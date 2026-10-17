// Autopilot-DM — content script : 🔮 farm d'orbes (groupes de 4 pious classiques, sinon 3, en boucle).
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.

// ---------- 🔮 Farm orbe ----------
// Le pilote scanne les zones à pious (bestiaire : race « Pious », niveaux 11–15) et attaque un groupe fait uniquement de
// pious classiques (ni archimonstre, ni avis de recherche) : 4 pious de préférence, sinon 3, à égalité le plus faible
// niveau total. Il le relance en boucle jusqu'au renouvellement des groupes (~3 min ; la relance viserait un groupe disparu)
// ou jusqu'à ce que la relance échoue, puis rescanne. Aucun groupe de 3 pious ou plus : nouveau scan au renouvellement.
// ORB_MAX_DEFEATS défaites d'affilée sur un groupe : abandonné. Groupe sans bouton « Attaquer » pendant ORB_STALL_MS
// (zone inaccessible) : zone écartée.
// cfg.orbRun = { active, startedAt, names: [noms normalisés], zones: [ids], skipped: [ids], recent: [sig], pick: { zone,
//   zn, g, n, names, total, rotateAt, sig }, pickedAt, fights, wins, groups, prev }
const ORB_MAX_DEFEATS = 3;
const ORB_STALL_MS = 45000;
const ORB_MIN = 3, ORB_WANT = 4;
// repli si le bestiaire est illisible (relevé le 18/10/2026)
const ORB_PIOUS = ['Piou Bleu', 'Piou Jaune', 'Piou Rose', 'Piou Rouge', 'Piou Vert', 'Piou Violet'];
const ORB_ZONES = [10, 32, 95, 973, 974, 975, 976, 977, 978, 980, 982, 482];
const orbOn = () => !!cfg.orbRun?.active;
let orbStallAt = 0;   // depuis quand le groupe choisi n'a pas de bouton « Attaquer »

// Pious du bestiaire : { names, zones } (noms normalisés, ids de zones de chasse).
async function orbPious() {
  try {
    const { flight } = await fetchFlight('/bestiaire');
    const { props } = rscProps(flight, (x) => Array.isArray(x.monsters) && Array.isArray(x.items));
    const pious = (props?.monsters || []).filter((m) => m.race === 'Pious' && m.n && !archiMatch(m.n));
    if (pious.length) return { names: pious.map((m) => normName(m.n)), zones: [...new Set(pious.flatMap((m) => m.z || []))] };
  } catch (e) { DM.log(`farm orbe : bestiaire illisible (${e.message}), liste intégrée`); }
  return { names: ORB_PIOUS.map(normName), zones: ORB_ZONES };
}

// Meilleur groupe de pious classiques : { best, nextAt } (best = null si aucun groupe de ORB_MIN pious ou plus).
async function orbBestGroup(run, say = () => {}) {
  const names = new Set(run.names);
  const zones = run.zones.filter((id) => !run.skipped?.includes(id));
  if (!zones.length) throw Object.assign(new Error('aucune zone à pious accessible'), { fatal: true });
  const zn = new Map((await DM.fetchZones({ all: true }).catch(() => [])).map((z) => [z.id, z.region ? `${z.name} (${z.region})` : z.name]));
  const queue = [...zones], out = [];
  let done = 0, nextAt = Infinity;
  await Promise.all([0, 1, 2].map(async () => {
    while (queue.length && orbOn()) {
      const id = queue.shift();
      try {
        const c = await scanZone(id);
        if (c.rotateAt) nextAt = Math.min(nextAt, c.rotateAt);
        for (const g of c.groups) {
          const classic = (m) => !m.archi && !m.wanted && names.has(normName(m.name)) && !targetMatch(m.name, ALL_KINDS);
          if (g.monsters.length < ORB_MIN || !g.monsters.every(classic)) continue;
          const gn = g.monsters.map((m) => m.name).sort();
          const sig = archiSig(id, g.n, gn, c.rotateAt);
          if (run.recent?.includes(sig)) continue;
          out.push({ zone: id, zn: zn.get(id) || `zone ${id}`, g: g.n, n: g.monsters.length, names: gn,
            total: g.total || g.monsters.reduce((t, m) => t + (+m.lvl || 0), 0), rotateAt: c.rotateAt || null, sig });
        }
      } catch (e) {
        if (e.fatal) throw e;
        if (e.empty && e.lvlReq) await save({ orbRun: { ...cfg.orbRun, skipped: [...(cfg.orbRun.skipped || []), id] } });   // zone au-dessus de ton niveau
      }
      say(`🔮 Farm orbe : scan ${++done}/${zones.length} zones…`);
      await sleep(250);
    }
  }));
  out.sort((a, b) => Math.min(b.n, ORB_WANT) - Math.min(a.n, ORB_WANT) || a.total - b.total);
  return { best: out[0] || null, nextAt: nextAt === Infinity ? Date.now() + 3 * 60000 : nextAt };
}

// Scan + départ vers le meilleur groupe. Rien trouvé : attente du prochain renouvellement des groupes, puis nouveau scan.
async function orbPick(why) {
  if (!orbOn()) return;
  orbStallAt = 0;
  setStatus('🔮 Farm orbe : recherche d’un groupe de pious…');
  progress();
  let r = null;
  for (let i = 0; orbOn(); i++) {
    try {
      r = await orbBestGroup(cfg.orbRun, (t) => { setStatus(t); progress(); });
    } catch (e) {
      DM.log(`farm orbe : scan impossible (${e.message})`);
      if (e.fatal || i >= 3) return orbStop(`scan impossible (${e.message})`);
      await sleep(5000);
      continue;
    }
    if (r.best) break;
    const until = Math.max(Date.now() + 10000, r.nextAt + 3000);
    DM.log(`farm orbe : aucun groupe de ${ORB_MIN} pious ou plus → nouveau scan à ${DM.hhmm(until)}`);
    while (Date.now() < until && orbOn()) {
      setStatus(`🔮 Farm orbe : aucun groupe de ${ORB_MIN}+ pious — nouveau scan à ${DM.hhmm(until)}`);
      progress();
      await sleep(5000);
    }
  }
  if (!orbOn() || !r?.best) return;
  const b = r.best;
  DM.log(`farm orbe : ${why} → ${b.zn} groupe ${b.g} (${b.names.join(', ')}), niveau total ${b.total}`);
  const run = cfg.orbRun;
  await save({ orbRun: { ...run, pick: b, pickedAt: Date.now(), fights: 0, groups: (run.groups || 0) + 1 },
    mode: 'chasse', huntZone: b.zone, huntZoneName: b.zn, huntGroup: b.g, huntTarget: null, lossStreak: 0 });
  setStatus(`🔮 Farm orbe : ${b.zn}, groupe ${b.g} (${b.n} pious)…`);
  progress();
  if (isOwner()) location.assign(`/chasse?zone=${b.zone}`);
}

// Sur la page de zone : pas de groupe choisi, autre zone, groupe renouvelé, ou groupe inattaquable → nouveau scan.
// true = on s'en occupe.
async function orbNeedPick() {
  if (!orbOn()) return false;
  const p = cfg.orbRun.pick;
  if (!p || cfg.huntZone !== p.zone || cfg.huntGroup !== p.g) { await orbPick('choix du groupe'); return true; }
  if (!groupCards().length) return true;   // page pas encore chargée
  const card = targetGroupByNumber(p.g);
  if (groupMonsters(card).map(normName).join('|') !== p.names.map(normName).sort().join('|')) {
    await orbPick(`groupe ${p.g} renouvelé`);
    return true;
  }
  const btns = [...card.querySelectorAll('button')];
  if (btns.some((b) => !b.disabled && b.offsetParent !== null && /^Attaquer$/.test(b.textContent.trim()))
    || btns.some((b) => /Plus d.énergie/.test(b.textContent))) { orbStallAt = 0; return false; }
  if (!orbStallAt) orbStallAt = Date.now();
  if (Date.now() - orbStallAt < ORB_STALL_MS) return false;
  DM.log(`farm orbe : ${p.zn}, groupe ${p.g} inattaquable depuis ${ORB_STALL_MS / 1000} s → zone écartée`);
  await save({ orbRun: { ...cfg.orbRun, skipped: [...(cfg.orbRun.skipped || []), p.zone] } });
  await orbPick(`${p.zn} inaccessible`);
  return true;
}

// Après une victoire : groupes renouvelés → nouveau scan (4 pious de préférence) ; sinon relance du même groupe.
// true = on s'en occupe (pas de relance).
async function orbAfterWin() {
  if (!orbOn() || !isHunt()) return false;
  const run = cfg.orbRun;
  const fights = (run.fights || 0) + 1;
  await save({ orbRun: { ...run, fights, wins: (run.wins || 0) + 1 } });
  if (run.pick?.rotateAt && Date.now() > run.pick.rotateAt + 2000) { await orbPick('groupes renouvelés'); return true; }
  setStatus(`🔮 Farm orbe : combat ${fights + 1} sur le groupe ${run.pick?.g} (${run.pick?.n || '?'} pious)…`);
  return false;
}

// Défaites d'affilée sur un groupe : abandonné jusqu'à son renouvellement, groupe suivant.
async function orbOnDefeats(streak, hint) {
  const run = cfg.orbRun, p = run.pick;
  notify('drop', `❌ Farm orbe : ${streak} défaites d’affilée contre **${p?.names?.join(', ') || 'le groupe'}** (${p?.zn || '?'}) — groupe abandonné.${hint ? `\n> 💡 ${hint}` : ''}`);
  if (p?.sig) await save({ orbRun: { ...run, recent: [...(run.recent || []), p.sig].slice(-30) } });
  return orbPick(`${streak} défaites sur le groupe ${p?.g}`);
}

async function orbEnd(status, msg) {
  const run = cfg.orbRun;
  if (!run) return;
  const prev = run.prev || {};
  await save({ orbRun: { ...run, active: false, endedAt: Date.now() }, enabled: false, paused: false, botFight: false, status,
    mode: prev.mode || cfg.mode, huntZone: prev.huntZone ?? null, huntZoneName: prev.huntZoneName || '', huntGroup: prev.huntGroup ?? null, huntTarget: null });
  if (msg) notify('drop', msg);
}
const orbStop = (reason) => orbEnd(`Farm orbe arrêté : ${reason}`.slice(0, 200),
  `⏹️ **Farm orbe arrêté** : ${reason} (${cfg.orbRun?.wins || 0} victoire(s) sur ${cfg.orbRun?.groups || 0} groupe(s))`);

async function startOrbFarm() {
  if (dropOn()) await dropStop('remplacé par 🔮 Farm orbe', false);
  if (sampleOn()) await sampleStop('remplacé par 🔮 Farm orbe');
  if (levelOn()) await levelStop('remplacé par 🔮 Farm orbe');
  if (archiOn()) await archiStop('remplacé par 🔮 Farm orbe');
  const { names, zones } = await orbPious();
  const run = { active: true, startedAt: Date.now(), names, zones, skipped: [], recent: [], pick: null, fights: 0, wins: 0, groups: 0,
    prev: orbOn() ? cfg.orbRun.prev : { mode: cfg.mode, huntZone: cfg.huntZone, huntZoneName: cfg.huntZoneName, huntGroup: cfg.huntGroup } };
  await save({ orbRun: run, mode: 'chasse', pauseReason: null, lossStreak: 0 });
  await send({ type: 'claim', start: true }).catch(() => {});   // le pilote démarre sur cet onglet
  DM.log(`farm orbe : lancé (${names.length} pious, ${zones.length} zones)`);
  await orbPick('départ');
}
