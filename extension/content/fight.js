// Autopilot-DM — content script : anti-blocage + chronomètre des combats.
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.

// ---------- Anti-blocage : requête du jeu qui n'aboutit jamais ----------
// Après un clic qui lance un combat (Attaquer, Combattre, Suivant en auto…), on doit voir un combat en cours.
// Si rien ne se passe au bout de LAUNCH_TIMEOUT_MS, ou si une étape du pilote reste bloquée, on recharge la page.
// Autres cas rattrapés : combat du pilote qui ne se termine jamais (page figée alors que le serveur a répondu),
// combat qui ne repart pas après la vérification de présence, page vide ou page d'erreur serveur (5xx),
// requête du jeu sans réponse (netwatch.js publie les requêtes en cours dans <html data-dm-pending>).
// Recharger /combat est en général sans risque : le combat en cours est rechargé tel quel et le pilote relance l'Auto.
// Mais le serveur peut l'avoir perdu (chasse : groupes renouvelés entre-temps) : /combat ne lance alors plus
// aucune requête → combat perdu, retour à la page d'accueil du mode ; en chasse d’avis de recherche, le pilote s’y arrête si le groupe a été renouvelé.
const LAUNCH_TIMEOUT_MS = 45 * 1000;
const BUSY_TIMEOUT_MS = 90 * 1000;
const FIGHT_STALL_MS = 40 * 1000;      // un combat en Auto se joue en ~10 s
const PRESENCE_STALL_MS = 15 * 1000;   // combat toujours figé après avoir répondu à « Es-tu toujours là ? »
const BLANK_STALL_MS = 20 * 1000;      // page vide
const PENDING_MAX_MS = 15 * 1000;      // requête du jeu sans réponse (normalement < 1 s)
const LOST_FIGHT_MS = 25 * 1000;       // /combat sans fin de combat ni aucune requête depuis le chargement
// Réglables dans la popup : délai avant de recharger une page d'erreur, écart minimal entre deux rechargements.
const errorStallMs = () => Math.max(1, +cfg.errorReloadSec || 5) * 1000;
const reloadGapMs = () => Math.max(5, +cfg.reloadGapSec || 30) * 1000;
const MAX_STUCK_RELOADS = 3;           // au-delà : retour à la page d'accueil du mode
const ERROR_PAGE = /Application error|client-side exception|Internal Server Error|Bad Gateway|Service (Temporarily )?Unavailable|Gateway Time-?out|Web server is down|Connection timed out|This page couldn.t load|Resource Limit|Erreur serveur|\b(erreur|error)\s*5\d\d\b/i;
const ERROR_TITLE = /^\s*((erreur|error)\s*)?5\d\d\b|\b(erreur|error)\s*5\d\d\b/i;   // titre « Erreur 508 », « 503 Service… »
let launchAt = 0, busySince = 0, fightSince = 0, presenceAt = 0, oddSince = 0, oddCheckedAt = 0, oddKind = '';
const pageLoadedAt = Date.now();
// Le jeu compte l'inactivité avec les gestes du joueur (pointerdown, keydown, scroll… sur window, PresenceBeacon) et
// signale l'écart (/api/file?ago=…) : les clics du pilote n'en sont pas. Chaque combat lancé compte comme activité
// (« clic, combat, mode Auto » d'après la page d'inactivité) ; un pilote bloqué finit, lui, bien par passer inactif.
const markActive = () => window.dispatchEvent(new Event('scroll'));
const markLaunch = () => {
  markActive();
  try { sessionStorage.setItem(LAUNCH_KEY, String(Date.now())); } catch { /* stockage bloqué : écart non garanti au rechargement */ }
  if (!launchAt) launchAt = Date.now();
  const now = Date.now(), key = timeKey();
  // boucle = écart entre deux lancements du même mode / moteur (pauses de plus de 5 min ignorées)
  if (cfg.lastLaunchAt && cfg.lastLaunchKey === key && now - cfg.lastLaunchAt < TIME_GAP_MAX) addTime(key, 'loop', now - cfg.lastLaunchAt);
  save({ lastLaunchAt: now, lastLaunchKey: key, lastFightTimed: false });
};

// ---------- Chronomètre des combats (comparer l'Auto du jeu et l'Auto par poids) ----------
// cfg.fightTimes[« mode|moteur »] = { n, fight (ms cumulées, lancement → écran de fin), loopN, loop (ms entre deux lancements) }
const TIME_GAP_MAX = 5 * 60000;
const timeKey = () => `${cfg.mode || 'aventure'}|${weightsOn() ? 'weights' : 'game'}`;
function addTime(key, kind, ms) {
  const all = { ...(cfg.fightTimes || {}) };
  const t = { n: 0, fight: 0, loopN: 0, loop: 0, ...all[key] };
  if (kind === 'loop') { t.loopN++; t.loop += ms; } else { t.n++; t.fight += ms; }
  all[key] = t;
  save({ fightTimes: all });
}
// Fin d'un combat du pilote : durée depuis son lancement (une seule fois par combat).
function timeFightEnd() {
  const d = Date.now() - (cfg.lastLaunchAt || 0);
  if (cfg.lastFightTimed || !cfg.lastLaunchAt || cfg.lastLaunchKey !== timeKey() || d > TIME_GAP_MAX) return;
  cfg.lastFightTimed = true;
  addTime(cfg.lastLaunchKey, 'fight', d);
  save({ lastFightTimed: true });
}
const TIME_LABELS = { aventure: 'Aventure', chasse: 'Chasse', ascension: 'Ascension', game: 'Auto du jeu', weights: 'Auto par poids' };
const fmtSec = (ms) => `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
function timeLines() {
  return Object.entries(cfg.fightTimes || {}).filter(([, t]) => t.n || t.loopN).map(([k, t]) => {
    const [mode, eng] = k.split('|');
    const loop = t.loopN ? t.loop / t.loopN : 0;
    return `<div><b>${TIME_LABELS[mode] || mode} · ${TIME_LABELS[eng] || eng}</b> : ${t.n} combat(s)${t.n ? `, ${fmtSec(t.fight / t.n)} / combat` : ''}${loop ? `, boucle ${fmtSec(loop)} (≈ ${Math.round(3600000 / loop)} / h)` : ''}</div>`;
  }).join('');
}

// Page vide ou page d'erreur (vérifié toutes les 2 s : innerText force un calcul de mise en page)
function oddPage(now) {
  if (now - oddCheckedAt < 2000) return;
  oddCheckedAt = now;
  const text = document.body?.innerText.trim() || '';
  const titles = [document.title, ...[...document.querySelectorAll('h1, h2')].map((h) => h.textContent)];
  const kind = document.getElementById('__next_error__') || titles.some((t) => ERROR_TITLE.test(t))
    || (text.length < 3000 && ERROR_PAGE.test(`${document.title} ${text}`)) ? 'error'
    : text.length < 40 ? 'blank' : '';
  if (kind !== oddKind) { oddKind = kind; oddSince = kind ? now : 0; }
}
// Plus ancienne requête du jeu en attente (ms), 0 si aucune.
const pendingFor = (now) => {
  const t = +(document.documentElement.dataset.dmPending || '').split(':')[1];
  return t ? now - t : 0;
};
const pageActions = () => +(document.documentElement.dataset.dmActions || 0);

function stuckCheck() {
  const now = Date.now();
  const end = location.pathname.startsWith('/combat') && endTitle();
  const inFight = location.pathname.startsWith('/combat') && !end;
  if (launchAt && inFight) launchAt = 0;   // le combat a démarré
  if (!inFight) { fightSince = 0; presenceAt = 0; } else if (!fightSince) fightSince = now;
  if (end && cfg.stuckReloads) save({ stuckReloads: 0 });   // un combat s'est terminé : compteur remis à zéro
  oddPage(now);
  const waitingPresence = !!presenceDialog();
  // Auto par poids : le combat dure bien plus que les ~10 s de l'Auto du jeu, et ses actions partent de l'extension
  // (invisibles pour netwatch.js). Tant qu'il joue (une action il y a moins de FIGHT_STALL_MS), le combat n'est ni figé ni perdu ;
  // à la fin, il recharge lui-même la page (10 s de marge).
  const weightsPlaying = (weightedBusy || now - weightedDoneAt < 10000) && now - lastProgress < FIGHT_STALL_MS;
  let why = null;
  if (launchAt && now - launchAt > LAUNCH_TIMEOUT_MS) why = 'lancement du combat sans réponse';
  else if (busy && now - busySince > BUSY_TIMEOUT_MS + cfg.delayMax * 1000) why = 'pilote bloqué';
  else if (oddKind === 'error' && now - oddSince > errorStallMs()) why = 'erreur serveur';
  else if (oddKind === 'blank' && now - oddSince > BLANK_STALL_MS) why = 'page vide';
  else if (pendingFor(now) > PENDING_MAX_MS) why = `requête sans réponse depuis ${Math.round(pendingFor(now) / 1000)} s`;
  else if (!waitingPresence && presenceAt && inFight && now - presenceAt > PRESENCE_STALL_MS) why = 'combat figé après la vérification de présence';
  else if (!waitingPresence && !weightsPlaying && inFight && cfg.botFight && now - fightSince > FIGHT_STALL_MS) why = 'combat figé';
  // Combat disparu côté serveur : la page /combat ne lance plus rien → inutile de recharger, on repart de l'accueil.
  // (seulement si netwatch.js tourne dans la page, sinon le compteur de requêtes reste à 0)
  if (!why && !waitingPresence && !weightsPlaying && inFight && cfg.botFight && document.documentElement.dataset.dmNetwatch
      && !pageActions() && !pendingFor(now) && now - pageLoadedAt > LOST_FIGHT_MS) why = 'combat introuvable (perdu par le serveur)';
  if (!why || now - (cfg.lastStuckReload || 0) < reloadGapMs()) return false;
  launchAt = 0;
  progress();
  const n = (cfg.stuckReloads || 0) + 1;
  // recharger ne suffit pas, ou combat perdu : on repart de la page d'accueil du mode
  const giveUp = n > MAX_STUCK_RELOADS || why.startsWith('combat introuvable');
  DM.log(`anti-blocage : ${why} sur ${location.pathname} → ${giveUp ? `retour à ${home()}` : 'rechargement'}`);
  save({ lastStuckReload: now, stuckReloads: giveUp ? 0 : n,
    status: giveUp ? `Toujours bloqué (${why}) — retour à ${home()}…` : `Page bloquée (${why}) — rechargement…` });
  setTimeout(() => (giveUp ? location.assign(home()) : location.reload()), 300);
  return true;
}

// Android : l'écran reste allumé tant que le pilote tourne sur cet onglet (en veille, le navigateur gèle la page
// et le farm s'arrête). Le verrou est rendu par le navigateur quand l'onglet passe en arrière-plan : redemandé au retour.
let wakeLock = null, wakeAsking = false;
async function keepAwake() {
  const want = DM.IS_MOBILE && isOwner() && document.visibilityState === 'visible' && !dead;
  if (want && !wakeLock && !wakeAsking && navigator.wakeLock) {
    wakeAsking = true;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { /* refusé (économie d'énergie…) : on réessaiera au prochain tour */ }
    wakeAsking = false;
  } else if (!want && wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

// Option « Garder actif en arrière-plan » (cfg.keepAlive) : un son quasi muet en boucle tant que le pilote tourne sur cet
// onglet. Un onglet qui joue du son n'est pas ralenti par Firefox, et sur Android la lecture empêche le système de mettre
// Firefox en pause (autre appli, écran éteint), comme une appli de musique (notification « lecture en cours »).
// Le son n'est pas un silence (les navigateurs ignorent une lecture muette ou quasi muette) : sinus de 20 Hz à −30 dB,
// sous le seuil de l'oreille à cette fréquence et que les haut-parleurs de téléphone ne reproduisent pas.
// Lecture automatique : permise après un geste (▶) ; après un rechargement du pilote, il faut que le site ait le droit
// de lire du son tout seul (Firefox → Paramètres → Autorisations des sites → Lecture automatique).
let aliveAudio = null, aliveWarned = false;
function aliveSound() {
  const rate = 8000, n = rate, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(1000 * Math.sin(2 * Math.PI * 20 * i / rate)), true);   // 20 cycles : boucle sans clic
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
function keepAlive() {
  const want = !!cfg.keepAlive && isOwner() && !dead;
  if (want) {
    if (!aliveAudio) { aliveAudio = new Audio(aliveSound()); aliveAudio.loop = true; aliveAudio.volume = 1; }
    if (aliveAudio.paused) aliveAudio.play().then(() => { aliveWarned = false; }).catch(() => {
      if (aliveWarned) return;
      aliveWarned = true;
      DM.log('garder actif : lecture du son refusée (lecture automatique bloquée)');
      tradeToast('🔊 Garder actif : Firefox bloque la lecture automatique. Autorise-la pour ce site (Paramètres → Autorisations des sites → Lecture automatique → Autoriser l’audio et la vidéo), ou appuie sur ▶.', 'err');
    });
  } else if (aliveAudio && !aliveAudio.paused) aliveAudio.pause();
}

async function tick() {
  if (!contextAlive()) { shutdown(); return; }
  keepAlive();
  keepAwake();
  updateLift();   // la barre du jeu apparaît ou disparaît selon la page
  seasonDetect();
  if (!isOwner()) return;
  wheelTick();   // Roue Bouftou (claims.js) : à part, ne bloque pas le pilote
  if (stuckCheck() || busy) return;
  busy = true;
  busySince = Date.now();
  try {
    if (Date.now() - lastProgress > WATCHDOG_MS && !(bossFighting() && !cfg.bossRun.clickedAt)) {   // boss : lancement surveillé par bossLaunch
      progress();
      setStatus(`Bloqué depuis 2 min — rechargement de ${home()}`);
      if (onHome()) location.reload();   // page d'accueil figée (relance qui ne part pas…)
      else location.assign(home());
      return;
    }
    await step();
  } catch (e) {
    console.warn('[Pilote auto]', e);
  } finally {
    busy = false;
  }
}
