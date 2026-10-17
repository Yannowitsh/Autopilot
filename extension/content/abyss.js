// Autopilot-DM — content script : Abysses (choix des sorts et des bonus, page /abysses, valeur des effets en combat).
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.
//
// Relevé le 16/10/2026 (abyss.har + code du site) :
// - /abysses : 1 000 étages de boss, équipement ignoré : 6 PA, 3 PM, 100 partout, 500 PV, une seule vie par descente.
//   Server actions : startAbyssRun(reprise?) (« Descendre », « Reprendre à l’étage N », « Nouvelle descente (étage 1) »),
//   chooseAbyss(index) (offre : props AbyssChoice { offer: { kind: 'spell'|'bonus', cards }, floor, newSpell }),
//   fightAbyssFloor() (« Combattre l’étage N » / « Affronter le boss Enragé de l’étage N » → /combat), saveAbyssDeck(ids)
//   (props AbyssDeck { spells, deck, deckSize: 10 } : un sort gagné entre dans le deck s’il reste de la place).
// - Sort au choix à l’étage 1 et après chaque boss Enragé (tous les 5 étages, combat manuel obligatoire), bonus de stat
//   sinon : { stat, v, r: rare|epique|legendaire, label } (pa, pm, po, puissance, critique, resPctAll, force…).
//   « Bonus cumulés » de la page : <li key=stat style={…}>+v …</li> (le style imbriqué empêchait la lecture avant la 2.32.1 :
//   tous les choix notés avec le build de départ).
// - Combat kind 'abyss' : multiCast 3 (chaque carte jusqu’à 3 fois par tour, played = lancers du tour), 2 sorts de soin ou
//   de bouclier par tour comme ailleurs (sustainThisTurn ; dégâts + soin compris), pas de bonus de deck ni « une ligne »,
//   pas de passifs de Dofus. PV max = 400 + Vitalité (644 → 763 pour +119, combats du 16/10). Presque toujours un seul
//   boss par étage (39 combats sur 40) : la zone ne compte que pour un quart d'ennemi de plus (invocations, rares groupes).
// - Fin de combat : « Choisir ma récompense » / « Retour aux Abysses » (lien /abysses) ; défaite = descente terminée.
// Évaluation (choix et deck) : un tour type, toutes les combinaisons de cartes (3 lancers chacune, arme 1 fois) dans les
// PA. Profondeur atteignable : coups (A) et PV (B) des boss du dernier combat multipliés par s, on gagne tant que nos dégâts
// sur le temps de survie couvrent ses PV : D × PV / (s·A − H) = s·B, avec H = soins + boucliers par tour (70 % utiles).
// Score = moitié ln(s), moitié ln(s sans soins) = ½ ln(D × PV / (B × A)) : sans cette seconde moitié, dès que les soins
// couvraient les coups, les dégâts ne comptaient presque plus (sorts de dégâts tous notés 0, Vitalité choisie partout).
// A : rés. %, esquive des PM, Affaibli des retraits de PA, invisibilité (attaque esquivée) comprises.
// Invisibilité à chaque tour : au plus 70 % des coups évités (frappes doubles, Rage, mécaniques…).
// Coup de grâce : un coup lourd après Rage vaut ~2,2 × l'attaque du boss avant résistances (2 449 pour 1 179 et 6 % de rés.,
// étage 60). La profondeur est aussi bornée par l'étage où ce coup dépasse PV + bouclier d'un lancer (s_one) : minimum doux
// des deux. Sans ça, les PV prenaient du retard (10,9 × l'attaque du boss à l'étage 10, 1,8 × à l'étage 60 : mort en un coup).
const ABYSS_PEAK = 2.2, ABYSS_SOFTMIN = 1.5;
const ABYSS_MULTI = 3, ABYSS_SUSTAIN = 2, ABYSS_S_MAX = 1e3, ABYSS_EVADE_MAX = 0.7, ABYSS_HEAL_USE = 0.7, ABYSS_ZONE_MIN = 0.25;
const ABYSS_BASE = { pa: 6, stats: { force: 100, intelligence: 100, chance: 100, agilite: 100, vitalite: 100 }, hpBase: 400 };
const abyssHp = (stats) => ABYSS_BASE.hpBase + (+stats.vitalite || 100);
const ABYSS_WEAPON = { id: 0, name: 'Coup de base', ap: 1, cc: 5, eff: [{ k: 'dmg', el: 0, min: 10, max: 14, tgt: 'enemy' }], weapon: true };
const ABYSS_REF_KEY = 'dmAbyssRef';
const ABYSS_DECK_FALLBACK = '402b44ff11a7ddf276e2eb711973ebe5b509834611';
const ABYSS_RARITY = { rare: 1, epique: 2, legendaire: 3 };
const ABYSS_NO_DOFUS = new Set();
const isAbyssFight = (st) => st?.kind === 'abyss';
// soin / bouclier (limite du jeu : 2 par tour)
const isSustainCard = (c) => isSupportCard(c);
const fxOnly = (c) => !damageLines(c).length && !(c.eff || []).some((e) => /heal|rewind/i.test(e?.k || '') && e.tgt !== 'enemy');   // buff, debuff, bouclier, invisibilité… : 1 fois par tour
const avgOf = (e) => ((+e.min || 0) + (+(e.max ?? e.min) || 0)) / 2;

// ---------- Ennemis de référence : ceux du dernier combat des Abysses ----------
function abyssNoteFight(st) {
  if (!isAbyssFight(st)) return;
  const p = st.fighters.p;
  const foes = Object.values(st.fighters).filter((f) => f.team !== p.team && f.id !== 'p')
    .map((f) => ({ id: f.id, atk: +f.atk || 0, element: f.element, stats: { ...f.stats }, resCap: +f.resCap || 100, maxHp: +f.maxHp || 0 }));
  try { localStorage.setItem(ABYSS_REF_KEY, JSON.stringify({ foes, weapon: p.weaponCard || null, at: Date.now() })); } catch { /* stockage plein */ }
}
function abyssRef() {
  let r = null;
  try { r = JSON.parse(localStorage.getItem(ABYSS_REF_KEY) || 'null'); } catch { /* rien */ }
  const res = Object.fromEntries(EL_RES_PCT.map((k) => [k, 7]));
  return { foes: r?.foes?.length ? r.foes : [{ id: 'b0', atk: 40, element: 1, stats: res, resCap: 100, maxHp: 200 }], weapon: r?.weapon || ABYSS_WEAPON };
}

// ---------- Évaluation d'un tour type ----------
// ctx : { cards, stats, ap, maxHp, foes, weapon }. Renvoie { score, D, T, plan }.
const abyssP = (stats, maxHp) => ({ id: 'p', team: 0, stats, maxHp, hp: maxHp, level: 200, buffs: [], cards: {}, resCap: 50, _fx: null });
function cardFeatures(c, p, foes) {
  const eff = c.eff || [];
  const spec = 1 + Math.min(1, SPECTRAL_PER_PO / 100 * (+p.stats.po || 0));   // vision spectrale : ×2
  const zone = eff.some((e) => e?.zone || e?.k === 'bomb' || e?.k === 'detonate');
  const fx0 = cardEffect(c, p, foes[0]);
  let d = fx0.dmg;
  if (zone) for (const f of foes.slice(1)) d += ZONE_FALLOFF * cardEffect(c, p, f).dmg;
  if (zone && foes.length < 2) d += ABYSS_ZONE_MIN * ZONE_FALLOFF * fx0.dmg;
  const sum = (k, pred = () => true) => eff.filter((e) => e?.k === k && pred(e));
  const summon = sum('summon').reduce((t, e) => {
    const S = fighterStat(p), el = Number.isInteger(e.el) ? e.el : 0;
    const res = Math.min(+foes[0].resCap || 100, +foes[0].stats?.[EL_RES_PCT[el]] || 0) / 100;
    return t + avgOf(e) * (1 + (S(EL_STAT[el]) + S('puissance')) / 100) * (1 - res);
  }, 0);
  return {
    c, ap: +c.ap || 0, d: d * spec, steal: fx0.steal * spec, heal: fx0.heal, sus: isSustainCard(c),
    shield: shieldOf(c, p), invis: eff.some((e) => e?.k === 'invisible'), apGain: apGainOf(c), cut: apCutOf(c),
    buffs: sum('buff', (e) => e.tgt !== 'enemy' && e.stat).map((e) => ({ stat: e.stat, v: avgOf(e), dur: +e.dur || 1 }))
      .concat(sum('stealStat').map((e) => ({ stat: e.stat, v: avgOf(e), dur: +e.dur || 1 }))),
    debuffs: sum('debuff', (e) => e.stat).concat(sum('stealStat')).map((e) => ({ stat: e.stat, v: avgOf(e), dur: +e.dur || 1 })),
    empower: sum('empower').reduce((t, e) => t + avgOf(e), 0) / 100,
    summon, summonTurns: Math.max(1, ...sum('summon').map((e) => +e.turns || 3)),
    selfCost: sum('selfDmgPct').reduce((t, e) => t + avgOf(e), 0) / 100 * (+p.maxHp || 0),
    fxOnly: fxOnly(c),
  };
}
// durée sur laquelle un effet qui dure est amorti (posé une fois pour plusieurs tours)
const amort = (dur) => Math.max(1, Math.min(3, dur));
function abyssTurn(ctx) {
  const foes = ctx.foes.map((f) => ({ ...f, team: 1, buffs: [], hp: f.maxHp }));
  const all = [...ctx.cards, ...(ctx.weapon ? [{ ...ctx.weapon, weapon: true }] : [])];
  const base = all.map((c) => cardFeatures(c, abyssP(ctx.stats, ctx.maxHp), foes));
  // effets « une fois par tour » qui changent les stats (buffs, debuffs) : chaque sous-ensemble, puis la meilleure suite
  const fx = ctx.noFx ? [] : base.filter((x) => x.fxOnly && (x.buffs.length || x.debuffs.length));
  const subsets = [];
  for (let m = 0; m < 1 << Math.min(fx.length, 5); m++) subsets.push(fx.filter((_, i) => m & (1 << i)));
  let best = null;
  for (const sub of subsets) {
    const stats = { ...ctx.stats }, fs = foes.map((f) => ({ ...f, stats: { ...f.stats } }));
    let apUsed = 0;
    for (const x of sub) {
      apUsed += x.ap / amort(Math.max(...x.buffs.concat(x.debuffs).map((b) => b.dur)));
      for (const b of x.buffs) stats[b.stat] = (+stats[b.stat] || 0) + b.v;
      for (const b of x.debuffs) for (const f of fs) f.stats[b.stat] = (+f.stats[b.stat] || 0) - b.v;
    }
    if (apUsed > ctx.ap + 1e-9) continue;
    const p = abyssP(stats, ctx.maxHp);
    const items = (sub.length ? all.map((c) => cardFeatures(c, p, fs)) : base).filter((x) => !(x.fxOnly && (x.buffs.length || x.debuffs.length)));
    const r = abyssKnap(items, ctx.ap - apUsed, p, fs, ctx);
    if (r && (!best || r.score > best.score)) best = { ...r, plan: [...sub.map((x) => x.c.name || x.c.n), ...r.plan] };
  }
  return best || { score: -Infinity, D: 0, T: 1, plan: [] };
}
// meilleure suite du tour (lancers multiples), PA éventuellement fractionnaires (effets amortis)
function abyssKnap(items, ap, p, foes, ctx) {
  const S = fighterStat(p), dodge = dodgeOf(S);
  const hits = foes.map((f) => hitOnPlayer(p, f, (+f.atk || 0) * 1.15, ABYSS_NO_DOFUS));   // attaque moyenne du motif
  const peaks = foes.map((f) => hitOnPlayer(p, f, (+f.atk || 0) * ABYSS_PEAK, ABYSS_NO_DOFUS));   // coup lourd après Rage
  const n = items.length, cnt = new Array(n).fill(0);
  let best = null;
  const leaf = () => {
    let D = 0, H = 0, sh = 0, cut = 0, evade = 0, cost = 0, topHit = 0;
    for (let i = 0; i < n; i++) {
      const k = cnt[i];
      if (!k) continue;
      const x = items[i];
      D += x.d * k + x.summon * k;
      topHit = Math.max(topHit, x.d);
      H += (x.heal + x.steal) * k;
      sh += x.shield.v / x.shield.dur * k;   // plus profond, les coups dépassent le bouclier : absorbé en entier
      cut += x.cut * k;
      evade += x.invis ? k : 0;
      cost += x.selfCost * k;
      D += x.empower * topHit * k;
    }
    const wk = Math.min(WEAKEN_MAX, AP_REMOVE_CUT * cut);
    const avoided = ABYSS_EVADE_MAX * Math.min(1, evade / Math.max(1, hits.length));
    const A = hits.reduce((t, h) => t + h, 0) * (1 - dodge) * (1 - wk) * (1 - avoided);
    const Hs = (H + sh) * ABYSS_HEAL_USE - cost, B = Math.max(1, foes.reduce((t, f) => t + (+f.maxHp || 0), 0)), M = ctx.maxHp;
    const sc = A > 1e-6 ? (B * Hs + Math.sqrt(Math.max(0, (B * Hs) ** 2 + 4 * B * A * Math.max(1, D) * M))) / (2 * B * A) : ABYSS_S_MAX;
    const burst = A > 1e-6 ? Math.sqrt(Math.max(1, D) * M / (B * A)) : ABYSS_S_MAX;
    const sMix = Math.exp(0.5 * Math.log(Math.min(ABYSS_S_MAX, Math.max(1e-6, sc))) + 0.5 * Math.log(Math.min(ABYSS_S_MAX, Math.max(1e-6, burst))));
    const peak = Math.max(1, ...peaks) * (1 - avoided), shield1 = Math.max(0, ...items.filter((x, i) => cnt[i]).map((x) => x.shield.v));
    const sOne = (M + shield1 * ABYSS_HEAL_USE) / peak;
    const score = -Math.log(sMix ** -ABYSS_SOFTMIN + sOne ** -ABYSS_SOFTMIN) / ABYSS_SOFTMIN;
    if (!best || score > best.score) best = { score, D, T: A > Hs ? M / (A - Hs) : Infinity, plan: items.flatMap((x, i) => Array(cnt[i]).fill(x.c.name || x.c.n)) };
  };
  const dfs = (i, apLeft, sus) => {
    if (i === n) return leaf();
    const x = items[i];
    const max = x.c.weapon || x.fxOnly ? 1 : ABYSS_MULTI;
    for (let k = 0; k <= max; k++) {
      const a = apLeft - k * (x.summon ? x.ap / amort(x.summonTurns) : x.ap) + k * x.apGain;
      if (k && (a < -1e-9 || (x.sus && sus + k > ABYSS_SUSTAIN))) break;
      cnt[i] = k;
      dfs(i + 1, a, sus + (x.sus ? k : 0));
    }
    cnt[i] = 0;
  };
  dfs(0, ap, 0);
  return best;
}

// Build actuel : stats de base + « Bonus cumulés »
function abyssBuild(bonus, cards) {
  const stats = { ...ABYSS_BASE.stats };
  for (const [k, v] of Object.entries(bonus)) if (k !== 'pa') stats[k] = (+stats[k] || 0) + v;
  const ref = abyssRef();
  return { cards, stats, ap: ABYSS_BASE.pa + (+bonus.pa || 0), maxHp: abyssHp(stats), foes: ref.foes, weapon: ref.weapon };
}
const withBonus = (ctx, b) => {
  const stats = { ...ctx.stats };
  if (b.stat !== 'pa') stats[b.stat] = (+stats[b.stat] || 0) + (+b.v || 0);
  return { ...ctx, stats, ap: ctx.ap + (b.stat === 'pa' ? +b.v || 0 : 0), maxHp: b.stat === 'vitalite' ? abyssHp(stats) : ctx.maxHp };
};
// PA jouables au plus : 3 lancers de chaque sort + l'arme
const abyssApCap = (ctx) => ctx.cards.reduce((t, c) => t + ABYSS_MULTI * (+c.ap || 0), 0) + (ctx.weapon ? +ctx.weapon.ap || 0 : 0);

// Offre → index choisi (et le détail des scores pour le journal)
function abyssPickOffer(offer, ctx, deckSize = 10) {
  const base = abyssTurn(ctx).score;
  const later = { ...ctx, ap: ctx.ap + 2 };   // PA à venir : un sort efficace sert encore quand les PA montent
  const baseLater = abyssTurn(later).score;
  const scored = offer.cards.map((c, i) => {
    let s;
    if (offer.kind === 'spell') {
      const cards = abyssBestDeck([...ctx.cards, c], ctx, deckSize);
      s = abyssTurn({ ...ctx, cards }).score - base + 0.25 * (abyssTurn({ ...later, cards }).score - baseLater);
    } else {
      const next = withBonus(ctx, c);
      s = abyssTurn(next).score - base;
      // PA : prioritaires tant qu'ils restent jouables (les prochains sorts s'en serviront)
      if (c.stat === 'pa' && abyssApCap(ctx) >= next.ap) s = Math.max(s, 0.6 * Math.log(next.ap / ctx.ap));
    }
    // départage (gains égaux) : dégâts du sort seul par PA ; un soin / bouclier de plus (2 par tour au plus, vols de vie non
    // comptés : jusqu'à 5 vols dans un tour, combats du 16/10) passe derrière quand le deck en a déjà un
    const extraSup = offer.kind === 'spell' && isSupportCard(c) && ctx.cards.some((k) => isSupportCard(k));
    const alone = offer.kind === 'spell' ? abyssTurn({ ...ctx, cards: [c], weapon: null, ap: Math.max(+c.ap || 1, ctx.ap) }).D / Math.max(1, ctx.ap) * (extraSup ? 0.5 : 1) : 0;
    return { i, s: Number.isFinite(s) ? s : -1, name: c.n || c.label, r: ABYSS_RARITY[c.r] || 0, alone };
  });
  scored.sort((a, b) => b.s - a.s || b.alone - a.alone || b.r - a.r);
  return scored;
}
// Les deckSize meilleurs sorts (échanges un à un tant que le tour type s'améliore)
// Les cartes que le tour type n'utilise pas valent toutes 0 : départage par les dégâts par PA du sort seul (un soin / bouclier
// de plus compte moitié), sinon un sort faible déjà dans le deck n'était jamais remplacé.
function abyssBestDeck(spells, ctx, deckSize) {
  if (spells.length <= deckSize) return spells;
  const solo = new Map(spells.map((c) => [c, abyssTurn({ ...ctx, cards: [c], weapon: null }).D / Math.max(1, ctx.ap) * (isSupportCard(c) ? 0.5 : 1)]));
  const top = Math.max(1, ...solo.values());
  const val = (d) => abyssTurn({ ...ctx, cards: d }).score + 1e-3 * d.reduce((t, c) => t + solo.get(c) / top, 0);
  let deck = spells.slice(0, deckSize), cur = val(deck);
  for (let pass = 0; pass < deckSize; pass++) {
    let swap = null;
    for (const out of spells.filter((c) => !deck.includes(c))) {
      for (let j = 0; j < deck.length; j++) {
        const next = deck.map((c, k) => (k === j ? out : c));
        const s = val(next);
        if (s > cur + 1e-7 && (!swap || s > swap.s)) swap = { s, next };
      }
    }
    if (!swap) break;
    deck = swap.next; cur = swap.s;
  }
  return deck;
}

// ---------- En combat : valeur (en PV) des effets sans dégâts, pour le plan du tour ----------
// Invisibilité : la prochaine attaque esquivée ; buff / debuff : dégâts gagnés sur sa durée (au plus le temps d'abattre les
// ennemis) ; Portail (empower) : son % sur la plus grosse carte ; invocation : ses coups sur ses tours.
function abyssFx(st, x, tg, seq) {
  const c = x.c;
  if (seq.some((q) => q.x.c.uid === c.uid)) return 0;
  if (Object.values(st.fighters).some((f) => (f.buffs || []).some((b) => b.source === c.uid && +b.turns > 0))) return 0;   // encore actif
  const memo = st._abyssFx || (st._abyssFx = new Map()), mk = `${c.uid}|${tg?.id || ''}`;
  if (!memo.has(mk)) memo.set(mk, abyssFxRaw(st, c, tg));
  return memo.get(mk);
}
function abyssFxRaw(st, c, tg) {
  const p = st.fighters.p, eff = c.eff || [];
  if (!eff.some((e) => ['invisible', 'stun', 'empower', 'summon'].includes(e?.k) || (e?.stat && ['buff', 'debuff', 'stealStat'].includes(e.k)))) return 0;
  const foes = Object.values(st.fighters).filter((f) => f.team !== p.team && f.alive && f.id !== 'p');
  if (!foes.length) return 0;
  const S = fighterStat(p);
  let v = 0;
  if (eff.some((e) => e?.k === 'invisible') && !(+p.evade > 0)) {
    const hit = Math.max(0, ...foes.map((f) => hitOnPlayer(p, f, rawNextOf(f), ABYSS_NO_DOFUS)));
    v += SELF_W * hit * (1 - dodgeOf(S));
  }
  if (eff.some((e) => e?.k === 'stun')) v += SELF_W * Math.max(0, ...foes.filter((f) => !f.stunImmune).map((f) => hitOnPlayer(p, f, rawNextOf(f), ABYSS_NO_DOFUS)));
  const stats = Object.fromEntries(Object.keys({ ...p.stats, ...Object.fromEntries((p.buffs || []).map((b) => [b.stat, 0])) }).map((k) => [k, S(k)]));
  const foe = tg || foes[0];
  const fStats = (f) => Object.fromEntries(Object.keys({ ...f.stats, ...Object.fromEntries((f.buffs || []).map((b) => [b.stat, 0])) }).map((k) => [k, fighterStat(f)(k)]));
  const ctx = { cards: Object.values(p.cards || {}), stats, ap: Math.max(+p.basePa || 6, +p.ap || 0), maxHp: +p.maxHp || 500,
    foes: [foe, ...foes.filter((f) => f !== foe)].map((f) => ({ ...f, stats: fStats(f) })), weapon: p.weaponCard, noFx: true };
  const dmgOf = (cx) => { const r = abyssTurn({ ...cx, foes: cx.foes }); return r.D; };
  const D = dmgOf(ctx);
  const ehp = foes.reduce((t, f) => t + (+f.hp || 0) + shieldSum(f), 0);
  const turns = (dur) => Math.max(1, Math.min(dur, Math.ceil(ehp / Math.max(1, D))));
  for (const e of eff) {
    if (!e?.stat || !['buff', 'debuff', 'stealStat'].includes(e.k)) continue;
    const self = e.k !== 'debuff' && e.tgt !== 'enemy', amt = avgOf(e);
    const cx = self ? { ...ctx, stats: { ...stats, [e.stat]: (+stats[e.stat] || 0) + amt } }
      : { ...ctx, foes: ctx.foes.map((f, i) => (i ? f : { ...f, stats: { ...f.stats, [e.stat]: (+f.stats[e.stat] || 0) - amt } })) };
    v += Math.max(0, dmgOf(cx) - D) * turns(+e.dur || 1);
    // résistances sur soi : PV épargnés sur les coups à venir
    if (self && /^res/.test(e.stat)) {
      const hitNow = foes.reduce((t, f) => t + hitOnPlayer(p, f, rawNextOf(f), ABYSS_NO_DOFUS), 0);
      const p2 = { ...p, _fx: null, stats: { ...p.stats, [e.stat]: (+p.stats[e.stat] || 0) + amt } };
      const hitThen = foes.reduce((t, f) => t + hitOnPlayer(p2, f, rawNextOf(f), ABYSS_NO_DOFUS), 0);
      v += SELF_W * Math.max(0, hitNow - hitThen) * turns(+e.dur || 1);
    }
  }
  const emp = eff.filter((e) => e?.k === 'empower').reduce((t, e) => t + avgOf(e), 0) / 100;
  if (emp) v += emp * Math.max(0, ...ctx.cards.map((k) => cardEffect(k, p, foe).dmg));
  for (const e of eff.filter((q) => q?.k === 'summon')) {
    const el = Number.isInteger(e.el) ? e.el : 0;
    v += avgOf(e) * (1 + (S(EL_STAT[el]) + S('puissance')) / 100) * turns(+e.turns || 3);
  }
  return v;
}
// Mécaniques annoncées des boss des Abysses (fighters[].rules du jeu : maxCards, mirror, healCurse, sameElement, hpSwap,
// exactAp, revive, enrage, silence…) → règles du plan du tour, traduites comme en Ascension (stateRule). Avant la 2.32.2, elles
// passaient brutes : seul Deuxième souffle était compris (Miroir, Malédiction des soins, Fureur, Onde de choc ignorés).
const abyssRules = (st) => fightMechanics(st, [], null);
// Lancers multiples (multiCast) : chaque carte autant de fois qu'il lui reste de lancers ce tour (copies consécutives, la
// recherche les prend dans l'ordre) ; buffs, debuffs, boucliers, invisibilité : une fois.
function expandCasts(p, cand) {
  const multi = Math.max(1, +p.multiCast || 1);
  const out = [];
  for (const x of cand) {
    const left = x.weapon ? 1 : Math.max(0, multi - (p.played || []).filter((u) => u === x.c.uid).length);
    const n = x.weapon || fxOnly(x.c) && !(x.c.eff || []).some((e) => /shield|bouclier/i.test(e?.k || '')) ? Math.min(1, left) : left;
    for (let k = 0; k < n; k++) out.push(k ? { ...x, dup: out.length - 1 } : x);
  }
  return out;
}

// ---------- Page /abysses ----------
const ABYSS_FIGHT = /^(Combattre l.étage|Affronter le boss Enragé de l.étage) (\d+)$/;
const ABYSS_START = /^(Reprendre à l.étage \d+|Descendre|Nouvelle descente \(étage 1\))$/;
const ABYSS_END_LINK = /^(Choisir ma récompense|Retour aux Abysses|Page des Abysses)/;
const ABYSS_QUICK = () => 400 + Math.random() * 600;   // pause courte, comme un joueur qui enchaîne
// deck revu avant chaque étage (une fois par chargement de page, et après un sort choisi) quand des sorts attendent hors du deck
let abyssClickAt = 0, abyssDeckChecked = false;
const abyssWaiting = () => [...document.querySelectorAll('h4')].some((h) => /^Mes autres sorts/.test(h.textContent.trim()));

async function abyssData() {
  const { flight, chunks } = await fetchFlight('/abysses');
  const choice = rscProps(flight, (x) => x && typeof x === 'object' && 'offer' in x && 'newSpell' in x);
  const deck = rscProps(flight, (x) => x && typeof x === 'object' && 'deckSize' in x && Array.isArray(x.deck));
  const bonus = {};
  const seg = flight.slice(flight.indexOf('Bonus cumulés'), flight.indexOf('Bonus cumulés') + 4000);
  if (flight.includes('Bonus cumulés')) for (const m of seg.matchAll(/\["\$","li","(\w+)",\{(?:[^{}]|\{[^{}]*\})*?"children":"([+\-−]?)\s*(\d+(?:[.,]\d+)?)/g)) bonus[m[1]] = (m[2] && m[2] !== '+' ? -1 : 1) * +m[3].replace(',', '.');
  return {
    chunks, bonus,
    offer: choice.props ? rscDeep(choice.rows, choice.props.offer) : null,
    floor: +choice.props?.floor || null,
    spells: deck.props ? rscDeep(deck.rows, deck.props.spells) || [] : [],
    deck: deck.props ? rscDeep(deck.rows, deck.props.deck) || [] : [],
    deckSize: +deck.props?.deckSize || 10,
  };
}

async function abyssPage() {
  if (location.pathname !== '/abysses') return goHome();
  progress();
  if (Date.now() - abyssClickAt < 4000) return;   // choix ou lancement en cours
  const choices = visibleButtons().filter((b) => /— touche \d$/.test(b.getAttribute('aria-label') || '') && !b.disabled);
  if (choices.length) {
    const data = await abyssData();
    if (!data.offer?.cards?.length) return setStatus('Abysses : offre illisible — on attend…', true);
    const deckCards = data.spells.filter((s) => data.deck.includes(s.id));
    const ctx = abyssBuild(data.bonus, deckCards);
    const ranked = abyssPickOffer(data.offer, ctx, data.deckSize);
    const pick = ranked[0];
    DM.log(`Abysses : ${data.offer.kind === 'spell' ? 'sort' : 'bonus'} — ${ranked.map((r) => `${r.name} ${r.s.toFixed(3)}`).join(' · ')} → ${pick.name}`);
    abyssRecord(data, ranked, ctx);
    setStatus(`Abysses : choix « ${pick.name} »…`);
    await sleep(ABYSS_QUICK());
    const btn = isOwner() && visibleButtons().find((b) => new RegExp(`— touche ${pick.i + 1}$`).test(b.getAttribute('aria-label') || '') && !b.disabled);
    if (!btn) return;
    await save({ abyssLive: true });
    abyssClickAt = Date.now();
    if (data.offer.kind === 'spell') abyssDeckChecked = false;
    btn.click();
    // choix enregistré : la page se rafraîchit (~0,5 s) et affiche le bouton de l'étage → lancé aussitôt
    for (let i = 0; i < 40 && !findBtn(ABYSS_FIGHT); i++) { progress(); await sleep(200); }
    if (findBtn(ABYSS_FIGHT)) return abyssLaunch(true);
    return;
  }
  if (findBtn(ABYSS_FIGHT)) return abyssLaunch(false);
  const start = findBtn(ABYSS_START);
  if (start) {
    // descente finie sans qu'on ait vu la défaite (page rechargée, fuite…) : pas de nouvelle descente toute seule
    if (cfg.abyssLive === true) return abyssStop('descente des Abysses terminée');
    if (!(await gate())) return progress();
    const resume = findBtn(/^Reprendre à l.étage \d+$/) || start;
    setStatus(`Abysses : ${btnText(resume).toLowerCase()}…`);
    await sleep(humanDelay());
    if (!isOwner()) return;
    await save({ abyssLive: true });
    abyssClickAt = Date.now();
    resume.click();
    return;
  }
  const off = visibleButtons().find((b) => b.disabled && /Pas assez d.énergie/.test(btnText(b)));
  if (off) { lastEnergyCheck = 0; if (!(await gate())) return progress(); }
  if (Date.now() - loadedAt > 20000) setStatus('Abysses : aucun bouton reconnu sur la page', true);
}

// Lancement de l'étage (quick : juste après un choix, sans le délai entre deux combats)
async function abyssLaunch(quick) {
  if (cfg.abyssLive !== true) await save({ abyssLive: true });
  // deck plein : les meilleurs sorts dedans (une fois après chaque nouveau sort)
  if (!abyssDeckChecked) {
    abyssDeckChecked = true;
    if (abyssWaiting() && await abyssFixDeck()) return;
  }
  const fight = findBtn(ABYSS_FIGHT);
  if (!fight) return;
  const [, kind, floor] = btnText(fight).match(ABYSS_FIGHT);
  setStatus(`Abysses : ${/boss/.test(kind) ? `boss Enragé de l’étage ${floor}` : `étage ${floor}`}…`);
  await sleep(launchDelay(quick ? ABYSS_QUICK() : humanDelay()));
  const btn = isOwner() && findBtn(ABYSS_FIGHT);
  if (!btn) return;
  await save({ botFight: true });
  lastAutoClick = 0;
  markLaunch();
  abyssClickAt = Date.now();
  btn.click();
  await sleep(3000);
}

// Avant chaque étage, sorts en attente (« Mes autres sorts ») : le deck garde les 10 meilleurs pour le build du moment (stats,
// PA, boss du dernier combat), toujours plein ; les sorts inutiles restent de côté (saveAbyssDeck) ; true si la page est rechargée.
async function abyssFixDeck() {
  try {
    const data = await abyssData();
    if (data.spells.length <= data.deck.length) return false;   // aucun sort en attente
    const ctx = abyssBuild(data.bonus, []);
    const inDeck = data.deck.map((id) => data.spells.find((s) => s.id === id)).filter(Boolean);
    const best = abyssBestDeck([...inDeck, ...data.spells.filter((s) => !data.deck.includes(s.id))], ctx, data.deckSize);
    const ids = best.map((c) => c.id);
    if (ids.every((id) => data.deck.includes(id))) return false;
    const id = await findAction(data.chunks, 'saveAbyssDeck', ABYSS_DECK_FALLBACK);
    await callAction('abysses', id, [ids]);
    DM.log(`Abysses : deck — ${inDeck.filter((c) => !ids.includes(c.id)).map((c) => c.n).join(', ')} remplacé par ${best.filter((c) => !data.deck.includes(c.id)).map((c) => c.n).join(', ')}`);
    location.reload();
    return true;
  } catch (e) {
    DM.log(`Abysses : deck non enregistré (${e.message})`);
    return false;
  }
}

async function abyssStop(why, floor = null) {
  await save({ enabled: false, paused: false, botFight: false, abyssLive: false, status: `Arrêté : ${why}${floor ? ` (étage ${floor})` : ''}` });
  notify('defeat', `🕳️ Abysses : ${why}${floor ? ` à l’étage **${floor}**` : ''}. Pilote arrêté.\n${DM.ORIGIN}/abysses`);
}

// Écran de fin d'un combat des Abysses
async function abyssEnd(end) {
  const mine = [...document.querySelectorAll('a')].some((a) => ABYSS_END_LINK.test(a.textContent.trim()));
  if (!mine) return goHome();
  const won = endWon(end);
  if (cfg.botFight) {
    timeFightEnd();
    await save({ botFight: false, ...(won ? { wins: (cfg.wins || 0) + 1, lossStreak: 0 } : { losses: (cfg.losses || 0) + 1 }) });
    if (!won) {
      const floor = document.body.innerText.match(/Descente terminée : étage (\d+)/)?.[1] || null;
      DM.log(`Abysses : descente terminée${floor ? ` à l’étage ${floor}` : ''}`);
      return abyssStop('descente des Abysses terminée', floor);
    }
  }
  return goHome();
}

// ---------- Compte rendu des choix (menu 🤖 → 🕳️ Compte rendu des Abysses) ----------
// Chaque choix : étage, propositions (texte court, note), choix fait, build du moment. localStorage de la page, 5 dernières
// descentes. « Copier » donne un texte à recoller à Claude pour revoir les choix.
const ABYSS_LOG_KEY = 'dmAbyssLog', ABYSS_LOG_RUNS = 5;
const abyssLogRead = () => { try { return JSON.parse(localStorage.getItem(ABYSS_LOG_KEY) || '[]'); } catch { return []; } };
function abyssCardText(c) {
  const el = (e) => (e.el === 'best' ? 'meilleur élément' : e.el === 'worst' ? 'pire élément' : ELEMENTS[+e.el || 0]?.name || '');
  const r = (e) => (+e.min === +(e.max ?? e.min) ? `${e.min}` : `${e.min}–${e.max}`);
  const dur = (e) => (+e.dur > 0 ? ` (${e.dur} t.)` : '');
  const lines = (c.eff || []).map((e) => {
    switch (e?.k) {
      case 'dmg': return `${r(e)} ${el(e)}${e.zone ? ' zone' : ''}`;
      case 'steal': return `vol ${r(e)} ${el(e)}${e.zone ? ' zone' : ''}`;
      case 'heal': return `soin ${r(e)}`;
      case 'healPct': return `soin ${r(e)} % PV`;
      case 'shieldLvl': case 'shieldHp': return `bouclier${dur(e)}`;
      case 'invisible': return 'invisibilité';
      case 'buff': return `+${r(e)} ${e.stat}${dur(e)}`;
      case 'debuff': return `−${r(e)} ${e.stat} cible${dur(e)}`;
      case 'apGain': return `+${r(e)} PA`;
      case 'apRemove': return `−${r(e)} PA cible`;
      case 'summon': return `invocation ${r(e)} ${el(e)}`;
      default: return e?.k || '';
    }
  }).filter(Boolean);
  return `${c.ap} PA · ${[...new Set(lines)].join(', ')}`;
}
function abyssRecord(data, ranked, ctx) {
  const runs = abyssLogRead();
  const floor = data.floor || 0, last = runs.at(-1)?.entries.at(-1);
  // après un boss Enragé : bonus puis sort au même étage → nouvelle descente seulement si l'étage redescend
  if (!runs.length || !last || floor < last.floor) runs.push({ start: Date.now(), entries: [] });
  const best = ranked[0];
  runs.at(-1).entries.push({
    at: Date.now(), floor, kind: data.offer.kind,
    build: `${ctx.ap} PA · ${Math.round(ctx.maxHp)} PV`,
    deck: data.offer.kind === 'spell' ? ctx.cards.map((c) => c.n || c.name) : undefined,
    opts: data.offer.cards.map((c, i) => {
      const r = ranked.find((x) => x.i === i);
      return { name: c.n || c.label, info: data.offer.kind === 'spell' ? abyssCardText(c) : c.r, s: +(r?.s ?? 0).toFixed(3), picked: i === best.i };
    }),
  });
  try { localStorage.setItem(ABYSS_LOG_KEY, JSON.stringify(runs.slice(-ABYSS_LOG_RUNS))); } catch { /* stockage plein */ }
}
const abyssDate = (t) => new Date(t).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
function abyssLogText(runs) {
  return runs.map((run) => [`Descente du ${abyssDate(run.start)}`, ...run.entries.map((e) =>
    `étage ${e.floor} ${e.kind === 'spell' ? 'sort' : 'bonus'} [${e.build}${e.deck ? ` · deck : ${e.deck.join(', ')}` : ''}] : `
    + e.opts.map((o) => `${o.picked ? '✔ ' : ''}${o.name}${e.kind === 'spell' ? ` (${o.info})` : ''} ${o.s.toFixed(3)}`).join(' | '))].join('\n')).join('\n\n');
}
function openAbyssLog() {
  document.querySelector('.dm-picker')?.remove();
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const runs = abyssLogRead();
  const ov = document.createElement('div');
  ov.className = 'dm-picker';
  ov.style.cssText = 'position:fixed;inset:0;z-index:2147483600;background:#000a;display:grid;justify-items:center;align-items:start;padding:4vh 16px 16px;font:13px system-ui,sans-serif;color:#eee;overflow:auto';
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  const rar = { rare: '#6aa6e8', epique: '#b07ee8', legendaire: '#e8c46a' };
  const opt = (e, o) => `<div style="flex:1 1 150px;padding:5px 8px;border-radius:8px;border:1px solid ${o.picked ? '#7bc96f' : '#4a3d2c'};background:${o.picked ? '#24361f' : '#211b14'}">
      <div>${o.picked ? '✔ ' : ''}<b>${esc(o.name)}</b> <span style="color:#998">${o.s.toFixed(3)}</span></div>
      <div style="font-size:11px;color:${e.kind === 'spell' ? '#bba' : rar[o.info] || '#bba'}">${esc(o.info || '')}</div></div>`;
  const entry = (e) => `<div style="border-top:1px solid #3a3024;padding:6px 0">
      <div style="color:#bba"><b style="color:#eee">Étage ${esc(e.floor)}</b> · ${e.kind === 'spell' ? 'sort' : 'bonus'} · ${esc(e.build)}${e.deck ? ` · deck : ${esc(e.deck.join(', ') || '—')}` : ''}</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px">${e.opts.map((o) => opt(e, o)).join('')}</div></div>`;
  const body = runs.length ? [...runs].reverse().map((run, k) => `
    <details ${k === 0 ? 'open' : ''} style="margin-top:8px"><summary style="cursor:pointer;font-weight:700">Descente du ${esc(abyssDate(run.start))} — ${run.entries.length} choix, jusqu’à l’étage ${esc(run.entries.at(-1)?.floor ?? '?')}</summary>
    ${run.entries.map(entry).join('')}</details>`).join('')
    : '<p style="color:#bba">Aucun choix enregistré pour l’instant : ils apparaissent ici dès la prochaine descente pilotée.</p>';
  ov.innerHTML = `<div style="background:#1d1812;border:1px solid #5a4a33;border-radius:14px;padding:16px;max-width:760px;width:100%">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><b style="font-size:15px;flex:1">🕳️ Compte rendu des Abysses</b>
      <button data-a="copy">📋 Copier (pour Claude)</button><button data-a="clear">Effacer</button><button data-a="close">✕</button></div>
    <div style="color:#998;font-size:12px;margin-top:4px">Chaque choix fait par le pilote (✔), face aux autres propositions ; le chiffre est la note (gain de profondeur atteignable). Les 5 dernières descentes sont gardées.</div>
    ${body}</div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-a=close]').addEventListener('click', close);
  ov.querySelector('[data-a=copy]').addEventListener('click', async (ev) => {
    try { await navigator.clipboard.writeText(abyssLogText(runs)); ev.target.textContent = '✔ Copié'; } catch { ev.target.textContent = 'Copie impossible'; }
  });
  ov.querySelector('[data-a=clear]').addEventListener('click', () => { try { localStorage.removeItem(ABYSS_LOG_KEY); } catch { /* rien */ } close(); });
}
