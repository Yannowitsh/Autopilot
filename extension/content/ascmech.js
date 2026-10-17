// Autopilot-DM — content script : mécaniques des boss (Ascension) et plan du tour qui les respecte.
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.
//
// Le bestiaire (/bestiaire?onglet=mecaniques, BossMechanicsGrid) liste pour chaque boss (id = monsterId du combat) ses
// mécaniques selon la difficulté : « Facile · Ascension, étages 1-2 », « Cauchemar · Ascension dès l’étage 9 », plus
// « Cauchemar · deuxième mécanique en même temps ». L'état du combat ne les donne pas : on les déduit des boss présents et
// de l'étage (cfg.ascFloor, noté au lancement). Étage inconnu : toutes les mécaniques d'Ascension du boss (prudent).
// En combat, planTurn cherche la meilleure suite de cartes du tour (ordre compris) sous ces contraintes ; le moteur
// joue sa première carte puis recalcule (pioche, morts, coups critiques…).
const MECH_KEY = 'dmBossMech';
const MECH_MAX_AGE = 12 * 3600000;
const SELF_W = 1.5;              // 1 PV perdu par nous-mêmes vaut 1,5 PV infligés (nos PV sont plus rares que ceux des boss)
const REFL_MARGIN = 1.25;       // coups renvoyés (Reflet) : réels jusqu'à ~×1,6 l'estimation (étage 126) → marge pour ne pas en mourir
const STEAL_HEAL_PART = 0.5;     // un vol de vie rend 50 % des dégâts infligés (journaux de combat)
// Soins et boucliers (patch du 14 oct. 2026, partout : Ascension, Dimension Écarlate, Colisée compris) : 2 sorts de soin
// ou de bouclier par tour (3 pour l'Eniripsa et le Sacrieur) ; au plus 40 % des PV max par sort (boucliers le 14/10,
// soins le 16/10 ; 25 % avant)
const SUPPORT_CAP = 0.4, SUPPORT_PER_TURN = 2;
const supportPerTurn = (breed) => ([7, 11].includes(+breed) ? 3 : SUPPORT_PER_TURN);   // 7 Eniripsa, 11 Sacrieur
let mechCache = null;

// Mécaniques de tous les boss : [{ id, n, m: [{ w, n, x }] }], gardées 12 h (localStorage de la page).
async function bossMechanics(force = false) {
  if (!mechCache) { try { mechCache = JSON.parse(localStorage.getItem(MECH_KEY) || 'null'); } catch { mechCache = null; } }
  if (!force && mechCache?.list?.length && Date.now() - mechCache.at < MECH_MAX_AGE) return mechCache.list;
  try {
    const { flight } = await fetchFlight('/bestiaire?onglet=mecaniques');
    const { rows, props } = rscProps(flight, (x) => Array.isArray(x.cards) && x.cards.length > 0 && x.cards.some((c) => c && typeof c === 'object' && 'm' in c));
    const list = props && rscDeep(rows, props.cards).filter((b) => b?.id && Array.isArray(b.m));
    if (!list?.length) throw new Error('liste des mécaniques introuvable');
    mechCache = { at: Date.now(), list };
    selfCheckMechanics(list);   // nouveaux types de mécaniques : signalés
    try { localStorage.setItem(MECH_KEY, JSON.stringify(mechCache)); } catch { /* stockage plein */ }
    return list;
  } catch (e) {
    DM.log(`mécaniques des boss : ${e.message}${mechCache?.list ? ' — dernière copie utilisée' : ''}`);
    selfIssue('page:bestiaire', 'mécaniques du bestiaire illisibles', e.message);
    return mechCache?.list || [];
  }
}

// Texte d'une mécanique → règle exploitable.
function parseMechanic(m) {
  const x = m.x || '', num = (re) => { const r = x.match(re); return r ? +r[1] : null; };
  switch (m.n) {
    // ×2,5 mesuré (2026-10-09, 29 coups « se déchaîne » ; ×1,375 quand le boss est Affaibli de 45 %)
    case 'Fureur': return { k: 'fureur', max: num(/plus de (\d+) cartes/) ?? 3, mult: +(x.match(/×(\d+(?:,\d+)?)/)?.[1] || '2.5').replace(',', '.') };
    case 'Peau dure': return { k: 'shield', pass: num(/seuls (\d+) ?%/) ?? 50 };
    case 'Onde de choc': return { k: 'onde', pct: num(/(\d+) ?% de tes PV/) ?? 25 };
    case 'Malédiction des soins': return { k: 'curse', from: num(/tour (\d+)/) ?? 1, half: /divisés par deux/.test(x) };
    case 'Sceau': return { k: 'seal', every: /chaque tour/.test(x) ? 1 : num(/Tous les (\d+) tours/) ?? 3 };
    case 'Deuxième souffle': return { k: 'revive', pct: num(/(\d+) ?% de ses PV/) ?? 30 };
    case 'Miroir': {
      const r = x.match(/tours? (\d+)(?: à (\d+))?/);
      return { k: 'mirror', from: r ? +r[1] : 3, to: r ? +(r[2] || r[1]) : 3 };
    }
    case 'PA comptés': return { k: 'apExact', turn: num(/tour (\d+)/) ?? 3, ap: num(/exactement (\d+) PA/) ?? 1 };
    case 'Rage': return { k: 'rage', turn: num(/tour (\d+)/) };
    case 'Vol de PA': return { k: 'apSteal' };
    case 'Échange de vie': return { k: 'swap', turn: num(/tour (\d+)/) ?? 5, half: /à moitié/.test(x) };
    default: return { k: 'none' };
  }
}
// Mécanique donnée par l'état du combat (f.rules : { k, name, text, valeurs }) : même texte que le bestiaire, valeurs
// exactes quand le jeu les donne (Miroir : turn + turns, Fureur : max + fury, Échange de vie : turn + partial…).
function stateRule(r) {
  const base = parseMechanic({ n: r.name, x: r.text || '' }), n = (v) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : null);
  switch (r.k) {
    case 'maxCards': return { ...base, k: 'fureur', max: n(r.max) ?? base.max, mult: n(r.fury) ?? base.mult };
    case 'mirror': return n(r.turn) ? { ...base, k: 'mirror', from: +r.turn, to: +r.turn + Math.max(1, n(r.turns) ?? 1) - 1 } : base;
    case 'hpSwap': return n(r.turn) ? { ...base, k: 'swap', turn: +r.turn, half: r.partial === true || base.half } : base;
    case 'enrage': return n(r.turn) ? { ...base, k: 'rage', turn: +r.turn } : base;
    case 'sameElement': return { ...base, k: 'onde', pct: n(r.pct) ?? base.pct };
    case 'healCurse': return { ...base, k: 'curse', from: n(r.from) ?? base.from };
    case 'revive': return { ...base, k: 'revive', pct: n(r.pct) ?? base.pct };
    case 'exactAp': return n(r.turn) ? { ...base, k: 'apExact', turn: +r.turn, ap: n(r.ap) ?? base.ap } : base;
    case 'apDrain': return { ...base, k: 'apSteal' };
    default: return base;
  }
}
// Étages d'Ascension couverts par une ligne du bestiaire (« Ascension, étages 3-5 », « Ascension dès l’étage 9 »).
function ascRanges(w) {
  const out = [];
  for (const r of (w || '').matchAll(/Ascension, étages (\d+)-(\d+)/g)) out.push([+r[1], +r[2]]);
  for (const r of (w || '').matchAll(/Ascension dès l.étage (\d+)/g)) out.push([+r[1], Infinity]);
  return out;
}
// Mécaniques actives d'un combat : [{ boss: id du combattant, name, text, ...règle }].
// diff : difficulté affichée sur la page Ascension (« Cauchemar »…), prioritaire ; sinon déduite de l'étage.
function fightMechanics(st, list, floor, diff = null) {
  const out = [];
  for (const f of Object.values(st.fighters || {})) {
    if (f.team === st.fighters.p?.team || !f.isBoss) continue;
    // depuis oct. 2026 le combat donne lui-même les mécaniques du boss (f.rules) : elles font foi
    if (Array.isArray(f.rules)) {
      for (const r of f.rules) if (r?.name) out.push({ boss: f.id, bossName: f.name, name: r.name, text: r.text || '', ...stateRule(r), fromState: true });
      continue;
    }
    const b = list.find((x) => +x.id === +f.monsterId) || list.find((x) => x.n === f.name);
    if (!b) continue;
    const asc = b.m.filter((m) => ascRanges(m.w).length);
    let picked = diff ? asc.filter((m) => m.w.split(' · ')[0].split(' et ').includes(diff))
      : floor ? asc.filter((m) => ascRanges(m.w).some(([a, z]) => floor >= a && floor <= z)) : asc;
    // Cauchemar : la deuxième mécanique s'ajoute
    const nightmare = diff ? diff === 'Cauchemar' : picked.some((m) => ascRanges(m.w).some(([a, z]) => z === Infinity && floor >= a));
    if (nightmare || (!diff && !floor)) picked = [...picked, ...b.m.filter((m) => /deuxième mécanique/.test(m.w))];
    for (const m of picked) out.push({ boss: f.id, bossName: f.name, name: m.n, text: m.x, ...parseMechanic(m) });
  }
  return out;
}

// ---------- Estimations (même formule que la tierlist) ----------
// buffs du combattant, sauf celui d'un Portail (empower : compté par le traqueur de classe sur la carte suivante)
const fighterStat = (f) => (k) => (+f.stats?.[k] || 0) + (f.buffs || []).reduce((s, b) => s + (b.stat === k && !empowerOf(f.cards?.[b.source]) ? +b.value || 0 : 0), 0);
// Dégâts moyens d'une carte sur une cible (résistances comprises), et ce qu'elle rend en PV au lanceur (vols, soins).
function cardEffect(card, p, tgt) {
  // mémorisé par combattant (mêmes stats) : le plan du tour et le conseiller de deck l'appellent des milliers de fois
  const memo = p._fx || (p._fx = new Map()), mk = `${card.id}|${card.uid || ''}|${tgt?.id || ''}`;
  if (memo.has(mk)) return memo.get(mk);
  const r = cardEffectRaw(card, p, tgt);
  memo.set(mk, r);
  return r;
}
function cardEffectRaw(card, p, tgt) {
  const S = fighterStat(p);
  const lines = damageLines(card, S);
  const critP = +card.cc > 0 ? Math.min(1, Math.max(0, (+card.cc + S('critique')) / 100)) : 0;
  const pct = dmgPctOf(card, S);   // le passif de classe est appliqué par le plan (classTracker)
  let dmg = 0, steal = 0;
  for (const { e, c, el, first } of lines) {
    if (e.chance != null && +e.chance < 100) continue;
    const mult = 1 + (S(EL_STAT[el]) + S('puissance')) / 100;
    const avg = (x) => ((+x.min || 0) + (+(x.max ?? x.min) || 0)) / 2;
    const fixed = first ? S('dommages') + S(EL_DMG[el]) : 0;
    const v = ((1 - critP) * (avg(e) * mult + fixed) + critP * ((c ? avg(c) : avg(e) * CRIT_MULT) * mult + fixed + (first ? S('dommagesCritiques') : 0))) * pct;
    const T = tgt && fighterStat(tgt);   // stats de la cible, malus compris (Proie de l'Ouginak : −20 % de résistance)
    const rp = tgt ? penRes(Math.min(+tgt.resCap || 100, T(EL_RES_PCT[el]) + T('resPctAll')), penOf(S)) : 0;   // pénétration
    const rf = tgt ? T(EL_RES[el]) : 0;
    const d = Math.max(0, (v - rf) * (1 - rp / 100));
    dmg += d;
    if (e.k === 'steal') steal += d * STEAL_HEAL_PART;
  }
  let heal = 0;
  const learned = cardHeals()[card.id];
  if (learned?.n) heal = learned.r * (+p.maxHp || 0);   // soin mesuré en combat
  else for (const e of card.eff || []) {
    if (e?.tgt !== 'self') continue;
    if (e.k === 'healPct') heal += (+e.min || 0) / 100 * (+p.maxHp || 0);
    else if (e.k === 'heal') {
      const el = Number.isInteger(e.el) ? e.el : 0;
      heal += ((+e.min || 0) + (+(e.max ?? e.min) || 0)) / 2 * (1 + (S(EL_STAT[el]) + S('puissance')) / 100);
    }
  }
  if (+p.maxHp > 0) heal = Math.min(heal, SUPPORT_CAP * p.maxHp);
  return { dmg, self: steal + heal, steal, heal };
}

// Bouclier posé par une carte (PV) : shieldHp = % des PV max (Vertu 26 → 26 % des PV max) ; shieldLvl = % du niveau
// (Fermentation 247 ×2 au niveau 200 = 2 × 494 = 988). Avec beaucoup de PV, les boucliers en % des PV max l'emportent.
// dur : tours pendant lesquels il absorbe (son utilité est plafonnée par les dégâts reçus sur cette durée).
function shieldOf(card, p) {
  let v = 0, dur = 1;
  for (const e of card.eff || []) {
    if (e?.tgt !== 'self') continue;
    if (e.k === 'shieldHp') v += (+e.min || 0) / 100 * (+p.maxHp || 0);
    else if (e.k === 'shieldLvl') v += (+e.min || 0) / 100 * (+p.level || 200);
    else continue;
    dur = Math.max(dur, +e.dur || 1);
  }
  return { v: Math.min(v, SUPPORT_CAP * (+p.maxHp || 0)), dur };
}
const apGainOf = (card) => (card.eff || []).reduce((t, e) => t + (e?.k === 'apGain' && e.tgt === 'self' ? +e.min || 0 : 0), 0);
const MONO_HORIZON = 2;   // tours comptés pour la rampe du bonus « une ligne » perdue par un sort à plusieurs lignes
const AP_REMOVE_CUT = 0.15;   // par PA retiré à l'ennemi : état Affaibli, sa prochaine attaque −15 % (Précipitation 3 PA → « weaken 45 », vérifié)
const WEAKEN_MAX = 0.6;        // Affaibli se cumule jusqu'à 60 % (Comte Razof : 45 puis 60, seq 2024)
// PA retirés à l'ennemi par une carte (Précipitation, Odorat…)
const apCutOf = (card) => (card.eff || []).reduce((t, e) => t + (e?.k === 'apRemove' && e.tgt === 'enemy' ? Math.abs(+e.min || 0) || 1 : 0), 0);
// prochaine VRAIE attaque d'un ennemi, brute (intent.value compte déjà l'état Affaibli) : s'il se garde ou enrage ce tour-ci,
// la suivante — par prudence une attaque lourde (×1,7)
function rawNextOf(f) {
  if (['attack', 'heavy', 'drain'].includes(f.intent?.k) && +f.intent.value) return +f.intent.value;
  return (+f.atk || 0) * 1.7 * (1 - Math.min(WEAKEN_MAX, +f.weaken || 0));
}
// coup brut d'un ennemi → PV qu'il nous retire : (brut × (1 − réduction de dégâts) − rés. fixe) × (1 − rés. % plafonnée à 50)
// (vérifié au point près sans réduction de dégâts ; réduction appliquée avant les résistances, d'après le jeu)
function hitOnPlayer(p, f, raw, dofus = wornDofus()) {
  const el = Number.isInteger(f?.element) ? f.element : 1, S = fighterStat(p);
  const hit = Math.max(0, raw * (1 - dmgRedOf(S)) - S(EL_RES[el])) * (1 - Math.min(+p.resCap || 50, S(EL_RES_PCT[el]) + S('resPctAll')) / 100);
  return dofus.has('ivoire') ? Math.min(hit, DOFUS_FX.ivoireCap * (+p.maxHp || 1)) : hit;   // Dofus Ivoire : 35 % des PV max au plus
}
// PV épargnés sur sa prochaine attaque en lui ôtant cut PA de plus, déjà Affaibli de w0 (état du jeu, ou plus après un
// retrait plus tôt dans le tour ; rien une fois à 60 %) : un retrait de PA vise l'ennemi qui frappera le plus fort sans
// être déjà affaibli
function weakenValue(p, f, cut, w0 = f.weaken, dofus = wornDofus()) {
  if (!cut) return 0;
  const g = Math.min(WEAKEN_MAX, +f.weaken || 0), a = Math.max(g, Math.min(WEAKEN_MAX, +w0 || 0));
  const b = Math.min(WEAKEN_MAX, a + AP_REMOVE_CUT * cut), raw = rawNextOf(f) / (1 - g);   // coup sans Affaibli
  return hitOnPlayer(p, f, raw * (1 - a), dofus) - hitOnPlayer(p, f, raw * (1 - b), dofus);
}
// Coût d'une mécanique pour nous, en part de nos PV max par tour (estimation) : sert à choisir l'ordre d'abattage, puisque
// seul le premier boss encore debout (le plus à gauche) impose ses mécaniques. Malédiction : selon la part de nos cartes
// qui soignent ou volent de la vie (elles deviennent des dégâts sur nous).
const MECH_PAIN = { apSteal: 0.1, fureur: 0.1, apExact: 0.1, swap: 0.1, onde: 0.05, seal: 0.05, shield: 0.05, mirror: 0.05 };
const LEAD_KILL_TURNS = 2;   // tours de mécaniques évités quand le meneur tombe (valeur du coup qui l'abat)
const EXHAUST_MARGIN = 1.25;   // Épuisement final : marge sur sa ligne tant que d'autres boss sont debout

// ---------- Plan du tour ----------
// cand : cartes jouables [{ c, key, weapon, w, ap, dup }] ; rules : fightMechanics(...). Renvoie la 1re carte de la meilleure
// suite { pick, target } (ou null = finir le tour) et les mécaniques en jeu ce tour (texte court).
// opt (Abysses) : allRules (règles de tous les boss à la fois), supportLeft / isSup (soins par tour), fx(x, cible, suite) = valeur en PV d'un effet sans dégâts (sinon
// poids × 5), noDofus (passifs de Dofus ignorés), maxCards. dup : copie d'une carte (lancers multiples), prise après la
// précédente seulement (mêmes suites dans un autre ordre écartées).
const PLAN_MAX_NODES = 60000;
function planTurn(st, cand, rules, opt = {}) {
  const p = st.fighters.p, round = +st.round || +p.turnNo || 1;
  const enemies = Object.values(st.fighters).filter((f) => f.team !== p.team && f.alive && f.id !== 'p');
  const alive = new Set(enemies.map((f) => f.id));
  // « Les mécaniques qui te visent viennent du premier boss encore debout : quand il tombe, le suivant prend le relais. »
  const order = (st.order || Object.keys(st.fighters)).filter((id) => alive.has(id));
  const lead = order.find((id) => rules.some((r) => r.boss === id)) ?? order[0];
  // Abysses (opt.allRules) : chaque boss impose ses propres règles, pas de meneur
  const R = opt.allRules ? rules : rules.filter((r) => r.boss === lead);
  const has = (k) => R.filter((r) => r.k === k);
  const notes = [];
  // Ordre d'abattage : abattre le meneur passe la main au boss suivant (et à ses mécaniques). Plus ses mécaniques coûtent
  // par rapport à celles du suivant, plus on le vise ; s'il est le moins gênant, on vise d'abord les autres.
  const healShare = cand.length ? cand.filter((x) => (x.c.eff || []).some((e) => e?.k === 'steal' || /heal/i.test(e?.k || ''))).length / cand.length : 0;
  const painOf = (id) => rules.filter((r) => r.boss === id)
    .reduce((t, r) => t + (r.k === 'curse' ? (r.half ? 0.15 : 0.4) * healShare : MECH_PAIN[r.k] || 0), 0);
  const nextLead = order.filter((id) => id !== lead).find((id) => rules.some((r) => r.boss === id));
  const leadDelta = lead && nextLead && !opt.allRules ? painOf(lead) - painOf(nextLead) : 0;
  const leadW = (id) => (id !== lead || Math.abs(leadDelta) < 0.02 ? 1 : leadDelta > 0 ? 1 + 10 * leadDelta : 1 / (1 - 10 * leadDelta));
  if (leadDelta >= 0.02) notes.push(`abattre ${st.fighters[lead]?.name} d’abord (ses mécaniques coûtent plus que celles de ${st.fighters[nextLead]?.name})`);
  else if (leadDelta <= -0.02) notes.push(`garder ${st.fighters[lead]?.name} en vie (${st.fighters[nextLead]?.name} prendrait le relais, en pire)`);
  const fureur = has('fureur').reduce((m, r) => Math.min(m, r.max), Infinity);
  if (fureur < Infinity) notes.push(`Fureur > ${fureur} cartes`);
  const onde = has('onde').length > 0;
  if (onde) notes.push('Onde : alterner');
  const inverted = invertNow(st);   // Inversion : soins ET boucliers blessent ce tour
  const curse = inverted || has('curse').some((r) => round >= r.from && !r.half);
  const halfHeal = has('curse').some((r) => round >= r.from && r.half);   // « tes soins sont divisés par deux »
  if (curse) notes.push(inverted ? 'Inversion : soins et boucliers = dégâts' : 'soins = dégâts');
  const keep = witherKeep(st);   // Flétrissure : part des soins et boucliers qui reste
  if (keep < 1) notes.push(`Flétrissure −${Math.round((1 - keep) * 100)} %`);
  const sealAp = sealApNow(st);   // Sceau : le premier sort du tour coûte plus cher
  if (sealAp) notes.push(`1er sort +${sealAp} PA`);
  if (mustPassTurn(st)) notes.push('Épuisement final : aucune attaque');   // cartes offensives déjà écartées (weights.js)
  const shieldRule = has('shield')[0];
  const shieldUp0 = (p.shields || []).some((s) => (+s.v || +s.value || +s.amount || 1) > 0);
  if (shieldRule && !shieldUp0) notes.push(`Peau dure ${shieldRule.pass} %`);
  const mirrored = new Set(has('mirror').filter((r) => round >= r.from && round <= r.to).map((r) => r.boss));
  if (mirrored.size) notes.push(`Miroir : ne pas frapper ${[...mirrored].map((id) => st.fighters[id]?.name).join(', ')}`);
  const reflected = reflectNow(st), immune = immuneNow(st), guarded = guardedNow(st), S0 = fighterStat(p);
  for (const [id, el] of reflected) if (st.fighters[id]?.alive) notes.push(`Reflet : pas de ${EL_NAMES[el]} sur ${st.fighters[id].name}`);
  for (const [id, el] of immune) if (st.fighters[id]?.alive) notes.push(`Élément mouvant : pas de ${EL_NAMES[el]} sur ${st.fighters[id].name}`);
  for (const id of guarded) notes.push(`Gardiens : ${st.fighters[id]?.name} invulnérable`);
  const apRule = has('apExact').find((r) => r.turn === round);
  if (apRule) notes.push(`finir à ${apRule.ap} PA`);
  // Échange de vie : boss à ménager avant son tour… sauf si on peut l'abattre d'ici là (plus d'échange, ni de ses
  // autres mécaniques : il ne mène plus). Nos tours jusqu'au sien compris (on joue avant lui) ; dégâts possibles par tour
  // sur lui : nos 4 meilleures cartes + l'arme.
  // Bouclier d'un boss (sa « garde », souvent pour 1 tour) : il absorbe chaque coup sauf la part de notre Perforation
  // (0,05 % par point de Fuite + Tacle, 25 % au plus : ~10 % vérifié à l'étage 36). Ce qu'il absorbe est perdu s'il expire
  // avant d'être cassé : dans la recherche, seuls les dégâts qui atteignent ses PV comptent.
  const enemyShield = shieldSum;
  const dofus = opt.noDofus ? new Set() : wornDofus(), ebene = dofus.has('ebene') ? DOFUS_FX.ebenePerfo : 1;   // Dofus Ébène : Perforation ×1,3
  // Vision spectrale (PO) : un sort peut frapper deux fois (×2,25 avec le Sylvestre), vol de vie et renvoi compris → pire cas
  // pour ne pas se tuer soi-même (étage 126 : Fléau doublé sous Malédiction des soins = 10 791 PV, mort)
  const specMax = fighterStat(p)('po') > 0 ? (dofus.has('sylvestre') ? DOFUS_FX.sylvestre : 2) : 1;
  const perfo = Math.min(0.25 * ebene, ((fighterStat(p)('fuite') || 0) + (fighterStat(p)('tacle') || 0)) * 0.0005 * ebene);
  const ehpOf = (f) => (+f.hp || 0) + enemyShield(f);
  // dégâts d qui atteignent les PV de f, bouclier restant sh : [vers les PV, bouclier après]
  const throughShield = (d, sh) => { const abs = sh > 0 ? Math.min(sh, d * (1 - perfo)) : 0; return [d - abs, sh - abs]; };
  for (const f of enemies) if (enemyShield(f) > 0) notes.push(`${f.name} sous bouclier (${Math.round(enemyShield(f))})`);
  const killableBy = (id, turns) => {
    const f = st.fighters[id];
    const per = cand.filter((x) => !x.weapon && damageLines(x.c, fighterStat(p)).length).map((x) => cardEffect(x.c, p, f).dmg).sort((a, b) => b - a)
      .slice(0, 4).reduce((t, d) => t + d, 0)   // 4 cartes : la Fureur se paie (bouclier), cf. Auto du jeu
      + cand.filter((x) => x.weapon).reduce((t, x) => t + cardEffect(x.c, p, f).dmg, 0);
    return ehpOf(f) <= per * turns;
  };
  const swapProt = new Set(has('swap').filter((r) => round < r.turn && !killableBy(r.boss, r.turn - round + 1)).map((r) => r.boss));
  const swapRush = has('swap').filter((r) => round < r.turn && !swapProt.has(r.boss));
  if (swapRush.length) notes.push(`abattre ${swapRush.map((r) => st.fighters[r.boss]?.name).join(', ')} avant le tour ${swapRush[0].turn}`);
  if (swapProt.size) notes.push(`Échange de vie : ménager ${[...swapProt].map((id) => st.fighters[id]?.name).join(', ')}`);
  // boss qui se relèvera encore (Deuxième souffle pas encore déclenché) : le tuer ne finit pas le combat
  const revived = new Set(st.log?.filter((L) => L.t === 'mechanic' && /se relève/.test(L.text || '')).map((L) => L.who));
  const reviveAt = Object.fromEntries(has('revive').filter((r) => !revived.has(r.boss)).map((r) => [r.boss, r.pct]));
  const willRevive = new Set(Object.keys(reviveAt));
  // Dofus Pourpre : le 1er sort de dégâts du combat (pas l'arme) frappe double — renvoi du Reflet compris
  const pourpreLeft = dofus.has('pourpre') && !(+st.logFrom > 0) && !(st.log || []).some((L) => L.t === 'play' && L.who === 'p'
    && Object.values(p.cards || {}).some((c) => c?.name === L.card && damageLines(c, fighterStat(p)).length));
  // Mécaniques annoncées des Transmutés (oct. 2026), valeurs dans f.affixes :
  // Seuil de douleur (threshold.pct) : aucun coup ne lui retire plus de x % de ses PV max (le Reflet, lui, renvoie le coup entier)
  const capOf = (f) => (affixOf(f, 'threshold') ? (+f.maxHp || 0) * (+affixOf(f, 'threshold').pct || 0) / 100 : Infinity);
  // Lien d'âme (soulbond.guard / pct) : tant que son porteur est debout, les autres boss subissent guard % de dégâts en moins ;
  // s'il tombe avant eux, ceux encore debout récupèrent pct % de leurs PV max au tour suivant
  const bonds = enemies.filter((f) => affixOf(f, 'soulbond'));
  // Écho (echo.pct / max) : à son tour, le boss nous renvoie le DERNIER sort du tour (pct % de nos PV max par PA, max % au
  // plus) ; l'arme, les soins et les boucliers ne sont pas copiés → finir le tour par eux
  const echoPct = (ap) => enemies.filter((f) => affixOf(f, 'echo')).map((f) => [f.id, Math.min(+affixOf(f, 'echo').max || 100, (+affixOf(f, 'echo').pct || 0) * ap)]);
  const copied = (c, weapon) => !!c && !weapon && cardKind(c) !== 'heal' && !(c.eff || []).some((e) => /shield|bouclier/i.test(e?.k || ''));
  const lastLogged = (() => { const L = sinceMyTurn(st).filter((q) => q.t === 'play' && q.who === 'p').at(-1); return L && L.card !== p.weaponCard?.name && Object.values(p.cards || {}).find((c) => c?.name === L.card); })();
  if (enemies.some((f) => affixOf(f, 'echo'))) notes.push('Écho : finir par l’arme, un soin ou un bouclier');
  // Glas (knell) : annoncé, il faut lui infliger brk % de ses PV max en quelques tours, sinon il frappe fort → on le vise
  // État du combat (f.knell { need, dealt, left }, null hors Glas) : dégâts comptés bouclier compris (15251 : brisé avec 1 934
  // PV + 8 995 absorbés pour 2 507 restants), left = tours restants (1 = dernier). Le journal ne suffit pas : « encore X PV
  // (dernier tour) » s'affiche au tour du boss, le tour d'après ne le voyait plus → Glas lâché au dernier tour (étage 152,
  // 8 défaites sur 9, 13 878 PV reçus) ; et les coups du tour d'annonce (« sonnera au prochain tour ») ne comptent pas.
  const knellOf = (f) => (f.knell && +f.knell.need > +f.knell.dealt ? f.knell : null);
  const knelled = new Set(enemies.filter((f) => affixOf(f, 'knell') && ('knell' in f ? knellOf(f) : sinceRound(st).concat(sinceMyTurn(st))
    .some((L) => L.t === 'mechanic' && L.who === f.id && /Glas/.test(L.text || '') && !/ — Glas :/.test(L.text || '')))).map((f) => f.id));
  // dernier tour du Glas : le briser évite pct % de nos PV max (bouclier déduit) → compté dans le score de la suite
  const knellLast = [...knelled].map((id) => st.fighters[id]).filter((f) => knellOf(f) && +f.knell.left <= 1)
    .map((f) => ({ f, rest: +f.knell.need - +f.knell.dealt, hit: (+p.maxHp || 0) * (+affixOf(f, 'knell').pct || 50) / 100 }));
  for (const id of knelled) notes.push(`Glas : frapper ${st.fighters[id]?.name}`);
  for (const f of bonds) if (enemies.some((g) => g !== f && g.isBoss)) notes.push(`Lien d’âme : ${f.name} en dernier`);
  for (const f of enemies) if (affixOf(f, 'threshold')) notes.push(`Seuil : ${f.name} ≤ ${affixOf(f, 'threshold').pct} % par coup`);
  // Épuisement final (exhaust.below / passes) : passer sous below % de ses PV impose N tours sans attaquer, sauf s'il tombe
  // dans le même tour. Tant que d'autres boss sont debout, ces tours se paient : leurs coups sans riposte et nos dégâts
  // perdus (étage 140 : Ougah sous 20 % au tour 4 dans les 4 défaites → tours 5-6 passés, 6-13 k PV reçus par tour, puis
  // Ougah achevé avant les autres = +30 % de PV pour eux). On le garde au-dessus jusqu'à ce qu'il reste seul.
  // ligne gardée avec une marge (critique, Vision spectrale : la suite estimée peut sous-compter les dégâts)
  const exhaustLine = (f) => { const a = affixOf(f, 'exhaust'); return a && !f.exhaustArmed && !f.exhaustDone ? (+f.maxHp || 0) * (+a.below || 0) / 100 * EXHAUST_MARGIN : 0; };
  const exhaustOthers = (f, ehp) => enemies.some((g) => g !== f && g.isBoss && ehp[g.id] > 0);
  // coût d'un tour passé : coups des boss debout (Hâte comprise) × SELF_W + dégâts d'un tour sur le meneur (5 meilleurs sorts,
  // Seuil compris) ; calculé à la demande (info, hitOn… sont définis plus bas)
  let turnDmg = null;
  const exhaustCost = (f, ehp) => {
    const L = st.fighters[lead];
    turnDmg ??= L ? info.filter((x) => x.isDmg).map((x) => Math.min(cardEffect(x.c, p, L).dmg, capOf(L) * x.nLines))
      .sort((a, b) => b - a).slice(0, 5).reduce((t, d) => t + d, 0) : 0;
    const hits = enemies.filter((g) => g.isBoss && ehp[g.id] > 0)
      .reduce((t, g) => t + hitOn(g, Math.max(+g.atk || 0, incomingOf(g))) * (hasted(g) ? 2 : 1), 0) * tr0.taken();
    return (+affixOf(f, 'exhaust').passes || 2) * (SELF_W * hits + turnDmg);
  };
  for (const f of enemies) if (exhaustLine(f) && +f.hp > exhaustLine(f) && enemies.some((g) => g !== f && g.isBoss)) notes.push(`Épuisement : ${f.name} au-dessus de ${affixOf(f, 'exhaust').below} % tant que les autres sont debout`);

  const info = cand.map((x) => {
    const dl = damageLines(x.c, fighterStat(p));
    const isDmg = dl.length > 0;
    const zone = (x.c.eff || []).some((e) => e?.zone || e?.k === 'bomb' || e?.k === 'detonate');
    const shield = (x.c.eff || []).some((e) => /shield|bouclier/i.test(e?.k || ''));
    return { ...x, isDmg, zone, shield, nLines: Math.max(1, dl.length), firstEl: isDmg ? dl[0].el : null, lastEl: isDmg ? dl[dl.length - 1].el : null };
  });
  const startLast = onde ? (p.lastEl ?? planTurn.lastEl ?? null) : null;
  const cardsDone = +p.cardsThisTurn || 0;
  const maxHp = +p.maxHp || 1;
  // dégâts annoncés par les boss pour leur prochain tour (intentions) : ne jamais se blesser en dessous
  const incomingOf = (f) => (['attack', 'heavy', 'drain', 'rage'].includes(f.intent?.k) ? +f.intent.value || +f.atk || 0 : 0);
  const hitOn = (f, raw) => hitOnPlayer(p, f, raw, dofus);
  // passif de classe : rejoué sur le journal, puis suivi carte par carte dans la recherche (Iop, Forgelance, Enutrof…)
  const tr0 = classTrackerFromLog(st);
  // Hâte (haste.every / off) : tous les N tours il agit deux fois → son coup compte double ce tour-là
  const hasted = (f) => {
    const h = affixOf(f, 'haste');
    if (!h) return false;
    if (sinceRound(st).some((L) => L.t === 'mechanic' && L.who === f.id && /Hâte/.test(L.text || '') && !/ — Hâte :/.test(L.text || ''))) return true;
    return +h.every > 0 && round >= +h.off && (round - +h.off) % +h.every === 0;
  };
  for (const f of enemies) if (hasted(f)) notes.push(`Hâte : ${f.name} agit deux fois`);
  const safety = enemies.reduce((t, f) => t + hitOn(f, incomingOf(f)) * (hasted(f) ? 2 : 1), 0) * tr0.taken() + maxHp * 0.05;   // Féca, Zobal : dégâts subis réduits
  const ondePct = Math.max(0, ...has('onde').map((r) => r.pct));
  // Fureur déjà chargée : un tour précédent à plus de N cartes dont l'attaque amplifiée n'est pas encore venue (le boss s'est
  // gardé ou a enragé entre-temps, seq 2017 : « se déchaîne » après un tour à 2 cartes). Elle viendra quoi qu'on joue :
  // inutile de se brider ce tour-ci.
  // L'arme ne compte pas (étage 145 : Vertu + Bouclier + arme lus comme 3 cartes → « déjà chargée » à tort dans 21 tours
  // sur 60, 10 tours à 3 cartes joués pour rien et autant d'attaques ×2,5 reçues).
  const weaponName = p.weaponCard?.name;
  const furyPending = (r) => {
    let pend = false, who = null, n = 0;
    for (const L of st.log || []) {
      if (L.t === 'turn') { if (who === 'p' && n > r.max) pend = true; who = L.who; n = 0; }
      if (L.t === 'play' && L.who === 'p' && L.card !== weaponName) n++;
      if (L.t === 'mechanic' && L.who === r.boss && /se déchaîne/.test(L.text || '')) pend = false;
    }
    return pend;
  };
  const fureurRules = has('fureur').filter((r) => !furyPending(r));
  if (has('fureur').length > fureurRules.length) notes.push('Fureur déjà chargée');
  let best = null, nodes = 0;
  const n = Math.min(info.length, opt.maxCards || 9);
  // Bonus « une ligne » (+50 %, +20 %/tour, +150 % au plus) : un sort à plusieurs lignes, arme comprise, le remet à zéro
  // jusqu'au tour suivant, où il repart de +50 %. La suite du tour le voit déjà (tr.cast) ; on compte en plus la rampe
  // perdue sur MONO_HORIZON tours, sur les dégâts « une ligne » d'un tour (3 meilleurs sorts à une ligne, hors bonus).
  // Étage 137 : Crocobur joué à chaque tour → bonus bloqué à +50 % (+110 % au 135 gagné, arme jamais jouée).
  const monoOn = spellBonusOpt(st).bonus;
  const monoTarget = enemies.find((f) => +f.hp > 0);
  const monoTurnDmg = monoOn && monoTarget ? info.filter((x) => !x.weapon && x.isDmg && cardLines(x.c) === 1)
    .map((x) => cardEffect(x.c, p, monoTarget).dmg).sort((a, b) => b - a).slice(0, 3).reduce((t, d) => t + d, 0) : 0;
  const monoLoss = (k) => { let pts = 0; for (let h = 1; h <= MONO_HORIZON; h++) pts += monoBonusPct(k + h) - monoBonusPct(h - 1); return pts / 100; };
  // Recherche en profondeur : ordre des cartes, cible de chacune, PV des ennemis et du joueur estimés au fil de la suite.
  // Score en PV : dégâts utiles infligés (sans l'excédent), + bonus par ennemi tué (son attaque ne viendra plus),
  // − SELF_W × PV perdus par nous-mêmes (onde de choc, soins maudits, coups renvoyés, Fureur).
  const dfs = (seq, used, ap, lastEl, count, hp, ehp, shieldUp, score, tr) => {
    const allDead = enemies.every((f) => ehp[f.id] <= 0);
    let s = score;
    if (apRule) s -= Math.abs(ap - apRule.ap) * 1e6;   // PA comptés : sinon il nous pulvérise
    // Lien d'âme : porteur abattu, les autres boss encore debout reprennent pct % de leurs PV max
    for (const f of bonds) {
      if (ehp[f.id] > 0) continue;
      s -= enemies.filter((g) => g !== f && g.isBoss && ehp[g.id] > 0).reduce((t, g) => t + (+g.maxHp || 0) * (+affixOf(f, 'soulbond').pct || 0) / 100, 0);
    }
    // Épuisement final : boss laissé sous sa ligne (ni achevé) alors que d'autres sont debout → tours passés à venir
    for (const f of enemies) if (exhaustLine(f) && ehp[f.id] > 0 && ehp[f.id] < exhaustLine(f) && exhaustOthers(f, ehp)) s -= exhaustCost(f, ehp);
    // Écho : le dernier sort du tour nous revient, si le boss est encore debout — rien si le tour finit par l'arme, un soin ou
    // un bouclier (étage 145 : 78 tours finis par l'arme après des sorts, 0 Écho ; on comptait le sort d'avant l'arme et le
    // bot passait ses fins de combat à l'arme seule, 9 PA et 4 sorts en main)
    const lastQ = seq.at(-1), lastC = lastQ ? (lastQ.x.weapon ? null : lastQ.x.c) : lastLogged;
    if (copied(lastC, false)) {
      const back = echoPct(+lastC.ap || 0).filter(([id]) => ehp[id] > 0).reduce((t, [, pc]) => t + maxHp * pc / 100, 0);
      if (back > 0) s -= back >= hp ? 1e9 : SELF_W * back;
    }
    // Fureur : au-delà de N cartes, la prochaine attaque du boss (s'il vit encore) est multipliée
    // Fureur : au-delà de N cartes, la prochaine attaque du boss (s'il vit encore) est multipliée ; interdit si elle nous tue
    if (!allDead) for (const r of fureurRules) {
      if (!(count > r.max && ehp[r.boss] > 0)) continue;
      // attaque déchaînée Affaiblie par un retrait de PA de ce tour (Précipitation sur lui : ×2,5 × 0,55 = ×1,375, vérifié)
      const f = st.fighters[r.boss], g = Math.min(WEAKEN_MAX, +f.weaken || 0), wk = Math.max(g, Math.min(WEAKEN_MAX, ehp[`w:${r.boss}`] ?? g));
      const boosted = hitOn(f, rawNextOf(f) * (1 - wk) / (1 - g) * (r.mult || 2.5)) * tr0.taken();
      const shieldNow = (p.shields || []).reduce((t, x) => t + (+x.v || +x.value || +x.amount || 0), 0) + (seq.some((q) => q.x.shield) ? Math.max(...seq.filter((q) => q.x.shield).map((q) => shieldOf(q.x.c, p).v)) : 0);
      // surcoût de l'attaque amplifiée, en partie absorbé par le bouclier posé ce tour
      s -= boosted >= hp + shieldNow ? 1e9 : SELF_W * Math.max(0, boosted * (1 - 1 / (r.mult || 2)) - shieldNow / 2);
    }
    // Glas brisé au dernier tour : son coup ne viendra pas (dégâts sur PV + bouclier, comme le jeu les compte)
    for (const { f, rest, hit } of knellLast) {
      const done = (+f.hp || 0) - Math.max(0, ehp[f.id]) + enemyShield(f) - (ehp[`s:${f.id}`] || 0);
      if (ehp[f.id] > 0 && done >= rest) s += SELF_W * Math.max(0, hit - shieldSum(p));
    }
    if (!best || s > best.s + 1e-6 || (Math.abs(s - best.s) <= 1e-6 && seq.length < best.seq.length)) best = { s, seq };
    if (allDead || ++nodes > PLAN_MAX_NODES) return;
    const sup = opt.isSup ? seq.filter((q) => opt.isSup(q.x.c)).length : 0;
    for (let i = 0; i < n; i++) {
      if (used & (1 << i)) continue;
      const x = info[i];
      if (x.dup != null && !(used & (1 << x.dup))) continue;
      if (opt.isSup && opt.isSup(x.c) && sup >= opt.supportLeft) continue;
      const cost = x.ap + (sealAp && !x.weapon && count === cardsDone ? sealAp : 0);   // Sceau : 1er sort du tour plus cher
      if (cost > ap) continue;
      if (x.shield && inverted) continue;   // Inversion : le bouclier nous blesserait
      // cibles essayées : la plus menaçante ; pour un retrait de PA (Précipitation, Odorat…), aussi celle dont il retire le plus
      // de dégâts à venir (attaque annoncée forte, pas déjà Affaiblie à 60 %) — la recherche garde la meilleure suite
      let picks = [null];
      if (x.isDmg || needsTarget(x.c)) {
        // cible : vivante, pas sous Miroir, et pas à ménager (Échange de vie) si le coup la fait passer sous nos PV %
        const myPct = hp / maxHp;
        const ok = enemies.filter((f) => ehp[f.id] > 0 && !mirrored.has(f.id) && !guarded.has(f.id) && blockFrac(x.c, f.id, reflected, immune, S0) < 1).filter((f) => {
          if (!swapProt.has(f.id)) return true;
          return (ehp[f.id] - cardEffect(x.c, p, f).dmg) / (+f.maxHp || 1) >= myPct + 0.05;
        });
        if (!ok.length) continue;
        // cible : celle qu'on achève, sinon la plus menaçante par PV effectif (attaque × dégâts du coup / PV restants, un
        // boss qui se relèvera compte ses PV de résurrection en plus) — pas simplement la moins entamée
        const threat = (f) => {
          const raw = cardEffect(x.c, p, f).dmg, d = throughShield(raw, ehp[`s:${f.id}`] || 0)[0];
          const waste = raw > 0 ? d / raw : 1;   // part du coup qui atteint ses PV (le reste se perd dans son bouclier)
          if (d >= ehp[f.id] && !(reviveAt[f.id] && !ehp[`r:${f.id}`])) return 1e12 + d;   // coup fatal
          const extra = reviveAt[f.id] && !ehp[`r:${f.id}`] ? (+f.maxHp || 0) * reviveAt[f.id] / 100 : 0;
          const rush = swapRush.some((q) => q.boss === f.id) || knelled.has(f.id) ? 10 : 1;   // Échange de vie à venir, Glas sonné : en priorité
          // Épuisement final : le coup qui le ferait passer sous sa ligne (sans l'achever) passe après les autres cibles
          const exh = exhaustLine(f) && ehp[f.id] - d < exhaustLine(f) && exhaustOthers(f, ehp) ? 0.01 : 1;
          return exh * rush * leadW(f.id) * waste * Math.max(1, +f.atk || incomingOf(f) || 1) * d / Math.max(1, ehp[f.id] + extra);
        };
        const top = ok.sort((a, b) => threat(b) - threat(a))[0], cut = apCutOf(x.c);
        picks = [top];
        // Glas sonné, Échange de vie à venir : la cible prioritaire est aussi essayée quand un coup fatal (un gardien) passe
        // devant (étage 145 : tour 2 fini avec l'arme seule et 8 PA, Drain et Tromperie en main → Glas reçu, 13 229 PV)
        for (const f of ok) if (!picks.includes(f) && (knelled.has(f.id) || swapRush.some((q) => q.boss === f.id))) picks.push(f);
        if (cut) {
          const wv = (f) => weakenValue(p, f, cut, ehp[`w:${f.id}`] ?? f.weaken, dofus);
          const weak = ok.reduce((m, f) => (wv(f) > wv(m) ? f : m));
          if (weak !== top && wv(weak) > wv(top)) picks.push(weak);
          // boss à Fureur : l'Affaiblir rend la carte en trop presque gratuite (son attaque déchaînée ×1,375 au lieu de ×2,5)
          for (const r of fureurRules) { const fb = ok.find((f) => f.id === r.boss); if (fb && !picks.includes(fb)) picks.push(fb); }
        }
      }
      for (const pick of picks) {
        let target = pick, gain = 0, self = 0, healed = 0, worst = 0, stole = 0;   // worst : PV perdus par nous-mêmes au pire
        const nh = { ...ehp };
        if (target) {
          const pass = shieldRule && !shieldUp ? shieldRule.pass / 100 : 1;
          const cm = tr.mult(x.c, { tgtId: target.id, tgtPct: nh[target.id] / Math.max(1, +target.maxHp || 1), selfPct: hp / maxHp })   // passif de classe
            * (pourpreLeft && x.isDmg && !x.weapon && !seq.some((q) => q.x.isDmg && !q.x.weapon) ? 2 : 1);
          const hit = (f, part) => {
            const e = cardEffect(x.c, p, f);
            // Reflet : la part de l'élément renvoyé ne le blesse pas et nous revient (ratio de l'affixe) ; Élément mouvant :
            // celle de l'élément immunisé ne le blesse pas (elle le soigne un peu)
            const rf = reflFrac(x.c, reflected.get(f.id), S0), bf = blockFrac(x.c, f.id, reflected, immune, S0);
            const bond = f.isBoss && bonds.find((g) => g !== f && nh[g.id] > 0);
            const d = Math.min(e.dmg * part * pass * cm * (1 - bf) * (bond ? 1 - (+affixOf(bond, 'soulbond').guard || 0) / 100 : 1), capOf(f) * x.nLines);
            const back = e.dmg * part * pass * cm * rf * reflBack(f);
            self += back;
            worst += back * specMax * REFL_MARGIN;
            if (mirrored.has(f.id)) { self += d; worst += d * specMax; return e; }   // Miroir : le coup nous revient
            const before = nh[f.id];
            const [toHp, shLeft] = throughShield(d, nh[`s:${f.id}`] || 0);
            nh[`s:${f.id}`] = shLeft;
            nh[f.id] -= toHp;
            gain += Math.min(before, toHp);
            // vol de vie : sur les dégâts réellement infligés à CHAQUE ennemi touché (zone comprise, Seuil et bouclier
            // déduits). Étage 151 (15247) : Dents du Piranya sous Malédiction des soins, 2 gardiens tués dans la zone →
            // 13 422 PV contre nous, alors que seule la cible principale (Minotot, sous Seuil) était comptée
            if (e.dmg > 0) stole += toHp * e.steal / e.dmg;
            if (nh[f.id] <= 0) {
              // Deuxième souffle : il se relève une fois avec x % de ses PV
              if (reviveAt[f.id] && !nh[`r:${f.id}`]) { nh[f.id] = (+f.maxHp || 0) * reviveAt[f.id] / 100; nh[`r:${f.id}`] = 1; }
              else {
                gain += incomingOf(f) + (+f.atk || 0);   // une attaque de moins à encaisser
                if (f.id === lead) gain += leadDelta * maxHp * LEAD_KILL_TURNS;   // ses mécaniques passent au suivant
              }
            }
            return e;
          };
          const eff = hit(target, 1);
          if (opt.fx) gain += opt.fx(x, target, seq);   // debuff (seul ou avec les dégâts)…
          // boss sous Gardiens dont ce sort abat tous les gardiens : les lignes suivantes le touchent (étage 127 : Traversée
          // sur un gardien, Gorgouille découverte en cours de sort, sa ligne Air renvoyée = 11 734 PV)
          const unguarded = (f) => guarded.has(f.id) && enemies.every((g) => g.ownerId !== f.id || nh[g.id] <= 0);
          const killed = nh[target.id] <= 0;
          if (x.zone) {
            // cible abattue pendant le sort : le premier autre ennemi touché devient la cible principale (100 %, pas 60 %) —
            // étage 126 : Traversée sur Gorgouille achevée, sa ligne Air pleine sur Fuji (Reflet Air) = 15 001 PV renvoyés
            let promo = killed;
            for (const f of enemies) if (f !== target && !guarded.has(f.id) && (nh[f.id] > 0 || mirrored.has(f.id))) { hit(f, promo ? 1 : ZONE_FALLOFF); promo = false; }
            for (const f of enemies) if (f !== target && unguarded(f) && nh[f.id] > 0) { hit(f, promo ? 1 : ZONE_FALLOFF); promo = false; }
          } else if (killed && x.nLines > 1) {
            // sort à une cible : les lignes restantes après sa mort partent sur le premier autre ennemi debout (100 %) ; on ne
            // compte que ce qu'il nous renverrait (étage 127 : Drain Élémentaire achève Shogun, ligne Air sur Gorgouille = 6 278)
            const next = enemies.find((f) => f !== target && nh[f.id] > 0 && (!guarded.has(f.id) || unguarded(f)));
            if (next) {
              const back = cardEffect(x.c, p, next).dmg * pass * cm * reflFrac(x.c, reflected.get(next.id), S0) * reflBack(next);
              self += back;
              worst += back * specMax * REFL_MARGIN;
            }
          }
          if (curse) { self += stole + eff.heal; worst += stole * specMax + eff.heal; }   // vols et soins blessent
          else healed += (stole + eff.heal) * (halfHeal ? 0.5 : 1) * keep;   // vol de vie : 50 % des dégâts rendus
          // retrait de PA : sa prochaine attaque Affaiblie (le coup annoncé compte déjà l'état actuel) ; l'état se cumule au fil
          // de la suite (deux retraits sur lui ce tour), et rien s'il tombe avant de frapper
          const apCut = apCutOf(x.c);
          if (apCut && nh[target.id] > 0) {
            const w0 = nh[`w:${target.id}`] ?? (+target.weaken || 0);
            gain += weakenValue(p, target, apCut, w0, dofus) * tr0.taken();
            nh[`w:${target.id}`] = Math.min(WEAKEN_MAX, w0 + AP_REMOVE_CUT * apCut);
          }
        } else if (cardKind(x.c) === 'heal') {
          const h = cardEffect(x.c, p, null).heal;
          if (curse) { self += h; worst += h; } else healed += h * (halfHeal ? 0.5 : 1) * keep;
        } else if (!x.shield && !apGainOf(x.c)) gain += opt.fx ? opt.fx(x, null, seq) : x.w * 5;   // buff… : valeur tirée de son poids
        // bouclier : PV épargnés sur les attaques à venir (une seule fois par tour)
        // bouclier : PV épargnés, comptés comme nos PV (× SELF_W, comme les PV perdus) ; relancé, il remplace ce qui reste
        // du précédent (l'Auto du jeu relance Vertu chaque tour : 3 046 à chaque fois)
        if (x.shield && !seq.some((q) => q.x.shield)) {
          const sh = shieldOf(x.c, p), left = (p.shields || []).reduce((t, z) => t + (+z.v || +z.value || +z.amount || 0), 0);
          gain += SELF_W * Math.max(0, Math.min(sh.v * keep, safety * sh.dur) - left);
        }
        if (x.shield && shieldRule && !shieldUp) gain += 5000;   // Peau dure : le bouclier d'abord
        const wave = ondePct > 0 && x.isDmg && !x.weapon && lastEl != null && x.firstEl === lastEl;
        if (wave) { self += maxHp * ondePct / 100; worst += maxHp * ondePct / 100; }
        // jamais en dessous de ce que les boss vont nous infliger à leur tour (sauf si la suite les tue tous)
        // soins (vols de vie compris) : PV rendus, plafonnés à ce qui manque, comptés comme nos PV (× SELF_W)
        const healUse = Math.max(0, Math.min(healed, maxHp - (hp - self)));
        gain += SELF_W * healUse;
        const left = hp - self + healUse;
        const killsAll = enemies.every((f) => nh[f.id] <= 0);
        // au pire (Vision spectrale, renvoi sous-estimé) : jamais en dessous de ce qui vient, ni à 0 même en finissant le combat
        const leftWorst = hp - worst + healUse;
        if (worst > 0 && leftWorst < safety && !(killsAll && leftWorst > 0)) continue;
        if (monoTurnDmg > 0 && cardLines(x.c) > 1 && tr.s.myTurns >= tr.s.monoFrom && !enemies.every((f) => nh[f.id] <= 0)) gain -= monoTurnDmg * monoLoss(tr.s.myTurns - tr.s.monoFrom);
        const tr2 = tr.clone();
        tr2.cast(x.c, { tgtId: target?.id });
        dfs([...seq, { x, target }], used | (1 << i), ap - cost + apGainOf(x.c), x.isDmg && !x.weapon ? x.lastEl : lastEl, count + (x.weapon ? 0 : 1),
          left, nh, shieldUp || x.shield, score + gain - SELF_W * self, tr2);
      }
    }
  };
  dfs([], 0, +p.ap || 0, startLast, cardsDone, +p.hp || 0, Object.fromEntries(enemies.flatMap((f) => [[f.id, +f.hp || 0], [`s:${f.id}`, enemyShield(f)]])), shieldUp0, 0, tr0);
  const first = best?.seq[0];
  return { pick: first?.x || null, target: first?.target || null, plan: best?.seq || [], notes, score: best?.s || 0 };
}
planTurn.lastEl = null;   // élément de la dernière ligne du dernier sort joué (si le jeu ne le donne pas)

// Étage d'Ascension lu sur un bouton (« Affronter l’étage 12 »).
const floorOf = (label) => +(label || '').match(/étage (\d+)/i)?.[1] || null;

// ---------- Mécaniques observées dans les combats (les nôtres et ceux des amis, via le Worker) ----------
// Le combat ne liste pas les mécaniques actives, mais le journal les annonce quand elles se déclenchent (t: 'mechanic').
// On garde ces observations par étage : au prochain essai (ou quand on atteint l'étage d'un ami), elles complètent les
// règles du bestiaire (mécanique manquante, tour exact du Miroir / des PA comptés / de l'Échange de vie).
// Reflet (Obsidiantre, Hell Mina…) : chaque tour, un élément annoncé à l'avance ne blesse pas le boss et une part de ces
// dégâts nous est renvoyée (50 % avant, 100 % depuis oct. 2026 : affixe reflect.ratio). Journal : « ce tour, les dégâts Eau
// lui sont renvoyés (tour suivant : Air) » en début de tour, « Reflet : X renvoie les dégâts Feu ! ».
// Élément mouvant : « ce tour, il est immunisé Terre (le frapper Terre le soigne) » en début de tour.
// Suivi rejoué ligne à ligne : cur (Reflet) et imm (Élément mouvant) = Map id du boss → élément (indice EL_STAT).
const EL_NAMES = ['Neutre', 'Terre', 'Feu', 'Eau', 'Air'];
const REFLECT_BACK = 0.5;
const reflBack = (f) => (+affixOf(f, 'reflect')?.ratio || REFLECT_BACK * 100) / 100;
function reflectTracker() {
  const cur = new Map(), next = new Map(), imm = new Map();
  const el = (s) => EL_NAMES.indexOf(s);
  return {
    cur, imm,
    line(L) {
      // nouveau tour : seul l'élément annoncé reste renvoyé (sans annonce, le Reflet s'arrête jusqu'au prochain message)
      if (L.t === 'round') { cur.clear(); imm.clear(); for (const [id, e] of next) cur.set(id, e); next.clear(); return; }
      if (L.t !== 'mechanic' || !L.who) return;
      const t = L.text || '';
      const i = t.match(/est immunisé (Neutre|Terre|Feu|Eau|Air)/);
      if (i) imm.set(L.who, el(i[1]));
      const m = t.match(/dégâts (Neutre|Terre|Feu|Eau|Air) lui sont renvoyés/) || t.match(/renvoie les dégâts (Neutre|Terre|Feu|Eau|Air)/);
      if (m) cur.set(L.who, el(m[1]));
      const n = t.match(/tour suivant : (Neutre|Terre|Feu|Eau|Air)/);
      if (n) next.set(L.who, el(n[1]));
    },
  };
}
// Bouclier total d'un combattant (format des boucliers selon les versions du jeu : value, v ou amount).
const shieldSum = (f) => (f.shields || []).reduce((t, x) => t + (+x.value || +x.v || +x.amount || 0), 0);
// Tour 1 : le jeu n'annonce l'élément renvoyé qu'après le premier coup ; l'affixe le donne (seed : élément du tour r =
// EL_NAMES[1 + (r + seed) % 4], étage 135 : seed 1 → Eau, Air, Terre, Feu). Sans ça, ~12 000 PV renvoyés au 1er tour.
const reflectNow = (st) => {
  const r = reflectTracker();
  for (const L of st.log || []) r.line(L);
  if ((+st.round || 1) === 1) {
    for (const f of Object.values(st.fighters || {})) {
      const seed = affixOf(f, 'reflect')?.seed;
      if (f.alive && Number.isInteger(seed) && !r.cur.has(f.id)) r.cur.set(f.id, 1 + (1 + seed) % 4);
    }
  }
  return r.cur;
};
const immuneNow = (st) => { const r = reflectTracker(); for (const L of st.log || []) r.line(L); return r.imm; };
// Part des lignes de dégâts d'une carte dans l'élément renvoyé (0 : pas concernée, 1 : entièrement renvoyée).
// statOf (caractéristiques du joueur) : élément « best » de l'arme résolu — sans lui, l'arme passait pour sans élément
// (étage 129 : Fureur de Gargandyas, Terre, jouée dans l'immunité Terre puis dans le Reflet Terre, ~5 600 PV renvoyés).
function reflFrac(card, el, statOf = null) {
  if (el == null || el < 0 || !card) return 0;
  const lines = damageLines(card, statOf).filter((l) => Number.isInteger(l.e.el) || (l.e.el === 'best' && statOf));
  return lines.length ? lines.filter((l) => l.el === el).length / lines.length : 0;
}
// Part d'une carte qui ne blesse pas f ce tour : élément renvoyé (Reflet) ou qui le soigne (Élément mouvant)
const blockFrac = (card, id, refl, imm, statOf = null) => Math.min(1, reflFrac(card, refl.get(id), statOf) + reflFrac(card, imm.get(id), statOf));

// ---------- Mécaniques annoncées (jeu, oct. 2026 : Ascension 50+, boss Transmutés 101+, Dimension écarlate…) ----------
// L'état de chaque boss les donne (f.affixes : carapace, guardians, wither, curse, seal, shift, exhaust, invert, grudge,
// phase, reflect, swap), le journal les annonce au tour 1 (« Boss — Nom : description ») puis à chaque déclenchement.
const affixOf = (f, k) => (f?.affixes || []).find((a) => a?.k === k);
// entrées du journal depuis le dernier début de tour (round) ou de NOTRE tour (turn p)
const logSince = (st, pred) => { const log = st.log || []; let i = log.length - 1; while (i >= 0 && !pred(log[i])) i--; return log.slice(i + 1); };
const sinceRound = (st) => logSince(st, (L) => L.t === 'round');
const sinceMyTurn = (st) => logSince(st, (L) => L.t === 'turn' && L.who === 'p');
// Gardiens : boss invulnérable tant qu'un de ses gardiens (ownerId) est debout → ids des boss intouchables maintenant
function guardedNow(st) {
  const F = Object.values(st.fighters || {});
  return new Set(F.filter((f) => f.alive && affixOf(f, 'guardians') && F.some((g) => g.alive && g.ownerId === f.id)).map((f) => f.id));
}
// Inversion : « Inversion de X (tour 1/2) : tes soins et tes boucliers te blessent ! » en début de tour
const invertNow = (st) => sinceRound(st).some((L) => L.t === 'mechanic' && /^Inversion de .*\(tour \d+\/\d+\)/.test(L.text || ''));
// Flétrissure : soins et boucliers réduits de x % tant que le boss est debout → part qui reste
const witherKeep = (st) => 1 - Math.max(0, ...Object.values(st.fighters || {}).filter((f) => f.alive).map((f) => +affixOf(f, 'wither')?.pct || 0)) / 100;
// Sceau (PA) : « ton premier sort du tour coûte +2 PA » (l'arme n'est pas concernée), annoncé au début de notre tour ;
// tant qu'aucun sort n'est lancé ce tour → surcoût du prochain sort
function sealApNow(st) {
  const L = sinceMyTurn(st);
  const m = L.map((x) => x.t === 'mechanic' && (x.text || '').match(/premier sort du tour coûte \+(\d+) PA/)).find(Boolean);
  if (!m) return 0;
  const w = st.fighters?.p?.weaponCard?.name;
  return L.some((x) => x.t === 'play' && x.who === 'p' && x.card !== w) ? 0 : +m[1];
}
// Épuisement final : sous x % de ses PV, il faut passer son tour N fois (aucune attaque, ni arme ni sort offensif), sinon il
// se soigne. Armé « à partir de ton prochain tour » : pas pendant le tour où il s'annonce (on peut encore l'achever).
function mustPassTurn(st) {
  const now = sinceMyTurn(st);
  return Object.values(st.fighters || {}).some((f) => f.alive && f.team !== st.fighters.p?.team && f.exhaustArmed && !f.exhaustDone
    && (+f.exhaustLeft || 0) > 0 && !now.some((L) => L.who === f.id && /Épuisement final !/.test(L.text || '')));
}

const MECH_TEXTS = [
  [/vous vole \d+ PA/i, 'Vol de PA'],
  [/soins vous blessent|soins sont divisés/i, 'Malédiction des soins'],
  [/se relève/i, 'Deuxième souffle'],
  [/renvoie le coup/i, 'Miroir'],
  [/scelle .* pour ce tour/i, 'Sceau'],
  [/échange sa vie/i, 'Échange de vie'],
  [/onde de choc/i, 'Onde de choc'],
  [/fureur|se déchaîne/i, 'Fureur'],   // « Koumiho se déchaîne ! » : plus de N cartes jouées dans le tour
  [/peau dure|sans bouclier/i, 'Peau dure'],
  [/perd patience|t.achève/i, 'Rage'],
  [/pulvérise .* d.un seul coup/i, 'PA comptés|Rage'],
  [/Reflet|lui sont renvoyés|renvoie les dégâts/i, 'Reflet'],
  [/Métamorphose/i, 'Métamorphose'],   // +20 % de résistances (buff, compté) et un gardien invoqué (nouvel ennemi)
  // mécaniques annoncées (oct. 2026) : messages de déclenchement
  [/Carapace/i, 'Carapace'],
  [/gardiens|n.est plus protégé/i, 'Gardiens'],
  [/Élément mouvant|est immunisé/i, 'Élément mouvant'],
  [/Épuisement final/i, 'Épuisement final'],
  [/Inversion/i, 'Inversion'],
  [/Rancune/i, 'Rancune'],
  [/est scellée pendant|prépare sa Malédiction/i, 'Malédiction'],
  [/premier sort (du tour|que tu lances).*coûte/i, 'Sceau (PA)'],   // pas l'ancien Sceau (carte scellée)
  [/Flétrissure/i, 'Flétrissure'],
  [/Échange de PV/i, 'Échange de PV'],   // affixe swap (Transmutés) : tous les N tours, pourcentages de PV échangés
  [/Tour passé\. Encore|à bout de forces/i, 'Épuisement final'],
  [/Seuil de douleur/i, 'Seuil de douleur'],
  [/Lien d.âme/i, 'Lien d’âme'],
  [/Écho/i, 'Écho'],
  [/Hâte/i, 'Hâte'],
  [/Accoutumance/i, 'Accoutumance'],
  [/Glas/i, 'Glas'],
  [/^Initiative :/i, 'Initiative'],   // Arène : l'adversaire le plus rapide joue en premier (pas une mécanique de boss)
];
// Annonce au tour 1 : « Glourséleste Transmuté — Carapace : bouclier de 15 % de ses PV… » → nom de la mécanique
const MECH_ANNOUNCE = /^.+? — ([^:]+?) : /;
const mechNameOf = (text) => {
  const t = text || '', ann = t.match(MECH_ANNOUNCE)?.[1]?.trim();
  if (/premier sort (du tour|que tu lances).*coûte/i.test(t)) return 'Sceau (PA)';
  return ann || MECH_TEXTS.find(([re]) => re.test(t))?.[1] || null;
};
// [{ monsterId, bossName, name (ou null : texte inconnu), round, text }]
function observedMechanics(st) {
  const out = [];
  let round = 0;
  for (const L of st.log || []) {
    if (L.t === 'round') round = +L.round || round;
    if (L.t !== 'mechanic' || !L.who || L.who === 'p') continue;
    const f = st.fighters?.[L.who];
    if (!f || f.team === st.fighters.p?.team) continue;
    const name = mechNameOf(L.text);
    if (!out.some((o) => o.monsterId === +f.monsterId && o.name === name && o.round === round)) {
      out.push({ monsterId: +f.monsterId, bossName: f.name, name, round, text: L.text });
    }
  }
  return out;
}
// Cause probable d'une défaite : mécanique qui nous a achevés, sinon l'attaque d'un boss (et nos auto-dégâts du combat).
function ascFailCause(st) {
  const log = st.log || [];
  let round = 0, self = 0, last = null;
  for (let i = 0; i < log.length; i++) {
    const L = log[i];
    if (L.t === 'round') round = +L.round || round;
    if (L.t === 'dmg' && L.who === 'p' && L.el === 0) self += +L.v || 0;   // onde, soins maudits, coups renvoyés
    if (L.t === 'mechanic' && /pulvérise|achève|perd patience/i.test(L.text || '')) last = { round, text: L.text };
  }
  if (last) return `tour ${last.round} : ${last.text}`;
  if (log.some((L) => L.t === 'end' && L.reason === 'flee')) return `abandon au tour ${round}`;
  const boss = Object.values(st.fighters || {}).find((f) => f.team !== st.fighters.p?.team && f.alive);
  return `PV à zéro au tour ${round}${boss ? ` (${boss.name} encore debout)` : ''}${self ? ` — ${Math.round(self)} PV perdus par nos propres sorts` : ''}`;
}
// Règles du bestiaire + observations [{ monsterId, name, round }] : mécanique observée absente des règles → ajoutée (texte
// du bestiaire pour ce boss) ; Miroir / PA comptés / Échange de vie → au(x) tour(s) observé(s).
function mergeObserved(rules, st, seen, list) {
  const out = rules.map((r) => ({ ...r }));
  for (const f of Object.values(st.fighters || {})) {
    if (f.team === st.fighters.p?.team || !f.isBoss || Array.isArray(f.rules)) continue;   // règles données par le combat
    const obs = (seen || []).filter((o) => +o.monsterId === +f.monsterId && o.name);
    if (!obs.length) continue;
    const b = list.find((x) => +x.id === +f.monsterId);
    for (const o of obs) {
      let name = o.name;
      if (name === 'PA comptés|Rage') name = b?.m.some((m) => m.n === 'PA comptés') ? 'PA comptés' : 'Rage';
      let r = out.find((x) => x.boss === f.id && x.name === name);
      if (!r) {
        const m = b?.m.filter((x) => x.n === name).at(-1);
        if (!m) continue;
        r = { boss: f.id, bossName: f.name, name, text: m.x, ...parseMechanic(m), learned: true };
        out.push(r);
      }
      if (r.k === 'mirror' && o.round) { r.from = Math.min(r.from, o.round); r.to = Math.max(r.to, o.round); r.seenRound = true; }
      if (r.k === 'apExact' && o.round) { r.turn = o.round; r.seenRound = true; }
      if (r.k === 'swap' && o.round) { r.turn = o.round; r.seenRound = true; }
    }
  }
  return out;
}
// Observations gardées pour l'étage (les nôtres, localStorage) : { étage: [{ at, status, diff, seen, cause }] }.
const ASC_SEEN_KEY = 'dmAscSeen';
function ascSeenOwn(floor) { try { return JSON.parse(localStorage.getItem(ASC_SEEN_KEY) || '{}')[floor] || []; } catch { return []; } }
function ascRemember(asc) {
  try {
    const all = JSON.parse(localStorage.getItem(ASC_SEEN_KEY) || '{}');
    all[asc.floor] = [...(all[asc.floor] || []), asc].slice(-10);
    localStorage.setItem(ASC_SEEN_KEY, JSON.stringify(all));
  } catch { /* stockage plein */ }
}
// Observations d'un étage : les nôtres + celles des amis (Worker, via le service worker ; 5 min de cache).
const ascSharedCache = {};
async function ascSeenAll(floor) {
  const own = ascSeenOwn(floor).map((a) => ({ ...a, player: 'toi' }));
  let shared = ascSharedCache[floor];
  if (!shared || Date.now() - shared.at > 5 * 60000) {
    const r = await send({ type: 'ascShared', floor }).catch(() => null);
    shared = ascSharedCache[floor] = { at: Date.now(), rows: r?.ok ? r.rows : [] };
  }
  const me = myName();
  return [...own, ...shared.rows.filter((x) => x.p !== me).map((x) => ({ ...x.d, at: x.at, status: x.status, player: x.p }))];
}
