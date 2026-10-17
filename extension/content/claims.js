// Autopilot-DM — content script : bulle 🎁 « Tout réclamer » (succès, série de connexion, quêtes du jour, Élan, compagnon, grotte)
// et Roue Bouftou automatique.
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.
//
// Server actions du jeu (IDs relus dans les chunks de la page, ils changent à chaque déploiement) — relevées le 12/10/2026 :
//   /succes     claimAchievement(["all"])          view.claimable = succès à réclamer
//   /compagnon  feedAction(["all"])                 initial.kibble = croquettes en stock, feedLeft = repas restants du jour
//   /jeu        claimLoginStreak()                  initial.claimed (série de connexion du jour)
//               claimDailyQuest(id)                 initial.quests[] { id, done, claimed }
//               claimChestElan()                    coffre de l'Élan : 25 combats (seed.total − seed.m.base), 3 par jour
//               claimChallengeElan(id)              défis du jour (seed.challenges) ; la progression est comptée par la page
//                                                   du jeu dans localStorage « rpgm:elan:v1:<perso> » { day, prog: { id: n } }
//               claimCave() puis enterCave()        grotte de l'Aéfka : butin de l'absence, puis relance
// Le serveur ne vérifie pas la progression des défis de l'Élan (claimChallengeElan('arena3') accepté sans combat d'arène,
// 12/10) : on ne réclame un défi que si la page du jeu le montre réussi (prog ≥ objectif), comme son bouton.
const CLAIM_CAVE_MIN_MS = 60 * 60000;   // grotte : butin récupéré (et grotte relancée) après 1 h au moins
const claimActionIds = {};
async function claimAct(segment, chunks, name, args) {
  claimActionIds[name] ||= await findAction(chunks, name, null);
  if (!claimActionIds[name]) throw new Error(`action ${name} introuvable`);
  try { return await callAction(segment, claimActionIds[name], args); } catch (e) { if (!e.game) delete claimActionIds[name]; throw e; }
}

// → { got: [textes], errors: [textes] }
async function claimAll() {
  const got = [], errors = [];
  const step = async (label, fn) => {
    try { const r = await fn(); if (r) got.push(r); } catch (e) { errors.push(`${label} : ${e.message}`); }
  };

  // Accueil : série de connexion, quêtes du jour, Élan, grotte
  await step('accueil', async () => {
    const { flight, chunks } = await fetchFlight('/jeu');
    const out = [];
    const streak = rscProps(flight, (x) => x.initial && 'streak' in x.initial && 'claimed' in x.initial && Array.isArray(x.initial.gifts)).props?.initial;
    if (streak && !streak.claimed) {
      await claimAct('jeu', chunks, 'claimLoginStreak', []);
      out.push(`série de connexion (jour ${streak.nextDay || streak.streak + 1})`);
    }
    const quests = rscProps(flight, (x) => x.initial && Array.isArray(x.initial.quests)).props?.initial.quests || [];
    for (const q of quests.filter((q) => q.done && !q.claimed)) {
      try { await claimAct('jeu', chunks, 'claimDailyQuest', [q.id]); out.push(`quête « ${q.label} »`); } catch (e) { errors.push(`quête ${q.label} : ${e.message}`); }
    }
    const seed = rscProps(flight, (x) => x.seed?.m && Array.isArray(x.seed.challenges)).props?.seed;
    if (seed) {
      const m = seed.m || {}, today = m.day;
      // coffre de l'Élan : le serveur vérifie lui-même (« Pas encore : continue à jouer. »)
      if (m.base != null && +seed.total - +m.base >= 25 && (+m.chests || 0) < 3) {
        try { await claimAct('jeu', chunks, 'claimChestElan', []); out.push('coffre de l’Élan'); } catch (e) { if (!e.game) errors.push(`coffre de l’Élan : ${e.message}`); }
      }
      let prog = {};
      try {
        const s = JSON.parse(localStorage.getItem(`rpgm:elan:v1:${seed.charId}`) || 'null');
        if (s && s.day === today) prog = s.prog || {};
      } catch { /* rien */ }
      for (const c of seed.challenges) {
        if ((m.ddone || []).includes(c.id) || !((+prog[c.id] || 0) >= c.target)) continue;
        try { await claimAct('jeu', chunks, 'claimChallengeElan', [c.id]); out.push(`défi « ${c.label} »`); } catch (e) { errors.push(`défi ${c.label} : ${e.message}`); }
      }
    }
    const cave = flight.match(/"enteredAt":(\d{12,})/);
    if (cave && Date.now() - +cave[1] >= CLAIM_CAVE_MIN_MS) {
      const r = await claimAct('jeu', chunks, 'claimCave', []);
      const l = r.loot || {};
      out.push(`grotte (${[l.kamas ? `${l.kamas.toLocaleString('fr-FR')} kamas` : '', l.xp ? `${l.xp.toLocaleString('fr-FR')} XP` : '',
        ...(l.chests || []).map((c) => `${c.qty} ${c.label}`)].filter(Boolean).join(', ') || 'rien'})`);
      try { await claimAct('jeu', chunks, 'enterCave', []); } catch (e) { errors.push(`relance de la grotte : ${e.message}`); }
    }
    return out.join(', ') || null;
  });

  // Succès (+ énergie depuis le 10/10)
  await step('succès', async () => {
    const { flight, chunks } = await fetchFlight('/succes');
    const view = rscProps(flight, (x) => 'claimable' in x && 'unlocked' in x && Array.isArray(x.rows)).props;
    if (!view) throw new Error('page illisible');
    if (!(+view.claimable > 0)) return null;
    await claimAct('succes', chunks, 'claimAchievement', ['all']);
    return `${view.claimable} succès${view.claimableEnergy ? ` (+${view.claimableEnergy} énergie)` : ''}`;
  });

  // Compagnon : toutes les croquettes en stock
  await step('compagnon', async () => {
    const { flight, chunks } = await fetchFlight('/compagnon');
    const st = rscProps(flight, (x) => x.initial && 'kibble' in x.initial && 'feedLeft' in x.initial).props?.initial;
    if (!st) return null;   // pas de compagnon (perso de saison…)
    if (!(+st.kibble > 0) || !(+st.feedLeft > 0)) return null;
    const r = await claimAct('compagnon', chunks, 'feedAction', ['all']);
    return `compagnon nourri (${r.fed ?? st.kibble} croquette${(r.fed ?? st.kibble) > 1 ? 's' : ''}${r.levelsUp ? `, +${r.levelsUp} niveau${r.levelsUp > 1 ? 'x' : ''}` : ''})`;
  });

  DM.log('🎁 tout réclamer :', got, errors);
  return { got, errors };
}

let claimBusy = false;
async function onClaimAll(el) {
  if (claimBusy) return;
  claimBusy = true;
  el?.classList.add('busy');
  try {
    const { got, errors } = await claimAll();
    const msg = got.length ? `🎁 Réclamé : ${got.join(' · ')}` : '🎁 Rien à réclamer pour le moment';
    tradeToast(errors.length ? `${msg}\n⚠️ ${errors.join(' · ')}` : msg, errors.length && !got.length ? 'err' : 'ok');
  } catch (e) {
    tradeToast(`🎁 Échec : ${e.message}`, 'err');
  } finally {
    claimBusy = false;
    el?.classList.remove('busy');
  }
}

// ---------- Roue Bouftou automatique (patch du 17/10) ----------
// /roue : WheelClient { nextAt (ms, null = tour disponible), blocked (texte : perso de saison…) } ; server action
// spinWheel() → { ok, index, text (« +2 000 kamas »), jackpot, nextAt } (HAR du 17/10). Un tour toutes les 3 h par compte,
// mode principal seulement. Pilote actif (même en pause énergie) : l'onglet du pilote tourne la roue dès qu'elle est prête.
// Prochain tour gardé par personnage (cfg.wheelNextAt[nom]) : deux comptes (fenêtre normale + navigation privée) partagent
// le stockage de l'extension.
const WHEEL_RETRY_MS = 10 * 60000, WHEEL_BLOCKED_MS = 3 * 3600000;
let wheelBusy = false, wheelRetryAt = 0;
async function wheelTick() {
  if (wheelBusy || !cfg.enabled || cfg.wheelAuto === false || cfg.seasonMode || cfg.seasonPilot || !isOwner()) return;
  const me = myName() || '?', now = Date.now();
  if (now < wheelRetryAt || now < (+cfg.wheelNextAt?.[me] || 0)) return;
  wheelBusy = true;
  const keep = (at) => save({ wheelNextAt: { ...(cfg.wheelNextAt || {}), [me]: at } });
  try {
    const { flight, chunks } = await fetchFlight('/roue');
    const w = rscProps(flight, (x) => 'nextAt' in x && 'blocked' in x).props;
    if (!w) throw new Error('page de la roue illisible');
    if (w.blocked) { DM.log(`🎡 roue fermée : ${w.blocked}`); await keep(now + WHEEL_BLOCKED_MS); return; }
    if (+w.nextAt > now) { await keep(+w.nextAt); return; }
    const r = await claimAct('roue', chunks, 'spinWheel', []);
    await keep(+r.nextAt || now + WHEEL_BLOCKED_MS);
    const won = String(r.text || 'lot inconnu');
    DM.log('🎡 roue Bouftou :', r);
    tradeToast(`🎡 Roue Bouftou : ${won}`, 'ok');
    notify('wheel', `🎡 **Roue Bouftou**${r.jackpot ? ' — 💥 **JACKPOT** !' : ''} (${me}) : ${won}. Prochain tour à ${DM.hhmm(+r.nextAt || now + WHEEL_BLOCKED_MS)}.`);
  } catch (e) {
    wheelRetryAt = now + WHEEL_RETRY_MS;
    DM.log(`🎡 roue Bouftou : échec (${e.message}), nouvel essai dans 10 min`);
    if (e.game) await keep(now + WHEEL_RETRY_MS);
  } finally {
    wheelBusy = false;
  }
}
