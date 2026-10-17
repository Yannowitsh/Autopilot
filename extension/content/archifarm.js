// Autopilot-DM — content script : 👑 farm d'archimonstres / avis de recherche (meilleur groupe d'une tranche, en boucle).
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.

// ---------- 👑 Farm archi / avis ----------
// Le pilote scanne les zones de la tranche de niveaux (champs « Niveaux » de la section 🎯 Avis & 👑 archis), attaque le
// meilleur groupe (le plus de cibles, archimonstres d'abord, puis le plus faible niveau total), le refait `perGroup`
// combats, puis rescanne et rejoint le meilleur groupe suivant. Types de cibles et minimum par groupe : ceux du scan
// (cases 🎯 / 👑, « Au moins N cible(s) »). Groupes renouvelés (~3 min) avant la fin : nouveau scan aussitôt.
// ARCHI_MAX_DEFEATS défaites d'affilée sur un groupe : abandonné. Rien trouvé : nouveau scan au prochain renouvellement.
// cfg.archiRun = { active, min, max, perGroup, lvl, fights, wins, groups, pick: { zone, zn, g, mons, targets, nA, nW,
//   total, rotateAt, sig }, pickedAt, recent: [sig], prev, startedAt }
const ARCHI_MAX_DEFEATS = 3;
const archiOn = () => !!cfg.archiRun?.active;
const archiScanCache = new Map();   // zone → résultat de scanZone, gardé jusqu'au renouvellement de ses groupes
const archiSig = (zone, g, names, rotateAt) => `${zone}|${g}|${names.join(',')}|${rotateAt || ''}`;

// Meilleur groupe de la tranche, hors groupes déjà farmés (recent) : { ...pick } ou null ; nextAt = prochain renouvellement.
async function archiBestGroup(run, say = () => {}) {
  const kinds = scanKinds();
  if (!kinds.wanted && !kinds.archi) throw Object.assign(new Error('coche au moins « avis de recherche » ou « archimonstres »'), { fatal: true });
  let zones = (await DM.fetchZones({ all: true })).filter((z) => !(run.lvl && (z.lvlReq > run.lvl || z.lvlMin > run.lvl))
    && (z.lvlMin == null || ((z.lvlMax ?? z.lvlMin) >= run.min && z.lvlMin <= run.max)));
  if (!kinds.wanted) {   // archis seuls : zones à badge « Archi » seulement
    const archiZones = await fetchArchiZones().catch(() => null);
    if (archiZones?.size) zones = zones.filter((z) => archiZones.has(z.id));
  }
  if (!zones.length) throw Object.assign(new Error(`aucune zone accessible entre les niveaux ${run.min} et ${run.max}`), { fatal: true });
  const min = Math.max(1, cfg.wantedMinPerGroup || 1);
  const queue = [...zones], out = [];
  let done = 0, nextAt = Infinity;
  await Promise.all([0, 1, 2].map(async () => {
    while (queue.length && archiOn()) {
      const z = queue.shift();
      try {
        let c = archiScanCache.get(z.id);
        if (!c || Date.now() > (c.rotateAt || c.at + 3 * 60000) + 1000) { c = { at: Date.now(), ...(await scanZone(z.id)) }; archiScanCache.set(z.id, c); }
        if (c.rotateAt) nextAt = Math.min(nextAt, c.rotateAt);
        for (const g of c.groups) {
          const mons = g.monsters.map((m) => {
            const t = targetMatch(m.name, kinds);
            const kind = m.archi ? 'archi' : m.wanted ? 'wanted' : t?.kind || null;   // badges du jeu d'abord
            return { name: m.name, lvl: +m.lvl || 1, kind: kind && kinds[kind] ? kind : null };
          });
          const targets = mons.filter((m) => m.kind);
          if (targets.length < min) continue;
          const names = mons.map((m) => m.name).sort();
          const sig = archiSig(z.id, g.n, names, c.rotateAt);
          if (run.recent?.includes(sig)) continue;
          const nA = targets.filter((m) => m.kind === 'archi').length;
          out.push({ zone: z.id, zn: z.region ? `${z.name} (${z.region})` : z.name, g: g.n, mons, names, targets: targets.map((m) => m.name),
            nA, nW: targets.length - nA, total: g.total || mons.reduce((t, m) => t + m.lvl, 0), rotateAt: c.rotateAt || null, sig });
        }
      } catch (e) { if (e.fatal) throw e; }
      say(`👑 Farm archi : scan ${++done}/${zones.length} zones…`);
      await sleep(250);
    }
  }));
  out.sort((a, b) => b.targets.length - a.targets.length || b.nA - a.nA || a.total - b.total);
  return { best: out[0] || null, nextAt: nextAt === Infinity ? Date.now() + 3 * 60000 : nextAt };
}

// Scan + départ vers le meilleur groupe. Rien trouvé : attente du prochain renouvellement des groupes, puis nouveau scan.
async function archiPick(why) {
  if (!archiOn()) return;
  setStatus('👑 Farm archi : recherche du meilleur groupe…');
  progress();
  let r = null;
  for (let i = 0; archiOn(); i++) {
    try {
      r = await archiBestGroup(cfg.archiRun, (t) => { setStatus(t); progress(); });
    } catch (e) {
      DM.log(`farm archi : scan impossible (${e.message})`);
      if (e.fatal || i >= 3) return archiStop(`scan impossible (${e.message})`);
      await sleep(5000);
      continue;
    }
    if (r.best) break;
    const until = Math.max(Date.now() + 10000, r.nextAt + 3000);
    DM.log(`farm archi : aucune cible dans la tranche ${cfg.archiRun.min}–${cfg.archiRun.max} → nouveau scan à ${DM.hhmm(until)}`);
    while (Date.now() < until && archiOn()) {
      setStatus(`👑 Farm archi : aucune cible dans la tranche — nouveau scan à ${DM.hhmm(until)}`);
      progress();
      await sleep(5000);
    }
  }
  if (!archiOn() || !r?.best) return;
  const b = r.best;
  DM.log(`farm archi : ${why} → ${b.zn} groupe ${b.g} (${b.targets.join(', ')} ; ${b.names.join(', ')}), niveau total ${b.total}`);
  const run = cfg.archiRun;
  await save({ archiRun: { ...run, pick: b, pickedAt: Date.now(), fights: 0, groups: (run.groups || 0) + 1 },
    mode: 'chasse', huntZone: b.zone, huntZoneName: b.zn, huntGroup: b.g, huntTarget: null, lossStreak: 0 });
  setStatus(`👑 Farm archi : ${b.zn}, groupe ${b.g} (${b.targets.join(', ')})…`);
  progress();
  if (isOwner()) location.assign(`/chasse?zone=${b.zone}`);
}

// Groupe farmé (ou abandonné) : retenu pour ne pas y revenir tant qu'il n'est pas renouvelé.
async function archiForget() {
  const run = cfg.archiRun;
  if (run?.pick?.sig) await save({ archiRun: { ...run, recent: [...(run.recent || []), run.pick.sig].slice(-30) } });
}

// Sur la page de zone : pas de groupe choisi, autre zone, ou groupe renouvelé (composition changée) → nouveau scan.
// true = on s'en occupe.
async function archiNeedPick() {
  if (!archiOn()) return false;
  const p = cfg.archiRun.pick;
  if (!p || cfg.huntZone !== p.zone || cfg.huntGroup !== p.g) { await archiPick('choix du groupe'); return true; }
  const cards = groupCards();
  if (!cards.length) return true;   // page pas encore chargée
  const now = groupMonsters(targetGroupByNumber(p.g)).map(normName);
  if (!p.targets.every((n) => now.includes(normName(n)))) {   // cibles plus là : groupe renouvelé (ou disparu)
    await archiForget();
    await archiPick(`groupe ${p.g} renouvelé`);
    return true;
  }
  return false;
}

// Après une victoire : X combats faits ou groupes renouvelés → scan et groupe suivant ; sinon relance du même groupe.
// true = on s'en occupe (pas de relance).
async function archiAfterWin() {
  if (!archiOn() || !isHunt()) return false;
  const run = cfg.archiRun;
  const fights = (run.fights || 0) + 1;
  await save({ archiRun: { ...run, fights, wins: (run.wins || 0) + 1 } });
  const rotated = run.pick?.rotateAt && Date.now() > run.pick.rotateAt + 2000;
  if (fights >= run.perGroup) {
    await archiForget();
    await archiPick(`${fights} combat${fights > 1 ? 's' : ''} faits sur ${run.pick?.zn || 'la zone'}, groupe ${run.pick?.g}`);
    return true;
  }
  // groupes renouvelés : le bouton de relance vise l'ancien groupe → nouveau scan
  if (rotated) { await archiPick('groupes renouvelés'); return true; }
  setStatus(`👑 Farm archi : combat ${fights + 1}/${run.perGroup} sur le groupe ${run.pick?.g}…`);
  return false;
}

// Défaites d'affilée sur un groupe : abandonné, groupe suivant.
async function archiOnDefeats(streak, hint) {
  const p = cfg.archiRun.pick;
  notify('wanted', `❌ Farm archi : ${streak} défaites d’affilée contre **${p?.targets?.join(', ') || 'le groupe'}** (${p?.zn || '?'}) — groupe abandonné.${hint ? `\n> 💡 ${hint}` : ''}`);
  await archiForget();
  return archiPick(`${streak} défaites sur le groupe ${p?.g}`);
}

async function archiEnd(status, msg) {
  const run = cfg.archiRun;
  if (!run) return;
  const prev = run.prev || {};
  await save({ archiRun: { ...run, active: false, endedAt: Date.now() }, enabled: false, paused: false, botFight: false, status,
    mode: prev.mode || cfg.mode, huntZone: prev.huntZone ?? null, huntZoneName: prev.huntZoneName || '', huntGroup: prev.huntGroup ?? null, huntTarget: null });
  if (msg) notify('wanted', msg);
}
const archiStop = (reason) => archiEnd(`Farm archi arrêté : ${reason}`.slice(0, 200),
  `⏹️ **Farm archi arrêté** : ${reason} (${cfg.archiRun?.wins || 0} victoire(s) sur ${cfg.archiRun?.groups || 0} groupe(s))`);

async function startArchiFarm() {
  if (dropOn()) await dropStop('remplacé par 👑 Farm archi', false);
  if (sampleOn()) await sampleStop('remplacé par 👑 Farm archi');
  if (levelOn()) await levelStop('remplacé par 👑 Farm archi');
  if (orbOn()) await orbStop('remplacé par 👑 Farm archi');
  if (seasonOn()) throw new Error('pas en mode saison (archimonstres = combats risqués)');
  let lvl = null;
  try {
    const r = await DM.fetchT(DM.ORIGIN + '/chasse', { credentials: 'include', cache: 'no-store' });
    lvl = +DM.zoneBrowserProps(await r.text())?.level || null;
  } catch { /* niveau inconnu : les zones réservées sont écartées par le scan */ }
  // tranche : champs « Niveaux » du scan ; vides → autour de ton niveau (±20)
  let min = +cfg.wantedLvlMin || 0, max = +cfg.wantedLvlMax || 0;
  if (!min && !max) { if (!lvl) throw new Error('renseigne la tranche de niveaux (champs « Niveaux »)'); min = Math.max(1, lvl - 20); max = lvl + 20; }
  if (!max) max = 200;
  if (min > max) throw new Error('niveau min > niveau max');
  const perGroup = Math.max(1, Math.round(+cfg.archiPerGroup || 5));
  const run = { active: true, startedAt: Date.now(), min, max, perGroup, lvl, fights: 0, wins: 0, groups: 0, pick: null, recent: [],
    prev: archiOn() ? cfg.archiRun.prev : { mode: cfg.mode, huntZone: cfg.huntZone, huntZoneName: cfg.huntZoneName, huntGroup: cfg.huntGroup } };
  await save({ archiRun: run, mode: 'chasse', pauseReason: null, lossStreak: 0 });
  await send({ type: 'claim', start: true }).catch(() => {});   // le pilote démarre sur cet onglet
  DM.log(`farm archi : lancé (niveaux ${min}–${max}, ${perGroup} combats par groupe)`);
  await archiPick('départ');
}
