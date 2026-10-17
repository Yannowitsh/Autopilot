// Autopilot-DM — content script : tierlist des sorts + test du calcul.
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.

// ---------- Tierlist des sorts : dégâts des cartes de la collection (/deck) ----------
// /deck contient toute la collection (DeckBuilder : collection[{ key, card:{ id, n, ap, icon, r, eff[] } }],
// initialFavorites[ids]). Effets de dégâts = liste du site : dmg, steal, bomb, trap, detonate, poison ;
// dmgCasterHp / dmgLostHp dépendent de la vie (« variables », non classés).
// Toutes les lignes d'un sort sont appliquées (vérifié dans les journaux de combat : Drain Élémentaire, Tromperie…
// frappent une fois par élément) → on les additionne. Exception : les lignes avec « chance » (x % de chance,
// ex. Topkaj) sont des tirages au sort exclusifs : moyenne pondérée par la chance, min 0, max = la plus forte.
// Favori natif : server action « setFavoriteCard(idCarte, bool) » sur /deck.
const FAV_ACTION_FALLBACK = '60105c931c92cff568c1e6ff395e809d4eb30addf9';
const ELEMENTS = [
  { name: 'Neutre', color: '#a8a29e' }, { name: 'Terre', color: '#a16207' }, { name: 'Feu', color: '#ef4444' },
  { name: 'Eau', color: '#3b82f6' }, { name: 'Air', color: '#22c55e' },
];
const DMG_FIXED = new Set(['dmg', 'steal', 'bomb', 'trap', 'detonate', 'poison']);
const DMG_VARIABLE = new Set(['dmgCasterHp', 'dmgLostHp']);
const SPELL_FILTERS_KEY = 'dmSpellFilters';
// Dégâts réels (option « Avec mes stats ») — formule vérifiée coup par coup sur les combats enregistrés (129/129, 2 builds) :
// chaque ligne : base × (1 + (stat de l'élément + Puissance) / 100), base tirée à part pour chaque ligne ;
// + Dommages + Dommages <élément de la ligne> (+ Dommages Critiques si critique) UNE fois par lancer, sur la 1re ligne de dégâts ;
// le tout × (1 + % Dommages aux sorts) (non vérifié). Neutre et Terre = Force, Feu = Intelligence, Eau = Chance, Air = Agilité.
// Critique : chance de la carte + % Critique (seulement si la carte peut critiquer) ; le coup utilise les lignes critiques
// de la carte (champ `crit` de l'état de combat, appris en combat : /deck ne les donne pas), sinon base × CRIT_MULT.
// Les buffs de stats (Runification, Drain Élémentaire…) s'ajoutent aux stats pendant leur durée. Zone : les autres cibles
// prennent les mêmes dégâts. Vision spectrale : 0,4 % par point de PO qu'un sort de dégâts frappe deux fois (en moyenne).
const EL_STAT = ['force', 'force', 'intelligence', 'chance', 'agilite'];
const EL_DMG = ['dommagesNeutre', 'dommagesTerre', 'dommagesFeu', 'dommagesEau', 'dommagesAir'];
const CRIT_MULT = 1.2;   // repli seulement (lignes critiques inconnues) : de +5 à ×1,6 selon la carte
// Lignes critiques des cartes, apprises dans les états de combat : { idCarte: [lignes] } (localStorage de la page).
const CARD_CRIT_KEY = 'dmCardCrit';
let cardCritCache = null;
const cardCrits = () => {
  if (!cardCritCache) { try { cardCritCache = JSON.parse(localStorage.getItem(CARD_CRIT_KEY) || '{}'); } catch { cardCritCache = {}; } }
  return cardCritCache;
};
// Avec les lignes critiques : la somme des lignes normales vues au même combat (« #id »), car le jeu y applique le
// Prestige de classe (classCardBoost) : les critiques apprises suivent le rapport entre cette somme et la carte simulée.
const effSum = (eff) => (eff || []).reduce((t, e) => t + (e && CLASS_MAIN_K.test(e.k || '') ? Math.abs(+e.min || 0) + Math.abs(+e.max || 0) : 0), 0);
function learnCardCrits(st) {
  const p = st?.fighters?.p;
  if (!p) return;
  const known = cardCrits();
  let changed = false;
  for (const c of [...Object.values(p.cards || {}), p.weaponCard]) {
    if (!c?.id || !Array.isArray(c.crit) || (JSON.stringify(known[c.id]) === JSON.stringify(c.crit) && known[`#${c.id}`] === effSum(c.eff))) continue;
    known[c.id] = c.crit;
    known[`#${c.id}`] = effSum(c.eff);
    changed = true;
  }
  if (changed) { try { localStorage.setItem(CARD_CRIT_KEY, JSON.stringify(known)); } catch { /* stockage plein */ } }
}
// Soins des cartes, appris en combat : { idCarte: { r: soin moyen / PV max, n } }. Le texte des cartes ne suffit pas
// (Évolution « 53 % » rend ~25 % des PV max ; Runification 6 % des PV max) — on mesure les « heal » qui suivent le lancer.
// Passif de classe annoncé dans le journal (t: 'passive', who: 'p') : « Mots 5/5 : +20 % de dégâts, +25 % de soins. »
// Il monte au fil du combat ; le dernier annoncé s'applique. → { dmg: %, heal: % }
const passiveOf = (L) => ({ dmg: +(L?.text || '').match(/\+(\d+(?:[.,]\d+)?) ?% de dégâts/)?.[1]?.replace(',', '.') || 0,
  heal: +(L?.text || '').match(/\+(\d+(?:[.,]\d+)?) ?% de soins/)?.[1]?.replace(',', '.') || 0 });
const lastPassive = (log) => { const L = (log || []).filter((x) => x.t === 'passive' && x.who === 'p').at(-1); return L ? passiveOf(L) : { dmg: 0, heal: 0 }; };
const CARD_HEAL_KEY = 'dmCardHeal';
let cardHealCache = null;
const cardHeals = () => {
  if (!cardHealCache) { try { cardHealCache = JSON.parse(localStorage.getItem(CARD_HEAL_KEY) || '{}'); } catch { cardHealCache = {}; } }
  return cardHealCache;
};
const healSeen = new Set();   // lancers déjà comptés (le même journal revient à chaque état)
function learnCardHeals(st) {
  const p = st?.fighters?.p, log = st?.log;
  if (!p || !Array.isArray(log) || !(+p.maxHp)) return;
  const byName = new Map(Object.values(p.cards || {}).map((c) => [c.name, c]));
  const known = cardHeals();
  const base = (+st.logCount || log.length) - log.length;
  let changed = false;
  for (let i = 0; i < log.length; i++) {
    const L = log[i];
    if (L.t !== 'play' || L.who !== 'p') continue;
    const c = byName.get(L.card);
    // seulement les soins « propres » (pas les vols de vie, qui dépendent des dégâts)
    if (!c?.id || !(c.eff || []).some((e) => e?.tgt === 'self' && /heal/i.test(e.k)) || (c.eff || []).some((e) => e?.k === 'steal')) continue;
    const key = `${c.id}|${base + i}|${p.maxHp}`;
    if (healSeen.has(key)) continue;
    let sum = 0, done = false;
    for (let j = i + 1; j < log.length; j++) {
      const D = log[j];
      if (['play', 'turn', 'round'].includes(D.t)) { done = true; break; }
      if (D.t === 'heal' && D.who === 'p') sum += +D.v || 0;
    }
    if (!done || !sum) continue;   // lancer pas terminé dans ce journal, ou soin nul (PV pleins / malédiction)
    healSeen.add(key);
    const k = known[c.id] || { r: 0, n: 0 };
    k.r = (k.r * k.n + sum / p.maxHp) / (k.n + 1); k.n = Math.min(20, k.n + 1);
    known[c.id] = k;
    changed = true;
  }
  if (changed) { try { localStorage.setItem(CARD_HEAL_KEY, JSON.stringify(known)); } catch { /* stockage plein */ } }
}
const critLinesOf = (card) => {
  if (Array.isArray(card?.crit)) return card.crit;
  const known = cardCrits(), crit = known[card?.id], seen = known[`#${card?.id}`], now = effSum(card?.eff);
  if (!Array.isArray(crit) || !seen || !now || Math.abs(now / seen - 1) < 0.01) return crit || null;
  const k = now / seen;   // carte simulée à un autre Prestige que le combat où la critique a été vue
  return crit.map((e) => (e && CLASS_MAIN_K.test(e.k || '') ? { ...e, min: Math.round(e.min * k), max: Math.round(e.max * k) } : e));
};
// Élément « best » (armes…) : celui de la meilleure caractéristique (Terre, Feu, Eau, Air) ; statOf(clé) → valeur.
const bestEl = (statOf) => (statOf ? [1, 2, 3, 4].reduce((b, el) => (statOf(EL_STAT[el]) > statOf(EL_STAT[b]) ? el : b), 1) : 0);
// Lignes de dégâts d'une carte : { e: ligne normale, c: ligne critique (même rang dans `crit`) ou null, el, first }.
// Bonus fixes (Dommages…) une fois par lancer, sur la 1re ligne de dégâts — même si plusieurs lignes ont le même élément.
// Arme : sur chaque ligne (Arc Volkorne, 4 éléments, vérifié 2026-10-09).
function damageLines(card, statOf = null) {
  const crit = critLinesOf(card);
  const pair = Array.isArray(crit) && crit.length === (card.eff || []).length;
  const out = [];
  (card.eff || []).forEach((e, i) => {
    if (!e || !DMG_FIXED.has(e.k)) return;
    const c = pair && crit[i]?.k === e.k ? crit[i] : null;
    out.push({ e, c, el: e.el === 'best' ? bestEl(statOf) : Number.isInteger(e.el) ? e.el : 0, first: !!card.weapon || !out.length });
  });
  return out;
}
const SPECTRAL_PER_PO = 0.4;
// Vision spectrale moyenne : 0,4 % par point de PO de frapper ×2 (×2,25 avec le Dofus Sylvestre)
const spectralOf = (po, sylv) => 1 + (+po || 0) * SPECTRAL_PER_PO / 100 * (sylv ? DOFUS_FX.sylvestre - 1 : 1);
// % de dommages du lancer : % Sorts pour un sort, % Armes pour l'arme (l'arme ne profite pas du % Sorts, vérifié 2026-10-09)
const dmgPctOf = (card, S) => 1 + S(card?.weapon ? 'dmgPctArmes' : 'dmgPctSorts') / 100;
const PA_VALUE_PCT = 3;   // optimiseur : 1 PA = +3 % de l'objectif (voir score)
const CHAR_STATS_KEY = 'dmCharStats';
const LAST_FIGHT_KEY = 'dmLastFight';   // dernier état de combat reçu, par personnage (localStorage de la page)
const fightAcct = () => myName() || (chrome.extension?.inIncognitoContext ? 'privé' : 'normal');
// netwatch.js transmet chaque état de combat reçu : on garde le dernier qui contient des coups du joueur.
window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.type !== 'dm-fight' || typeof e.data.line !== 'string') return;
  try {
    const obj = JSON.parse(e.data.line);
    const st = withFullLog(obj.state);
    learnCardCrits(st);
    learnCardHeals(st);
    if (obj.rewards && st?.status && st.status !== 'ongoing') { dropOnRewards(obj.rewards, `${st.kind}|${st.logCount}`); farmOnRewards(st, obj.rewards); }
    if (st?.status && st.status !== 'ongoing') combatOnEnd(st, obj.rewards);
    // type du combat affiché (Dimension, Faille du Kralamoure, arène) : « Continuer » (playContext) en a besoin sur /combat
    if (st?.fighters) try { sessionStorage.setItem('dmFightKind', JSON.stringify({ dimension: !!st.dimension, faille: !!st.faille, pvp: st.kind === 'pvp', abyss: st.kind === 'abyss', at: Date.now() })); } catch { /* rien */ }
    saveLastFight(st);
  } catch { /* état illisible ou stockage plein */ }
});
// Dernier combat où le joueur a joué une carte : reçu par la page (netwatch) ou joué par l'auto par poids (weights.js)
function saveLastFight(st) {
  try {
    if (!st?.fighters?.p?.stats || !st.log?.some((L) => L.t === 'play' && L.who === 'p')) return;
    const fighters = Object.fromEntries(Object.entries(st.fighters).map(([id, f]) => [id,
      { id, name: f.name, kind: f.kind, team: f.team, level: f.level, maxHp: f.maxHp, stats: f.stats, resCap: f.resCap, buffs: f.buffs,
        ...(id === 'p' ? { cards: f.cards, weaponCard: f.weaponCard, basePa: f.basePa, breedId: f.breedId, pasBoost: f.pasBoost } : {}) }]));
    const all = JSON.parse(localStorage.getItem(LAST_FIGHT_KEY) || '{}');
    all[fightAcct()] = { at: Date.now(), kind: st.kind, status: st.status, fighters, log: st.log, logFrom: st.logFrom || 0 };
    localStorage.setItem(LAST_FIGHT_KEY, JSON.stringify(all));
  } catch { /* stockage plein */ }
}
const lastFight = () => { try { return JSON.parse(localStorage.getItem(LAST_FIGHT_KEY) || '{}')[fightAcct()] || null; } catch { return null; } };
// Cibles toutes faites (cible de l'optimiseur) : boss connus et ennemis du dernier combat capturé.
// { clé: { name, rp: % rés. [Neutre, Terre, Feu, Eau, Air] (plafonnés par le resCap du monstre), rf: rés. fixes, pv: PV max } }
function targetPresets() {
  const out = Object.fromEntries(Object.entries(BUILD_TARGETS).map(([k, t]) => [k, { name: t.name, rp: [...t.resPct], rf: [0, 0, 0, 0, 0], pv: 0 }]));
  const fight = lastFight();
  for (const f of Object.values(fight?.fighters || {})) {
    if (f.id === 'p' || f.team === fight.fighters.p?.team) continue;
    const st = f.stats || {};
    out[`f:${f.name}`] = { name: `${f.name}${f.level ? ` (niv. ${f.level})` : ''} — combat de ${DM.hhmm(fight.at)}`, pv: +f.maxHp || 0,
      rp: EL_RES_PCT.map((k) => Math.min(+f.resCap || 100, (+st[k] || 0) + (+st.resPctAll || 0))), rf: EL_RES.map((k) => +st[k] || 0) };
  }
  return out;
}

// ---------- Résistances des monstres combattus (pénétration) ----------
// À chaque lancement de combat (dm-fight-init) : % rés. de base [Neutre, Terre, Feu, Eau, Air] de chaque ennemi, par
// « nom|niveau », avec le nombre de rencontres (cfg.monsterRes = { clé: [rN, rT, rF, rE, rA, n, boss, vu le] }, 1 500 au plus).
// Sert à estimer ce que la pénétration rapporte sur TES cibles habituelles (optimiseur, cible par défaut).
const MONSTER_RES_MAX = 1500;
function learnMonsterRes(st) {
  const P = st?.fighters?.p;
  if (!P) return;
  const all = { ...(cfg.monsterRes || {}) };
  let changed = false;
  for (const f of Object.values(st.fighters)) {
    if (f.id === 'p' || f.team === P.team || !f.name || !f.stats) continue;
    const k = `${f.name}|${+f.level || 0}`, old = all[k];
    all[k] = [...EL_RES_PCT.map((r) => Math.min(+f.resCap || 100, (+f.stats[r] || 0) + (+f.stats.resPctAll || 0))), (old?.[5] || 0) + 1, f.isBoss ? 1 : 0, Date.now()];
    changed = true;
  }
  if (!changed) return;
  const keys = Object.keys(all);
  if (keys.length > MONSTER_RES_MAX) keys.sort((a, b) => all[a][7] - all[b][7]).slice(0, keys.length - MONSTER_RES_MAX).forEach((k) => delete all[k]);
  save({ monsterRes: all });
}
window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.type !== 'dm-fight-init' || typeof e.data.json !== 'string') return;
  try { learnMonsterRes(rscDeep({}, JSON.parse(e.data.json))); } catch { /* état illisible */ }
});
// Cibles habituelles : multiplicateur moyen de dégâts par élément selon la pénétration, sur les monstres appris autour
// du niveau `lvl` (−25 / +10 ; tous s'il y en a moins de 15), pondérés par le nombre de rencontres.
// → { n, lo, hi, avg: % rés. moyennes [5], mult: [5][0..PEN_MAX] (1 − % rés. après pénétration) } ou null (< 5 monstres).
function monsterResProfile(lvl = 0) {
  let list = Object.entries(cfg.monsterRes || {}).map(([k, v]) => ({ lvl: +k.split('|').pop() || 0, r: v.slice(0, 5), n: v[5] || 1 }));
  const near = list.filter((m) => !lvl || (m.lvl >= lvl - 25 && m.lvl <= lvl + 10));
  if (near.length >= 15) list = near;
  if (list.length < 5) return null;
  const W = list.reduce((t, m) => t + m.n, 0);
  const avg = [0, 1, 2, 3, 4].map((el) => list.reduce((t, m) => t + m.r[el] * m.n, 0) / W);
  const mult = [0, 1, 2, 3, 4].map((el) => Array.from({ length: PEN_MAX + 1 }, (_, pen) => list.reduce((t, m) => t + (1 - penRes(m.r[el], pen) / 100) * m.n, 0) / W));
  return { n: list.length, fights: W, lo: Math.min(...list.map((m) => m.lvl)), hi: Math.max(...list.map((m) => m.lvl)), avg, mult };
}
let favActionId = null;

// Dégâts d'une carte : total min / max / moyen, détail par élément, zone ou cible unique.
// `stats` (caractéristiques du personnage) : dégâts estimés avec ses bonus, critique et vision spectrale compris.
function spellDamage(card, stats = null) {
  const S = (k) => +stats?.[k] || 0;
  const pct = dmgPctOf(card, S);
  const critP = stats && +card.cc > 0 ? Math.min(1, Math.max(0, (+card.cc + S('critique')) / 100)) : 0;
  // valeur d'un coup de base `v` (normal) / `vc` (critique) dans l'élément `el` : [normal, critique] ;
  // Dommages (+ élément, + critiques) seulement sur la 1re ligne de dégâts du sort
  const hitVal = (v, vc, el, first) => {
    if (!stats) return [v, v];
    const mult = 1 + (S(EL_STAT[el]) + S('puissance')) / 100, fixed = first ? S('dommages') + S(EL_DMG[el]) : 0;
    return [(v * mult + fixed) * pct, (vc * mult + fixed + (first ? S('dommagesCritiques') : 0)) * pct];
  };
  let min = 0, max = 0, zone = false, fixed = false, random = false;
  const variable = (card.eff || []).some((e) => DMG_VARIABLE.has(e?.k));
  let delayed = false, rndAvg = 0, rndMax = 0, sure = 0;
  const byEl = {};
  for (const { e, c, el, first } of damageLines(card, stats ? S : null)) {
    fixed = true;
    const n = e.k === 'poison' ? Math.max(1, +(e.turns || e.dur) || 1) : 1;   // poison : dégâts à chaque tour
    const eMin = +e.min || 0, eMax = +(e.max ?? e.min) || 0;
    const cMin = c ? +c.min || 0 : eMin * CRIT_MULT, cMax = c ? +(c.max ?? c.min) || 0 : eMax * CRIT_MULT;
    const [loN, loC] = hitVal(eMin, cMin, el, first), [hiN, hiC] = hitVal(eMax, cMax, el, first);
    // min = sans critique, max = critique ; moyenne pondérée par la chance de critique
    const lo = loN * n, hi = (critP ? hiC : hiN) * n;
    const mid = ((1 - critP) * (loN + hiN) / 2 + critP * (loC + hiC) / 2) * n;
    const p = e.chance != null && +e.chance < 100 ? Math.max(0, +e.chance) / 100 : 1;
    if (p < 1) {   // ligne à x % de chance
      random = true;
      rndAvg += p * mid;
      rndMax = Math.max(rndMax, hi);
      byEl[el] = (byEl[el] || 0) + p * mid;
    } else {
      min += lo; max += hi; sure += mid;
      byEl[el] = (byEl[el] || 0) + mid;
    }
    if (e.zone || e.k === 'bomb' || e.k === 'detonate') zone = true;   // bombes : explosion en zone
    if (e.k === 'bomb' || e.k === 'trap' || e.k === 'poison') delayed = true;
  }
  if (!fixed) return null;
  const spectral = stats ? spectralOf(S('po'), wornDofus().has('sylvestre')) : 1;   // 2e frappe possible (moyenne seulement)
  const avg = (sure + rndAvg) * spectral;
  const r = (v) => Math.round(v);
  for (const k in byEl) byEl[k] *= spectral;
  return { min: r(min), max: r(max + rndMax), avg: Math.round(avg * 10) / 10, byEl, zone, variable, delayed, random, critP };
}

const DEF_KINDS = new Set(['shieldHp', 'shieldLvl', 'heal', 'healPct']);

// Code de deck du jeu (/deck, « Copier le code » / « Importer un code ») : octets [2, classe, nombre, ids…] en varint,
// base 32 (Crockford), puis somme de contrôle FNV-1a 32 bits sur [83, …octets] (20 bits hauts, 4 caractères). Ex. :
// DM-S-080GHWVAV7M03MB4X1NF8RW3DBB6DDK5-Q6A0 = Féca (1), 8 cartes. 30 cartes au plus, sans doublon.
function deckCode(breed, ids) {
  const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const uniq = [...new Set(ids.map((x) => Math.floor(+x)).filter((x) => Number.isInteger(x) && x > 0 && x < 0x7fffffff))].slice(0, 30);
  const bytes = [2];
  const v = (n) => { let x = Math.max(0, Math.floor(n)); for (; x >= 128; x = Math.floor(x / 128)) bytes.push((x % 128) | 128); bytes.push(x); };
  v(breed); v(uniq.length); uniq.forEach(v);
  let out = '', acc = 0, bits = 0;
  for (const b of bytes) { acc = (acc << 8) | (b & 255); bits += 8; while (bits >= 5) { out += A[(acc >>> (bits - 5)) & 31]; bits -= 5; } acc &= (1 << bits) - 1; }
  if (bits > 0) out += A[(acc << (5 - bits)) & 31];
  let h = 0x811c9dc5;
  for (const b of [83, ...bytes]) { h ^= b; h = Math.imul(h, 0x1000193) >>> 0; }
  const q = h >>> 12;
  let chk = '';
  for (let i = 3; i >= 0; i--) chk += A[(q >>> (5 * i)) & 31];
  return `DM-S-${out}-${chk}`;
}

// who : { prestige } (fiche perso) ; sans lui, celui du dernier combat (pasBoost = 5 % par Prestige depuis la V3).
// Les sorts de la classe du personnage (breedId de /deck) reçoivent le Prestige de classe (classCardBoost).
async function fetchSpells(who = {}) {
  const { flight, chunks } = await fetchFlight('/deck');
  const { rows, props } = rscProps(flight, (x) => Array.isArray(x.collection) && 'initialDecks' in x);
  if (!props) throw new Error('Collection de sorts introuvable sur /deck');
  const res = (v) => rscResolve(rows, v);
  const lf = lastFight(), breed = +res(props.breedId) || +lf?.fighters?.p?.breedId || 0;
  const prestige = who.prestige ?? (lf?.at >= PASSIVES_V3_SINCE && lf?.kind !== 'abyss' ? Math.round((+lf.fighters?.p?.pasBoost || 0) / 5) : 0);
  const spells = [], variableOnly = [], utils = [], defs = [];
  for (const raw of props.collection) {
    const ent = res(raw) || {};
    const raw0 = res(ent.card);
    if (!raw0?.id) continue;
    const card = classCardBoost({ ...raw0, eff: (res(raw0.eff) || []).map(res) }, breed, prestige);
    const eff = card.eff;
    const dmg = spellDamage({ ...card, eff, crit: critLinesOf(card) });
    if (!dmg) {
      if (eff.some((e) => DMG_VARIABLE.has(e?.k))) variableOnly.push(card.n);
      // cartes sans dégâts qui boostent tes dégâts (buff sur toi, % rés. en moins sur la cible) : combat long (optimiseur)
      else if (typeof offenseFx === 'function' && offenseFx({ eff })) utils.push({ id: card.id, usable: ent.usable !== false, name: card.n, ap: +card.ap || 0, card: { ...card, eff } });
      // cartes de défense (bouclier, soin sur soi) : proposées dans le deck conseillé de l'optimiseur
      if (eff.some((e) => e?.tgt === 'self' && DEF_KINDS.has(e.k))) defs.push({ id: card.id, usable: ent.usable !== false, name: card.n, ap: +card.ap || 0, card: { ...card, eff } });
      continue;
    }
    const ap = +card.ap || 0;
    spells.push({ id: card.id, key: ent.key, usable: ent.usable !== false, name: card.n, desc: card.d || '', icon: card.icon, ap, rarity: card.r,
      fusion: +card.f || 0, card: { ...card, eff, crit: critLinesOf(card) }, ...dmg, perAp: ap ? dmg.avg / ap : Infinity });
  }
  const favs = new Set((res(props.initialFavorites) || []).map(Number));
  const decks = res(props.initialDecks) || [];
  const deckIds = (i) => (res(decks[i]) || []).map((k) => +String(k).split(':')[0]);
  const activeDeck = new Set(deckIds(+res(props.initialActive) || 0));
  return { spells, utils, defs, favs, variableOnly, chunks, activeDeck, deckIds, breed, deckSize: +res(props.deckSize) || 0 };
}

// Caractéristiques du personnage : l'état de combat (/combat, combattant « p ») contient ses stats totales
// (équipement, points, prestige). Mémorisées par personnage pour quand aucun combat n'est disponible.
async function fetchCharStats() {
  const lf = lastFight();
  if (lf?.fighters?.p?.stats) return { stats: lf.fighters.p.stats, at: lf.at, level: lf.fighters.p.level };
  const acct = fightAcct();
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(CHAR_STATS_KEY) || '{}')[acct] || null; } catch { /* stockage indisponible */ }
  try {
    const { flight } = await fetchFlight('/combat');
    const { rows, props } = rscProps(flight, (x) => x.id === 'p' && x.kind === 'player' && x.stats && typeof x.stats === 'object');
    const stats = props && rscResolve(rows, props.stats);
    if (stats && typeof stats === 'object') {
      const out = { stats, at: Date.now(), level: props.level };
      try {
        const all = JSON.parse(localStorage.getItem(CHAR_STATS_KEY) || '{}');
        all[acct] = out;
        localStorage.setItem(CHAR_STATS_KEY, JSON.stringify(all));
      } catch { /* idem */ }
      return out;
    }
  } catch { /* pas de combat lisible : dernière lecture */ }
  return saved;
}

async function setFavorite(id, on, chunks) {
  if (!favActionId) favActionId = await findAction(chunks || (await fetchFlight('/deck')).chunks, 'setFavoriteCard', FAV_ACTION_FALLBACK);
  try {
    await callAction('deck', favActionId, [id, on]);
  } catch (e) {
    if (!e.game) favActionId = null;   // ID peut-être périmé : relu au prochain essai
    throw e;
  }
}

// ---------- Test du calcul : coups réels du dernier combat vs estimation ----------
// Pour chaque carte jouée : les lignes de dégâts qui suivent dans le journal (jusqu'à la carte / au tour suivant),
// appariées dans l'ordre aux lignes de la carte du même élément (lignes critiques si le coup est critique).
// Observé = v + absorbé (bouclier). Stats = stats du combat + buffs du joueur encore actifs (journal « buff », durée en tours).
// Estimation « sans rés. » = formule de la tierlist ; « avec rés. » = (x − rés. fixe) × (1 − % rés.) de la cible, % rés.
// diminuée de la pénétration du joueur (penRes).
// Zone : les autres cibles touchées prennent les mêmes dégâts (vérifié sur les combats enregistrés).
// Zone : la cible visée prend 100 %, les autres cibles d'une ligne de zone 60 % (vérifié sur des centaines de coups de
// Traversée) ; une ligne normale reportée sur un autre ennemi (cible morte) frappe à 100 %.
const ZONE_FALLOFF = 0.6;
const EL_RES_PCT = ['resPctNeutre', 'resPctTerre', 'resPctFeu', 'resPctEau', 'resPctAir'];
const EL_RES = ['resNeutre', 'resTerre', 'resFeu', 'resEau', 'resAir'];
// Pénétration (jeu, oct. 2026) : lignes « % Dommages distance » + « % Dommages mêlée » des objets, malus ignorés, 50 points
// au plus ; chaque point ignore 0,8 % de résistance élémentaire EN % de la cible (pas les fixes), jamais sous 0 : une
// faiblesse (résistance négative) reste entière. Réduction de dégâts : « % Résistance distance » + « % Résistance mêlée »,
// −1 % des dégâts subis par point avant les résistances, 50 % au plus. Prestige / forge / Discord : ×3 au plus sur ces lignes.
// S : fonction (stat → valeur) ou objet de stats.
const PEN_PER_POINT = 0.8, PEN_MAX = 50, DMG_RED_MAX = 50, CAPPED_GEAR_MULT = 3;
const PEN_KEYS = ['dmgPctDistance', 'dmgPctMelee'], DMG_RED_KEYS = ['resPctDistance', 'resPctMelee'];
const CAPPED_KEYS = new Set([...PEN_KEYS, ...DMG_RED_KEYS]);
const statGet = (S) => (typeof S === 'function' ? S : (k) => +S?.[k] || 0);
const penOf = (S) => { const g = statGet(S); return Math.min(PEN_MAX, PEN_KEYS.reduce((t, k) => t + Math.max(0, +g(k) || 0), 0)); };
const dmgRedOf = (S) => { const g = statGet(S); return Math.min(DMG_RED_MAX, DMG_RED_KEYS.reduce((t, k) => t + Math.max(0, +g(k) || 0), 0)) / 100; };
const penRes = (rp, pen) => (rp > 0 && pen > 0 ? Math.max(0, rp - pen * PEN_PER_POINT) : rp);
// Esquive totale : chaque PM (les 3 de base compris) donne 1 % d'esquiver entièrement un coup ennemi, 50 % au plus.
const DODGE_BASE_PM = 3, DODGE_MAX = 50;
const dodgeOf = (S, cap = DODGE_MAX) => Math.min(cap, DODGE_BASE_PM + Math.max(0, statGet(S)('pm'))) / 100;
// Passifs de Dofus (jeu : dofusPassiveOf, par id d'objet, vérifié sur le coffre de Dofus au choix, oct. 2026) :
// pourpre : 1er sort de dégâts du combat ×2 (pas l'arme) ; turquoise : un critique → +1 PA au tour suivant (1 fois par
// tour) ; ebene : Perforation ×1,3 (plafond 32,5 %) ; glaces : −10 % sur la frappe de la cible ; ivoire : aucun coup
// ordinaire ne retire plus de 35 % des PV max ; emeraude : survit une fois à 20 % des PV max ; vulbis : +2 % d'esquive par
// coup reçu non esquivé (75 % au plus) ; ocre : 1 carte de plus en main ; tachete : 1er contrôle du tour ignoré ;
// kaliptus : butin des boss ; mystere : « effet mystère » (Dofawa).
// Patch d'oct. 2026 : sylvestre : vision spectrale ×2,25 au lieu de ×2 ; argente : bouclier de 8 % des PV max au début ;
// jyfus : une fois sous 30 % des PV, soin de 10 % ; cauchemar : −15 % de dégâts reçus les 2 premiers tours ; dolmanax :
// +10 % de dégâts dans un élément (état du combat : fighters.p.dolEl ; Eau ×1,100 pile sur Tromperie, combats du 13/10) ;
// les autres (Cawotte, Dokille, Veilleurs, Dotruche, Domakuro, Dorigami, Dofoozbz, Forgelave, Cacao, Pin) ne sont pas calculés.
const DOFUS_PASSIVES = { 737: 'emeraude', 694: 'pourpre', 739: 'turquoise', 7754: 'ocre', 6980: 'vulbis', 7115: 'ivoire', 7043: 'glaces',
  7114: 'ebene', 8072: 'kaliptus', 7113: 'mystere', 7112: 'tachete', 30356: 'jyfus', 20833: 'cacao', 20987: 'cacao', 972: 'cawotte',
  10907: 'dokille', 13344: 'dolmanax', 16061: 'veilleurs', 15235: 'dotruche', 23237: 'domakuro', 23408: 'dorigami', 31794: 'dofoozbz',
  19398: 'forgelave', 20286: 'argente', 26066: 'cauchemar', 27803: 'pin', 29136: 'sylvestre' };
const DOFUS_FX = { ebenePerfo: 1.3, ivoireCap: 0.35, glaces: 0.1, emeraude: 0.2, vulbisStep: 2, vulbisCap: 75, sylvestre: 2.25, argente: 0.08,
  jyfus: 0.1, cauchemar: 0.15, cauchemarTurns: 2, dolmanax: 1.1 };
// Dofus portés par ce personnage, lus avec l'inventaire (fetchEquipState) : cfg.wornDofus = { perso: { k: [passifs], at } }
const wornDofus = () => new Set(cfg.wornDofus?.[fightAcct()]?.k || []);
function rememberWornDofus(slots) {
  const k = slots.filter((s) => s.cur && DOFUS_PASSIVES[s.cur.id]).map((s) => DOFUS_PASSIVES[s.cur.id]).sort();
  const old = cfg.wornDofus?.[fightAcct()];
  if (old && old.k.join() === k.join() && Date.now() - old.at < 3600000) return;
  save({ wornDofus: { ...(cfg.wornDofus || {}), [fightAcct()]: { k, at: Date.now() } } });
}
function damageTest(fight, spells) {
  const P = fight.fighters.p, stats = P.stats;
  // début du journal perdu (le serveur n'en renvoie que 150 entrées) : les buffs posés avant sont inconnus
  const partial = (+fight.logFrom || 0) > 0 || (+fight.logCount || 0) > (fight.log?.length || 0);
  const buffs = [], seen = new Set();   // seen : entrées « buff » déjà comptées (journal parcouru deux fois)
  // un buff relancé pendant qu'il dure est rafraîchi, pas cumulé (une entrée par sort dans fighters.buffs) : même stat et
  // même valeur → on remplace
  const addBuff = (k, B) => {
    if (seen.has(k) || B.who !== 'p' || !B.stat) return;
    seen.add(k);
    const v = +B.v || 0, old = buffs.findIndex((b) => b.stat === B.stat && b.v === v);
    if (old >= 0) buffs.splice(old, 1);
    buffs.push({ stat: B.stat, v, from: pTurn, turns: +B.turns || 1 });
  };
  // malus posés sur les ennemis (Proie de l'Ouginak : « buff » resPctAll −20 sur la cible, 3 tours) : { id: [{ stat, v, left }] },
  // décomptés aux tours de l'ennemi ; relancé pendant qu'il dure, il est rafraîchi (pas cumulé)
  const foeBuffs = {};
  const addFoeBuff = (k, B) => {
    if (seen.has(k) || B.who === 'p' || !B.stat || fight.fighters[B.who]?.team === P.team) return;
    seen.add(k);
    const v = +B.v || 0, list = (foeBuffs[B.who] ||= []);
    const old = list.findIndex((b) => b.stat === B.stat && b.v === v);
    if (old >= 0) list.splice(old, 1);
    list.push({ stat: B.stat, v, left: +B.turns || 1 });
  };
  const foeStat = (id, k) => (foeBuffs[id] || []).reduce((s, b) => s + (b.stat === k ? b.v : 0), 0);
  let pTurn = 0;
  const S = (k) => (+stats[k] || 0) + buffs.reduce((s, b) => s + (b.stat === k && pTurn < b.from + b.turns ? b.v : 0), 0);
  // passif de classe (classes.js) rejoué au fil du journal ; PV des combattants suivis (Sram, Sacrieur…)
  const tr = classTracker(fight.kind === 'abyss' ? null : P.breedId, +fight.at || Date.now(), spellBonusOpt(fight));   // Abysses : pas de passif de classe
  const hpNow = Object.fromEntries(Object.values(fight.fighters).map((f) => [f.id, +f.maxHp || 0]));
  let castMult = 1;
  let card = null;
  const pourpre = wornDofus().has('pourpre'), sylvestre = wornDofus().has('sylvestre');   // Dofus Sylvestre : vision ×2,25
  let firstSpellDone = false;
  const pct = () => dmgPctOf(card, S) * castMult;
  // cartes de l'état de combat (lignes critiques comprises), sinon celles de la collection
  const byName = new Map(spells.map((sp) => [sp.name, sp.card]));
  for (const c of [...Object.values(P.cards || {}), P.weaponCard]) if (c?.name) byName.set(c.name, { ...byName.get(c.name), ...c, n: c.name });
  const rows = [];
  const log = fight.log;
  const refl = reflectTracker();   // Reflet : élément renvoyé par chaque boss, tour par tour
  for (let i = 0; i < log.length; i++) {
    const L = log[i];
    refl.line(L);
    if (L.t === 'turn' && L.who === 'p') pTurn++;
    if (L.t === 'buff') { addBuff(i, L); addFoeBuff(i, L); }
    if (L.t === 'turn' && foeBuffs[L.who]) foeBuffs[L.who] = foeBuffs[L.who].filter((b) => --b.left > 0);
    if (L.t === 'turn' && L.who === 'p') tr.turn();
    if (L.t === 'passive' && L.who === 'p') tr.passiveLog(L.text);
    if (L.t === 'dmg' && L.who in hpNow) hpNow[L.who] -= +L.v || 0;
    if (L.t === 'heal' && L.who in hpNow) hpNow[L.who] = Math.min(+fight.fighters[L.who]?.maxHp || Infinity, hpNow[L.who] + (+L.v || 0));
    if (L.t !== 'play' || L.who !== 'p') continue;
    card = byName.get(L.card) || null;
    const pct0 = (id) => hpNow[id] / Math.max(1, +fight.fighters[id]?.maxHp || 1);
    // passif de classe : propre à chaque cible touchée (Proie : seulement contre la proie) → état d'avant le lancer, par coup
    const castTr = tr.clone(), castCtx = { tgtPct: pct0(L.target), selfPct: pct0('p') };
    let castExtra = 1;
    castMult = card ? castTr.mult(card, { tgtId: L.target, ...castCtx }) : 1;
    // vision spectrale déclenchée : « Vision spectrale ! Bluff inflige le double de dégâts. » juste après le lancer
    // (souvent après la ligne de passif « … a plusieurs lignes de dégâts » : on cherche jusqu'au premier coup)
    for (let j = i + 1; j < log.length && !['play', 'turn', 'round', 'dmg'].includes(log[j].t); j++) {
      if (log[j].t === 'mechanic' && log[j].who === 'p' && /Vision spectrale/.test(log[j].text || '')) { castExtra *= sylvestre ? DOFUS_FX.sylvestre : 2; break; }
    }
    if (card) tr.cast(card, { tgtId: L.target });
    // Dofus Pourpre : le 1er sort de dégâts du combat (pas l'arme) frappe double — début du journal connu seulement
    if (card && !card.weapon && damageLines(card, S).length && !firstSpellDone) {
      firstSpellDone = true;
      if (pourpre && !partial) castExtra *= 2;
    }
    // Portail : son « buff » dmgPctSorts du journal n'en est pas un (compté par le traqueur sur la carte suivante)
    if (card && empowerOf(card)) for (let j = i + 1; j < log.length && !['play', 'turn', 'round'].includes(log[j].t); j++) if (log[j].t === 'buff' && log[j].stat === 'dmgPctSorts') seen.add(j);
    const lines = card ? damageLines(card, S).filter(({ e }) => !(e.chance != null && +e.chance < 100)) : [];
    const used = new Set();
    // cible principale : celle visée ; si elle meurt, l'ennemi touché par une ligne suivante devient la cible principale
    let primary = L.target, primaryDead = false, killLine = -1, lastLine = -1;
    for (let j = i + 1; j < log.length && !['play', 'turn', 'round'].includes(log[j].t); j++) {
      const D = log[j];
      if (D.t === 'buff') { addBuff(j, D); addFoeBuff(j, D); }   // vol de stats, malus posé par le sort
      if (D.t === 'death' && D.who === primary) { primaryDead = true; killLine = lastLine; }
      if (D.t !== 'dmg') continue;
      const tg = fight.fighters[D.who];
      if (!tg || tg.team === P.team) continue;   // coups sur soi / les alliés (zones) ignorés
      castMult = (card ? castTr.mult(card, { tgtId: D.who, ...castCtx, tgtPct: pct0(D.who) }) : 1) * castExtra;
      // une ligne normale frappe une fois ; une ligne de zone, une fois par cible
      const li = lines.findIndex((x, k) => !used.has(k) && !used.has(`${k}|${D.who}`) && x.el === D.el);
      if (li >= 0) used.add(lines[li].e.zone ? `${li}|${D.who}` : li);
      if (primaryDead && li !== killLine && D.who !== primary) { primary = D.who; primaryDead = false; }
      lastLine = li;
      const ln = lines[li];
      const crit = !!(D.crit ?? L.crit);
      const fatal = log[j + 1]?.t === 'death' && log[j + 1].who === D.who;
      const secondary = !!primary && D.who !== primary;   // autre cible touchée par une ligne de zone
      const buffed = S(EL_STAT[D.el]) - (+stats[EL_STAT[D.el]] || 0) + S('puissance') - (+stats.puissance || 0);
      const src = ln && (crit ? ln.c : ln.e);
      const row = { card: L.card, ap: card?.ap, target: tg.name, el: D.el, v: (+D.v || 0) + (+D.absorbed || 0), crit, fatal, buffed,
        secondary, pos: li >= 0 ? `${li + 1}/${lines.length}` : null, base: src ? `${src.min}-${src.max ?? src.min}${crit ? ' (crit)' : ''}`
          : ln ? `${ln.e.min}-${ln.e.max ?? ln.e.min} ×${CRIT_MULT} (crit inconnu)` : null };
      // élément renvoyé (Reflet) ou immunisé (Élément mouvant), boss sous ses Gardiens (coup à 0) : pas d'estimation
      if (refl.cur.get(D.who) === D.el || refl.imm.get(D.who) === D.el || (!(+D.v) && !(+D.absorbed) && affixOf(tg, 'guardians'))) row.reflected = true;
      // Seuil de douleur : coup plafonné à x % de ses PV max → pas d'estimation
      else if (affixOf(tg, 'threshold') && row.v >= (+tg.maxHp || 0) * (+affixOf(tg, 'threshold').pct || 0) / 100 * 0.97) row.reflected = true;
      else if (ln) {
        const e = ln.e, n = e.k === 'poison' ? Math.max(1, +(e.turns || e.dur) || 1) : 1;
        const mult = 1 + (S(EL_STAT[D.el]) + S('puissance')) / 100;
        const fixed = ln.first ? S('dommages') + S(EL_DMG[D.el]) + (crit ? S('dommagesCritiques') : 0) : 0;
        const b = (x) => (crit ? (ln.c ? +x || 0 : (+x || 0) * CRIT_MULT) : +x || 0);
        const val = (x) => (b(x) * mult + fixed) * pct();
        const s2 = crit && ln.c ? ln.c : e;
        const zf = secondary && e.zone ? ZONE_FALLOFF : 1;   // zone : les autres cibles prennent 60 %
        // Lien d'âme : tant que son porteur est debout, les autres boss subissent x % de dégâts en moins
        const bond = Object.values(fight.fighters).find((f) => f.id !== D.who && affixOf(f, 'soulbond') && hpNow[f.id] > 0 && tg.isBoss);
        const bf = bond ? 1 - (+affixOf(bond, 'soulbond').guard || 0) / 100 : 1;
        const df = +P.dolEl && D.el === +P.dolEl ? DOFUS_FX.dolmanax : 1;   // Dofus Dolmanax : son élément
        row.lo = val(s2.min) * n * zf * bf * df; row.hi = val(s2.max ?? s2.min) * n * zf * bf * df;
        if (crit && !ln.c) row.critGuess = true;   // ligne critique inconnue (arme…) : ×1,25 supposé, pas une mesure
        const rp = penRes(Math.min(+tg.resCap || 100, (+tg.stats?.[EL_RES_PCT[D.el]] || 0) + (+tg.stats?.resPctAll || 0)
          + foeStat(D.who, EL_RES_PCT[D.el]) + foeStat(D.who, 'resPctAll')), penOf(S));
        const rf = (+tg.stats?.[EL_RES[D.el]] || 0) + foeStat(D.who, EL_RES[D.el]);
        const adj = (x) => Math.max(0, (x - rf) * (1 - rp / 100));
        row.rp = rp; row.rf = rf; row.loR = adj(row.lo); row.hiR = adj(row.hi);
        row.ratio = row.v / ((row.loR + row.hiR) / 2 || 1);
      }
      rows.push(row);
    }
  }
  // détails bruts pour l'analyse : cartes jouées (lignes complètes) et buffs du journal / des combattants
  const played = [...new Set(log.filter((L) => L.t === 'play' && L.who === 'p').map((L) => L.card))];
  const cards = played.map((n) => [n, byName.get(n)]).filter(([, c]) => c)
    .map(([n, c]) => `${n} : ${c.ap} PA, cc ${c.cc ?? 0} % — ${JSON.stringify((c.eff || []).filter((e) => DMG_FIXED.has(e.k) || DMG_VARIABLE.has(e.k)))}`);
  const buffLog = log.filter((L) => L.t === 'buff').map((L) => JSON.stringify(L));
  const fbuffs = Object.values(fight.fighters).filter((f) => f.buffs && (!Array.isArray(f.buffs) || f.buffs.length)).map((f) => `${f.name} : ${JSON.stringify(f.buffs)}`);
  return { rows, stats, cards, buffs: buffLog, fbuffs, partial };
}

function openDamageTest(spells) {
  document.querySelector('.dm-dtest')?.remove();
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const ov = document.createElement('div');
  ov.className = 'dm-dtest dm-picker';
  ov.style.cssText = 'position:fixed;inset:0;z-index:2147483601;background:#000c;display:grid;justify-items:center;align-items:start;padding:4vh 16px 16px;font:13px system-ui,sans-serif;color:#eee';
  const close = () => ov.remove();
  ov.addEventListener('click', (e) => { if (e.target === ov || e.target.closest('[data-a="close"]')) close(); });
  ov.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') close(); });
  const btn = 'border:1px solid #5a4a33;border-radius:8px;padding:5px 10px;color:#fff;cursor:pointer;font:600 12px system-ui,sans-serif;background:#2a231a';
  const fight = lastFight();
  const box = (html) => `<div style="width:min(900px,100%);max-height:90vh;display:flex;flex-direction:column;gap:8px;background:#1d1812;border:1px solid #5a4a33;border-radius:14px;padding:14px;box-shadow:0 10px 40px #000">${html}</div>`;
  if (!fight) {
    ov.innerHTML = box(`<div style="display:flex;gap:8px;align-items:center"><b style="flex:1">🧪 Test du calcul</b><button data-a="close" style="${btn}">✕</button></div>
      <div>Aucun combat capturé pour ce personnage. Fais un combat (Auto ou manuel) dans un onglet du jeu avec l’extension active, puis rouvre ce test.</div>`);
    document.body.appendChild(ov);
    return;
  }
  const { rows, stats, cards, buffs, fbuffs, partial } = damageTest(fight, spells);
  const EL = (el) => ELEMENTS[el]?.name || '?';
  const r1 = (x) => Math.round(x);
  const statLine = Object.entries(stats).filter(([, v]) => +v).map(([k, v]) => `${k} ${v}`).join(', ');
  const text = [
    `Test calcul dégâts — combat ${fight.kind || ''} du ${new Date(fight.at).toLocaleString('fr-FR')} (${fight.status || ''})`,
    `Stats : ${statLine}`,
    ...rows.map((r) => `${r.card} (${r.ap ?? '?'} PA) → ${r.target} : ${r.v} ${EL(r.el)}${r.crit ? ' CRIT' : ''}${r.secondary ? ' [zone]' : ''}${r.fatal ? ' (coup fatal)' : ''}${r.buffed ? ` [buff +${r.buffed}]` : ''}`
      + (r.pos ? ` | ligne ${r.pos} base ${r.base}` : '') + (r.lo != null ? ` | estimé ${r1(r.lo)}-${r1(r.hi)} sans rés. | ${r1(r.loR)}-${r1(r.hiR)} avec rés. (${r.rp} %, ${r.rf} fixe) | ratio ${r.ratio.toFixed(2)}` : ` | ${card(r)}`)),
    '', 'Cartes jouées (lignes de dégâts) :', ...cards,
    '', `Buffs du journal : ${buffs.length ? '' : 'aucun'}`, ...buffs,
    ...(fbuffs.length ? ['Buffs des combattants (fin de combat) :', ...fbuffs] : []),
  ].join('\n');
  const okRows = rows.filter((r) => r.lo != null && !r.fatal);
  function card(r) { return r.ap == null ? 'arme ou carte hors collection : non gérée' : 'ligne de la carte introuvable'; }
  const inRange = okRows.filter((r) => r.v >= Math.floor(r.loR) - 1 && r.v <= Math.ceil(r.hiR) + 1).length;
  ov.innerHTML = box(`
    <div style="display:flex;gap:8px;align-items:center"><b style="flex:1;font-size:15px">🧪 Test du calcul — dernier combat (${esc(new Date(fight.at).toLocaleString('fr-FR'))})</b>
      <button data-a="copy" style="${btn};background:#2e6fbf">📋 Copier le récap</button><button data-a="close" style="${btn}">✕</button></div>
    <div style="color:#b9a98c;font-size:12px">Stats du combat : ${esc(statLine) || 'aucun bonus'}</div>
    ${partial ? '<div style="font-size:12px;color:#f0a040">⚠️ Début du combat absent du journal (le serveur n’en garde que 150 entrées) : des buffs posés avant ont pu être manqués, les écarts sont possibles.</div>' : ''}
    <div style="font-size:12px">${okRows.length ? `<b>${inRange} / ${okRows.length}</b> coups dans la fourchette estimée (hors coups fatals, plafonnés par la vie restante).` : 'Aucun coup comparable.'}</div>
    <div style="overflow:auto">
      <table style="border-collapse:collapse;width:100%;font-size:12px">
        <tr style="color:#b9a98c;text-align:left"><th>Sort</th><th>Cible</th><th>Élément</th><th style="text-align:right">Observé</th><th style="text-align:right">Estimé sans rés.</th><th style="text-align:right">Avec rés. cible</th><th style="text-align:right">Ratio</th></tr>
        ${rows.map((r) => {
          const ok = r.lo != null && r.v >= Math.floor(r.loR) - 1 && r.v <= Math.ceil(r.hiR) + 1;
          const col = r.lo == null || r.fatal ? '#b9a98c' : ok ? '#6fcf7a' : '#ff7b6b';
          return `<tr style="border-top:1px solid #3a3024">
            <td>${esc(r.card)}${r.crit ? ' <b style="color:#f0c04a">CRIT</b>' : ''}${r.secondary ? ' <span title="Autre cible touchée par la zone">[zone]</span>' : ''}${r.buffed ? ` <span title="Buffs de stats actifs pendant ce coup (Runification, Drain…), comptés dans l'estimation">[buff +${r.buffed}]</span>` : ''}${r.lo == null ? ` <span style="color:#8a7d66">(${esc(card(r))})</span>` : ''}</td>
            <td>${esc(r.target)}${r.fatal ? ' ☠' : ''}</td>
            <td style="color:${ELEMENTS[r.el]?.color || '#888'}">${EL(r.el)}</td>
            <td style="text-align:right;font-weight:700;color:${col}">${r.v}</td>
            <td style="text-align:right">${r.lo != null ? `${r1(r.lo)} – ${r1(r.hi)}` : '—'}</td>
            <td style="text-align:right">${r.lo != null ? `${r1(r.loR)} – ${r1(r.hiR)} <span style="color:#8a7d66">(${r.rp} %)</span>` : '—'}</td>
            <td style="text-align:right">${r.ratio != null ? r.ratio.toFixed(2) : '—'}</td></tr>`;
        }).join('') || '<tr><td colspan="7" style="padding:10px;color:#b9a98c">Aucun coup de sort dans ce combat.</td></tr>'}
      </table>
    </div>
    <div style="color:#8a7d66;font-size:11px">Vert = dans la fourchette, rouge = hors fourchette, gris = non comparable (coup fatal ☠ plafonné par la vie, ligne inconnue). « Copier le récap » puis colle-le moi.</div>`);
  ov.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a="copy"]');
    if (!b) return;
    try { await navigator.clipboard.writeText(text); b.textContent = '✔ Copié'; } catch { b.textContent = '❌ Copie impossible'; }
  });
  document.body.appendChild(ov);
}
