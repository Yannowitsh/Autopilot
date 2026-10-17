// Autopilot-DM — content script : lecture de l’inventaire (/personnage) et appels aux server actions du jeu.
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.

// /personnage est une page Next.js : l'inventaire est dans le payload RSC (self.__next_f.push).
// `entries` ne contient que les objets non portés.

// Fusion (constantes FUSION du jeu, relues dans ses chunks le 2026-10-09) : 0 = Tiers 1, 1 = Tiers 2, 2 = Rayonnant,
// 3 à 7 = Rayonnant +1 à +5. Jusqu'au Rayonnant : 3 exemplaires du tier → 1 du suivant. Ensuite : l'objet + des Rayonnants
// « nourriture » (radiantFeed : 1 pour +1 et +2, 2 pour +3 à +5). Stats : +10 % (T2), +20 % (Rayonnant), puis +25 à +45 %.
// Dofus et trophées : fusion jusqu'au Rayonnant +5 depuis le 16/10 (+2 avant, dofusMax relu dans les chunks) ; en
// Rayonnant +5 (fusion ou éternel du Prestige) : toutes leurs stats ×2, PA et PM compris.
const FUSION = { max: 7, radiant: 2, copies: 3, bonusPct: [0, 10, 20, 25, 30, 35, 40, 45], excluded: ['pa', 'pm', 'po', 'invocations'],
  dofusRadiantPct: 100, dofusMax: 7, radiantPa: 2 };
const radiantFeed = (f) => (f < 2 ? 0 : f < 4 ? 1 : 2);   // Rayonnants consommés pour passer de f à f + 1
const isRadiant = (f) => (+f || 0) >= FUSION.radiant;
// Objets légendaires (isLegendItem du jeu, 16/10) : Mehditapasose, trophée, et les 9 « Mehdita… » (991010 à 991018) :
// ni fusion, ni bris, ni vente au marchand
const isLegendItem = (id) => [991001, 991002].includes(+id) || (+id >= 991010 && +id <= 991018);
// PA « free » des légendaires (constante du jeu) : en plus du plafond de PA (16 PA sur la fiche au P11 avec l'Arme
// Mehditaclaque, plafond 15)
const LEGEND_FREE_PA = { 991010: 1, 991012: 1, 991013: 1, 991016: 1, 991017: 1, 991018: 1 };
// Pano Mehdi (patch du 17/10) : chacun des 11 légendaires porté donne +20 % de ses propres stats (hors PA/PM/PO, comme les
// runes ; invocations exclues aussi, à vérifier) et +2 % de dégâts de sorts. Appliqué par le serveur : `st` de l'objet reste
// la valeur brute (Arme Mehditaclaque sans dmgPctSorts le 17/10). Calcul sur les stats fusionnées, à côté des runes.
const LEGEND_BOOST = { itemPct: 20, dmgPctSorts: 2 };
function withLegend(out, st, id) {
  if (!isLegendItem(id)) return out;
  out = { ...out };
  for (const [k, v] of Object.entries(st || {})) if (v > 0 && !FUSION.excluded.includes(k)) out[k] = (out[k] || 0) + Math.max(1, Math.round(v * LEGEND_BOOST.itemPct / 100));
  out.dmgPctSorts = (out.dmgPctSorts || 0) + LEGEND_BOOST.dmgPctSorts;
  return out;
}
// Runes (RUNE_LIST / runeStats du jeu, relus le 16/10) : 2 par objet au plus, « runes: ["eve", …] » sur l'objet porté ou
// l'exemplaire. stats = bonus fixe ; itemPct = +x % de chaque stat de l'objet (arrondi, au moins 1 ; hors PA/PM/PO/invoc.) ;
// elemDouble = Dommages élémentaires de l'objet doublés ; une seule Rune d'Action (PA) comptée par personnage (paRune).
// Comptées avant le Prestige, la forge et le compagnon (fiche du 16/10 : écart ramené de 5 à 1,5 % en les multipliant).
const RUNES = { vi: { vitalite: 60 }, fo: { force: 30 }, ine: { intelligence: 30 }, cha: { chance: 30 }, age: { agilite: 30 }, sa: { sagesse: 15 },
  pros: { prospection: 20 }, ini: { initiative: 100 }, rne: { resPctNeutre: 3 }, rte: { resPctTerre: 3 }, rfe: { resPctFeu: 3 },
  rea: { resPctEau: 3 }, rai: { resPctAir: 3 }, tac: { tacle: 10 }, fui: { fuite: 10 }, pui: { puissance: 25 }, do: { dommages: 8 },
  dne: { dommagesNeutre: 12 }, dte: { dommagesTerre: 12 }, dfe: { dommagesFeu: 12 }, dea: { dommagesEau: 12 }, dai: { dommagesAir: 12 },
  cri: { critique: 3 }, rall: { resPctNeutre: 2, resPctTerre: 2, resPctFeu: 2, resPctEau: 2, resPctAir: 2 }, so: { soins: 15 },
  dso: { dmgPctSorts: 3 }, ecl: { itemPct: 5 }, po: { po: 1 }, pm: { pm: 1 }, inv: { invocations: 1 }, pa: { paRune: 1 },
  dcr: { dmgPctCrit: 2 }, eve: { itemPct: 15 }, ele: { elemDouble: 1 } };
const RUNE_PER_ITEM = 2, RUNE_ELEM = ['dommagesNeutre', 'dommagesTerre', 'dommagesFeu', 'dommagesEau', 'dommagesAir'];
// stats de l'objet (déjà fusionnées) + celles de ses runes
function withRunes(st, runes) {
  if (!runes?.length) return st;
  const out = { ...st }, add = (k, v) => { if (v) out[k] = (out[k] || 0) + v; };
  for (const id of runes.slice(0, RUNE_PER_ITEM)) {
    const { itemPct, elemDouble, ...fixed } = RUNES[id] || {};
    for (const [k, v] of Object.entries(fixed)) add(k, v);
    if (itemPct) for (const [k, v] of Object.entries(st || {})) if (v > 0 && !FUSION.excluded.includes(k)) add(k, Math.max(1, Math.round(v * itemPct / 100)));
    if (elemDouble) for (const k of RUNE_ELEM) if ((st?.[k] ?? 0) > 0) add(k, st[k]);
  }
  return out;
}
const fusionCap = (type) => (type === 'dofus' ? FUSION.dofusMax : FUSION.max);
const fusionName = (f) => ((f = +f || 0) < 2 ? `T${f + 1}` : f === 2 ? 'Rayonnant' : `Rayonnant +${f - 2}`);
// exemplaires de base (T1) que représente un objet en fusion f : 1, 3, 9, 18, 27, 45, 63, 81
const fusionCopies = (f) => { let n = 1; for (let i = 0; i < (+f || 0); i++) n = i < FUSION.radiant ? n * FUSION.copies : n + 9 * radiantFeed(i); return n; };
// libellé du jeu (« Tiers 2 », « Rayonnant », « Rayonnant +3 », « T2 », « ★+1 ») → fusion
const fusionOfLabel = (t) => { const r = String(t || '').match(/(?:Rayonnant|★)\s*(?:\+\s*(\d))?/); if (r) return 2 + (+r[1] || 0);
  return Math.max(0, +(String(t || '').match(/T(?:iers)?\s*(\d)/)?.[1] || 1) - 1); };

// Résout une référence RSC « $10:props:children:1:… » vers la valeur pointée.
function rscResolve(rows, v) {
  const m = typeof v === 'string' && v.match(/^\$([0-9a-f]+):(.+)$/);
  if (!m) return v;
  let cur = rows[m[1]];
  for (const k of m[2].split(':')) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) && cur[0] === '$' && k === 'props' ? cur[3] : cur[k];
  }
  return cur;
}

// Page Next.js : payload RSC concaténé (« flight ») + chunks JS (pour retrouver les server actions).
// Simple lecture (GET) : en cas d'erreur serveur (5xx, « Resource Limit » 508…) ou réseau, on réessaie
// FLIGHT_RETRY_WAITS fois en espaçant ; fetchFlight.onRetry(message) permet d'afficher la progression.
// Fiche du personnage (caractéristiques, points, Prestige, passifs de classe) : onglet « Stats » de /personnage depuis oct. 2026
const PERSO_STATS = '/personnage?onglet=stats';
const FLIGHT_RETRY_WAITS = [2000, 5000, 10000, 20000];
async function fetchFlight(path) {
  let r;
  for (let i = 0; ; i++) {
    let why = null;
    try {
      r = await DM.fetchT(path, { credentials: 'same-origin', cache: 'no-store' });
      if (r.status >= 500) why = `HTTP ${r.status}`;
    } catch (e) {
      why = e.name === 'TimeoutError' ? 'délai dépassé' : 'erreur réseau';
    }
    if (!why) break;
    if (i >= FLIGHT_RETRY_WAITS.length) throw new Error(`${path} : ${why} (après ${i + 1} essais)`);
    fetchFlight.onRetry?.(`${path} : ${why} — nouvel essai ${i + 2}/${FLIGHT_RETRY_WAITS.length + 1} dans ${FLIGHT_RETRY_WAITS[i] / 1000} s…`);
    await sleep(FLIGHT_RETRY_WAITS[i]);
  }
  if (r.redirected && /connexion/.test(r.url)) throw new Error('Déconnecté');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();
  let flight = '';
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) flight += JSON.parse(m[1]);
  const chunks = [...new Set([...html.matchAll(/\/_next\/static\/chunks\/[^"'\\\s]+?\.js(?:\?[^"'\\\s]*)?/g)].map((m) => m[0]))];
  return { flight, chunks, html };
}

// Lignes JSON du payload RSC (« id:{…} ») + premier objet (non tableau) qui satisfait `pred`.
function rscProps(flight, pred) {
  const rows = {};
  for (const line of flight.split(/\r?\n/)) {
    const m = line.match(/^([0-9a-f]+):([[{].*)$/);
    if (!m) continue;
    try { rows[m[1]] = JSON.parse(m[2]); } catch { /* ligne texte/partielle */ }
  }
  let props = null;
  const walk = (x) => {
    if (props || x == null || typeof x !== 'object') return;
    if (!Array.isArray(x) && pred(x)) { props = x; return; }
    for (const k in x) walk(x[k]);
  };
  for (const id in rows) walk(rows[id]);
  return { rows, props };
}

async function fetchInventory() {
  const { flight, chunks } = await fetchFlight('/personnage');
  const { rows, props } = rscProps(flight, (x) => Array.isArray(x.entries) && Array.isArray(x.slots));
  if (!props) throw new Error('Inventaire introuvable dans la page');

  const entries = props.entries.map((e) => {
    const item = rscResolve(rows, e.item) || {};
    return { id: item.id, name: item.n, lvl: item.lvl, slot: item.s, rarity: item.r, fusion: e.fusion, qty: e.qty, locked: !!e.locked };
  }).filter((e) => Number.isInteger(e.id) && e.qty > 0);
  return { entries, chunks, level: +props.level || null };
}

// L'ID d'une server action change à chaque déploiement : on le relit dans les chunks JS de la page.
async function findAction(chunks, name, fallback) {
  const re = new RegExp(`createServerReference\\)\\("([0-9a-f]{20,})",[^)]*?"${name}"\\)`);
  for (const src of [...chunks].reverse()) {
    try {
      const m = (await (await DM.fetchT(src)).text()).match(re);
      if (m) return m[1];
    } catch { /* chunk suivant */ }
  }
  return fallback;
}

// Résultat d'une server action dans la réponse RSC : la ligne 0 le désigne (« "a":"$@N" ») ; souvent la ligne 1, mais pas
// toujours (la ligne 1 peut être une référence de module « I[…] » : « Unexpected token 'I' » avant la 1.81.1).
// Sinon : première ligne objet { ok | error }. → objet résultat, ou null.
function actionResult(text) {
  const rows = new Map();
  for (const l of text.split(/\r?\n/)) {
    const m = l.match(/^([0-9a-f]+):(.*)$/);
    if (m && !rows.has(m[1])) rows.set(m[1], m[2]);
  }
  const parse = (v) => { try { const o = JSON.parse(v); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; } };
  const ref = rows.get('0')?.match(/^\{"a":"\$@([0-9a-f]+)"/)?.[1];
  const res = parse(rows.get(ref || '1') || '');
  if (res) return res;
  for (const [k, v] of rows) {
    if (k === '0' || v[0] !== '{') continue;
    const o = parse(v);
    if (o && ('ok' in o || 'error' in o)) return o;
  }
  return null;
}

// Appelle une server action de la page /<segment> ; renvoie son résultat (ligne « 1: » de la réponse RSC).
// Erreur renvoyée par le jeu (« Pas assez de kamas »…) : err.game = true ; sinon problème de protocole (ID périmé…).
async function callAction(segment, actionId, args, query = '') {
  return (await postAction(segment, actionId, args, query)).res;
}

// Comme callAction, mais renvoie aussi le texte brut (la page re-rendue suit le résultat).
async function postAction(segment, actionId, args, query = '') {
  const tree = encodeURIComponent(JSON.stringify(['', { children: [segment, { children: ['__PAGE__', {}, null, null, 4096] }, null, null, 4096] }, null, null, 4116]));
  const r = await DM.fetchT(`/${segment}${query}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'text/x-component',
      'Content-Type': 'text/plain;charset=UTF-8',
      'Next-Action': actionId,
      'Next-Router-State-Tree': tree,
    },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  const text = await r.text();
  const res = actionResult(text);
  if (!res) throw new Error('Réponse du serveur illisible');
  if (res.error) throw Object.assign(new Error(res.error), { game: true });
  return { res, text };
}

// Équipements enregistrés de /personnage (composant GearPresets) ; null si illisibles.
async function fetchPresets() {
  const { flight } = await fetchFlight('/personnage');
  const { props } = rscProps(flight, (x) => Array.isArray(x.presets));
  return props && props.presets.map((p) => ({ slot: p.slot, name: String(p.name || `Équipement ${(+p.slot || 0) + 1}`), items: (p.items || []).filter(Boolean) }));
}

// Noms des équipements enregistrés (bulles ⚔️ / 🍀), par personnage : cfg.gearPresets[nom] = { list: [{ slot, name }], at }.
// Relus sur /personnage (toutes les 10 min au plus), ailleurs une fois par jour.
async function refreshPresetNames() {
  const me = myName();
  if (!me) return;
  const at = cfg.gearPresets?.[me]?.at || 0;
  if (Date.now() - at < (location.pathname.startsWith('/personnage') ? 10 : 24 * 60) * 60000) return;
  try {
    const list = await fetchPresets();
    if (list) await save({ gearPresets: { ...(cfg.gearPresets || {}), [me]: { list: list.map((p) => ({ slot: p.slot, name: p.name })), at: Date.now() } } });
  } catch (e) { DM.log(`équipements enregistrés illisibles (${e.message})`); }
}

// Ouvre ou ferme le cadenas d'une pile : server action « setItemLock(id, tier, on) » de /personnage.
const LOCK_ACTION_FALLBACK = '705e9898422cc41c27d2a949ae2d46fa5df960a549';
let lockActionId = null;
async function setItemLock(id, fusion, on) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await callAction('personnage', lockActionId || LOCK_ACTION_FALLBACK, [id, fusion || 0, !!on]);
    } catch (e) {
      // ID périmé (nouveau déploiement du site) : relu une fois dans les chunks de /personnage
      if (e.game || attempt) throw e;
      lockActionId = await findAction((await fetchFlight('/personnage')).chunks, 'setItemLock', LOCK_ACTION_FALLBACK);
    }
  }
}

// Bouton « 🔓 Tout déverrouiller » (menu 🤖 → Fusion) : ouvre le cadenas de chaque pile verrouillée, une requête à la fois.
async function unlockAll(onProgress) {
  const piles = (await fetchInventory()).entries.filter((e) => e.locked);
  let done = 0;
  for (const e of piles) {
    onProgress?.(done + 1, piles.length, e);
    await setItemLock(e.id, e.fusion, false);
    done++;
    await sleep(300);
  }
  return done;
}

// Équipe un équipement enregistré d'un coup : server action « equipGearPreset(n° 0, 1…) » de /personnage.
const PRESET_ACTION_FALLBACK = '40d5fbc32d1885b3936085996df300c1581f064912';
let presetActionId = null;
async function equipGearPreset(slot) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await callAction('personnage', presetActionId || PRESET_ACTION_FALLBACK, [slot]);
    } catch (e) {
      // ID périmé (nouveau déploiement du site) : relu une fois dans les chunks de /personnage
      if (e.game || attempt) throw e;
      presetActionId = await findAction((await fetchFlight('/personnage')).chunks, 'equipGearPreset', PRESET_ACTION_FALLBACK);
    }
  }
}
