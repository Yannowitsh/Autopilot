// Autopilot-DM — content script : optimiseur de build : données (stats, panoplies, bestiaire, forge, fiche perso, HDV).
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.

// ---------- Optimiseur de build : équipement qui maximise les dégâts d'un tour ----------
// Stats d'un build = points de base (fiche perso) + objets (fusion, puis prestige +25 %/niveau + Bouclier de forge, hors PA/PM/PO/invoc.)
// + bonus de panoplie (dofusdb, palier d'indice = nombre d'objets portés − 1, plafonné ; rien sous 2 objets — calé sur
// le panneau « Panoplies » de la fiche). Dégâts d'un tour = meilleure combinaison de K sorts tenant dans les PA
// (formule de la tierlist, cible sans résistances). Recherche locale (emplacement par emplacement + panoplies
// complètes) avec plusieurs départs.
const CHAR_KEYS = { 0: 'pv', 1: 'pa', 10: 'force', 11: 'vitalite', 12: 'sagesse', 13: 'chance', 14: 'agilite', 15: 'intelligence',
  16: 'dommages', 18: 'critique', 19: 'po', 23: 'pm', 25: 'puissance', 26: 'invocations', 27: 'esquivePA', 28: 'esquivePM',
  33: 'resPctTerre', 34: 'resPctFeu', 35: 'resPctEau', 36: 'resPctAir', 37: 'resPctNeutre', 40: 'pods', 44: 'initiative',
  48: 'prospection', 49: 'soins', 50: 'renvoi', 54: 'resTerre', 55: 'resFeu', 56: 'resEau', 57: 'resAir', 58: 'resNeutre',
  78: 'fuite', 79: 'tacle', 82: 'retraitPA', 83: 'retraitPM', 84: 'dommagesPoussee', 85: 'resPoussee', 86: 'dommagesCritiques',
  87: 'resCritiques', 88: 'dommagesTerre', 89: 'dommagesFeu', 90: 'dommagesEau', 91: 'dommagesAir', 92: 'dommagesNeutre',
  120: 'dmgPctDistance', 121: 'resPctDistance', 122: 'dmgPctArmes', 123: 'dmgPctSorts', 124: 'resPctMelee', 125: 'dmgPctMelee' };
const PRESTIGE_GEAR_PCT = 25;
// Cibles particulières (option de l'optimiseur) : % de résistance par élément [Neutre, Terre, Feu, Eau, Air], relevés
// sur l'état de combat (aucune résistance fixe). Kralamoure Géant = boss de guilde (10 tours, on vise le total de dégâts).
const BUILD_TARGETS = { krala: { name: 'Kralamoure Géant', resPct: [20, 20, 20, 30, 20] } };
// Objectifs de l'optimiseur (menu « Objectif ») : dégâts par tour (éventuellement contre une cible à résistances),
// ou une stat à maximiser (stat, valeur value(S), points de caractéristiques à y mettre : points) — les dégâts ne
// servent alors qu'à départager deux builds. Prospection : 100 de base, +1 par 10 de Chance (objets et points), vérifié en jeu.
const BUILD_GOALS = {
  dps: { label: '⚔️ Dégâts par tour' },
  krala: { label: '🐙 Dégâts sur Kralamoure', target: BUILD_TARGETS.krala, turns: 10 },   // combat de 10 tours
  cible: { label: '🎯 Dégâts sur une cible', custom: true },   // résistances et PV saisis (opts.tgt)
  prospection: { label: '💰 Prospection', stat: 'prospection', points: 'chance', also: ['chance'],
    value: (S) => 100 + (S.prospection || 0) + Math.floor((S.chance || 0) / 10) },
  sagesse: { label: '📚 Sagesse', stat: 'sagesse', points: 'sagesse', value: (S) => S.sagesse || 0 },
  asc: { label: '🏔️ Ascension (survie)', asc: true },   // marge de survie contre les boss d'un étage (ascOptimizerData)
};
// Ascension : stats qui comptent pour la survie (en plus des dégâts)
const SURVIVAL_KEYS = ['vitalite', 'pv', 'resPctNeutre', 'resPctTerre', 'resPctFeu', 'resPctEau', 'resPctAir', 'resNeutre', 'resTerre', 'resFeu', 'resEau', 'resAir', ...DMG_RED_KEYS];
const PRESTIGE_EXCLUDED = new Set(['pa', 'pm', 'po', 'invocations', 'paRune', 'paFree']);
const SET_CACHE_KEY = 'dmSetBonuses';
const SET_CACHE_MS = 7 * 24 * 3600 * 1000;
const OFFENSE_KEYS = ['force', 'intelligence', 'chance', 'agilite', 'puissance', 'dommages', 'dommagesNeutre', 'dommagesTerre',
  'dommagesFeu', 'dommagesEau', 'dommagesAir', 'critique', 'dommagesCritiques', 'dmgPctSorts', 'pa', 'po', ...PEN_KEYS];
const BUILD_OPTS_KEY = 'dmBuildOpts';
const SAVE_DECK_FALLBACK = '60aca5c0a9a6852940d3385c5d3ad45fe51092e4ed';   // saveDeck([{ id, f }], indice du deck : 0 = deck 1)
const DECK_TARGET = 2;                                                        // deck 3
const DECK_CARDS = 10;
const DECK_MIN = 7;                                                           // le jeu refuse un deck plus petit
const DECK_DEF = 2;                                                           // cartes de défense conseillées (bouclier + soin)
let saveDeckId = null;
// Liste noire de l'optimiseur : objets (par id, toutes fusions) à ne jamais proposer. cfg.buildBlacklist = { id: nom }
const buildBlacklist = () => cfg.buildBlacklist || {};
// PA de base 6 + PA du Prestige (P1, P4, P7 : +1 chacun) + PA des objets et panoplies (vérifié sur la fiche : P3 → 7, P4 → 8).
// Prestige : P1 +1 PA, P2 +2 PO, P3 +2 PM, P4 +1 PA, P5 +3 PO, P6 +3 PM, P7 +1 PA (cumulés).
const prestigePa = (p) => [1, 4, 7].filter((n) => (p || 0) >= n).length;
const prestigePo = (p) => ((p || 0) >= 2 ? 2 : 0) + ((p || 0) >= 5 ? 3 : 0);
const prestigePm = (p) => ((p || 0) >= 3 ? 2 : 0) + ((p || 0) >= 6 ? 3 : 0);   // esquive totale (1 % par PM)
// Plafond de PA : 12, 13 dès le Prestige 2, 14 au P5, 15 au P8 (patch 2.3).
const paCap = (p) => 12 + [2, 5, 8].filter((n) => (p || 0) >= n).length;
// paFree : PA des objets légendaires, comptés au-delà du plafond ; paRune : Runes d'Action, une seule comptée par personnage
const buildPaOf = (level, prestige = 0) => (S) => Math.min(paCap(prestige), 6 + prestigePa(prestige) + (S.pa || 0) + Math.min(1, S.paRune || 0) - (S.paFree || 0)) + (S.paFree || 0);
const buildPvOf = (level) => (S) => 50 + 5 * level + (S.vitalite || 0) + (S.pv || 0);

// Builds enregistrés (💾 dans l'optimiseur, aussi listés dans la bulle ❤️) : cfg.buildSaves = [{ id, name, who, at, data }].
// data = résultat de l'optimiseur sans fonctions ni bestiaire complet ; c'est une photo : stocks HDV et inventaire ont pu changer.
const BUILD_SAVES_MAX = 20;
const buildSaves = () => cfg.buildSaves || [];
function packBuild(r) {
  const zones = {};
  for (const c of Object.values(r.final)) for (const [, , , , zs] of c?.sources || []) for (const z of zs) if (r.bestiary?.zones[z]) zones[z] = r.bestiary.zones[z];
  const goalKey = Object.keys(BUILD_GOALS).find((k) => BUILD_GOALS[k] === r.goal) || 'dps';
  const { pvOf, paOf, goal, setFx, equipped, ...rest } = r;
  return JSON.parse(JSON.stringify({ ...rest, goalKey, bestiary: r.bestiary ? { count: r.bestiary.count, at: r.bestiary.at, zones } : null },
    (k, v) => (k === 'baseEff' || k === 'realEff' ? undefined : v)));
}
// Dernière recherche de l'optimiseur (par personnage), réaffichée à la réouverture : localStorage, photo comme un build enregistré.
const LAST_BUILD_KEY = 'dmLastBuild';
const lastBuildAll = () => { try { return JSON.parse(localStorage.getItem(LAST_BUILD_KEY) || '{}'); } catch { return {}; } };
const lastBuild = () => lastBuildAll()[myName() || '?'] || null;
function rememberBuild(r) {
  try {
    const all = lastBuildAll();
    all[myName() || '?'] = { at: Date.now(), data: packBuild(r) };
    localStorage.setItem(LAST_BUILD_KEY, JSON.stringify(all));
  } catch (e) { DM.log(`optimiseur : dernière recherche non gardée (${e.message})`); }
}
// Objets à équiper pour passer au build proposé : possédés seulement, de ton niveau ; l'arme d'abord.
const buildEquipChanges = (r) => r.slots.map((s) => ({ s, to: r.final[s.slot], from: r.current[s.slot] }))
  .filter(({ to, from }) => to && !['hdv', 'bank', 'drop'].includes(to.src) && to !== from && !(to.lvl > r.sheet.level))
  .map(({ s, to, from }) => ({ slot: s.slot, label: s.label, from, to }))
  .sort((a, b) => (a.slot === 'arme' ? -1 : b.slot === 'arme' ? 1 : 0));
function unpackBuild(d) {
  const r = { ...d, goal: BUILD_GOALS[d.goalKey] || BUILD_GOALS.dps, pvOf: buildPvOf(d.statLevel || d.sheet.level), paOf: buildPaOf(d.statLevel || d.sheet.level, d.sheet.prestige) };
  r.target = r.goal.target || null;
  // builds enregistrés avant 2.34.0 : ni cartes de défense ni classe (code de deck)
  r.defs ||= []; r.keepCards ||= []; r.keepNames ||= {}; r.breed ??= +lastFight()?.fighters?.p?.breedId || 0;
  // même objet des deux côtés (rien à changer sur l'emplacement) : identité rétablie après le passage en JSON
  for (const s of r.slots) if (r.final[s.slot] && r.final[s.slot].uid === r.current[s.slot]?.uid) r.final[s.slot] = r.current[s.slot];
  return r;
}

// Objets favoris (cœur dans l'optimiseur, bulle ❤️) : cfg.buildFavs = { id: { name, icon, lvl, type, setName } }
const buildFavs = () => cfg.buildFavs || {};
const toggleFav = (c) => {
  const favs = { ...buildFavs() };
  if (favs[c.id]) delete favs[c.id];
  else favs[c.id] = { name: c.name, icon: c.icon || null, lvl: c.lvl ?? null, type: c.type || null, setName: c.setName || null };
  return save({ buildFavs: favs });
};

// Bonus de panoplie par nom (dofusdb, en cache 7 jours) : { nom: [[{k, v}], …] | null }
async function fetchSetBonuses(names) {
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(SET_CACHE_KEY) || '{}'); } catch { /* stockage indisponible */ }
  const now = Date.now();
  const missing = names.filter((n) => !cache[n] || now - cache[n].at > SET_CACHE_MS);
  for (let i = 0; i < missing.length; i += 25) {
    const batch = missing.slice(i, i + 25);
    const q = batch.map((n) => `name.fr[$in][]=${encodeURIComponent(n)}`).join('&');
    const url = `https://api.dofusdb.fr/item-sets?${q}&$limit=50&$select[]=name&$select[]=effects&lang=fr`;
    let r = null;
    for (const wait of [0, 2000, 5000, 10000]) {
      if (wait) await sleep(wait);
      r = await DM.fetchT(url, {}, 20000).catch(() => null);
      if (r?.ok) break;
    }
    if (!r?.ok) throw new Error(`dofusdb : ${r ? `HTTP ${r.status}` : 'injoignable'} (après 4 essais)`);
    const found = {};
    for (const set of (await r.json()).data || []) {
      found[set.name?.fr] = (set.effects || []).map((lvl) => (lvl || []).map((e) => ({ k: CHAR_KEYS[e.characteristic], v: +e.from || 0 })).filter((e) => e.k && e.v));
    }
    for (const n of batch) cache[n] = { at: now, fx: found[n] || null };
  }
  try { localStorage.setItem(SET_CACHE_KEY, JSON.stringify(cache)); } catch { /* idem */ }
  return Object.fromEntries(names.map((n) => [n, cache[n]?.fx || null]));
}
// Points de caractéristiques : coût d'un point selon la valeur déjà investie (paliers de la fiche, ex. Force
// 1 point jusqu'à 100, puis 2, 3, 4 ; Sagesse 3 ; Vitalité 1). Capital = points dépensés + points libres (= 5 × (niveau − 1)).
const POINT_STATS = ['vitalite', 'sagesse', 'force', 'intelligence', 'chance', 'agilite'];
const OFF_POINT_STATS = ['force', 'intelligence', 'chance', 'agilite'];
const DEFAULT_POINT_TIERS = { vitalite: [[0, 1]], sagesse: [[0, 3]] };
const ELEM_POINT_TIERS = [[0, 1], [100, 2], [200, 3], [300, 4]];
const pointCost = (tiers, v) => { let c = tiers[0]?.[1] || 1; for (const [th, k] of tiers) if (v >= th) c = k; return c; };
const spentPoints = (tiers, base) => { let n = 0; for (let v = 0; v < base; v++) n += pointCost(tiers, v); return n; };
// Répartition des points sur la fiche : server actions de /personnage « resetPoints() » (tout remet en libre)
// et « allocatePoints(stat, n) » (n points de stat, coût selon les paliers). Elles renvoient la page re-rendue
// (pas de ligne « 1: »), on y relit pointsFree et la base de chaque stat pour vérifier.
const POINTS_ACTION_FALLBACK = { resetPoints: '004944f9b01c999a6788b5755bcc24bf192bac43ce', allocatePoints: '60dbf9f72590dfc5c79366a0bed9bbbc123e6de0e4' };
const pointsActionIds = {};
async function pointsCall(name, args) {
  for (let attempt = 0; ; attempt++) {
    try {
      if (!pointsActionIds[name]) pointsActionIds[name] = await findAction((await fetchFlight(PERSO_STATS)).chunks, name, POINTS_ACTION_FALLBACK[name]);
      const tree = encodeURIComponent(JSON.stringify(['', { children: ['personnage', { children: ['__PAGE__?{"onglet":"stats"}', {}, null, null, 4096] }, null, null, 4096] }, null, null, 4116]));
      const r = await DM.fetchT(PERSO_STATS, {
        method: 'POST', credentials: 'same-origin',
        headers: { Accept: 'text/x-component', 'Content-Type': 'text/plain;charset=UTF-8', 'Next-Action': pointsActionIds[name], 'Next-Router-State-Tree': tree },
        body: JSON.stringify(args),
      });
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
      let text = await r.text();
      const res = actionResult(text);
      if (res?.error) throw Object.assign(new Error(res.error), { game: true });
      // page re-rendue sans la fiche (autre onglet) : on la relit
      if (!/"pointsFree":\d+/.test(text)) text = (await fetchFlight(PERSO_STATS)).flight;
      const free = text.match(/"pointsFree":(\d+)/);
      const rows = text.match(/"rows":(\[.*?\]),"pointsFree"/);
      if (!free || !rows) throw new Error('Réponse du serveur illisible');
      return { free: +free[1], base: Object.fromEntries(JSON.parse(rows[1]).map((x) => [x.key, +x.base || 0])) };
    } catch (e) {
      if (!e.game) delete pointsActionIds[name];
      if (e.game || attempt >= 2) throw e;
      await sleep(attempt ? 5000 : 2000);
    }
  }
}
// Applique la répartition `target` ({ stat: points }) : réinitialise seulement si une stat doit baisser.
async function applyPoints(target, current, say) {
  let base = { ...current };
  try { base = (await fetchCharSheet()).base; } catch { /* fiche illisible : on part des points connus */ }   // état réel (reprise après erreur)
  if (POINT_STATS.some((k) => (base[k] || 0) > (target[k] || 0))) {
    say('Réinitialisation des points…');
    ({ base } = await pointsCall('resetPoints', []));
  }
  for (const k of POINT_STATS) {
    const n = (target[k] || 0) - (base[k] || 0);
    if (n <= 0) continue;
    say(`${STAT_LABELS[k] || k} : +${n}…`);
    const r = await pointsCall('allocatePoints', [k, n]);
    if ((r.base[k] || 0) !== (target[k] || 0)) throw new Error(`${STAT_LABELS[k] || k} : ${r.base[k] || 0} au lieu de ${target[k]} (points libres : ${r.free})`);
    base = r.base;
    await sleep(300 + Math.random() * 300);
  }
  DM.log(`optimiseur : points répartis ${JSON.stringify(base)}`);
  return base;
}

// Bestiaire (/bestiaire) : tous les objets lootables (stats complètes) et, pour chacun, les monstres qui le lâchent, leurs
// zones et tes chances (prospection comprise, calculées par le jeu ; 0 = « objet bonus de victoire », pas un drop normal),
// plus les Boss du Chemin (onglet boss, HTML rendu seulement : objets lâchés à ~90 %). Copie locale d'un jour.
const BESTIARY_KEY = 'dmBestiary';
const BESTIARY_MS = 24 * 3600 * 1000;
async function fetchBestiary(say) {
  try {
    const c = JSON.parse(localStorage.getItem(BESTIARY_KEY) || 'null');
    if (c?.v === 3 && Date.now() - c.at < BESTIARY_MS) return c;
  } catch { /* copie absente ou illisible */ }
  say?.('Import du bestiaire (copie locale absente ou de plus d’un jour)…');
  const { flight } = await fetchFlight('/bestiaire');
  const { props } = rscProps(flight, (x) => Array.isArray(x.monsters) && Array.isArray(x.items));
  if (!props) throw new Error('Bestiaire illisible');
  // zones : id (le même que /chasse?zone=) → [nom (région), niveau min, niveau max]
  const zones = Object.fromEntries((props.zones || []).map((z) => [z.id, [z.area && z.area !== z.n ? `${z.n} (${z.area})` : z.n, z.min, z.max]]));
  const items = props.items.filter((it) => it?.id).map((it) => ({ id: it.id, n: it.n, lvl: it.lvl, s: it.s, icon: it.icon, r: it.r,
    st: it.st || {}, setName: it.setName || null, two: !!it.w?.twoHanded }));
  const drops = {};   // id objet → [[monstre, niveau min, niveau max, ta chance %, ids de zones, chance de base %]], meilleure chance d'abord
  for (const m of props.monsters) {
    for (const [id, base, mine] of Array.isArray(m.d) ? m.d : []) {
      (drops[id] ||= []).push([m.n, m.lo, m.hi, +mine || 0, m.z || [], +base || 0]);
    }
  }
  for (const id in drops) drops[id].sort((a, b) => b[3] - a[3]);
  // Boss du Chemin : objets (stats lues dans le payload, par nom) et boss qui les lâchent (lus dans le HTML rendu)
  say?.('Import des Boss du Chemin…');
  const bp = await fetchFlight('/bestiaire?onglet=boss');
  const known = new Map(items.map((it) => [it.n, it]));
  const { rows } = rscProps(bp.flight, () => false);
  const walk = (x) => {
    if (x == null || typeof x !== 'object') return;
    if (!Array.isArray(x) && Number.isInteger(x.id) && x.n && x.s && x.st && typeof x.st === 'object' && !known.has(x.n)) {
      const it = { id: x.id, n: x.n, lvl: x.lvl, s: x.s, icon: x.icon, r: x.r, st: x.st, setName: x.setName || null, two: !!x.w?.twoHanded };
      known.set(x.n, it);
      items.push(it);
    }
    for (const k in x) walk(x[k]);
  };
  for (const id in rows) walk(rows[id]);
  const boss = {};   // id objet → [[boss, niveau, étape du Chemin, chance %, zone, vaincu, id de zone de chasse ou null]]
  const zoneByName = new Map((props.zones || []).map((z) => [z.n, z.id]));
  const doc = new DOMParser().parseFromString(bp.html, 'text/html');
  for (const panel of doc.querySelectorAll('main .panel, main [class*="__card"]')) {
    // v2 du site : l'image du boss est dans un <span> (sprite), le bloc nom / zone / étape est le voisin de ce span
    const img = panel.querySelector('img[src*="/img/monsters/"]');
    const head = img?.nextElementSibling || img?.parentElement?.nextElementSibling;
    const lis = panel.querySelectorAll('li');
    if (!head || head.children.length < 3 || !lis.length) continue;
    const [nameEl, zoneEl, stepEl] = head.children;
    const zt = zoneEl.textContent, st = stepEl.textContent;
    const src = [nameEl.textContent.trim(), +(zt.match(/niveau\s*(\d+)/) || [])[1] || 0, +(st.match(/étape\s*(\d+)/) || [])[1] || 0,
      0, zt.replace(/\s*·\s*niveau.*$/, '').trim(), /vaincu/.test(st)];
    src[6] = zoneByName.get(src[4]) ?? null;
    for (const li of lis) {
      const it = known.get(li.querySelector('[title]')?.getAttribute('title'));
      const pct = li.textContent.match(/([\d,.]+)\s*%/);
      if (it) (boss[it.id] ||= []).push(Object.assign([...src], { 3: pct ? +pct[1].replace(',', '.') : 0 }));
    }
  }
  const out = { v: 3, at: Date.now(), items, drops, boss, zones };
  try { localStorage.setItem(BESTIARY_KEY, JSON.stringify(out)); } catch (e) { DM.log(`bestiaire : copie locale impossible (${e.message})`); }
  DM.log(`bestiaire : ${items.length} objets, ${props.monsters.length} monstres importés`);
  return out;
}

// Multiplicateur de l'équipement = 1 + Prestige (+25 % par niveau) + Bouclier de forge (forgeBonusPct du jeu) + Compagnon, appliqué
// aux objets ET aux bonus de panoplie, arrondi objet par objet, hors PA/PM/PO/invocations (ex. P3 + forge niv. 98 :
// 1 + 0,75 + 0,132 = ×1,882, relevé au point près sur la fiche). Contrôlé sur la fiche (bonus des points de
// caractéristiques = Σ arrondi(stat × m) des objets portés et des panoplies actives) ; recalé seulement s'il ne colle pas.
const FORGE = { maxLevel: 200 };
const forgeBonusPct = (lvl) => {   // même calcul que le site depuis le 08/10 : 150^((niv − 1) / 199) % (+150 % au niv. 200), arrondi
  if (!(lvl > 0)) return 0;
  const v = 150 ** ((Math.min(FORGE.maxLevel, lvl) - 1) / (FORGE.maxLevel - 1));
  return v < 10 ? Math.round(100 * v) / 100 : Math.round(10 * v) / 10;
};
// Niveau du Bouclier de forge (/forgemagie, props du ForgeView), relu à chaque recherche ; 0 = pas encore de bouclier.
// Page illisible (site saturé…) : dernier niveau connu (cfg.forgeLevel), signalé dans le journal.
async function fetchForgeLevel() {
  try {
    const { flight } = await fetchFlight('/forgemagie');
    const props = rscProps(flight, (x) => 'orbs' in x && 'leftToday' in x && 'level' in x).props;
    if (!props) throw new Error('niveau introuvable sur /forgemagie');
    const lvl = +props.level || 0;
    if (lvl !== cfg.forgeLevel) save({ forgeLevel: lvl });
    return lvl;
  } catch (e) {
    DM.log(`forgemagie : ${e.message} — dernier niveau connu utilisé (${cfg.forgeLevel ?? 0})`);
    return +cfg.forgeLevel || 0;
  }
}
// Compagnon (patch du 10/10) : +0,2 % de stats d'équipement par niveau (+79,8 % au niv. 400), comme le Prestige et la forge
// (pas les PA/PM/PO/invocations, pas les Abysses). /compagnon, props « initial » : { level, bonusPct… } (bonusPct 1,4 au
// niveau 8). Page illisible : dernière valeur connue (cfg.companionPct).
async function fetchCompanionPct() {
  try {
    const { flight } = await fetchFlight('/compagnon');
    const props = rscProps(flight, (x) => x.initial && 'bonusPct' in x.initial && 'level' in x.initial).props;
    if (!props) throw new Error('bonus introuvable sur /compagnon');
    const pct = +props.initial.bonusPct || 0;
    if (pct !== cfg.companionPct) save({ companionPct: pct });
    return pct;
  } catch (e) {
    DM.log(`compagnon : ${e.message} — dernière valeur connue utilisée (${cfg.companionPct ?? 0} %)`);
    return +cfg.companionPct || 0;
  }
}
function fitGearMult(worn, setFx, sheet, guess) {
  const vals = Object.fromEntries(POINT_STATS.map((k) => [k, []]));
  const sets = {};
  for (const c of worn) {
    for (const k of POINT_STATS) if ((c.eff?.[k] || 0) > 0) vals[k].push(c.eff[k]);
    if (c.setName) sets[c.setName] = (sets[c.setName] || 0) + 1;
  }
  for (const [n, cnt] of Object.entries(sets)) for (const { k, v } of setTier(setFx[n], cnt) || []) if (vals[k] && v > 0) vals[k].push(v);
  const err = (m) => POINT_STATS.reduce((e, k) => e + Math.abs(vals[k].reduce((n, v) => n + Math.round(v * m), 0) - (sheet.bonus[k] || 0)), 0);
  let best = guess, bestErr = err(guess);
  const tol = POINT_STATS.length * 2;
  // la valeur du jeu (prestige + forge) colle : on la garde ; sinon on cherche autour
  if (bestErr > tol) for (let m = 1; m <= guess + 0.5 + 1e-9; m += 0.0005) { const e = err(m); if (e < bestErr) { best = m; bestErr = e; } }
  // écart restant important (parchemins d'arène, objet illisible…) : on garde la valeur du jeu
  const ok = bestErr <= tol;
  DM.log(`optimiseur : multiplicateur d'équipement ${best.toFixed(4)} (jeu ${guess.toFixed(4)}, écart ${bestErr}${ok ? '' : ', rejeté'})`);
  return ok ? best : guess;
}

// dofusdb : effects[i] = bonus avec i + 1 objets portés (effects[0] vide) ; vérifié sur la fiche du jeu
// (Frimanoplie 2/4 → effects[1], sans le +1 PA de effects[2]).
const setTier = (fx, count) => (!fx?.length || count < 2 ? null : fx[Math.min(count - 1, fx.length - 1)]);

// Panoplies de la fiche (/personnage) : le jeu affiche, pour chaque panoplie portée, tous ses paliers (« 2 objets : +1 PA ·
// +30 Force… », « 3 objets… »). Ses tables ne suivent pas toujours dofusdb (palier décalé selon la panoplie) : ce qui est
// lu ici fait foi et est retenu (cfg.setTiers) pour les recherches suivantes.
// → { nom: { count, max, tiers: { n: [{ k, v }] } } } ; libellés inconnus ignorés.
const STAT_BY_LABEL = Object.fromEntries(Object.entries(STAT_LABELS).map(([k, l]) => [l.toLowerCase(), k]));
// le jeu affiche « Pénétration » et « Réduction de dégâts » pour les deux lignes (distance / mêlée), parfois avec « % »
Object.assign(STAT_BY_LABEL, { 'pénétration': 'dmgPctDistance', '% pénétration': 'dmgPctDistance', 'réduction de dégâts': 'resPctDistance',
  '% réduction de dégâts': 'resPctDistance', '% dommages distance': 'dmgPctDistance', '% dommages mêlée': 'dmgPctMelee',
  '% résistance distance': 'resPctDistance', '% résistance mêlée': 'resPctMelee' });
function parseBonusText(text) {
  const out = [];
  for (const part of String(text).split('·')) {
    const m = part.trim().match(/^([+-]?\d+)\s*(%?)\s*(.+)$/);
    if (!m) continue;
    const k = STAT_BY_LABEL[`${m[2] ? '% ' : ''}${m[3].trim()}`.toLowerCase()];
    if (k) out.push({ k, v: +m[1] });
  }
  return out;
}
function parseSheetSets(flight) {
  const rows = {};
  for (const line of flight.split(/\r?\n/)) {
    const m = line.match(/^([0-9a-f]+):([[{].*)$/);
    if (m) { try { rows[m[1]] = JSON.parse(m[2]); } catch { /* ligne partielle */ } }
  }
  const res = (v) => { const m = typeof v === 'string' && v.match(/^\$L?([0-9a-f]+)$/); return m && rows[m[1]] !== undefined ? rows[m[1]] : v; };
  const kids = (el) => { const c = res(Array.isArray(el) && el[0] === '$' ? el[3]?.children : el); return Array.isArray(c) ? c.map(res) : c == null ? [] : [res(c)]; };
  const text = (el) => { el = res(el); if (el == null || typeof el === 'boolean') return ''; if (typeof el !== 'object') return String(el); if (el[0] === '$') return kids(el).map(text).join(''); return Array.isArray(el) ? el.map(text).join('') : ''; };
  const out = {};
  const seen = new Set();
  const walk = (el, depth = 0) => {
    el = res(el);
    if (!el || typeof el !== 'object' || depth > 60 || seen.has(el)) return;
    seen.add(el);
    if (el[0] === '$') {
      const ch = kids(el);
      // en-tête « Nom (n/max) » suivi de la liste des paliers
      const head = ch.find((c) => Array.isArray(c) && c[0] === '$' && /\(\d+\/\d+\)$/.test(text(c).trim()));
      if (head) {
        const m = text(head).trim().match(/^(.+?)\s*\((\d+)\/(\d+)\)$/);
        const tiers = {};
        const lis = [];
        const collect = (x, d = 0) => { x = res(x); if (!x || typeof x !== 'object' || d > 20) return; if (x[0] === '$' && x[1] === 'li') lis.push(x); for (const c of (x[0] === '$' ? kids(x) : Array.isArray(x) ? x : [])) collect(c, d + 1); };
        for (const c of ch) if (c !== head) collect(c);
        for (const li of lis) {
          const t = text(li).trim().match(/^(\d+)\s*objets?[^:]*:\s*(.+)$/);
          if (t) tiers[+t[1]] = parseBonusText(t[2]);
        }
        if (m && Object.keys(tiers).length) out[m[1].trim()] = { count: +m[2], max: +m[3], tiers };
      }
      for (const c of ch) walk(c, depth + 1);
    } else if (Array.isArray(el)) for (const c of el) walk(c, depth + 1);
    else for (const k in el) walk(el[k], depth + 1);
  };
  for (const id in rows) walk(rows[id]);
  return out;
}

// Fiche perso : niveau, prestige, points de base, PV/PA affichés, panoplies actives (texte du jeu).
async function fetchCharSheet() {
  const { flight } = await fetchFlight(PERSO_STATS);
  const { rows } = rscProps(flight, () => false);
  const res = (v) => rscResolve(rows, v);
  const alloc = rscProps(flight, (x) => Array.isArray(x.rows) && x.rows[0]?.key && 'pointsFree' in x).props;
  const info = rscProps(flight, (x) => 'prestige' in x && 'level' in x && 'equipped' in x).props;
  if (!alloc || !info) throw new Error('Fiche personnage illisible');
  const base = {}, bonus = {}, tiers = {};
  for (const r of res(alloc.rows).map(res)) {
    base[r.key] = +r.base || 0; bonus[r.key] = +r.bonus || 0;
    const t = res(r.tiers);
    tiers[r.key] = Array.isArray(t) && t.length ? t.map(res) : DEFAULT_POINT_TIERS[r.key] || ELEM_POINT_TIERS;
  }
  const pointsFree = +alloc.pointsFree || 0;
  const capital = pointsFree + Object.keys(base).reduce((n, k) => n + spentPoints(tiers[k], base[k]), 0);
  // tuiles de la fiche : valeur, puis libellé (« PV », « PA », « % Critique »…)
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tile = (label) => +(flight.match(new RegExp(`"children":"?(-?[\\d.,]+)"?\\}\\],\\["\\$","div",null,\\{"className":"[^"]*","children":"${esc(label)}"\\}`))?.[1]?.replace(',', '.') ?? NaN);
  // panoplies portées : « Nom (n/max) » puis le palier actif (v2 : liste « N objets : … » ; avant : une ligne de texte)
  const sets = [
    ...flight.matchAll(/"children":\["([^"]+)"," \(",(\d+),"\/",(\d+),"\)"\]\}\],\["\$","div",null,\{"className":"text-muted","children":"([^"]*)"\}/g),
    ...flight.matchAll(/"children":\["([^"]+)"," \(",(\d+),"\/",(\d+),"\)"\]\}\],\["\$","ul",null,\{[^{]*"children":\[\["\$","li","\d+",\{"className":"text-parchment","children":\[\["\$","span",null,\{"className":"font-bold","children":"\d+ objets[^"]*"\}\]," :"," ","([^"]*)"/g),
  ].map((m) => ({ name: m[1], count: +m[2], max: +m[3], text: m[4] }));
  const forge = await fetchForgeLevel();
  const companionPct = await fetchCompanionPct();
  // paliers des panoplies portées, tels que le jeu les affiche : retenus pour les recherches suivantes
  try {
    const game = parseSheetSets(flight);
    if (Object.keys(game).length) {
      const known = { ...(cfg.setTiers || {}) };
      for (const [n, s] of Object.entries(game)) known[n] = { max: s.max, tiers: { ...(known[n]?.tiers || {}), ...s.tiers }, at: Date.now() };
      save({ setTiers: known });
    }
  } catch (e) { DM.log(`fiche : panoplies illisibles (${e.message})`); }
  // objets éternels (un par Prestige) : { prestige, n, fusion } — Rayonnant +5 à vie, jamais rabaissés par le tier simulé
  const eternal = (res(info.eternal) || []).map(res).filter((e) => e?.n);
  return { level: +info.level || 1, prestige: +info.prestige || 0, forge, forgePct: forgeBonusPct(forge), companionPct, base, bonus, tiers, pointsFree, capital,
    pv: tile('PV'), pa: tile('PA'), crit: tile('% Critique'), pen: tile('Pénétration'), sets, eternal, ascensionBest: +info.ascensionBest || 0 };
}

// Signature de dégâts d'une carte : par élément, base moyenne cumulée normale (B) et critique (BC), nombre de coups
// (N, pour les résistances fixes) ; F = élément de la 1re ligne de dégâts, qui seule reçoit les Dommages fixes (poids FW).
function spellProfile(card) {
  const B = [0, 0, 0, 0, 0], BC = [0, 0, 0, 0, 0], N = [0, 0, 0, 0, 0];
  let F = null, FW = 0;
  for (const { e, c, el, first } of damageLines(card)) {
    const n = e.k === 'poison' ? Math.max(1, +(e.turns || e.dur) || 1) : 1;
    const w = e.chance != null && +e.chance < 100 ? Math.max(0, +e.chance) / 100 : 1;
    const avg = ((+e.min || 0) + (+(e.max ?? e.min) || 0)) / 2;
    B[el] += w * n * avg;
    BC[el] += w * n * (c ? ((+c.min || 0) + (+(c.max ?? c.min) || 0)) / 2 : avg * CRIT_MULT);
    N[el] += w * n;
    if (first) { F = el; FW = w; }
  }
  return F != null ? { B, BC, N, F, FW, cc: +card.cc || 0, lines: cardLines(card) } : null;
}
// Bonus moyen des sorts à une ligne sur un combat de T tours sans lancer à plusieurs lignes : +50 %, +20 % par tour,
// +150 % au plus (patch d'oct. 2026) ; T = 4 → +80 %, T = 6 → +100 %.
const monoAvg = (T) => { const n = Math.max(1, Math.round(T)); let s = 0; for (let k = 0; k < n; k++) s += monoBonusPct(k); return s / n / 100; };
// Part des dégâts qui passe les % rés. de la cible, par élément, selon la pénétration (0 à PEN_MAX) : table [5][PEN_MAX + 1].
// Cible fixe (% rés. connues) : 1 − penRes(rés.) ; cibles habituelles : moyenne sur les monstres appris (monsterResProfile).
const resTableOf = (resPct) => resPct.map((r) => Array.from({ length: PEN_MAX + 1 }, (_, pen) => 1 - penRes(+r || 0, pen) / 100));
// pénétration du dernier S vu : profileAvg la demande pour chaque sort et chaque élément du même S (optimiseur)
let penMemoS = null, penMemo = 0;
const penRound = (S) => (S === penMemoS ? penMemo : (penMemoS = S, penMemo = Math.round(penOf(S))));
const resPass = (pf, S, el) => (pf.T ? pf.T[el][penRound(S)] : 1);
// Dégâts moyens d'un sort avec ces stats (même formule que spellDamage, en version rapide).
// pf.R (cible à résistances fixes) : retirées à chaque coup, après les % Dommages ; pf.T : % rés. de la cible (resTableOf),
// appliquées ensuite avec la pénétration du build.
function profileAvg(pf, S) {
  const pct = 1 + (S.dmgPctSorts || 0) / 100, spectral = spectralOf(S.po, S['dx:sylvestre']);
  const p = pf.cc > 0 ? Math.min(1, Math.max(0, (pf.cc + (S.critique || 0)) / 100)) : 0;
  let tot = 0;
  for (let el = 0; el < 5; el++) {
    if (!pf.N[el]) continue;
    const m = 1 + ((S[EL_STAT[el]] || 0) + (S.puissance || 0)) / 100;
    let v = (pf.B[el] * (1 - p) + pf.BC[el] * p) * m;
    if (el === pf.F) v += pf.FW * ((S.dommages || 0) + (S[EL_DMG[el]] || 0) + p * (S.dommagesCritiques || 0));
    v *= pct;
    tot += (pf.R ? Math.max(0, v - pf.N[el] * pf.R[el]) : v) * resPass(pf, S, el);
  }
  return tot * spectral;
}
// Tours joués par combat, appris par la victoire estimée (winrate.js) ; 4 sans mesure. Sert au Dofus Pourpre.
const fightTurnsLearned = () => {
  const t = Object.entries(cfg.winModel || {}).filter(([k]) => k.startsWith(`${fightAcct()}|`)).map(([, m]) => +m.turns).filter((x) => x > 0);
  return t.length ? t.reduce((a, b) => a + b, 0) / t.length : 4;
};
// Passifs de Dofus du build (S['dx:clé'] = 1, posé par l'optimiseur) sur les dégâts par tour :
// Pourpre : le 1er sort de dégâts du combat frappe double → + meilleur sort ÷ tours par combat ;
// Turquoise : un critique dans le tour → +1 PA au tour suivant → + P(au moins un critique) × gain d'un PA.
function dofusTurnBonus(turn, spells, S, pa, turns, mono = null) {
  const fx = [];
  let dmg = turn.dmg;
  const vals = turn.valsS === S && turn.vals?.length === spells.length ? turn.vals : spells.map((sp) => profileAvg(sp.pf, S));
  if (S['dx:pourpre']) {
    const g = Math.max(0, ...vals) / Math.max(1, turns);
    dmg += g; fx.push({ k: 'pourpre', g });
  }
  if (S['dx:turquoise'] && turn.used.length) {
    const none = turn.used.reduce((q, { sp }) => q * (1 - (sp.pf.cc > 0 ? Math.min(1, Math.max(0, (sp.pf.cc + (S.critique || 0)) / 100)) : 0)), 1);
    const g = (1 - none) * Math.max(0, bestTurnPA(spells, S, pa + 1, mono, vals).dmg - turn.dmg);
    dmg += g; fx.push({ k: 'turquoise', g });
  }
  return fx.length ? { ...turn, dmg, dofus: fx } : turn;
}
// Meilleur tour sans limite de nombre de sorts (cartes distinctes) dont la somme des PA ≤ pa : sac à dos 0/1.
// mono = { B, base } (bonus des sorts à une ligne) : deux façons de jouer, la meilleure gardée —
// « one » : sorts à une ligne seulement, bonus moyen B sur le combat ; « mix » : un sort à plusieurs lignes par tour
// remet le bonus à zéro, il repart à +50 % (base) au tour suivant → sorts à une ligne ×1,5 (lancés avant), les autres ×1.
// mono.d : bonus de deck (part, 0,25 au plus), additionné par le jeu à celui des sorts à une ligne → leur avantage relatif
// est 1 + B / (1 + d), pas 1 + B.
// vals : dégâts moyens de chaque sort avec S (calculés une fois, partagés par les deux façons de jouer et le Dofus Pourpre).
// Optimiseur : appelé des millions de fois → sac à dos avec une table de choix par sort (pas de copie de listes).
function bestTurnPA(spells, S, pa, mono = null, vals = spells.map((sp) => profileAvg(sp.pf, S))) {
  const plan = (mult) => {
    const dp = new Float64Array(pa + 1), items = [];
    for (let i = 0; i < spells.length; i++) {
      const sp = spells[i], m = mult(sp), v = m && vals[i] * m;
      if (!(v > 0) || sp.ap > pa) continue;
      const take = new Uint8Array(pa + 1);
      for (let a = pa; a >= sp.ap; a--) {
        const nv = dp[a - sp.ap] + v;
        if (nv > dp[a]) { dp[a] = nv; take[a] = 1; }
      }
      items.push({ sp, v, m, take });
    }
    const used = [];
    for (let k = items.length - 1, a = pa; k >= 0; k--) if (items[k].take[a]) { const { sp, v, m } = items[k]; used.push({ sp, v, m }); a -= sp.ap; }
    return { dmg: dp[pa], used: used.reverse(), pa, vals, valsS: S };
  };
  if (!mono) return plan(() => 1);
  const d = 1 + (+mono.d || 0);
  const one = plan((sp) => (sp.pf.lines === 1 ? 1 + mono.B / d : 0));
  const mix = plan((sp) => (sp.pf.lines === 1 ? 1 + mono.base / d : 1));
  return one.dmg >= mix.dmg ? { ...one, mono: 'one', alt: mix.dmg } : { ...mix, mono: 'mix', alt: one.dmg };
}

// ---------- Combat long (Kralamoure : 10 tours) ----------
// Effets offensifs d'une carte : buffs sur toi (stats de dégâts, PA, PO) et % de résistance retirés à la cible
// (« −26 % Résistance (tous éléments) », Proie), avec leur durée en tours (la plus courte des lignes).
const BUFF_KEYS = new Set(OFFENSE_KEYS);
function offenseFx(card) {
  const self = {}, res = [0, 0, 0, 0, 0];
  let dur = Infinity, any = false;
  for (const e of card?.eff || []) {
    if (!e?.stat) continue;
    const v = ((+e.min || 0) + (+(e.max ?? e.min) || 0)) / 2;
    if (!(v > 0)) continue;
    if (e.k === 'buff' && e.tgt === 'self' && BUFF_KEYS.has(e.stat)) self[e.stat] = (self[e.stat] || 0) + v;
    else if (e.k === 'debuff' && e.tgt === 'enemy' && (e.stat === 'resPctAll' || EL_RES_PCT.includes(e.stat))) {
      for (let i = 0; i < 5; i++) if (e.stat === 'resPctAll' || EL_RES_PCT[i] === e.stat) res[i] += v;
    } else continue;
    any = true;
    dur = Math.min(dur, Math.max(1, +e.dur || 1));
  }
  return any ? { self, res, dur } : null;
}
const FX0 = { self: {}, res: [0, 0, 0, 0, 0] };
const fxAdd = (a, b) => {
  const self = { ...a.self };
  for (const k in b.self) self[k] = (self[k] || 0) + b.self[k];
  return { self, res: a.res.map((r, i) => r + b.res[i]) };
};
// Sorts et stats sous ces effets : stats boostées (hors PA, comptés à part) ; table de résistances de la cible refaite
// avec ses % rés. diminués (resPct : % rés. de la cible). cache : Map partagée par appel.
function underFx(spells, S, fx, resPct, cache) {
  const S2 = { ...S };
  for (const k in fx.self) if (k !== 'pa') S2[k] = (S2[k] || 0) + fx.self[k];
  const key = fx.res.join();
  if (!cache.has(key)) {
    const T = resTableOf(resPct.map((r, i) => r - fx.res[i]));
    cache.set(key, spells.map((x) => ({ ...x, pf: { ...x.pf, T } })));
  }
  return { S: S2, spells: cache.get(key) };
}
// Tour avec des effets entretenus déjà choisis (fx, coût en PA par tour) : rapide, sert pendant la recherche.
function fxTurn(spells, S, pa, mono, fx, cost, resPct, cache) {
  const u = underFx(spells, S, fx, resPct, cache);
  const paF = Math.max(0, pa - cost + (fx.self.pa || 0)), lo = Math.floor(paF), f = paF - lo;
  const a = bestTurnPA(u.spells, u.S, lo, mono);
  if (f < 1e-6) return a;
  const b = bestTurnPA(u.spells, u.S, lo + 1, mono);
  return { ...(f >= 0.5 ? b : a), dmg: a.dmg + (b.dmg - a.dmg) * f, pa: paF };
}
// Tour « en régime établi » d'un combat de `turns` tours : chaque buff / debuff utile est entretenu tout le combat.
// Une carte sans dégâts de durée d, relancée tous les d tours, coûte ap ÷ d PA par tour (PA fractionnaires : moyenne
// entre les deux tours entiers voisins). Un sort de dégâts qui porte un buff (Dents du Piranya : +20 Dommages) l'entretient
// gratuitement s'il est joué chaque tour. Cartes gardées choisies une à une tant qu'elles rapportent.
function steadyTurn(spells, utils, S, pa, mono, resPct, turns) {
  const cache = new Map();
  const run = (fx, paF) => {
    const u = underFx(spells, S, fx, resPct, cache);
    paF = Math.max(0, paF + (fx.self.pa || 0));
    const lo = Math.floor(paF), f = paF - lo;
    const a = bestTurnPA(u.spells, u.S, lo, mono);
    if (f < 1e-6) return a;
    const b = bestTurnPA(u.spells, u.S, lo + 1, mono);
    return { ...(f >= 0.5 ? b : a), dmg: a.dmg + (b.dmg - a.dmg) * f, pa: paF };
  };
  let fx = FX0, cost = 0, best = run(FX0, pa);
  const kept = [];
  // buffs des sorts de dégâts du tour : valables seulement si ces sorts restent dans le tour
  for (let i = 0; i < 2; i++) {
    const carriers = best.used.filter((u) => u.sp.fx);
    if (!carriers.length) break;
    const fx2 = carriers.reduce((f, u) => fxAdd(f, u.sp.fx), fx);
    const t = run(fx2, pa - cost);
    if (t.dmg <= best.dmg || !carriers.every((c) => t.used.some((u) => u.sp.id === c.sp.id))) break;
    best = t;
    fx = fx2;
  }
  for (;;) {
    let pick = null;
    for (const u of utils) {
      if (kept.includes(u) || u.ap > pa) continue;
      const c = u.ap / Math.max(1, Math.min(u.fx.dur, turns));
      const t = run(fxAdd(fx, u.fx), pa - cost - c);
      if (t.dmg > (pick ? pick.t.dmg : best.dmg) * 1.0001) pick = { u, t, c };
    }
    if (!pick) break;
    kept.push(pick.u);
    fx = fxAdd(fx, pick.u.fx);
    cost += pick.c;
    best = pick.t;
  }
  return { ...best, utils: kept, fx, cost };
}
// Simulation tour par tour d'un combat de `turns` tours contre une cible unique (Kralamoure), pour le build proposé :
// passif de classe (classTracker : Proie qui monte, Enchaînement…), bonus des sorts à une ligne exact (repart à zéro
// après un sort à plusieurs lignes de dégâts), bonus de deck, buffs / debuffs avec leur durée, Dofus Pourpre (1er sort ×2).
// Chaque tour : le meilleur enchaînement, avec ou sans une carte de buff de plus (sa valeur future comptée sur sa durée).
// Deux façons de jouer essayées (sorts à une ligne seulement / tout), la meilleure gardée. Hypothèses : tes cartes sont
// toujours en main (pas de tirage), PA de base chaque tour, dégâts de l'arme non comptés, cible toujours en vie.
function fightPlan(spells, utils, S, pa, turns, o) {
  const resPct = o.resPct, cache = new Map();
  const one = (policy) => {
    const tr = classTracker(o.breed, Date.now(), { deck: o.deck, bonus: !!o.mono, boost: o.boost });
    let active = [], total = 0, pourpre = !!S['dx:pourpre'];
    const out = [];
    const fxNow = () => active.reduce((f, a) => fxAdd(f, a.fx), FX0);
    const pool = spells.filter((x) => policy === 'mix' || x.pf.lines === 1);
    // enchaînement choisi sous ces effets, avec les multiplicateurs du traqueur en début de tour
    const choose = (fx, paT) => {
      const u = underFx(pool, S, fx, resPct, cache);
      const val = new Map(u.spells.map((x) => [x.id, profileAvg(x.pf, u.S) * tr.mult(x.card, { tgtId: 'cible' })]));
      const dp = new Array(paT + 1).fill(0), sel = Array.from({ length: paT + 1 }, () => []);
      for (const x of u.spells) {
        const v = val.get(x.id);
        if (!(v > 0) || x.ap > paT) continue;
        for (let a = paT; a >= x.ap; a--) if (dp[a - x.ap] + v > dp[a]) { dp[a] = dp[a - x.ap] + v; sel[a] = [...sel[a - x.ap], x]; }
      }
      return { est: dp[paT], used: sel[paT], u };
    };
    // joue l'enchaînement : sorts à une ligne d'abord (le bonus tient), le plus fort en premier (Pourpre) ; buffs posés au fil.
    // Pourpre encore là : on essaie aussi le plus gros sort à plusieurs lignes en premier (doublé, mais les sorts à une ligne
    // qui suivent perdent leur bonus pour le tour) et on garde le meilleur ordre
    const play = (trk, plan, util, fx0) => {
      const order = [...plan.used].sort((a, b) => (a.pf.lines > 1) - (b.pf.lines > 1) || profileAvg(b.pf, S) - profileAvg(a.pf, S));
      const big = pourpre && order.some((x) => x.pf.lines === 1) && order.filter((x) => x.pf.lines > 1).sort((a, b) => profileAvg(b.pf, S) - profileAvg(a.pf, S))[0];
      if (big) {
        const alt = [big, ...order.filter((x) => x !== big)];
        if (playOrder(trk.clone(), alt, util, fx0).dmg > playOrder(trk.clone(), order, util, fx0).dmg) return playOrder(trk, alt, util, fx0);
      }
      return playOrder(trk, order, util, fx0);
    };
    const playOrder = (trk, order, util, fx0) => {
      let dmg = 0, fx = fx0, first = pourpre;
      const on = new Set(active.map((a) => a.id));   // buff déjà actif : relancé, pas cumulé
      const casts = [];
      if (util) { trk.cast(util.card, {}); fx = fxAdd(fx, util.fx); casts.push({ name: util.name, util: true }); }
      for (const x of order) {
        const u = underFx([x], S, fx, resPct, new Map());
        let v = profileAvg(u.spells[0].pf, u.S) * trk.mult(x.card, { tgtId: 'cible' });
        if (first) { v *= 2; first = false; }
        dmg += v;
        casts.push({ name: x.name, v });
        trk.cast(x.card, { tgtId: 'cible' });
        if (x.fx && !on.has(x.id)) { fx = fxAdd(fx, x.fx); on.add(x.id); }
      }
      if (o.weaponMulti && o.weaponCard) trk.cast({ ...o.weaponCard, weapon: true }, { tgtId: 'cible' });   // arme à plusieurs lignes jouée
      return { dmg, casts };
    };
    for (let t = 1; t <= turns; t++) {
      tr.turn();
      active = active.filter((a) => a.left > 0);
      const fx0 = fxNow(), left = turns - t + 1;
      const paT = Math.max(0, Math.round(pa + (fx0.self.pa || 0)));
      // sans carte de buff en plus
      const base = choose(fx0, paT);
      let bestC = { plan: base, util: null, score: play(tr.clone(), base, null, fx0).dmg };
      for (const ut of utils) {
        if (ut.ap > paT || active.some((a) => a.id === ut.id)) continue;   // encore actif : relancé à son expiration
        const fx1 = fxAdd(fx0, ut.fx), paU = paT - ut.ap + (ut.fx.self.pa || 0);
        const plan = choose(fx1, Math.max(0, paU));
        const now = play(tr.clone(), plan, ut, fx0).dmg;
        // valeur future : gain d'un tour plein avec ce buff, sur ses tours restants
        const gain = Math.max(0, choose(fx1, paT + (ut.fx.self.pa || 0)).est - base.est) * (Math.min(ut.fx.dur, left) - 1);
        if (now + gain > bestC.score) bestC = { plan, util: ut, score: now + gain };
      }
      const r = play(tr, bestC.plan, bestC.util, fx0);
      pourpre = false;
      if (bestC.util) active.push({ id: bestC.util.id, fx: bestC.util.fx, left: bestC.util.fx.dur });
      for (const x of bestC.plan.used) if (x.fx) { active = active.filter((a) => a.id !== x.id); active.push({ id: x.id, fx: x.fx, left: x.fx.dur }); }
      active.forEach((a) => { a.left--; });
      total += r.dmg;
      out.push({ t, dmg: r.dmg, casts: r.casts });
    }
    return { total, turns: out, policy };
  };
  const a = one('one');
  if (!o.mono) return a;
  const b = one('mix');
  return a.total >= b.total ? a : b;
}

async function fetchHdvGear(types, level, failed = []) {
  const out = [];
  for (const type of types) {
    let flight;
    try {
      ({ flight } = await fetchFlight(`/hdv?emplacement=${encodeURIComponent(type)}`));
    } catch (e) {
      failed.push(type);   // déjà réessayé plusieurs fois : on continue sans cet emplacement
      DM.log(`optimiseur : HDV ${type} illisible (${e.message})`);
      continue;
    }
    const { rows, props } = rscProps(flight, (x) => Array.isArray(x.listings));
    for (const raw of props ? rscResolve(rows, props.listings) || [] : []) {
      const l = rscResolve(rows, raw), it = rscResolve(rows, l?.item);
      if (!it?.id || l.mine || (it.lvl || 0) > level) continue;
      out.push({ id: it.id, name: it.n, lvl: it.lvl, type: it.s, rarity: it.r, icon: it.icon, fusion: +l.fusion || 0,
        setName: it.setName || null, two: !!rscResolve(rows, it.w)?.twoHanded, eff: fusedStats(rscResolve(rows, it.st), it.s, +l.fusion || 0),
        baseEff: rscResolve(rows, it.st) || {}, src: 'hdv', price: +l.price || 0, listingId: l.id, seller: l.seller });
    }
    await sleep(250);
  }
  // une seule annonce par objet (id + fusion) : la moins chère
  const best = new Map();
  for (const c of out) { const k = `${c.id}|${c.fusion}`; if (!best.has(k) || best.get(k).price > c.price) best.set(k, c); }
  return [...best.values()];
}

// Compte « banque » (onglet de l'autre contexte) : ses objets non portés, avec stats (fusion comprise, sans prestige :
// celui du personnage qui les portera s'applique), en excluant les exemplaires liés (achetés / reçus il y a < 24 h).
async function peerGear() {
  try {
    const [state, sell] = await Promise.all([fetchEquipState(), fetchSellable({ tradable: true })]);
    const now = Date.now();
    const free = new Map();   // id|fusion → exemplaires échangeables
    for (const e of sell.entries) {
      if (e.boundUntil && new Date(e.boundUntil) > now) continue;
      const k = `${e.id}|${e.fusion || 0}`;
      free.set(k, (free.get(k) || 0) + (+e.qty || 0));
    }
    const entries = state.entries.filter((e) => free.get(`${e.id}|${e.fusion || 0}`) > 0)
      .map((e) => ({ id: e.id, name: e.name, lvl: e.lvl, type: e.type, rarity: e.rarity, icon: e.icon, fusion: e.fusion,
        setName: e.setName, two: e.two, eff: e.eff, baseEff: e.baseEff, ...(e.runes ? { runes: e.runes } : {}) }));
    return { ok: true, name: myName(), entries, bound: state.entries.length - entries.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
