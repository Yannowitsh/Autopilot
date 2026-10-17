// Autopilot-DM — content script : passifs de classe (bonus de dégâts, soins, dégâts subis) selon la classe du joueur.
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.
//
// La classe vient de l'état du combat (fighters.p.breedId) : chaque joueur (toi, ton ami) a la sienne. La page /personnage
// liste toutes les classes avec leur passif (props « classes » : { id, n, passive: { name, desc } }) ; on y relit les
// textes une fois par jour et l'auto-diagnostic signale tout changement (les chiffres ci-dessous seraient à revoir).
// Un « traqueur » rejoue le combat (journal) et donne, pour chaque sort lancé, le multiplicateur de dégâts du passif ;
// le même traqueur sert au test du calcul, au plan du tour (Ascension) et, en moyenne, à l'optimiseur.
// Si le jeu annonce lui-même son passif dans le journal (t: 'passive', « Mots 3/5 : +12 % de dégâts »), sa valeur prime.
const CLASSES_KEY = 'dmClasses3';   // 3 : textes de la V3 du 13/10 (évite de signaler chaque classe comme modifiée)
// sort de soin / bouclier : vérifié sur les annonces « Mots » (Vertu, Fermentation, Évolution, Mot Interdit) ; les vols de
// vie (Tromperie, Runification, Drain Élémentaire) n'en sont pas, même avec une ligne de soin
const isHealShield = (c) => (c.eff || []).some((e) => e?.tgt === 'self' && /heal|shield/i.test(e.k || '')) && !(c.eff || []).some((e) => e?.k === 'steal');
const PASSIVES_SINCE = Date.parse('2026-10-08T01:20:00Z');   // arrivée des passifs de classe (1re annonce « Mots »)
// Armure Féca : tout sort qui soigne ou protège le lanceur, vols de vie compris (Tromperie : « Armure Féca 2/5 » après
// chaque lancer, combats du 13/10), ou qui lui donne des résistances
const isFecaCharge = (c) => (c.eff || []).some((e) => e?.tgt === 'self' && (/heal|shield/i.test(e.k || '') || (e.k === 'buff' && /^res/.test(e.stat || ''))));
const isResBuff = (c) => (c.eff || []).some((e) => e?.tgt === 'self' && e.k === 'buff' && /^res/.test(e.stat || ''));
const isDmgCard = (c) => (c.eff || []).some((e) => e && DMG_FIXED.has(e.k));
const apTaken = (c) => (c.eff || []).reduce((t, e) => t + (e?.tgt === 'enemy' && /apRemove|apSteal/.test(e.k || '') ? Math.abs(+e.min || 0) || Math.abs(+e.max || 0) || 1 : 0), 0);

// Modèles par classe (breedId) : stack(c) = charges gagnées par le lancer ; max ; dmg(st, ctx) = multiplicateur de dégâts ;
// heal(st) ; taken(st, round) = multiplicateur des dégâts subis ; avg = multiplicateur moyen sur un combat (optimiseur).
// V3 du 13/10/2026 (textes de la page Personnage) : Armure Féca 4 % par charge (20 % au plus), passifs de l'Enutrof, du
// Sram, du Xélor, de l'Eniripsa, du Roublard et du Steamer +10 %. Prestige : fighters.p.pasBoost (+5 % par Prestige depuis
// la V3, +10 % avant ; donné par le jeu) multiplie les bonus de dégâts et de soins du passif (site : passiveTitle, chaque
// nombre « e(x) » × (1 + pasBoost/100)), pas les réductions de dégâts subis ni les chances (vision du Crâ, malchance de l'Ecaflip).
const CLASS_PASSIVES = {
  1: { name: 'Armure Féca', max: 5, stack: (c) => (isFecaCharge(c) ? 1 : 0), dmg: (s) => 1 + 0.04 * s.stacks, taken: (s) => 1 - 0.04 * s.stacks, avg: 1.16, avgTaken: 0.84 },
  2: { name: 'Dompteur', dmg: (s, x) => 1 + 0.2 * Math.min(3, x.summons || 0), avg: 1.2 },   // +20 % par invocation active (hors bombes)
  3: { name: 'Avarice', max: 10, stack: (c) => ((+c.ap || 0) <= 2 ? 1 : 0), dmg: (s) => 1 + 0.055 * s.stacks, avg: 1.275 },
  4: { name: 'Assassinat', dmg: (s, x) => (x.tgtPct < 0.25 ? 1.66 : x.tgtPct < 0.5 ? 1.33 : 1), avg: 1.264 },
  5: { name: 'Distorsion temporelle', max: 10, stack: (c) => apTaken(c), dmg: (s) => 1 + 0.066 * s.stacks, avg: 1.33 },
  // coup de chance ×(1 + k) à 32 % (k = 1 + pasBoost/100 : ×2 sans Prestige), malchance ×0,5 à 2 % (non boostée)
  6: { name: 'Chance d’Ecaflip', dmgK: (s, x, k) => 1 + 0.32 * k - 0.02 * 0.5, dmg: () => 1.31, avg: 1.31, random: true },
  7: { name: 'Mots', max: 5, stack: (c) => (isHealShield(c) ? 1 : 0), dmg: (s) => 1 + 0.099 * s.stacks, heal: (s) => 1 + 0.099 * s.stacks, avg: 1.374 },
  8: { name: 'Enchaînement', dmg: (s) => 1 + Math.min(0.45, 0.15 * s.turnCasts), avg: 1.22 },
  9: { name: 'Œil de lynx', spectral: 26, spectralCap: 60, dmg: () => 1, avg: 1.17 },
  10: { name: 'Puissance sylvestre', dmg: () => 1, avg: 1.1 },   // poison de 3 % des PV max par tour, 12 % au plus (boss 3 %)
  11: { name: 'Souffrance', dmg: (s, x) => 1 + Math.min(0.63, 0.07 * Math.floor((1 - x.selfPct) * 10)), avg: 1.28 },
  12: { name: 'Ivresse', max: 6, stack: () => 1, dmg: (s) => 1 + 0.05 * s.stacks, regen: (s) => 0.01 * s.stacks, avg: 1.25 },
  13: { name: 'Artificier', dmg: (s) => 1 + Math.min(0.33, 0.11 * s.bombs), avg: 1.11 },
  14: { name: 'Masques', dmg: (s) => [1.1, 1.25, 1][(s.myTurns - 1) % 3] || 1, taken: (s) => [0.9, 1, 0.75][(s.myTurns - 1) % 3] || 1, avg: 1.12, avgTaken: 0.88 },
  15: { name: 'Évolution', dmg: (s) => 1 + 0.077 * Math.max(0, Math.min(6, s.myTurns - 1)), avg: 1.231 },
  16: { name: 'Portails', dmg: (s) => ((s.fightDmgCasts + 1) % 2 === 0 ? 1.5 : 1), avg: 1.25 },   // la 2e, la 4e… attaque du combat
  17: { name: 'Runes élémentaires', dmg: (s) => 1 + 0.11 * Math.min(4, s.runes.size), avg: 1.36 },
  // Proie (oct. 2026) : +12 % par sort qui a déjà frappé la cible, +60 % au plus (« Proie (3/5) : +36 % », annoncé après le coup)
  18: { name: 'Proie', dmg: (s, x) => 1 + (s.prey === x.tgtId ? Math.min(0.6, 0.12 * s.preyHits) : 0), avg: 1.3 },
  20: { name: 'Lance projetée', dmg: (s) => (s.turnDmgCasts === 0 ? 1.45 : 1), avg: 1.16 },
};
// Équilibrage du 10/10/2026 → V3 du 13/10 : combats enregistrés entre les deux (test du calcul, auto-diagnostic)
const CLASS_PASSIVES_V2 = {
  1: { name: 'Armure Féca', max: 5, stack: (c) => (isHealShield(c) || isResBuff(c) ? 1 : 0), dmg: (s) => 1 + 0.06 * s.stacks, taken: (s) => 1 - 0.06 * s.stacks, avg: 1.24, avgTaken: 0.76 },
  2: { name: 'Dompteur', dmg: (s, x) => 1 + 0.2 * Math.min(3, x.summons || 0), avg: 1.2 },   // +20 % par invocation active (hors bombes)
  3: { name: 'Avarice', max: 10, stack: (c) => ((+c.ap || 0) <= 2 ? 1 : 0), dmg: (s) => 1 + 0.05 * s.stacks, avg: 1.25 },
  4: { name: 'Assassinat', dmg: (s, x) => (x.tgtPct < 0.25 ? 1.6 : x.tgtPct < 0.5 ? 1.3 : 1), avg: 1.24 },
  5: { name: 'Distorsion temporelle', max: 10, stack: (c) => apTaken(c), dmg: (s) => 1 + 0.06 * s.stacks, avg: 1.3 },
  // coup de chance ×(1 + k) à 32 % (k = 1 + pasBoost/100 : ×2 sans Prestige), malchance ×0,5 à 2 % (non boostée)
  6: { name: 'Chance d’Ecaflip', dmgK: (s, x, k) => 1 + 0.32 * k - 0.02 * 0.5, dmg: () => 1.31, avg: 1.31, random: true },
  7: { name: 'Mots', max: 5, stack: (c) => (isHealShield(c) ? 1 : 0), dmg: (s) => 1 + 0.09 * s.stacks, heal: (s) => 1 + 0.09 * s.stacks, avg: 1.34 },
  8: { name: 'Enchaînement', dmg: (s) => 1 + Math.min(0.45, 0.15 * s.turnCasts), avg: 1.22 },
  9: { name: 'Œil de lynx', spectral: 26, spectralCap: 60, dmg: () => 1, avg: 1.17 },
  10: { name: 'Puissance sylvestre', dmg: () => 1, avg: 1.1 },   // poison de 3 % des PV max par tour, 12 % au plus (boss 3 %)
  11: { name: 'Souffrance', dmg: (s, x) => 1 + Math.min(0.63, 0.07 * Math.floor((1 - x.selfPct) * 10)), avg: 1.28 },
  12: { name: 'Ivresse', max: 6, stack: () => 1, dmg: (s) => 1 + 0.05 * s.stacks, regen: (s) => 0.01 * s.stacks, avg: 1.25 },
  13: { name: 'Artificier', dmg: (s) => 1 + Math.min(0.3, 0.1 * s.bombs), avg: 1.1 },
  14: { name: 'Masques', dmg: (s) => [1.1, 1.25, 1][(s.myTurns - 1) % 3] || 1, taken: (s) => [0.9, 1, 0.75][(s.myTurns - 1) % 3] || 1, avg: 1.12, avgTaken: 0.88 },
  15: { name: 'Évolution', dmg: (s) => 1 + 0.07 * Math.max(0, Math.min(6, s.myTurns - 1)), avg: 1.21 },
  16: { name: 'Portails', dmg: (s) => ((s.fightDmgCasts + 1) % 2 === 0 ? 1.5 : 1), avg: 1.25 },   // la 2e, la 4e… attaque du combat
  17: { name: 'Runes élémentaires', dmg: (s) => 1 + 0.11 * Math.min(4, s.runes.size), avg: 1.36 },
  // Proie (oct. 2026) : +12 % par sort qui a déjà frappé la cible, +60 % au plus (« Proie (3/5) : +36 % », annoncé après le coup)
  18: { name: 'Proie', dmg: (s, x) => 1 + (s.prey === x.tgtId ? Math.min(0.6, 0.12 * s.preyHits) : 0), avg: 1.3 },
  20: { name: 'Lance projetée', dmg: (s) => (s.turnDmgCasts === 0 ? 1.45 : 1), avg: 1.16 },
};
// Avant l'équilibrage du 10/10/2026 : combats enregistrés plus anciens (test du calcul, auto-diagnostic)
const CLASS_PASSIVES_V1 = {
  1: { name: 'Armure Féca', max: 5, stack: (c) => (isHealShield(c) || isResBuff(c) ? 1 : 0), dmg: (s) => 1 + 0.02 * s.stacks, taken: (s) => 1 - 0.03 * s.stacks, avg: 1.08, avgTaken: 0.88 },
  2: { name: 'Dompteur', dmg: () => 1, avg: 1 },   // invocations : non gérées
  3: { name: 'Avarice', max: 6, stack: (c) => ((+c.ap || 0) <= 2 ? 1 : 0), dmg: (s) => 1 + 0.03 * s.stacks, avg: 1.12 },
  4: { name: 'Assassinat', dmg: (s, x) => (x.tgtPct < 0.25 ? 1.35 : x.tgtPct < 0.5 ? 1.2 : 1), avg: 1.12 },
  5: { name: 'Distorsion temporelle', max: 8, stack: (c) => apTaken(c), dmg: (s) => 1 + 0.02 * s.stacks, avg: 1.1 },
  6: { name: 'Chance d’Ecaflip', dmg: () => 1 + 0.18 - 0.05 * 0.5, avg: 1.155, random: true },   // espérance : ×2 à 18 %, ×0,5 à 5 %
  7: { name: 'Mots', max: 5, stack: (c) => (isHealShield(c) ? 1 : 0), dmg: (s) => 1 + 0.04 * s.stacks, heal: (s) => 1 + 0.05 * s.stacks, avg: 1.15 },
  8: { name: 'Enchaînement', dmg: (s) => 1 + Math.min(0.45, 0.15 * s.turnCasts), avg: 1.22 },
  9: { name: 'Œil de lynx', spectral: 18, dmg: () => 1, avg: 1.12 },
  10: { name: 'Puissance sylvestre', dmg: () => 1, avg: 1.05 },   // poison de 1 % des PV max par tour (boss 3 % au plus)
  11: { name: 'Souffrance', dmg: (s, x) => 1 + Math.min(0.18, 0.02 * Math.floor((1 - x.selfPct) * 10)), avg: 1.08 },
  12: { name: 'Ivresse', max: 4, stack: () => 1, dmg: (s) => 1 + 0.03 * s.stacks, regen: (s) => 0.01 * s.stacks, avg: 1.1 },
  13: { name: 'Artificier', dmg: (s) => 1 + Math.min(0.15, 0.05 * s.bombs), avg: 1.05 },
  14: { name: 'Masques', dmg: (s) => [1.1, 1.25, 1][(s.myTurns - 1) % 3] || 1, taken: (s) => [0.9, 1, 0.75][(s.myTurns - 1) % 3] || 1, avg: 1.12, avgTaken: 0.88 },
  15: { name: 'Évolution', dmg: (s) => 1 + 0.02 * Math.max(0, Math.min(5, s.myTurns - 1)), avg: 1.06 },
  16: { name: 'Portails', dmg: (s) => ((s.fightDmgCasts + 1) % 3 === 0 ? 1.25 : 1), avg: 1.083 },
  17: { name: 'Runes élémentaires', dmg: (s) => 1 + 0.04 * Math.min(4, s.runes.size), avg: 1.13 },
  // Proie (oct. 2026) : +12 % par sort qui a déjà frappé la cible, +60 % au plus (« Proie (3/5) : +36 % », annoncé après le coup)
  18: { name: 'Proie', dmg: (s, x) => 1 + (s.prey === x.tgtId ? Math.min(0.6, 0.12 * s.preyHits) : 0), avg: 1.3 },
  20: { name: 'Lance projetée', dmg: (s) => (s.turnDmgCasts === 0 ? 1.2 : 1), avg: 1.07 },
};
const PASSIVES_V2_SINCE = Date.parse('2026-10-10T16:00:00Z');   // équilibrage des passifs de classe
const PASSIVES_V3_SINCE = Date.parse('2026-10-13T16:00:00Z');   // V3 (dernier combat à pasBoost 100 au P10 : 15:40 UTC)
const classOf = (breed, at = Date.now()) => (!at ? CLASS_PASSIVES : at < PASSIVES_V2_SINCE ? CLASS_PASSIVES_V1 : at < PASSIVES_V3_SINCE ? CLASS_PASSIVES_V2 : CLASS_PASSIVES)[+breed] || null;
// Prestige : multiplicateur des bonus du passif (fighters.p.pasBoost, en %), et bonus moyen boosté pour l'optimiseur
const pasK = (boost) => 1 + Math.max(0, +boost || 0) / 100;
const classAvg = (cp, boost) => (cp ? 1 + ((cp.avg || 1) - 1) * pasK(boost) : 1);
// Prestige de classe sur les sorts de SA classe (carte.cls = breedId) : sorts de dégâts +10 % par Prestige (boucliers et
// soins compris), sorts de boost +2 % (V3 ; +10 % sur tout avant). Le jeu l'applique aux cartes de l'état de combat
// (Bouclier Féca 33 → 66 et Masque du Psychopathe 41 → 49 au P10, 82 avant la V3) ; /deck donne les valeurs de base.
const CLASS_SPELL_PRESTIGE = { mainPct: 10, boostPct: 2 };
const CLASS_MAIN_K = /dmg|steal|heal|shield/i;
function classCardBoost(card, breed, prestige, at = Date.now()) {
  if (!card || !(+breed) || !(prestige > 0) || +card.cls !== +breed) return card;
  const main = (card.eff || []).some((e) => e && CLASS_MAIN_K.test(e.k || ''));
  const pct = at < PASSIVES_V3_SINCE ? 10 : main ? CLASS_SPELL_PRESTIGE.mainPct : CLASS_SPELL_PRESTIGE.boostPct;
  const k = 1 + prestige * pct / 100;
  const up = (e) => (e && (main ? CLASS_MAIN_K.test(e.k || '') : e.k === 'buff') ? { ...e, min: Math.round(e.min * k), max: Math.round(e.max * k) } : e);
  return { ...card, eff: (card.eff || []).map(up), ...(Array.isArray(card.crit) ? { crit: card.crit.map(up) } : {}) };
}
// passifs qui comptent aussi l'arme (« ses sorts et son arme » ; Masques vérifié ; Armure Féca : 73/82 coups d'Arc Volkorne justes
// avec, 55 sans, 13/10 ; Portails : 1 lancer de dégâts sur 3 du
// combat, arme comprise — 264/264 lancers de Lanthane)
const PASSIVE_WEAPON = new Set([1, 2, 4, 13, 14, 15, 16, 18]);   // Proie : bonus contre la proie aussi à l'arme (ne la marque pas)
// Carte « Portail » (effet empower) : la prochaine carte de dégâts, arme comprise, ×(1 + v/100) puis consommé. Le journal
// l'annonce comme un buff dmgPctSorts d'un tour, mais ce n'est pas un % sorts (118 combats de Lanthane : ×1,65 séparé).
const empowerOf = (c) => (c?.eff || []).reduce((t, e) => (e?.k === 'empower' ? Math.max(t, +e.min || 0) : t), 0);

// Bonus de sorts (jeu, patch d'oct. 2026 : SPELL_BONUS, pas dans les Abysses) :
// - grand deck : +5 % de dégâts aux sorts par carte au-delà de 7, +25 % au plus ;
// - sorts à une seule ligne de dégâts : +50 %, puis +20 % par tour, +150 % au plus, tant qu'aucun sort ni arme à plusieurs
//   lignes de dégâts n'est lancé ; un tel lancer remet le bonus à zéro, il repart au tour suivant (p.monoFrom).
const SPELL_BONUS = { deckPerCard: 5, deckMax: 25, monoStart: 50, monoPerTurn: 20, monoMax: 150 };
const deckBonusPct = (n) => Math.min(SPELL_BONUS.deckMax, Math.max(0, n - 7) * SPELL_BONUS.deckPerCard);
const monoBonusPct = (turns) => Math.min(SPELL_BONUS.monoMax, SPELL_BONUS.monoStart + Math.max(0, turns) * SPELL_BONUS.monoPerTurn);
// Lignes de dégâts d'un sort (patch du 12/10/2026 : « les lignes de boost ne comptent pas ») ; avant, toutes les lignes
// comptaient (vérifié en combat : Ponteira, Nimbus, Lance-flamme remettaient le bonus à zéro)
const cardLines = (c) => (c?.eff || []).filter((e) => e && (DMG_FIXED.has(e.k) || DMG_VARIABLE.has(e.k))).length;
// Traqueur : état du passif au fil du combat. cast(card, { tgtId, el }) après chaque lancer ; mult(card, ctx) avant.
const BOMB_KABOOM_SINCE = Date.UTC(2026, 9, 17);   // patch du 17/10 : bombes posées jusqu'à Kaboom (10 au plus)
// opt : { deck: cartes du deck en combat, bonus: bonus de sorts actifs (pas les Abysses) }
function classTracker(breed, at = Date.now(), opt = {}) {
  const cp = at && at < PASSIVES_SINCE ? null : classOf(breed, at);   // combat antérieur aux passifs : aucun
  const k = pasK(opt.boost);
  const s = { empower: 0, stacks: 0, turnCasts: 0, turnDmgCasts: 0, fightDmgCasts: 0, myTurns: 0, runes: new Set(), prey: null, preyHits: 0, bombs: 0, planted: 0, logged: null, monoFrom: 1 };
  return {
    cp, s,
    // l'annonce vaut pour le tour : Masques change chaque tour (« Masque Pleutre : −25 % de dégâts subis » = aucun bonus)
    turn() { s.myTurns++; s.turnCasts = 0; s.turnDmgCasts = 0; s.logged = null; },
    passiveLog(text) {
      if (/passe par un portail/.test(text)) return;
      // Proie : l'annonce suit le coup et ne vaut que contre cette cible (changer de cible la remet à zéro) → le modèle suffit
      if (/est sa Proie/.test(text)) return;   // Portails : propre au lancer qui vient d'avoir lieu (après la ligne play)
      // charges annoncées (« Armure Féca 3/5 : … ») : elles durent tout le combat, l'annonce ne vaut pas que pour le tour
      const n = String(text).match(/^[^:]*?(\d+)\/\d+ ?:/);
      if (n && cp?.stack) s.stacks = +n[1];
      const m = String(text).match(/\+(\d+(?:[.,]\d+)?) ?% de dégâts(?! subis)/);
      if (m) s.logged = +m[1].replace(',', '.');
      else if (/% de dégâts subis/.test(text)) s.logged = 0;
    },
    // multiplicateur de dégâts du prochain lancer ; ctx : { tgtId, tgtPct, selfPct }
    mult(card, ctx = {}) { return this.passive(card, ctx) * this.emp(card) * this.spell(card); },
    // bonus de deck et des sorts à une ligne (sorts seulement, pas l'arme) : ADDITIONNÉS par le jeu (+25 % et +50 % → ×1,75,
    // pas ×1,875 : 482/500 coups justes en Ascension le 13/10, contre 156 en les multipliant ; l'arme, sans bonus, tombait juste)
    spell(card) {
      if (!opt.bonus || card.weapon || !isDmgCard(card)) return 1;
      let pct = deckBonusPct(+opt.deck || 0);
      if (cardLines(card) === 1 && s.myTurns >= s.monoFrom) pct += monoBonusPct(s.myTurns - s.monoFrom);
      return 1 + pct / 100;
    },
    emp(card) { return s.empower && isDmgCard(card) ? 1 + s.empower / 100 : 1; },   // Portail en attente
    passive(card, ctx = {}) {
      // valeur annoncée par le jeu : sans le bonus de Prestige (« Masque Psychopathe : +25 % » à pasBoost 80 alors que les
      // dégâts suivent +45 % : rescan3.har, 233 coups, écart 4,4 % contre 6,9 % sans le bonus) → boostée ici
      if (s.logged != null) return 1 + s.logged / 100 * k;
      if (!cp || !isDmgCard(card) || (card.weapon && !PASSIVE_WEAPON.has(+breed))) return 1;
      const x = { tgtPct: 1, selfPct: 1, ...ctx };
      return cp.dmgK ? cp.dmgK(s, x, k) : 1 + (cp.dmg(s, x) - 1) * k;
    },
    heal() { return cp?.heal ? 1 + (cp.heal(s) - 1) * k : 1; },
    taken() { return cp?.taken ? cp.taken(s) : 1; },
    // à appeler pour chaque lancer, arme comprise
    cast(card, ctx = {}) {
      const dmg = isDmgCard(card);
      if (cardLines(card) > 1) s.monoFrom = s.myTurns + 1;   // plusieurs lignes : bonus « une ligne » perdu jusqu'au tour suivant
      if (dmg) s.empower = 0;
      if (empowerOf(card)) s.empower = empowerOf(card);
      if (card.weapon) {   // l'arme ne compte que pour les passifs qui la comptent
        if (dmg && PASSIVE_WEAPON.has(+breed)) { s.turnDmgCasts++; s.fightDmgCasts++; }
        return;
      }
      if (cp?.stack) s.stacks = Math.min(cp.max || 99, s.stacks + cp.stack(card));
      s.turnCasts++;
      if (dmg) {
        s.turnDmgCasts++; s.fightDmgCasts++;
        for (const e of card.eff || []) if (e && DMG_FIXED.has(e.k) && Number.isInteger(e.el)) s.runes.add(e.el);
        if (ctx.tgtId) { if (s.prey === ctx.tgtId) s.preyHits++; else { s.prey = ctx.tgtId; s.preyHits = 1; } }
      }
      // Artificier : bombes qui explosent. Depuis le 17/10, elles attendent Kaboom (detonate), qui les fait toutes exploser
      if (at && at < BOMB_KABOOM_SINCE) { if ((card.eff || []).some((e) => e?.k === 'bomb' || e?.k === 'detonate')) s.bombs++; }
      else if ((card.eff || []).some((e) => e?.k === 'detonate')) { s.bombs += s.planted; s.planted = 0; }
      else if ((card.eff || []).some((e) => e?.k === 'bomb')) s.planted = Math.min(10, s.planted + 1);
    },
    clone() { const c = classTracker(breed, at, opt); Object.assign(c.s, { ...s, runes: new Set(s.runes) }); return c; },
  };
}
// Bonus de sorts d'un combat : taille du deck en combat ; pas dans les Abysses ni en multi-lancer
// (+ bonus de Prestige du passif, pasBoost)
const spellBonusOpt = (st) => ({ deck: Object.keys(st?.fighters?.p?.cards || {}).length, bonus: st?.kind !== 'abyss' && !st?.fighters?.p?.multiCast,
  boost: st?.kind === 'abyss' ? 0 : +st?.fighters?.p?.pasBoost || 0 });
// Traqueur rejoué sur le journal d'un combat (cartes du joueur : fighters.p.cards / weaponCard).
function classTrackerFromLog(st, at = Date.now()) {
  const p = st?.fighters?.p;
  // Abysses : pas de passif de classe (aucune annonce dans 105 combats ; Secourisme lancé à PV pleins pour des charges
  // d'Armure Féca qui n'existent pas là, étage 60 le 16/10)
  const tr = classTracker(st?.kind === 'abyss' ? null : p?.breedId, at, spellBonusOpt(st));
  if (!p) return tr;
  const byName = new Map([...Object.values(p.cards || {}), p.weaponCard].filter(Boolean).map((c) => [c.name, c]));
  for (const L of st.log || []) {
    if (L.t === 'turn' && L.who === 'p') tr.turn();
    if (L.t === 'passive' && L.who === 'p') tr.passiveLog(L.text);
    if (L.t === 'play' && L.who === 'p') { const c = byName.get(L.card); if (c) tr.cast(c, { tgtId: L.target }); }
  }
  if (+p.monoFrom > 0) tr.s.monoFrom = +p.monoFrom - (+p.turnNo || tr.s.myTurns) + tr.s.myTurns;   // état du jeu : fait foi
  return tr;
}

// Textes des passifs (page Personnage) : gardés un jour ; un texte qui change est signalé (modèle à revoir).
async function checkClassPassives() {
  let prev = null;
  try { prev = JSON.parse(localStorage.getItem(CLASSES_KEY) || 'null'); } catch { /* rien */ }
  if (prev && Date.now() - prev.at < 86400000) return prev.list;
  const { flight } = await fetchFlight(PERSO_STATS);
  const { rows, props } = rscProps(flight, (x) => Array.isArray(x.classes) && x.classes[0]?.passive);
  const list = props ? rscDeep(rows, props.classes).map((c) => ({ id: c.id, n: c.n, name: c.passive?.name, desc: c.passive?.desc })) : [];
  if (!list.length) { selfIssue('page:classes', 'passifs de classe illisibles (page Personnage)', 'liste « classes » introuvable'); return prev?.list || []; }
  for (const c of list) {
    const old = prev?.list?.find((x) => x.id === c.id);
    if (old && old.desc !== c.desc) selfIssue(`passive:${c.id}`, `passif de classe modifié : ${c.n} (${c.name})`, `avant : ${old.desc}\nmaintenant : ${c.desc}`);
    if (!CLASS_PASSIVES[c.id]) selfIssue(`passive:${c.id}`, `classe inconnue de l’extension : ${c.n} (${c.name})`, c.desc);
  }
  try { localStorage.setItem(CLASSES_KEY, JSON.stringify({ at: Date.now(), list })); } catch { /* rien */ }
  return list;
}
