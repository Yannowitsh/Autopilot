// Autopilot-DM — content script : préparation d'un étage d'Ascension (boss, mécaniques, deck conseillé).
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.
//
// La page /ascension donne l'étage (props { floor }), la difficulté (« difficulté Cauchemar »), les 3 boss (<li key=monsterId>)
// et les decks ({ active, decks: [{ label, size, names }] }). Le conseiller simule des tours avec un deck de 7 cartes
// (minimum du jeu ; toute la main jouable, la pioche en couvre l'essentiel) contre ces boss — mécaniques comprises, via planTurn — et cherche dans la collection les échanges
// de cartes qui améliorent le score (dégâts utiles + boucliers − PV perdus). « Appliquer » enregistre le deck dans un
// emplacement (saveDeck sur /deck) puis l'active (selectDeck sur /ascension).
const ASC_DECK_SIZE = 7;   // minimum du jeu (un deck de 5 était refusé)
const ASC_DECK_SLOT = 5;   // Deck 6 : réservé au deck conseillé
const SELECT_DECK_FALLBACK = '4073c2992e75439598aa66fea0fe140b07a9d11302';
// boss inconnus avant le combat ; chaque boss « mène » (ses mécaniques s'appliquent) pendant 2 tours : 1-2, 3-4, 5-6
const ASC_SIM = { hpPct: 0.7, bossHp: 15000, bossAtk: 1700, bossRes: 30, roundsPerBoss: 2 };

// Étage, difficulté, boss et decks de la page Ascension.
async function readAscPage() {
  const { flight, chunks } = await fetchFlight('/ascension');
  const floor = +(flight.match(/"floor":(\d+)/)?.[1] || 0) || null;
  const diff = flight.match(/"children":"(Initiation|Facile|Normale|Difficile|Cauchemar)"\}\]/)?.[1] || null;
  const ids = [...flight.matchAll(/\["\$","li","(\d+)",\{"className":"[^"]*border-ember/g)].map((m) => +m[1]);
  const names = [...flight.matchAll(/"src":"\/img\/monsters\/\d+\.png","alt":"([^"]+)"/g)].map((m) => m[1]);
  const bosses = ids.map((id, i) => ({ id, name: names[i] || `boss ${id}` }));
  const { rows, props } = rscProps(flight, (x) => Array.isArray(x.decks) && 'active' in x);
  const dk = props ? rscDeep(rows, props) : null;
  return { floor, diff, bosses, decks: dk?.decks || [], active: +dk?.active || 0, chunks };
}

// Toute la collection (/deck), cartes non offensives comprises, avec leurs lignes critiques apprises.
async function fetchCollection() {
  const { flight, chunks } = await fetchFlight('/deck');
  const { rows, props } = rscProps(flight, (x) => Array.isArray(x.collection) && 'initialDecks' in x);
  if (!props) throw new Error('Collection de cartes introuvable sur /deck');
  const cards = rscDeep(rows, props.collection).map((e) => e?.card && { ...e.card, usable: e.usable !== false }).filter((c) => c?.id);
  for (const c of cards) c.crit = critLinesOf(c);
  return { cards, chunks };
}

// Personnage pour la simulation : stats, PV, PA de combat et arme du dernier combat capté.
function ascSimPlayer() {
  const f = lastFight()?.fighters?.p;
  if (!f?.stats) return null;
  return { id: 'p', team: 0, kind: 'player', name: f.name, level: +f.level || 200, stats: f.stats, buffs: [], maxHp: +f.maxHp || 10000,
    basePa: +f.basePa || 12, weaponCard: f.weaponCard || null };
}

// Combat « vide » d'un étage pour fightMechanics : boss de la page, avec les mécaniques que le combat a données au dernier
// essai qui les a enregistrées (f.rules, f.affixes ; les nôtres ou celles d'un ami) — sinon le bestiaire.
function ascFakeFight(bosses, attempts) {
  const seen = (id) => attempts.flatMap((a) => a.bosses || []).find((b) => +b.id === +id && Array.isArray(b.rules));
  return { fighters: { p: { team: 0 }, ...Object.fromEntries(bosses.map((b, i) => {
    const k = seen(b.id);
    return [`b${i}`, { id: `b${i}`, team: 1, isBoss: true, monsterId: b.id, name: b.name, ...(k ? { rules: k.rules, affixes: k.affixes || [] } : {}) }];
  })) } };
}
const ASC_GUARD_HP = 0.05;   // PV d'un gardien ≈ 5 % des PV max de son boss (3 à 9 % vus aux étages 126-127)

// Une carte compte si elle frappe (les cartes « une fois par combat » sont écartées : la main doit rester la même), protège, donne des PA, soigne ou affaiblit.
// carte à condition de lancer (« Noa : ne peut se lancer que sur la Lance si le lanceur est Désarmé ») : jamais jouable en
// combat (étage 145 : proposée par l'exploration, jamais lancée en 3 combats)
const castOnly = (c) => /ne peut (?:se |être )?lanc(?:er|é)e? que/i.test(c.d || c.desc || '');
// soigne le lanceur (vol de vie, soin sur soi) : blesse sous Malédiction des soins
const ascHealsSelf = (c) => (c.eff || []).some((e) => e?.k === 'steal' || (e?.tgt === 'self' && /heal/.test(e?.k || '')));
const usefulCard = (c) => c.usable && !c.once && !castOnly(c) && !noKillCard(c) && (c.eff || []).some((e) => e && (DMG_FIXED.has(e.k) || /shield|apGain|apRemove|heal|buff|debuff/.test(e.k)));

// Score moyen d'un deck sur quelques tours simulés (planTurn : mécaniques, ordre, cibles).
function evalAscDeck(deck, sim) {
  let total = 0, dmg = 0, n = 0;
  for (let lead = 0; lead < sim.bosses.length; lead++) for (let k = 1; k <= ASC_SIM.roundsPerBoss; k++) {
    const round = lead * ASC_SIM.roundsPerBoss + k;
    n++;
    const cards = Object.fromEntries(deck.map((c, i) => [`c${i}`, { ...c, uid: `c${i}`, name: c.n || c.name }]));
    const p = { ...sim.p, cards, hand: Object.keys(cards), ap: sim.p.basePa, hp: sim.p.maxHp * ASC_SIM.hpPct, cardsThisTurn: 0, shields: [],
      lastEl: null, weaponUsed: false, alive: true };
    const fighters = { p };
    sim.bosses.forEach((b, i) => {
      if (i < lead) return;   // déjà tombé
      // stats vues lors d'un essai à cet étage, sinon valeurs types
      const k = b.known;
      const res = Object.fromEntries(EL_RES_PCT.map((key, j) => [key, k?.res ? k.res[j] : ASC_SIM.bossRes]));
      const hp = k?.maxHp || ASC_SIM.bossHp, atk = k?.atk || ASC_SIM.bossAtk;
      fighters[`b${i}`] = { id: `b${i}`, team: 1, isBoss: true, alive: true, monsterId: b.id, name: b.name, stats: res, resCap: k?.resCap || 100,
        hp, maxHp: hp, atk, intent: { k: 'attack', value: atk }, affixes: b.affixes || [] };
    });
    // mécaniques annoncées (Transmutés) rejouées comme dans un vrai combat : le journal du tour les annonce, planTurn les lit
    const log = [{ t: 'round', round }], mech = (who, text) => log.push({ t: 'mechanic', who, text });
    sim.bosses.forEach((b, i) => {
      const f = fighters[`b${i}`];
      if (!f) return;
      const af = (key) => (b.affixes || []).find((a) => a?.k === key);
      // Reflet et Élément mouvant : un élément différent à chaque tour (Terre → Feu → Eau → Air)
      if (af('reflect')) mech(f.id, `Reflet de ${f.name} : ce tour, les dégâts ${EL_NAMES[1 + (round + (Number.isInteger(af('reflect').seed) ? af('reflect').seed : i)) % 4]} lui sont renvoyés.`);
      if (af('shift')) mech(f.id, `Élément mouvant de ${f.name} : ce tour, il est immunisé ${EL_NAMES[1 + (round + i + 2) % 4]}.`);
      const inv = af('invert');
      if (inv && +inv.every > 0 && round % +inv.every === 0) mech(f.id, `Inversion de ${f.name} (tour 1/${inv.turns || 2}) : tes soins et tes boucliers te blessent !`);
      // Gardiens : au premier tour, puis rappelés quelques tours après leur chute
      const gd = af('guardians');
      if (gd && (round - 1) % ((+gd.every || 3) + 1) === 0) {
        for (let g = 0; g < (+gd.adds || 2); g++) {
          const gh = f.maxHp * ASC_GUARD_HP, ga = f.atk * 0.3;
          fighters[`g${i}${g}`] = { id: `g${i}${g}`, team: 1, alive: true, ownerId: f.id, name: `Gardien de ${f.name}`, stats: f.stats, resCap: 100,
            hp: gh, maxHp: gh, atk: ga, intent: { k: 'attack', value: ga } };
        }
      }
    });
    log.push({ t: 'turn', who: 'p' });
    // boss en tête : Sceau (+N PA sur le 1er sort) et Vol de PA (PA en moins au début du tour)
    const leadB = sim.bosses[lead], sealA = (leadB?.affixes || []).find((a) => a?.k === 'seal');
    if (sealA) mech(`b${lead}`, `Sceau de ${leadB.name} : ton premier sort du tour coûte +${sealA.ap || 2} PA.`);
    const drain = sim.rules.filter((r) => r.k === 'apSteal' && r.boss === `b${lead}`).length;
    if (drain) p.ap = Math.max(0, p.ap - drain);
    // Sceau du boss en tête : sa carte la plus chère est scellée les tours concernés
    const seal = sim.rules.find((r) => r.k === 'seal' && r.boss === `b${lead}`);
    if (seal && (round - 1) % (seal.every || 1) === 0) {
      const top = Object.values(cards).sort((a, b) => (+b.ap || 0) - (+a.ap || 0))[0];
      if (top) p.sealed = [top.uid];
    }
    const st = { round, fighters, log, order: ['p', ...sim.bosses.map((_, i) => `b${i}`)] };
    const cand = Object.values(cards).filter((c) => !p.sealed?.includes(c.uid)).map((c) => ({ c, key: c.id, weapon: false, w: weightOf(c).w, ap: +c.ap || 0 }));
    if (p.weaponCard) cand.push({ c: p.weaponCard, key: WEAPON_KEY, weapon: true, w: weightOf(p.weaponCard, true).w, ap: +p.weaponCard.ap || 0 });
    planTurn.lastEl = null;
    const plan = planTurn(st, cand, sim.rules);
    total += plan.score;
    dmg += plan.plan.reduce((t, q) => t + (q.x.isDmg && q.target ? cardEffect(q.x.c, p, q.target).dmg : 0), 0);
  }
  return { score: total / n, dmg: dmg / n };
}

// Signature d'un étage pour le pilote : boss + dernier essai connu (date). Le nombre d'essais ne suffit pas : on n'en garde
// que 10 par étage (ascRemember), il ne bougeait plus après le 10e → ni build ni deck recalculés (étage 145, 16/10).
const ascAttemptSig = (page, attempts) => `${page.floor}|${page.bosses.map((b) => b.id).join(',')}|${attempts.length}|${Math.max(0, ...attempts.map((a) => +a.at || 0))}`;

// Decks essayés par étage (localStorage) : { étage: { _at: date du dernier essai compté, « cartes triées »: { n, lost } } }.
// Un deck qui a perdu ASC_TRY_LOSSES fois n'est plus reproposé tel quel : le conseiller passe à la meilleure variante
// (une carte changée) pas encore épuisée — le pilote full auto essaie ainsi d'autres decks au lieu de rejouer le même.
const ASC_TRIED_KEY = 'dmAscTried';
const ASC_TRY_LOSSES = 3;
const ascDeckKey = (names) => [...names].sort().join('|');
function ascTried(floor) { try { return JSON.parse(localStorage.getItem(ASC_TRIED_KEY) || '{}')[floor] || {}; } catch { return {}; } }
// compte le dernier essai (le nôtre) pour le deck actif de la page : c'est avec lui qu'il a été joué
function ascCountTry(page) {
  const last = ascSeenOwn(page.floor).at(-1), tried = ascTried(page.floor);
  if (!last || !(last.at > (tried._at || 0))) return tried;
  tried._at = last.at;
  const t = tried[ascDeckKey(page.decks[page.active]?.names || [])] ||= { n: 0, lost: 0 };
  t.n++;
  if (last.status !== 'won') t.lost++;
  try {
    const all = JSON.parse(localStorage.getItem(ASC_TRIED_KEY) || '{}');
    all[page.floor] = tried;
    localStorage.setItem(ASC_TRIED_KEY, JSON.stringify(all));
  } catch { /* stockage plein : pas d'exploration */ }
  return tried;
}
const ascSpent = (tried, deck) => (tried[ascDeckKey(deck.map((c) => c.n))]?.lost || 0) >= ASC_TRY_LOSSES;

// Deck conseillé : part du deck actif (7 cartes) ou des 7 meilleures seules, puis échanges carte par carte tant que ça gagne.
async function adviseAscDeck(page, say = () => {}) {
  const p = ascSimPlayer();
  if (!p) throw new Error('fais d’abord un combat (stats du personnage inconnues)');
  say('Lecture de ta collection…');
  const { cards, chunks } = await fetchCollection();
  const list = await bossMechanics();
  const attempts = page.floor ? await ascSeenAll(page.floor).catch(() => []) : [];
  const fake = ascFakeFight(page.bosses, attempts);
  const rules = mergeObserved(fightMechanics(fake, list, page.floor, page.diff), fake, attempts.flatMap((a) => a.seen || []), list);
  // boss : stats vues au dernier essai à cet étage (PV, attaque, résistances), sinon valeurs types
  const known = (id) => attempts.flatMap((a) => a.bosses || []).find((b) => +b.id === +id && b.maxHp);
  const sim = { p: { ...p, _fx: new Map() }, bosses: page.bosses.map((b, i) => ({ ...b, known: known(b.id), affixes: fake.fighters[`b${i}`].affixes || [] })), rules };   // _fx : estimations partagées entre les simulations
  const byName = new Map(cards.map((c) => [c.n, c]));
  const current = (page.decks[page.active]?.names || []).map((n) => byName.get(n)).filter(Boolean);
  say('Classement des cartes…');
  // Malédiction des soins (entière) du premier boss : il mène tout le combat (mécaniques du premier boss debout), la
  // simulation ne lui donne que 2 tours sur 6 → soins et vols de vie y paraissaient rentables. Étage 152 (9 défaites) :
  // 4 cartes sur 7 à soin / vol de vie sous la Malédiction de Fuji, dès le tour 3 l'arme seule et 9 PA perdus par tour.
  const cursed = rules.some((r) => r.k === 'curse' && !r.half && r.boss === 'b0' && (+r.from || 1) <= 2);
  const allowed = (c) => !castOnly(c) && !(cursed && ascHealsSelf(c));
  let pool = cards.filter(usefulCard);
  if (pool.filter(allowed).length >= ASC_DECK_SIZE) pool = pool.filter(allowed);
  const inPool = new Set(pool);
  const solo = pool.map((c) => ({ c, v: evalAscDeck([c], sim).score })).sort((a, b) => b.v - a.v);
  const cands = [...new Set([...solo.slice(0, 24).map((x) => x.c), ...current.filter((c) => inPool.has(c) && !castOnly(c))])];   // 7 cartes : recherche plus longue, 24 candidates
  let deck = current.length === ASC_DECK_SIZE && current.every((c) => inPool.has(c) && !castOnly(c)) ? [...current] : solo.slice(0, ASC_DECK_SIZE).map((x) => x.c);
  let best = evalAscDeck(deck, sim).score;
  for (let pass = 0; pass < 8; pass++) {
    say(`Recherche du meilleur deck… (passe ${pass + 1})`);
    await sleep(0);
    let move = null;
    for (let i = 0; i < deck.length; i++) {
      for (const c of cands) {
        if (deck.includes(c)) continue;
        const d = deck.map((x, j) => (j === i ? c : x));
        const v = evalAscDeck(d, sim).score;
        if (v > best + 1 && (!move || v > move.v)) move = { d, v };
      }
    }
    if (!move) break;
    deck = move.d; best = move.v;
  }
  // déjà perdu ASC_TRY_LOSSES fois à cet étage : meilleure variante à une carte près qui ne l'est pas encore
  const tried = page.floor ? ascTried(page.floor) : {};
  let explored = null;
  if (ascSpent(tried, deck)) {
    say('Deck déjà perdant ici : recherche d’une variante…');
    let alt = null;
    for (let i = 0; i < deck.length; i++) {
      for (const c of cands) {
        if (deck.includes(c)) continue;
        const d = deck.map((x, j) => (j === i ? c : x));
        if (ascSpent(tried, d)) continue;
        const v = evalAscDeck(d, sim).score;
        if (!alt || v > alt.v) alt = { d, v, out: deck[i], in: c };
      }
    }
    if (alt) { explored = { out: alt.out, in: alt.in, lost: tried[ascDeckKey(deck.map((c) => c.n))].lost }; deck = alt.d; }
  }
  const evCur = current.length ? evalAscDeck(current, sim) : null, evNew = evalAscDeck(deck, sim);
  const affixes = new Set(sim.bosses.flatMap((b) => b.affixes.map((a) => a?.k)));
  return { knownBosses: sim.bosses.some((b) => b.known), rules, affixes, current, deck, evCur, evNew, explored, add: deck.filter((c) => !current.includes(c)), remove: current.filter((c) => !deck.includes(c)), chunks };
}

// Tour d'application d'une règle (après observation), affiché à côté du texte du bestiaire.
const ascRuleTiming = (r) => (!r.seenRound ? '' : r.k === 'mirror' ? ` <b>[tours ${r.from}–${r.to}]</b>` : r.k === 'apExact' || r.k === 'swap' ? ` <b>[tour ${r.turn}]</b>` : '');

// Raison courte d'un ajout / retrait, selon les mécaniques en jeu.
function ascCardReason(c, rules, adding, p = ascSimPlayer(), affixes = new Set()) {
  const eff = c.eff || [];
  const k = new Set([...rules.map((r) => r.k), ...affixes]);
  const els = new Set(eff.filter((e) => e && DMG_FIXED.has(e.k) && Number.isInteger(e.el)).map((e) => e.el));
  const steals = ascHealsSelf(c);
  const out = [];
  if (k.has('curse') && steals && !adding) out.push('vols de vie / soins : te blessent sous Malédiction des soins');
  if (k.has('reflect') && els.size > 1 && !adding) out.push('plusieurs éléments : une ligne souvent renvoyée par le Reflet');
  if (k.has('reflect') && els.size === 1 && adding) out.push('un seul élément : facile à jouer hors de l’élément renvoyé (Reflet)');
  if ((k.has('apSteal') || k.has('seal')) && adding && (+c.ap || 0) <= 2) out.push('peu chère : jouable malgré le vol de PA / le Sceau');
  if (k.has('guardians') && adding && eff.some((e) => e?.zone)) out.push('zone : abat les gardiens et touche le boss');
  if (eff.some((e) => /shield/.test(e?.k || ''))) {
    const sh = p ? shieldOf(c, p) : null;
    const amount = sh ? ` ≈ ${Math.round(sh.v).toLocaleString('fr-FR')} PV (${Math.round(sh.v / (+c.ap || 1)).toLocaleString('fr-FR')} par PA, ${sh.dur} tour${sh.dur > 1 ? 's' : ''})` : '';
    out.push(`bouclier${amount}${k.has('shield') ? ' : indispensable contre Peau dure' : ''}${k.has('wither') ? ' (réduit par la Flétrissure)' : k.has('invert') ? ' (te blesse pendant l’Inversion)' : ''}`);
  }
  if (eff.some((e) => e?.k === 'apGain')) out.push(`+${apGainOf(c)} PA : plus de cartes jouées par tour`);
  if (eff.some((e) => e?.k === 'apRemove' && e.tgt === 'enemy')) out.push('retire des PA : affaiblit la prochaine attaque');
  if (k.has('mirror') && eff.some((e) => e?.zone) && !adding) out.push('sort de zone : touche le boss sous Miroir');
  if (k.has('fureur') && adding && (+c.ap || 0) >= 3) out.push('carte forte : rentable avec peu de cartes par tour (Fureur)');
  if (k.has('onde') && adding && eff.some((e) => DMG_FIXED.has(e?.k))) out.push('enchaînement d’éléments compatible avec l’Onde de choc');
  if (!out.length) out.push(adding ? 'plus de dégâts utiles par tour' : 'moins utile que la carte proposée');
  return out.join(' · ');
}

// Enregistre le deck dans l'emplacement réservé puis l'active pour l'Ascension.
async function applyAscDeck(deck, page) {
  const { chunks } = await fetchFlight('/deck');
  const saveId = saveDeckId || (saveDeckId = await findAction(chunks, 'saveDeck', SAVE_DECK_FALLBACK));
  await callAction('deck', saveId, [deck.map((c) => ({ id: c.id, f: 0 })), ASC_DECK_SLOT]);
  const selId = await findAction(page.chunks, 'selectDeck', SELECT_DECK_FALLBACK);
  await callAction('ascension', selId, [ASC_DECK_SLOT]);
}

// ---------- Optimiseur de build, objectif « 🏔️ Ascension » ----------
// Attaque des boss mesurée sur les coups reçus (ramenés avant nos résistances, plafonnées à PLAYER_RES_CAP) :
// attaque ×1, lourde ×1,7, drain ×0,8, garde / rage 0 ; la rage multiplie ensuite (×1,3 puis ×1,6) au fil du combat.
const PLAYER_RES_CAP = 50;
const BOSS_INTENT_MULT = { attack: 1, heavy: 1.7, drain: 0.8, guard: 0, rage: 0 };
const BOSS_RAGE_AVG = 1.2;
const bossTurnFactor = (pattern) => (Array.isArray(pattern) && pattern.length
  ? pattern.reduce((t, k) => t + (BOSS_INTENT_MULT[k] ?? 1), 0) / pattern.length : 0.9) * BOSS_RAGE_AVG;
// Boss d'un étage (dernier essai connu, le nôtre ou celui d'un ami) + mécaniques (résurrection) + boucliers du deck actif.
async function ascOptimizerData(floor) {
  if (!(+floor > 0)) throw new Error('étage d’Ascension inconnu : ouvre la page Ascension ou saisis l’étage');
  const attempts = await ascSeenAll(+floor);
  const att = attempts.filter((a) => (a.bosses || []).some((b) => b.maxHp)).sort((a, b) => b.at - a.at)[0];
  if (!att) throw new Error(`aucun essai connu à l’étage ${floor} (PV et attaques des boss inconnus) : lance-le une fois, ou attends qu’un ami de la synchro l’ait fait`);
  const list = await bossMechanics();
  const fake = ascFakeFight(att.bosses, attempts);
  const rules = mergeObserved(fightMechanics(fake, list, +floor, att.diff || null), fake, attempts.flatMap((a) => a.seen || []), list);
  const bosses = att.bosses.map((b, i) => ({ ...b, revive: rules.find((r) => r.boss === `b${i}` && r.k === 'revive')?.pct || 0,
    factor: bossTurnFactor(b.pattern), element: b.element ?? 1, res: b.res || [0, 0, 0, 0, 0],
    ...ascBossLoad(fake.fighters[`b${i}`].affixes || [], rules.filter((r) => r.boss === `b${i}`)) }));
  const wither = Math.max(0, ...bosses.map((b) => b.wither || 0));
  // boucliers en % des PV max du deck actif (Vertu…) : ils grandissent avec les PV
  let shieldPct = 0, deckN = 0;
  try {
    const { cards } = await fetchCollection();
    const page = await readAscPage().catch(() => null);
    const names = new Set(page?.decks?.[page.active]?.names || []);
    deckN = names.size;
    for (const c of cards) if (names.has(c.n)) for (const e of c.eff || []) if (e?.k === 'shieldHp' && e.tgt === 'self') shieldPct = Math.max(shieldPct, (+e.min || 0) / Math.max(1, +e.dur || 1));
  } catch { /* sans boucliers */ }
  // passif de classe : bonus moyen sur un combat (dégâts, dégâts subis) — classe du dernier combat capté ;
  // grand deck : +5 % par carte au-delà de 7 (+25 % au plus, patch d'oct. 2026)
  const lp = lastFight()?.fighters?.p, cp = classOf(lp?.breedId);
  // Fureur (règle vue en combat) : au-delà de N cartes par tour, son attaque suivante ×2,5 → on n'en joue que N
  const furyMax = Math.min(Infinity, ...rules.filter((r) => r.k === 'fureur').map((r) => +r.max || Infinity));
  return { floor: +floor, diff: att.diff || null, from: att.player, at: att.at, bosses, shieldPct: shieldPct * (1 - wither / 100), rules, furyMax,
    classMult: classAvg(cp, lp?.pasBoost) * (1 + deckBonusPct(deckN) / 100), classTaken: cp?.avgTaken || 1, className: cp?.name || null };
}
// Poids des mécaniques d'un boss dans la marge de survie (optimiseur « asc ») :
// - hpMult : PV en plus à percer — Rancune (pct % des dégâts rendus en PV : ÷ (1 − pct)), Carapace (bouclier de pct % des PV
//   max), Gardiens (adds × ~5 % de ses PV, rappelés : compté 2 fois) ;
// - phaseRes : Métamorphose, +res % de résistances sur la 2e moitié de ses PV ;
// - dptMult : part de nos dégâts qui le touche — Reflet / Élément mouvant (un élément perdu par tour : ×0,85 chacun), PA
//   perdus (Vol de PA, Sceau des Transmutés : ~1 et ~2 PA sur 12) ;
// - extraTurns : Épuisement final (passer son tour N fois sous les coups) ; wither : Flétrissure (boucliers −pct %) ;
// - cap : Seuil de douleur, aucun coup ne lui retire plus de cap × ses PV max (Transmutés : 6 %) → c'est le nombre de
//   coups qui compte, plus les dégâts ; bond : Lien d'âme, les boss encore debout reprennent bond × leurs PV à sa chute.
function ascBossLoad(affixes, rules) {
  const af = (k) => affixes.find((a) => a?.k === k);
  let hpMult = 1, dptMult = 1, apLost = 0;
  if (af('grudge')) hpMult /= 1 - Math.min(0.8, (+af('grudge').pct || 25) / 100);
  if (af('carapace')) hpMult *= 1 + (+af('carapace').pct || 15) / 100;
  if (af('guardians')) hpMult *= 1 + (+af('guardians').adds || 2) * ASC_GUARD_HP * 2;
  if (af('reflect')) dptMult *= 0.85;
  if (af('shift')) dptMult *= 0.85;
  if (af('seal')) apLost += +af('seal').ap || 2;
  apLost += rules.filter((r) => r.k === 'apSteal').length;
  return { hpMult, dptMult, apLost, phaseRes: af('phase') ? +af('phase').res || 40 : 0,
    cap: af('threshold') ? (+af('threshold').pct || 6) / 100 : 0, bond: af('soulbond') ? (+af('soulbond').pct || 30) / 100 : 0,
    extraTurns: af('exhaust') ? +af('exhaust').passes || 2 : 0, wither: af('wither') ? +af('wither').pct || 0 : 0 };
}

// Marge de survie d'un build : PV effectifs ÷ dégâts encaissés le temps de tout tuer (> 1 : on gagne).
// Boss tués dans l'ordre de menace ; chacun frappe (son élément, nos rés. plafonnées) jusqu'à sa mort.
// turn (facultatif) : le tour simulé ({ used: [{ sp, v }] }) — lignes de dégâts (Seuil) et Fureur (N meilleures cartes).
function ascSurvival(S, pv, dpt, asc, avgRes, turn = null) {
  let lines = 0;
  if (turn?.used?.length) {
    const used = [...turn.used].sort((a, b) => b.v - a.v), tot = used.reduce((t, u) => t + u.v, 0);
    const kept = used.slice(0, Math.min(used.length, asc.furyMax ?? Infinity));
    if (kept.length < used.length && tot > 0) dpt *= kept.reduce((t, u) => t + u.v, 0) / tot;
    lines = kept.reduce((t, u) => t + Math.max(1, +u.sp?.pf?.lines || 1), 0);
  }
  let bondBack = 1;   // Lien d'âme : PV repris par les boss tués après son porteur
  const order = [...asc.bosses].sort((a, b) => (b.atk * b.factor) / (b.maxHp * (1 + b.revive / 100)) - (a.atk * a.factor) / (a.maxHp * (1 + a.revive / 100)));
  let T = 0, taken = 0;
  const per = [];
  // esquive totale (PM, 3 de base compris) ; Dofus Vulbis : +2 % par coup reçu, compté pour ~2 coups, plafond 75 %
  const dodge = S['dx:vulbis'] ? Math.min(DOFUS_FX.vulbisCap, dodgeOf(S) * 100 + 2 * DOFUS_FX.vulbisStep) / 100 : dodgeOf(S);
  // pénétration : la cible « moyenne » (dpt) et chaque boss voient leurs % rés. positives diminuées
  if (asc.target?.resPct) avgRes = asc.target.resPct.reduce((t, x) => t + penRes(x, penOf(S)), 0) / 5 / 100;
  for (const b of order) {
    const r = b.res.reduce((t, x) => t + penRes(x, penOf(S)), 0) / 5 / 100;   // pénétration : rés. du boss diminuées
    // Métamorphose : la 2e moitié de ses PV avec +phaseRes % de résistances (plafond 90 %)
    const phase = b.phaseRes ? 0.5 + 0.5 * Math.max(0.05, 1 - r) / Math.max(0.05, 1 - Math.min(0.9, r + b.phaseRes / 100)) : 1;
    const hp = b.maxHp * (1 + b.revive / 100) * (b.hpMult || 1) * phase * bondBack;   // PV à lui retirer
    const apF = b.apLost ? Math.max(0.3, 1 - b.apLost / 12) : 1;   // PA volés / Sceau : ~12 PA par tour, moins de cartes jouées
    // PV qu'il perd par tour : nos dégâts « contre la moyenne » ramenés à ses résistances ; Seuil : lignes × plafond au plus
    let loss = dpt * (asc.classMult || 1) * (b.dptMult || 1) * apF * Math.max(0.05, 1 - r) / Math.max(0.05, 1 - avgRes);
    if (b.cap && lines) loss = Math.min(loss, lines * b.cap * b.maxHp * (b.dptMult || 1) * apF);
    const t = hp / Math.max(1, loss) + (b.extraTurns || 0);
    if (b.bond) bondBack *= 1 + b.bond;
    T += t;
    const el = b.element ?? 1;
    const rp = Math.min(PLAYER_RES_CAP, S[EL_RES_PCT[el]] || 0), rf = S[EL_RES[el]] || 0;
    let hit = Math.max(0, b.atk * b.factor * (1 - dmgRedOf(S)) - rf) * (1 - rp / 100) * (asc.classTaken || 1);   // réduction de dégâts
    if (S['dx:glaces']) hit *= 1 - DOFUS_FX.glaces;                     // Dofus des Glaces : −10 % sur sa frappe
    if (S['dx:cauchemar']) hit *= 1 - DOFUS_FX.cauchemar * Math.min(1, DOFUS_FX.cauchemarTurns / Math.max(1, T));   // Cauchemar : 2 premiers tours
    if (S['dx:ivoire']) hit = Math.min(hit, DOFUS_FX.ivoireCap * pv);   // Dofus Ivoire : 35 % des PV max au plus par coup
    taken += hit * T * (1 - dodge);
    per.push({ name: b.name, turns: t, hit });
  }
  // Émeraude : survit une fois à 20 % ; Jyfus : soin de 10 % une fois ; Argenté : bouclier de 8 % au début
  const once = (S['dx:emeraude'] ? DOFUS_FX.emeraude : 0) + (S['dx:jyfus'] ? DOFUS_FX.jyfus : 0) + (S['dx:argente'] ? DOFUS_FX.argente : 0);
  const ehp = pv * (1 + (asc.shieldPct / 100) * T + once);
  return { ratio: ehp / Math.max(1, taken), turns: T, taken, ehp, per, dodge };
}

// ---------- Moteur de combat en Ascension (cfg.ascEngine : 'best' | 'game' | 'ours') ----------
// « best » : celui qui gagne le plus à cet étage d'après les essais (les nôtres et ceux des amis), sinon d'après tous les
// étages ; à égalité ou sans données, l'Auto du jeu (bilan 08/10 : Auto du jeu 4/5, notre moteur 6/29 aux étages 28-35).
function ascPickEngine(attempts) {
  if (cfg.ascEngine === 'game' || cfg.ascEngine === 'ours') return cfg.ascEngine;
  const rate = (list, e) => { const a = list.filter((x) => x.engine === e); return { w: a.filter((x) => x.status === 'won').length, n: a.length }; };
  const all = Object.values((() => { try { return JSON.parse(localStorage.getItem(ASC_SEEN_KEY) || '{}'); } catch { return {}; } })()).flat();
  const score = (e) => {
    const f = rate(attempts, e), g = rate(all, e);
    const prior = g.n ? (g.w + 1) / (g.n + 2) : (e === 'game' ? 0.6 : 0.4);
    return (f.w + 2 * prior) / (f.n + 2);
  };
  return score('ours') > score('game') ? 'ours' : 'game';
}

// ---------- Deck automatique (pilote) ----------
// cfg.ascAutoDeck : avant de lancer un étage, le deck conseillé est enregistré dans le Deck 6 et activé s'il diffère du
// deck actif. Un seul calcul par étage, boss et nombre d'essais connus (une défaite apporte des infos : on recalcule).
// Renvoie false si la page va être rechargée (deck changé) : le pilote attend.
async function ascPrepareDeck() {
  if (!(cfg.ascAutoDeck || cfg.ascAutoBuild) || !modOn('spells')) return true;
  try {
    const page = await readAscPage();
    if (!page.floor || !page.bosses.length) return true;
    const attempts = await ascSeenAll(page.floor).catch(() => []);
    const sig = ascAttemptSig(page, attempts);
    if (cfg.ascDeckSig === sig) return true;
    ascCountTry(page);
    const adv = await adviseAscDeck(page, (m) => setStatus(`Ascension étage ${page.floor} : ${m}`));
    const now = (page.decks[page.active]?.names || []).slice().sort().join('|');
    const want = adv.deck.map((c) => c.n).sort().join('|');
    await save({ ascDeckSig: sig });
    if (now === want) { DM.log(`ascension étage ${page.floor} : deck actif déjà conseillé`); return true; }
    setStatus(`Ascension étage ${page.floor} : deck conseillé → Deck ${ASC_DECK_SLOT + 1}…`);
    await applyAscDeck(adv.deck, page);
    if (adv.explored) DM.log(`ascension étage ${page.floor} : deck conseillé perdu ${adv.explored.lost} fois, variante essayée (${adv.explored.out.n} → ${adv.explored.in.n})`);
    DM.log(`ascension étage ${page.floor} : deck auto ${adv.deck.map((c) => c.n).join(', ')} (−${adv.remove.map((c) => c.n).join(', ') || '∅'} / +${adv.add.map((c) => c.n).join(', ') || '∅'})`);
    location.reload();
    return false;
  } catch (e) {
    DM.log(`ascension : deck auto impossible (${e.message}) — deck actuel gardé`);
    return true;
  }
}

// ---------- Build automatique (pilote) ----------
// cfg.ascAutoBuild : avant de lancer un étage, et de nouveau après chaque défaite (un essai de plus = une signature de
// plus), l'optimiseur cherche le build « Ascension (survie) » de cet étage avec tes seuls objets (inventaire et porté, à
// leur vrai tier : rien de simulé, ni HDV, ni banque, ni drops), l'équipe et répartit les points. La page est rechargée
// après un changement, puis le deck auto (forcé avec cette option) est recalculé. Renvoie false si la page va être rechargée.
async function ascPrepareBuild() {
  if (!cfg.ascAutoBuild || !modOn('build')) return true;
  let floor = '?';
  try {
    const page = await readAscPage();
    if (!page.floor || !page.bosses.length) return true;
    floor = page.floor;
    const attempts = await ascSeenAll(page.floor).catch(() => []);
    const sig = ascAttemptSig(page, attempts);
    if (cfg.ascBuildSig === sig) return true;
    await save({ ascBuildSig: sig });   // avant le calcul : une erreur ne le relance pas en boucle
    const say = (m) => setStatus(`Ascension étage ${floor} : build auto — ${m}`);
    let base = {};
    try { base = JSON.parse(localStorage.getItem(BUILD_OPTS_KEY) || '{}'); } catch { /* réglages de l'optimiseur absents */ }
    const r = await optimizeBuild({ ...base, goal: 'asc', ascFloor: page.floor, realTiers: true, hdv: false, bank: false, bestiary: false,
      deckOnly: false, dofus5: false, lvlMax: '', ownTol: 0, budget: 0 }, say);
    const todo = resolveOwnedTiers(buildEquipChanges(r), await fetchEquipState());
    const pts = r.realloc && POINT_STATS.some((k) => (r.sheet.base[k] || 0) !== (r.nxt.alloc[k] || 0));
    const margin = `marge ×${r.asc.cur.ratio.toFixed(2)} → ×${r.asc.nxt.ratio.toFixed(2)}`;
    if (!todo.length && !pts) { DM.log(`ascension étage ${floor} : build auto, rien à changer (${margin})`); return true; }
    if (todo.length) {
      await runEquip({ changes: todo, stats: [] }, null, (i, n, c) => say(`équipement ${i}/${n} : ${c.to.name} (${fusionName(c.to.fusion || 0)})…`));
    }
    if (pts) await applyPoints(r.nxt.alloc, r.sheet.base, say);
    // l'auto-équipement (fait pour l'XP) déferait le build
    await save({ ascDeckSig: null, ...((cfg.equipAuto || 'off') !== 'off' ? { equipAuto: 'off' } : {}) });
    DM.log(`ascension étage ${floor} : build auto — ${todo.map((c) => `${c.label} ${c.to.name} ${fusionName(c.to.fusion || 0)}`).join(', ') || 'équipement inchangé'}${pts ? ', points répartis' : ''} (${margin})`);
    location.reload();
    return false;
  } catch (e) {
    DM.log(`ascension étage ${floor} : build auto impossible (${e.message}) — build actuel gardé`);
    return true;
  }
}

// ---------- Panneau 🧠 sur /ascension ----------
// Il prend la place du bloc « Comment ça marche » de la page (à côté des boss) ; la flèche ⇄ en haut à droite rebascule
// vers le texte du jeu (choix gardé pour l'onglet). Le site peut re-rendre ce bloc : le panneau (déjà calculé) y est remis.
// Bloc introuvable : panneau flottant en bas à droite.
const ASC_VIEW_KEY = 'dmAscView';
let ascPanelFor = null, ascPanelEl = null;
const ascShowGame = () => { try { return sessionStorage.getItem(ASC_VIEW_KEY) === 'game'; } catch { return false; } };
function scanAscPanel() {
  const on = location.pathname.startsWith('/ascension') && modOn('spells');
  if (!on) { document.querySelectorAll('.dm-asc, .dm-asc-toggle').forEach((x) => x.remove()); ascPanelFor = null; ascPanelEl = null; return; }
  if (ascPanelFor !== location.href || !ascPanelEl) {
    ascPanelFor = location.href;
    ascPanelEl = document.createElement('div');
    ascPanelEl.className = 'dm-asc';
    ascPanelEl.innerHTML = '<b>🧠 Préparer l’étage</b> <span style="color:#b9a98c">lecture de la page…</span>';
    renderAscPanel(ascPanelEl).catch((e) => { ascPanelEl.innerHTML = `<b>🧠 Préparer l’étage</b><div style="color:#ff7b6b">${e.message}</div>`; });
  }
  const aside = [...document.querySelectorAll('aside')].find((x) => /Comment ça marche/.test(x.querySelector('h3')?.textContent || ''));
  const el = ascPanelEl;
  if (!aside) {   // repli : panneau flottant
    el.style.cssText = 'position:fixed;right:12px;bottom:calc(12px + var(--dm-lift,0px));z-index:2147483600;width:min(420px,calc(100vw - 24px));max-height:70vh;overflow:auto;background:#1d1812;border:1px solid #5a4a33;border-radius:12px;padding:10px 12px;font:13px system-ui,sans-serif;color:#eee;box-shadow:0 8px 30px #000a';
    if (el.parentNode !== document.body) document.body.appendChild(el);
    return;
  }
  el.style.cssText = 'font:13px system-ui,sans-serif;color:#eee';
  if (getComputedStyle(aside).position === 'static') aside.style.position = 'relative';
  if (el.parentNode !== aside) aside.appendChild(el);
  let tg = aside.querySelector(':scope > .dm-asc-toggle');
  if (!tg) {
    tg = document.createElement('button');
    tg.className = 'dm-asc-toggle';
    tg.style.cssText = 'position:absolute;top:8px;right:8px;z-index:2;border:1px solid #5a4a33;border-radius:8px;padding:2px 8px;background:#2a231a;color:#eee;cursor:pointer;font:600 12px system-ui,sans-serif';
    tg.onclick = () => { try { sessionStorage.setItem(ASC_VIEW_KEY, ascShowGame() ? 'ext' : 'game'); } catch { /* rien */ } scanAscPanel(); };
    aside.appendChild(tg);
  }
  const game = ascShowGame();
  tg.textContent = game ? '🧠 ⇄' : '⇄';
  tg.title = game ? 'Revenir aux infos de l’extension (boss, mécaniques, deck conseillé)' : 'Afficher « Comment ça marche » (texte du jeu)';
  for (const c of aside.children) if (c !== el && c !== tg) c.style.display = game ? '' : 'none';
  el.style.display = game ? 'none' : '';
}
async function renderAscPanel(el) {
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const btn = 'border:1px solid #5a4a33;border-radius:8px;padding:5px 10px;color:#fff;cursor:pointer;font:600 12px system-ui,sans-serif;background:#2a231a';
  const page = await readAscPage();
  if (!page.floor || !page.bosses.length) selfIssue('page:ascension', 'page Ascension illisible', `étage ${page.floor ?? '?'}, ${page.bosses.length} boss trouvés — la page du jeu a peut-être changé`);
  else selfClear('page:ascension');
  if (page.floor) save({ ascFloor: page.floor, ascDiff: page.diff || null, ascBosses: page.bosses.map((b) => b.id) });
  const list = await bossMechanics();
  const attempts = page.floor ? await ascSeenAll(page.floor).catch(() => []) : [];
  const fake = ascFakeFight(page.bosses, attempts);
  const rules = mergeObserved(fightMechanics(fake, list, page.floor, page.diff), fake, attempts.flatMap((a) => a.seen || []), list);
  const head = `<div style="padding-right:44px"><b style="font-size:15px">🧠 Étage ${page.floor ?? '?'}${page.diff ? ` · ${esc(page.diff)}` : ''}</b><div style="font-size:11px;color:#8a7d66">Mécaniques du premier boss encore debout ; à sa chute, le suivant prend le relais.</div></div>`;
  const mech = page.bosses.map((b, i) => `<div style="margin-top:6px"><b>${i + 1}. ${esc(b.name)}</b>${rules.filter((r) => r.boss === `b${i}`).map((r) => `<div style="font-size:12px;color:#d8cbb3">• <b>${esc(r.name)}</b>${r.learned ? ' <span style="color:#8fd4ee" title="Absente du bestiaire pour cette difficulté, mais vue en combat à cet étage">(vue en combat)</span>' : r.seenRound ? ' <span style="color:#8fd4ee" title="Tour confirmé par un combat à cet étage">(tour confirmé)</span>' : ''} — ${esc(r.text)}${ascRuleTiming(r)}</div>`).join('') || '<div style="font-size:12px;color:#8a7d66">aucune mécanique connue</div>'}</div>`).join('');
  const deckNow = page.decks[page.active];
  const fmtAt = (t) => new Date(t).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const hist = attempts.slice(0, 6).map((a) => `<div style="font-size:12px;margin-top:3px"><span style="color:${a.status === 'won' ? '#6fcf7a' : '#ff7b6b'}">${a.status === 'won' ? '✔' : '✖'}</span> <b>${esc(a.player)}</b> <span style="color:#8a7d66">${fmtAt(a.at)}${a.rounds ? `, ${a.rounds} tours` : ''}</span>${a.cause ? ` — ${esc(a.cause)}` : ''}${(a.seen || []).length ? `<div style="color:#b9a98c;padding-left:14px">vu : ${a.seen.map((o) => `${esc(o.bossName)} ${esc(o.name || o.text)} (t${o.round})`).join(' · ')}</div>` : ''}</div>`).join('');
  el.innerHTML = `${head}${mech}
    ${hist ? `<div style="margin-top:8px"><b style="font-size:12px">📜 Essais à cet étage</b>${hist}</div>` : ''}
    <div style="margin-top:8px;font-size:12px;color:#b9a98c">Deck actif : <b>${esc(deckNow?.label || '?')}</b> — ${esc((deckNow?.names || []).join(', ') || 'vide')}</div>
    <div style="margin-top:8px"><button data-a="advise" style="${btn};background:#2e6fbf">🃏 Conseiller un deck (${ASC_DECK_SIZE} cartes)</button></div>
    <label style="display:flex;gap:6px;align-items:center;margin-top:6px;font-size:12px;color:#d8cbb3;cursor:pointer" title="Avec le pilote en Ascension : avant chaque étage, le deck conseillé est enregistré dans le Deck ${ASC_DECK_SLOT + 1} et activé s’il diffère du deck actif ; recalculé après une défaite. Après une victoire, le pilote repasse par cette page pour voir les boss suivants."><input type="checkbox" data-a="autodeck"${cfg.ascAutoDeck ? ' checked' : ''}> 🤖 Pilote : appliquer le deck conseillé avant chaque étage</label>
    <label style="display:flex;gap:6px;align-items:center;margin-top:6px;font-size:12px;color:#d8cbb3;cursor:pointer" title="Mode full auto. Avec le pilote en Ascension : avant chaque étage et après chaque défaite, l’optimiseur cherche le meilleur build de survie pour ces boss avec TES objets à leur vrai tier (ni HDV, ni banque, ni drops), l’équipe, répartit tes points, puis le deck conseillé est recalculé et activé. L’auto-équipement passe sur Off."><input type="checkbox" data-a="autobuild"${cfg.ascAutoBuild ? ' checked' : ''}> 🤖 Pilote full auto : adapter équipement, points et deck avant chaque essai</label>
    <label style="display:flex;gap:6px;align-items:center;margin-top:6px;font-size:12px;color:#d8cbb3" title="Moteur de combat du pilote en Ascension. « Le meilleur » : celui qui gagne le plus à cet étage d’après les essais (les tiens et ceux des amis), sinon sur tous les étages ; l’Auto du jeu sans données.">⚔️ Moteur <select data-a="engine" style="background:#2a231a;border:1px solid #5a4a33;border-radius:6px;color:#eee;font:12px system-ui,sans-serif">${[['best', 'le meilleur selon les essais'], ['game', 'Auto du jeu'], ['ours', 'notre moteur (mécaniques)']].map(([v, l]) => `<option value="${v}"${(cfg.ascEngine || 'best') === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <span style="color:#8a7d66">${(() => { const r = (e) => { const a = attempts.filter((x) => x.engine === e); return a.length ? `${a.filter((x) => x.status === 'won').length}/${a.length}` : '—'; }; return `ici : Auto du jeu ${r('game')} · notre moteur ${r('ours')} → ${ascPickEngine(attempts) === 'ours' ? 'notre moteur' : 'Auto du jeu'}`; })()}</span></label>
    <div data-k="out" style="margin-top:8px"></div>`;
  el.querySelector('[data-a="autodeck"]').onchange = (e) => save({ ascAutoDeck: e.target.checked, ascDeckSig: null });
  el.querySelector('[data-a="autobuild"]').onchange = (e) => save({ ascAutoBuild: e.target.checked, ascBuildSig: null, ascDeckSig: null });
  el.querySelector('[data-a="engine"]').onchange = (e) => save({ ascEngine: e.target.value });
  const out = el.querySelector('[data-k="out"]');
  let advice = null;
  el.querySelector('[data-a="advise"]').onclick = async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try {
      advice = await adviseAscDeck(page, (m) => { out.innerHTML = `<span style="color:#b9a98c">${esc(m)}</span>`; });
      const fmt = (n) => Math.round(n).toLocaleString('fr-FR');
      const same = !advice.add.length;
      out.innerHTML = `
        ${advice.evCur ? `<div style="font-size:12px">Dégâts estimés par tour : ${fmt(advice.evCur.dmg)} → <b>${fmt(advice.evNew.dmg)}</b> · score ${fmt(advice.evCur.score)} → <b>${fmt(advice.evNew.score)}</b></div>` : ''}
        ${same ? '<div style="color:#6fcf7a;margin-top:4px">Ton deck actif est déjà le meilleur trouvé pour cet étage.</div>' : `
        ${advice.remove.map((c) => `<div style="font-size:12px;margin-top:4px;color:#ff9b8b">− ${esc(c.n)} <span style="color:#b9a98c">(${esc(ascCardReason(c, advice.rules, false, undefined, advice.affixes))})</span></div>`).join('')}
        ${advice.add.map((c) => `<div style="font-size:12px;margin-top:4px;color:#8fe39a">+ ${esc(c.n)} (${c.ap} PA) <span style="color:#b9a98c">(${esc(ascCardReason(c, advice.rules, true, undefined, advice.affixes))})</span></div>`).join('')}`}
        <div style="font-size:12px;margin-top:6px">Deck conseillé : <b>${advice.deck.map((c) => esc(c.n)).join(', ')}</b></div>
        ${same ? '' : `<div style="margin-top:6px"><button data-a="apply" style="${btn};background:#2e7d32">✔ Enregistrer dans le Deck ${ASC_DECK_SLOT + 1} et l’activer</button></div>`}
        <div style="font-size:11px;color:#8a7d66;margin-top:6px">Simulation : ${advice.knownBosses ? 'PV, attaques et résistances des boss vus au dernier essai' : `boss à ${fmt(ASC_SIM.bossHp)} PV, ${ASC_SIM.bossRes} % de résistances, attaques de ${fmt(ASC_SIM.bossAtk)} (pas encore d’essai à cet étage)`} ; Sceau simulé ; boucliers en PV épargnés (ceux « selon le niveau » estimés, à vérifier), gain de PA compris.</div>`;
      const ap = out.querySelector('[data-a="apply"]');
      if (ap) ap.onclick = async () => {
        ap.disabled = true; ap.textContent = 'Enregistrement…';
        try {
          await applyAscDeck(advice.deck, page);
          ap.textContent = `✔ Deck ${ASC_DECK_SLOT + 1} actif`;
          DM.log(`ascension : deck conseillé appliqué (${advice.deck.map((c) => c.n).join(', ')})`);
          setTimeout(() => location.reload(), 800);
        } catch (err) { ap.disabled = false; ap.textContent = `❌ ${err.message}`; }
      };
    } catch (err) {
      out.innerHTML = `<span style="color:#ff7b6b">${esc(err.message)}</span>`;
    } finally { b.disabled = false; }
  };
}
