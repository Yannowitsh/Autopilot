// Autopilot-DM — content script : constantes, état partagé, contexte, DOM, vérification de présence, boss auto.
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.

const TICK_MS = 500;
const ENERGY_POLL_MS = 2 * 60000;   // vérification de l'énergie pendant une pause
const WATCHDOG_MS = 2 * 60000;      // rien ne bouge depuis 2 min → retour à /aventure
const MAX_PATH_RETRIES = 5;         // aventure : nouveaux essais après une défaite avant arrêt + alerte Discord

let cfg = { ...DM.DEFAULTS };
let myTabId = null;
let busy = false;
let lastProgress = Date.now();
let lastEnergyCheck = 0;
let lastAutoClick = 0;
let endRetries = 0;   // clics de relance sur le même écran de fin
let endSince = 0;     // arrivée sur cet écran de fin : au-delà de END_STUCK_MS sans relance réussie, on repasse par la zone
const END_STUCK_MS = 60000;
// Dernier clic de relance (« Refaire ce combat », « Étape suivante »…). Pendant RELAUNCH_WAIT_MS, ou tant qu'un combat par
// poids se joue en arrière-plan (l'ancien écran de fin reste affiché jusqu'au rechargement), l'écran de fin n'est pas
// retraité : avant, 3 passages (~6 s) suffisaient pour croire la relance refusée et repartir à la zone en plein combat
// (groupe perdu), et la même victoire était comptée deux fois.
let relaunchAt = 0;
const RELAUNCH_WAIT_MS = 15000;
// Relance cliquée sans effet (leavechasse.har : après un rechargement, le site ne s'était pas activé et le clic sur la relance
// n'avait rien envoyé ; repartir à la zone faisait perdre le groupe). On recharge d'abord l'écran de fin, où la relance reste
// possible ; après END_RELOADS_MAX rechargements sans relance réussie en 2 min → page de la zone (Leveling : nouveau scan).
const END_RELOADS_KEY = 'dmEndReloads';
const END_RELOADS_MAX = 2;
function endReloads() {
  try { return JSON.parse(sessionStorage.getItem(END_RELOADS_KEY) || '[]').filter((t) => Date.now() - t < 120000); } catch { return []; }
}
function endReloadsClear() { try { sessionStorage.removeItem(END_RELOADS_KEY); } catch { /* rien */ } }
// true : l'écran de fin est rechargé ; false : déjà rechargé assez, à l'appelant de repartir à la zone
function endReload(why) {
  const r = endReloads();
  if (r.length >= END_RELOADS_MAX) { endReloadsClear(); return false; }
  try { sessionStorage.setItem(END_RELOADS_KEY, JSON.stringify([...r, Date.now()])); } catch { return false; }
  DM.log(`${why} → rechargement de l’écran de fin (${r.length + 1}/${END_RELOADS_MAX})`);
  setStatus('Relance sans effet — rechargement de l’écran de fin…');
  progress();
  location.reload();
  return true;
}
let ticker = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const humanDelay = () => (cfg.delayMin + Math.random() * Math.max(0, cfg.delayMax - cfg.delayMin)) * 1000;
// Rythme humain (développeur du jeu, 18/10 : « en ratio humain un combat fini jamais en dessous de 2.8 s avant la relance », 3 s en
// auto AFK, imposé par le serveur ; en dessous « c'est de la macro ») : jamais deux lancements de combat à moins de
// LAUNCH_GAP_MS (+ aléa d'1 s) dans cet onglet, quels que soient les délais réglés. Mémorisé par onglet (sessionStorage,
// survit aux rechargements) : en navigation privée « spanning », chrome.storage est partagé entre les deux comptes.
const LAUNCH_GAP_MS = 3500;
const LAUNCH_KEY = 'dmLastLaunch';
const lastLaunch = () => { try { return +sessionStorage.getItem(LAUNCH_KEY) || 0; } catch { return 0; } };
const launchWait = () => Math.max(0, LAUNCH_GAP_MS + Math.random() * 1000 - (Date.now() - lastLaunch()));
// délai avant un clic qui lance un combat : le délai voulu, mais jamais sous l'écart minimal depuis le lancement précédent
const launchDelay = (ms = humanDelay()) => Math.max(ms, launchWait());
// Délai avant de relancer depuis l'écran de fin : en combat rapide, juste ce qu'il faut pour respecter
// fastFightMinSec depuis le lancement précédent (+ un petit aléa) ; sinon le délai « humain » habituel.
// Combat rapide désactivé (1.63.3) : le serveur impose désormais la durée des combats, recharger ne fait rien gagner.
const FAST_FIGHT_ENABLED = false;
const fastFight = () => FAST_FIGHT_ENABLED && !!cfg.fastFight;
const relaunchDelay = () => (fastFight()
  ? Math.max(0, (+cfg.fastFightMinSec || 0) * 1000 - (Date.now() - (cfg.lastLaunchAt || 0))) + 300 + Math.random() * 700
  : launchDelay());
// ---------- Extension rechargée pendant que l'onglet reste ouvert ----------
// Ce script devient « orphelin » : tout appel chrome.* lève « Extension context invalidated ».
// On le détecte et on s'arrête proprement (plus d'erreurs, plus d'interface fantôme) ; la page rechargée repart à neuf.
let dead = false;
const contextAlive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
const isInvalidated = (e) => /Extension context invalidated/i.test(e?.message || String(e || ''));
const send = (msg) => {
  if (!contextAlive()) { shutdown(); return Promise.reject(new Error('extension rechargée : recharge la page')); }
  return chrome.runtime.sendMessage(msg);
};
const save = (o) => {
  Object.assign(cfg, o);
  if (!contextAlive()) { shutdown(); return Promise.resolve(); }
  return chrome.storage.local.set(o);
};
function shutdown() {
  if (dead) return;
  dead = true;
  const quiet = (f) => { try { f(); } catch { /* pas encore initialisé */ } };
  quiet(() => clearInterval(ticker));
  quiet(() => clearInterval(aliveTimer));
  quiet(() => clearInterval(eqTimer));
  quiet(() => wakeLock?.release());
  quiet(() => aliveAudio?.pause());
  quiet(() => eqAsk?.host.remove());
  quiet(() => domObserver.disconnect());
  quiet(() => ui?.host.remove());
  quiet(() => queueBox?.remove());
  quiet(() => toastEl?.remove());
  quiet(() => cardStack?.host.remove());
  quiet(() => document.querySelectorAll('.dm-deck-weights, .dm-fuse-all, .dm-unequip-all, .dm-cancel-all, .dm-manual-weights').forEach((el) => el.remove()));
  document.querySelectorAll('.dm-trade, .dm-lock, .dm-picker, .dm-tip, .dm-tip-style').forEach((el) => el.remove());
  console.info('[Autopilot-DM] Extension rechargée : recharge la page pour la réactiver.');
}
window.addEventListener('error', (e) => { if (isInvalidated(e.error || e.message)) { e.preventDefault(); shutdown(); } });
window.addEventListener('unhandledrejection', (e) => { if (isInvalidated(e.reason)) { e.preventDefault(); shutdown(); } });
const aliveTimer = setInterval(() => { if (!contextAlive()) shutdown(); }, 2000);
// kind : type de notification (DM.NOTIF), filtré selon les réglages par le service worker
const notify = (kind, text, embeds) => send({ type: 'discord', kind, text, embeds }).catch(() => {});
const progress = () => { lastProgress = Date.now(); };
const setStatus = (status, paused = false) => {
  if (cfg.status !== status || !!cfg.paused !== paused) save({ status, paused });
};
const isOwner = () => cfg.enabled && myTabId != null && cfg.ownerTabId === myTabId;
const modOn = (k) => DM.modOn(cfg, k);   // module activé dans la popup de l'extension
// Ascension : moteur choisi par étage (cfg.ascUseOurs, cf. ascPickEngine) ; ailleurs, réglage « Auto par poids »
// Abysses : toujours l'Auto par poids (l'Auto du jeu y choisirait aussi les sorts et les bonus)
const weightsOn = () => (cfg.mode === 'ascension' ? cfg.ascUseOurs === true : cfg.mode === 'abysses' || (cfg.fightEngine === 'weights' && modOn('weights')));

// ---------- DOM ----------
const visibleButtons = () => [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null);
// Texte d'un bouton sans son raccourci clavier (<kbd>, raccourcis personnalisables depuis le patch du 9/10)
const btnText = (b) => [...b.childNodes].filter((n) => n.nodeName !== 'KBD').map((n) => n.textContent).join('').trim();
const findBtn = (re) => visibleButtons().find((b) => !b.disabled && re.test(btnText(b)));
// Titre de l'écran de fin (code du site, 13/10/2026) : « Victoire ! », « Victoire aux points ! », « Capturé ! », « Défaite… » ;
// Dimension : « Vague N franchie ! », « Descente terminée… », « Tu as fui la Dimension » ; Kralamoure : « Faille terminée ».
// Avant, seuls Victoire / Défaite étaient reconnus : fin de vague prise pour un combat en cours, rechargée en boucle.
const END_TITLE = /^(Victoire|Défaite|Capturé|Vague \d+ franchie|Descente terminée|Tu as fui la Dimension|Faille terminée)/;
const endTitle = () => [...document.querySelectorAll('h2')].map((h) => h.textContent.trim()).find((t) => END_TITLE.test(t));
const endWon = (t) => /^(Victoire|Capturé|Vague \d+ franchie|Faille terminée)/.test(t || '');
// Boutons de fin de combat propres au Chemin (aventure)
// « Un autre combat » : bouton de relance depuis le patch « Élan » (10/10), victoire au Chemin comme en chasse
const NEXT_STAGE = /^(Un autre combat|Étape suivante|Réessayer l.étape|Suivant en auto|Continuer en (mode )?auto|Réessayer en auto)$/i;
const AUTO_NEXT = /^(Suivant en auto|Continuer en (mode )?auto)$/i;   // étape suivante en Auto (récompenses entières)
const SEMI_AUTO = /^Auto$/;              // jamais « Auto AFK −50 % » ni « Fuir »
// Boutons de fin de combat de chasse (« Suivant en auto » y relance aussi le même groupe en Auto)
const HUNT_RETRY = /^(Un autre combat|Refaire ce combat|Réessayer ce groupe)$/;
const isHunt = () => cfg.mode === 'chasse' && !!cfg.huntZone;
const isAsc = () => cfg.mode === 'ascension';
const isDim = () => cfg.mode === 'dimension';     // Dimension Écarlate (guilde) : vagues sans fin
const isKrala = () => cfg.mode === 'krala';       // Faille du Kralamoure (guilde) : un combat toutes les 20 min
const isArena = () => cfg.mode === 'arene';       // Arène : un défi contre chaque adversaire pas encore affronté
const isAbyss = () => cfg.mode === 'abysses';     // Abysses : descente rogue-like, une seule vie
const continueOn = () => (cfg.activity ?? 'continuer') === 'continuer';
// Mode saison (saison Héroïque) : une défaite contre un boss tue le perso de saison → le pilote ne fait que de la chasse.
// Actif si la case est cochée (seasonMode, réglage commun) ou si le perso joué dans CET onglet est un perso de saison :
// deux fenêtres (normale et privée) partagent le même stockage, chacune peut jouer un perso différent.
const seasonOn = () => !!cfg.seasonMode || seasonTab === true;
const SEASON_ONLY_HUNT = 'mode saison : seule la chasse est autorisée (les boss tuent le perso de saison)';
// Perso de saison joué ? Le jeu l'écrit dans les données de chaque page (en-tête : "seasonChar":true|false) : dans les
// scripts du chargement de la page, puis dans les réponses du jeu (navigations, actions) lues par netwatch.js
// (<html data-dm-season-char>), sans requête de plus. L'onglet du pilote publie la valeur de son perso (seasonPilot) :
// l'arrière-plan s'en sert (boss de chasse auto), la popup l'affiche.
let seasonTab = null, seasonScripts;
function seasonDetect() {
  if (seasonScripts === undefined) {   // scripts du chargement : lus une fois (la navigation côté client ne les change pas)
    seasonScripts = null;
    for (const s of document.scripts) {
      const m = s.textContent.match(/seasonChar\\?":(true|false)/);
      if (m) { seasonScripts = m[1] === 'true'; break; }
    }
  }
  const attr = document.documentElement.dataset.dmSeasonChar;
  const on = attr ? attr === 'true' : seasonScripts;
  if (on != null && on !== seasonTab) {
    seasonTab = on;
    let told = null;   // dernier perso annoncé dans cet onglet (sessionStorage : survit aux rechargements du pilote)
    try { told = sessionStorage.getItem('dmSeasonTab'); sessionStorage.setItem('dmSeasonTab', String(on)); } catch { /* bloqué */ }
    if (told !== String(on) && (on || told === 'true')) {
      DM.log(on ? 'perso de saison détecté : mode saison (chasse uniquement)' : 'perso principal : mode saison automatique levé');
      tradeToast(on ? '🛡️ Perso de saison détecté : mode saison activé (chasse uniquement, jamais de boss)'
        : '🛡️ Perso principal : mode saison automatique levé', 'ok');
    }
    renderUi();
  }
  if (isOwner() && seasonTab != null && !!cfg.seasonPilot !== seasonTab) save({ seasonPilot: seasonTab });
  // 2.6.0 – 2.8.1 : la détection cochait la case commune (seasonAuto) → on la décoche, la détection est par onglet
  if (cfg.seasonAuto != null) save({ seasonAuto: null, ...(cfg.seasonAuto ? { seasonMode: false } : {}) });
}
const maxRetries = () => (isHunt() ? (cfg.dropRun?.active ? DROP_MAX_DEFEATS - 1 : cfg.sampleRun?.active ? SAMPLE_MAX_DEFEATS - 1 : cfg.levelRun?.active ? LEVEL_MAX_DEFEATS : cfg.archiRun?.active ? ARCHI_MAX_DEFEATS - 1 : cfg.orbRun?.active ? ORB_MAX_DEFEATS - 1 : Math.max(0, Math.round(+cfg.huntRetries || 0))) : MAX_PATH_RETRIES);
// Fin d'un combat d'Ascension : boutons propres aux étages (« Suivant en auto » / « Réessayer en auto » existent aussi).
const ASC_END = /^(Étage suivant|Réessayer l.étage|Voir l.Ascension)$/;
const ASC_START = /^Affronter l.étage \d+$/;   // bouton de /ascension
const home = () => DM.homePath(cfg);
const onHome = () => (isDim() ? location.pathname === '/guilde/dimension' : isKrala() ? location.pathname === '/guilde' : isArena() ? location.pathname === '/arene' : isAbyss() ? location.pathname === '/abysses' : false)
  || location.pathname + location.search === home()
  || (isAsc() ? location.pathname.startsWith('/ascension') : !isHunt() && !isDim() && !isKrala() && !isArena() && !isAbyss() && location.pathname.startsWith('/aventure'));
// Fin d'un combat de chasse : le jeu affiche le lien « Autres groupes de la zone ».
const huntEnd = () => [...document.querySelectorAll('a')].some((a) => /Autres groupes de la zone/.test(a.textContent));

const groupNumber = (panel) => +(panel?.querySelector('.title')?.textContent.trim().match(/^Groupe\s*(\d+)$/)?.[1] || 0);
// Carte d'un groupe de chasse : « .panel » avant la v2 du site, carte « pageKit…__card » (classe CSS module) depuis.
const GROUP_CARD = '.panel, [class*="__card"]';
const groupCardOf = (el) => el?.closest?.(GROUP_CARD) || null;
// Cartes « Groupe N » de la page (ou d'un document parsé), repérées par leur titre.
const groupCards = (root = document) => [...root.querySelectorAll('.title')]
  .filter((t) => /^Groupe\s*\d+$/.test(t.textContent.trim())).map(groupCardOf).filter((p) => p && groupNumber(p));

// Panneau du groupe visé sur /chasse?zone=… : celui choisi à la main (cfg.huntGroup),
// sinon le plus dur (« Groupe 3 », ou le numéro le plus élevé).
function targetGroup() {
  let best = null, bestN = -1;
  for (const p of groupCards()) {
    const n = groupNumber(p);
    if (cfg.huntGroup && n === cfg.huntGroup) return p;
    if (n > bestN) { best = p; bestN = n; }
  }
  return best;
}

// Composition d'un groupe (noms des monstres, triés) : sert à voir si les groupes ont été renouvelés (~3 min).
const groupMonsters = (panel) => [...panel?.querySelectorAll('li') || []]
  .map((li) => li.querySelector('.font-bold')?.textContent.trim()).filter(Boolean).sort();
// Mémorise le groupe attaqué (cfg.huntTarget) ; comparé avant chaque attaque (groupe renouvelé ?).
const rememberHuntTarget = (panel) => {
  const monsters = groupMonsters(panel);
  if (monsters.length) save({ huntTarget: { zone: cfg.huntZone, group: groupNumber(panel), monsters } });
};

// Choix manuel : quand TU cliques sur « Attaquer » dans une zone de chasse, ce groupe devient la cible du pilote
// (mode chasse). Les clics du pilote (.click()) ne sont pas « isTrusted » : ils ne sont pas pris en compte ici.
document.addEventListener('click', (e) => {
  if (!e.isTrusted || !location.pathname.startsWith('/chasse')) return;
  const b = e.target.closest?.('button');
  if (!b || b.disabled || !/^Attaquer$/.test(b.textContent.trim())) return;
  const zone = +new URLSearchParams(location.search).get('zone');
  const group = groupNumber(groupCardOf(b));
  if (!zone || !group) return;
  const name = document.querySelector('h1')?.textContent.trim() || cfg.huntZoneName;
  const monsters = groupMonsters(groupCardOf(b));
  const o = { mode: 'chasse', huntZone: zone, huntZoneName: name, huntGroup: group, huntTarget: { zone, group, monsters } };
  if (isOwner()) {   // le pilote prend la main : Auto puis relance en boucle
    Object.assign(o, { botFight: true, pauseReason: null });
    lastAutoClick = 0;
    markLaunch();
  }
  save(o);
}, true);

// ---------- Vérification de présence (anti-bot « Es-tu toujours là ? ») ----------
// Pendant le mode Auto, le serveur peut demander de cliquer sur un chiffre affiché.
// La modale : role="dialog" aria-label="Vérification de présence", titre « Es-tu toujours là ? »,
// le chiffre cible dans un <strong class="text-gold">, les options dans des <button> (grille).
const presenceDialog = () =>
  document.querySelector('[role="dialog"][aria-label="Vérification de présence"]') ||
  [...document.querySelectorAll('[role="dialog"]')].find((d) => /Es-tu toujours là/i.test(d.textContent));

async function solvePresence(dlg) {
  const target = dlg.querySelector('strong.text-gold, strong')?.textContent.trim();
  if (!target || !/^\d+$/.test(target)) return false;
  const btn = [...dlg.querySelectorAll('button')]
    .find((b) => !b.disabled && b.offsetParent !== null && b.textContent.trim() === target);
  if (!btn) return false;
  await sleep(700 + Math.random() * 1600);   // petit délai « humain » avant de cliquer
  if (!isOwner() || dlg !== presenceDialog()) return false;  // dialogue fermé entre-temps
  btn.click();
  progress();
  lastAutoClick = Date.now();   // laisse l'animation/combat reprendre sans re-clic Auto immédiat
  presenceAt = Date.now();      // si le combat ne repart pas, l'anti-blocage recharge la page
  // le jeu relance SON Auto une fois la présence confirmée : en Auto par poids, on le coupe (le tour déjà parti se termine)
  if (location.pathname.startsWith('/combat') && cfg.botFight && weightsOn()) {
    for (let i = 0; i < 25; i++) {
      await sleep(200);
      const stop = findBtn(/^Arrêter l.Auto$/);
      if (stop) { stop.click(); DM.log('vérification de présence : Auto du jeu relancé par le jeu → arrêté (Auto par poids)'); break; }
    }
  }
  return true;
}

// ---------- Boss de chasse automatique (dans l'onglet du pilote) ----------
// bossRun.phase 'waiting' : le pilote finit son combat sans relancer, puis passe en 'fighting' : /chasse, « Affronter le
// boss » (section « Boss de zone », un seul essai, 2 énergie), combat joué comme les autres, puis retour à l'activité
// (page d'accueil du mode ; chasse : nouveau choix de groupe si le groupe suivi a été renouvelé entre-temps).
// Pas d'onglet à part (1.63.2 : deux onglets se retrouvaient en combat en même temps).
const loadedAt = Date.now();
const bossFighting = () => cfg.bossRun?.phase === 'fighting';
const bossSection = () => [...document.querySelectorAll('section')].find((s) => /boss de zone/i.test(s.textContent));

async function bossLaunch() {
  progress();
  if (!isOwner()) return;
  if (location.pathname !== '/chasse' || location.search) { location.assign('/chasse'); return; }
  const waited = Date.now() - loadedAt;
  if (cfg.bossRun.clickedAt) {   // déjà cliqué : on attend l'arrivée sur /combat, sinon le lancement a échoué
    if (Date.now() - cfg.bossRun.clickedAt > 30000) return bossDone('lancement sans réponse');
    return;
  }
  const sec = bossSection();
  const btn = sec && [...sec.querySelectorAll('button')].find((b) => b.offsetParent !== null);
  if (!btn) {
    if (waited > 25000) return bossDone(sec && /Arrive dans/.test(sec.textContent) ? 'pas encore là / déjà parti' : 'bouton du boss introuvable');
    return setStatus('Boss de chasse : attente du bouton…');
  }
  if (btn.disabled) {
    if (/Lancement/.test(btn.textContent)) return;
    if (waited > 15000) return bossDone(`indisponible (${btn.textContent.trim()})`);
    return;
  }
  setStatus(`Boss de chasse : ${cfg.bossRun.name || 'boss'} (${btn.textContent.trim()})…`);
  await sleep(launchDelay(800 + Math.random() * 1200));
  if (!bossFighting() || cfg.bossRun.clickedAt || btn.disabled || !isOwner()) return;
  await save({ botFight: true, bossRun: { ...cfg.bossRun, clickedAt: Date.now() } });
  spendEnergy(2);
  lastAutoClick = 0;   // le combat démarre en manuel : le mode Auto sera activé au tick suivant
  markLaunch();
  btn.click();
}

let bossDoneSent = false;
async function bossDone(result) {
  if (bossDoneSent) return;
  bossDoneSent = true;
  setStatus(`Boss : ${result} — reprise de l’activité…`);
  if (cfg.botFight && /^(victoire|défaite)/.test(result)) timeFightEnd();
  await save({ botFight: false, bossReturn: true });   // chasse : groupe suivi revérifié au retour
  await send({ type: 'bossDone', result }).catch(() => {});
  await sleep(humanDelay());
  if (isOwner()) location.assign(home());
}
