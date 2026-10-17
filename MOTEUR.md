# Journal du moteur (IA de combat, deck, build)

Mémoire des changements de **comportement** d'Autopilot-DM : décisions de combat (`ascmech.js`, `weights.js`, `abyss.js`),
conseiller de deck (`ascdeck.js`), optimiseur de build (`build-*.js`), pilote (`loop.js`).
Chaque entrée garde la règle, la preuve qui l'a motivée et le moyen de la défaire : si un changement se révèle faux
plus tard, on sait d'où il vient et ce qu'il faut remettre.

Règles du fichier :
- une entrée par changement de comportement, la plus récente en haut, avec la version du manifest ;
- **Preuve** : combats enregistrés (n° `seq` de la table D1 `combats`), chiffres mesurés ;
- **Code** : fichier et fonction / constante touchés ;
- **Annuler** : ce qu'il faut remettre si la règle se révèle fausse ;
- **À surveiller** : ce qui confirmerait ou infirmerait la règle dans les prochains combats ;
- statut : `en test` (pas encore vu en combat après le changement), `confirmé` (vérifié sur des combats ultérieurs),
  `annulé` (garder l'entrée, dire pourquoi).

Objectif : que le moteur s'adapte seul (mécaniques apprises en combat, essais enregistrés, variantes de deck), sans
réécrire l'IA à chaque étage. Une règle propre à un étage est un signal d'alerte : chercher la règle générale.

## Questions ouvertes

- **Reflet assumé à bas PV** : le bot joue un sort dont une ligne est renvoyée (Tromperie, 4 éléments) ; 15245 tour 4 à
  6 143 PV, 7 932 renvoyés (critique). La marge `REFL_MARGIN` compte-t-elle bien le critique ?
- **Fureur** (plus de N cartes → attaque ×2,5) : le bot la déclenche exprès dans ~55 % des tours à l'étage 145
  (carte en plus = 3-4 coups sous le Seuil), pour 8 à 18 k PV perdus par combat. Arbitrage à mesurer : combats avec et
  sans dépassement, PV restants des boss à la mort.
- **Équipement sans exploration** : le build auto est déterministe ; seul le deck essaie des variantes. Piste : écarter
  un objet après N défaites avec le même build, comme pour le deck.
- **Deck conseillé avec les stats du dernier combat** : après un changement d'équipement, il ne se recale qu'à l'essai
  suivant.
- **Marge de survie** (optimiseur, objectif Ascension) : Glas, Écho, Accoutumance pas comptés.

---

## 2.40.1 — Pilote : au moins 3,5 s entre deux lancements de combat · `en test`

- **Règle** : chaque clic qui lance un combat (attaque, relance, réessai, étape / étage / vague suivante, Kralamoure,
  arène, Abysses, boss de chasse) attend au moins `LAUNCH_GAP_MS` (3,5 s) + 0 à 1 s depuis le lancement précédent de
  l'onglet, quels que soient `delayMin` / `delayMax`. Mémorisé par onglet (sessionStorage) : le stockage est partagé
  entre les deux comptes (navigation privée « spanning »).
- **Preuve** : Discord, le développeur du jeu (18/10, 00:13–00:15) : « en ratio humain un combat fini jamais en dessous de 2.8 s avant
  la relance », 3 s en auto AFK (imposé par le serveur), 1,2 s en auto normal ; en dessous « c'est de la macro » ;
  11 comptes suspendus le même soir. Trous trouvés : délai de la popup réglable à 0, Abysses « rapide » (0,4–1 s après
  un choix), boss de chasse (0,8–2 s).
- **Code** : `content/core.js` (`LAUNCH_GAP_MS`, `launchWait`, `launchDelay`, `relaunchDelay`, `bossLaunch`),
  `content/fight.js` (`markLaunch` note l'heure), `content/loop.js` et `content/abyss.js` (sites de lancement).
- **Annuler** : `LAUNCH_GAP_MS = 0`.
- **À surveiller** : écart minimal entre deux `at` de combats d'un même joueur dans D1 `combats` (doit rester ≥ 3,5 s).

## 2.40.0 — Pilote : mode 🔮 Farm orbe (pious) · `en test`

- **Règle** : scan des zones à pious (bestiaire, race « Pious ») ; groupe fait uniquement de pious classiques (ni archi,
  ni avis, ni autre monstre), 4 de préférence sinon 3, plus faible niveau total ; relancé jusqu'au renouvellement des
  groupes ou à l'échec de la relance, puis rescan. Rien : rescan au renouvellement. 3 défaites : groupe écarté ;
  45 s sans « Attaquer » : zone écartée.
- **Preuve** : demande d’un utilisateur (18/10). Relevé du 18/10 : 12 zones à pious, groupes de 1 à 4 monstres, la plupart
  des groupes de 3+ contiennent un archimonstre → l'attente du renouvellement sera fréquente.
- **Code** : `content/orbfarm.js` (`orbBestGroup`, `orbPick`, `orbNeedPick`, `orbAfterWin`), branchements dans `loop.js`.
- **Annuler** : retirer `content/orbfarm.js` du manifest et les appels `orb*` de `loop.js`, `core.js`, `ui.js`, `ui-menus.js`.
- **À surveiller** : temps passé à attendre un groupe valide ; zones de Bonta / Brâkmar réellement attaquables.

## 2.38.0 — patch du 17/10 : Kaboom du Roublard, pano Mehdi (en test)

- **Règle** : (1) Auto par poids : Kaboom (effet `detonate`) jamais lancé sans bombe posée, et seulement quand aucune carte
  bombe n'est jouable à ce coup (ou 10 bombes posées). Bombes comptées par le pilote (`casts.$bombs`, remis à 0 par Kaboom).
  (2) Passif Artificier (`classTracker`) : depuis le 17/10, +11 % par bombe qui EXPLOSE = bombes posées au moment de Kaboom
  (avant : chaque lancer de bombe ou de Kaboom). (3) Optimiseur : chaque légendaire porté (991001, 991002, 991010-991018)
  +20 % de ses stats (hors PA/PM/PO/invocations) et +2 % de dégâts de sorts (`withLegend`).
- **Preuve** : patchnote du dev du 17/10 ; chunk du jeu : `bomb` « dommages quand Kaboom la fait exploser », `detonate`
  « +20 % par bombe posée ». Pano Mehdi : `st` de l'Arme Mehditaclaque inchangé sur /personnage le 17/10 (pas de
  dmgPctSorts) → bonus appliqué par le serveur. Aucun combat de Roublard enregistré (base D1 non lue : wrangler non autorisé).
- **Code** : `weights.js` (BOMB_MAX, isBombCard, isDetonateCard, chooseFightAction, mise à jour de casts),
  `classes.js` (BOMB_KABOOM_SINCE, s.planted), `inventory.js` (LEGEND_BOOST, withLegend), `build-solver.js`, `fusion-equip.js`.
- **Annuler** : retirer le filtre `isDetonateCard` de chooseFightAction ; remettre `s.bombs++` sans date ; LEGEND_BOOST à 0.
- **À surveiller** : un Roublard qui finit des combats avec des bombes non explosées (Kaboom trop tardif) ; l'état de
  combat expose peut-être le nombre de bombes (à lire plutôt que compter). Fiche vs optimiseur avec un légendaire :
  l'invocation est-elle boostée, le +20 % se calcule-t-il avant les runes ? Non modélisé : la valeur de Kaboom elle-même
  (dégâts des bombes ×(1 + 0,2 × n)) et l'attaque coordonnée de l'Osamodas (25 → 50 %).

## 2.37.1 — Pioche : cartes en recharge exclues, refus comptés par tour · `en test`

- **Règle** : le paquet de pioche exclut les cartes en recharge (`readyOn[uid] > turnNo`), comme le jeu (« Plus aucune
  carte à piocher. ») ; le compteur de refus (5 refus → Auto du jeu) repart de zéro à chaque tour.
- **Preuve** : étage 152, seq 18421 (gagné) : deck de 7 cartes, Drain Élémentaire en recharge ; le bot comptait
  « 1 carte utile au paquet » et piochait, refus aux tours 2 à 7 (7 refus sur le combat) → 6e refus au tour 7 →
  repli sur l'Auto du jeu pour la fin du combat.
- **Code** : `weights.js` `chooseFightAction` (pool), `weightedFight` (`errors = 0` au changement de tour).
- **Annuler** : retirer le filtre `readyOn` du pool et le `errors = 0`.
- **À surveiller** : plus aucune pioche refusée dans les combats enregistrés (décision « pioche » sans `draw` au journal).

## 2.37.0 — Optimiseur : runes et PA des légendaires · `en test`

- **Règle** : chaque objet possédé compte ses runes (`withRunes`, table `RUNES` = RUNE_LIST du jeu) avant le
  multiplicateur d'équipement ; Rune d'Action : une seule par personnage (`paRune`) ; PA des légendaires au-delà du
  plafond (`paFree`, 2.36.2).
- **Preuve** : fiche d’un personnage le 16/10 (P11, 16 PA au plafond 15 ; runes Éveil ×3, Mouvement) : somme des objets
  à 1,5 % de la fiche avec les runes multipliées, 5 % sans.
- **Code** : `inventory.js` `RUNES`, `withRunes` ; `fusion-equip.js` `fetchEquipState` (`runes`) ; `build-solver.js`
  (eff du pool) ; `build-data.js` `buildPaOf`, `PRESTIGE_EXCLUDED`.
- **Annuler** : retirer `withRunes` du pool et de `fetchEquipState`.
- **À surveiller** : l'écart restant (~1,5 % de Vitalité) ; un exemplaire runé et un non runé du même objet au même tier
  partagent la clé `id|fusion` (l'équipement automatique peut prendre le mauvais).

## 2.36.0 — Patch du jeu 14-16/10 : soins et boucliers 40 %, Eniripsa/Sacrieur 3 par tour, Popokémons, Dofus R+5 · `en test`

- **Règle** : chaque soin ou bouclier compté au plus à 40 % des PV max (25 % avant) ; 3 sorts de soin/bouclier par
  tour pour l'Eniripsa (breed 7) et le Sacrieur (11), 2 pour les autres (Abysses : inchangé, `ABYSS_SUSTAIN`) ;
  carte « tes coups ne peuvent pas tuer la cible » (Maîtrise des Popokémons) jamais lancée ni gardée dans un deck
  conseillé ; Dofus et trophées fusionnables jusqu'au Rayonnant +5 (optimiseur, conseil d'objet éternel).
- **Preuve** : patch notes du développeur (14 et 16/10) ; `dofusMax: 7` relu dans le chunk des constantes du jeu le 16/10.
- **Code** : `ascmech.js` `SUPPORT_CAP`, `supportPerTurn` ; `weights.js` `noKillCard`, `supportLeft` ; `ascdeck.js`
  `usefulCard` ; `inventory.js` `FUSION.dofusMax` ; `build-ui.js` `rarityOf` (plus de ×5 pour un Dofus).
- **Annuler** : `SUPPORT_CAP = 0.25`, `supportLeft` avec `SUPPORT_PER_TURN`, retirer `noKillCard`, `dofusMax: 4`.
- **À surveiller** : soins/boucliers réels > 25 % des PV max dans les combats enregistrés ; refus « 2 sorts de soin »
  pour un Eniripsa au 3e sort.

## 2.35.5 — Glas lu dans l'état du combat, brisé au dernier tour · `en test`

- **Règle** : un boss est « sous Glas » quand l'état du combat le dit (`f.knell { need, dealt, left }`), plus seulement
  quand le journal du tour le mentionne. Au dernier tour (`left ≤ 1`), une suite qui inflige les PV restants (bouclier
  compris) gagne 1,5 × le coup évité (50 % de nos PV max − bouclier).
- **Preuve** : étage 152, 15251-15260 : le Glas est reçu dans 8 défaites sur 9 (~13 900 PV, 42 % de nos PV). Le message
  « encore X PV (dernier tour) » s'affiche au tour du boss, donc le tour suivant (le dernier) ne voyait plus le Glas :
  15260 tour 4, Flèche + arme sur Fuji, 7 PA et 4 cartes en main. Dans 15251, brisé avec 1 934 PV + 8 995 absorbés pour
  2 507 restants : le bouclier compte. Les coups du tour d'annonce ne comptent pas (besoin entier au tour suivant).
  Rejoué sur 15260 tour 4 : la suite passe de Fuji à XLII (Eau-de-vie, Flèche, arme).
- **Code** : `ascmech.js`, `planTurn` → `knellOf`, `knelled`, `knellLast` ; bonus dans `dfs` avant `best`.
- **Annuler** : remettre `knelled` sur le seul journal (`sinceRound` / `sinceMyTurn`) et retirer `knellLast` et sa boucle.
- **À surveiller** : « Glas … brisé ! » au dernier tour ; Glas reçu alors que la suite prévoyait de le briser
  (estimation trop haute : Seuil, Rancune).

## 2.35.5 — Deck conseillé sans soins sous Malédiction des soins du premier boss · `en test`

- **Règle** : si le premier boss a une Malédiction des soins entière (pas « divisés par deux ») dès le tour 1 ou 2, les
  cartes qui soignent le lanceur (vol de vie, soin sur soi) sont écartées du deck conseillé, et sortent du deck actuel,
  tant qu'il reste assez de cartes pour un deck complet.
- **Preuve** : étage 152, 9 défaites (15251-15260) : 4 cartes sur 7 à soin / vol de vie (Cryothérapie, Eau-de-vie,
  Tromperie, Drain Élémentaire) sous la Malédiction de Fuji, qui mène tout le combat. Dès le tour 3, 1 carte par tour,
  9 PA et 5 cartes en main dans 7 combats sur 9. La simulation du deck ne donne au premier boss que 2 tours sur 6 et
  joue le tour 1, avant la Malédiction : les soins y semblaient rentables.
- **Code** : `ascdeck.js`, `adviseAscDeck` → `cursed`, `allowed`, `inPool` ; `ascHealsSelf` (aussi dans `ascCardReason`).
- **Annuler** : remettre `const pool = cards.filter(usefulCard)` et les filtres `castOnly` seuls sur `cands` / `deck`.
- **À surveiller** : deck à 7 cartes de dégâts et passage du 152 ; manque de soins quand la Malédiction est sur un boss
  qui tombe vite (piste : peser chaque boss selon sa durée en tête dans `evalAscDeck`).

## 2.35.4 — Vol de vie compté sur tous les ennemis touchés · `en test`

- **Règle** : le vol de vie d'un sort est calculé sur les dégâts réellement infligés à chaque ennemi touché (zone
  comprise, Seuil et boucliers déduits). Sous Malédiction des soins, tout ce vol de vie blesse ; sinon il soigne (moins
  qu'avant sur les cibles à Seuil, où les dégâts sont plafonnés).
- **Preuve** : 15247 (étage 151), tour 6 : Dents du Piranya sur Minotot (Seuil), deux gardiens tués dans la zone
  (9 872 chacun) → 13 422 PV contre nous = 50 % de (5 521 + 1 579 + 9 872 + 9 872). Le moteur ne comptait que le vol de
  vie de la cible principale, sans plafond.
- **Code** : `ascmech.js`, `planTurn` → `hit()` accumule `stole` ; `curse` / `healed` l'utilisent au lieu de
  `eff.self` / `eff.steal`.
- **Annuler** : remettre `self += eff.self; worst += eff.steal * specMax + eff.heal` et
  `healed += (eff.steal + eff.heal) * …`.
- **À surveiller** : gros dégâts « moi » juste après un sort à vol de vie sous Malédiction des soins ; soins de vol de
  vie trop bas (bot qui ne se soigne plus assez sur les boss à Seuil).

## 2.35.3 — Écho annulé en finissant le tour par l'arme · `confirmé`

- **Règle** : l'Écho (Transmutés) ne renvoie rien si le dernier coup du tour est l'arme (ou un soin / bouclier). Avant,
  le moteur comptait le dernier *sort* même suivi de l'arme.
- **Preuve** : étage 145, combats 15205-15210 et 15233-15237 : 78 tours finis par l'arme après des sorts → 0 Écho ;
  tours finis par un sort → 10 Échos sur 18. Effet du bug : 15236, tours 8 à 17 joués à l'arme seule, 9 PA et 4 sorts
  en main (le bot évitait un Écho qui ne serait pas venu).
- **Code** : `ascmech.js`, `planTurn` → `lastQ = seq.at(-1)` (arme en dernier = rien de copié) et `lastLogged` (arme
  ignorée).
- **Annuler** : `lastQ = seq.filter((q) => !q.x.weapon).at(-1)` et retirer le test `L.card !== p.weaponCard?.name`.
- **À surveiller** : un « Écho de … » dans le journal après un tour fini par l'arme ; fins de combat à 9 PA inutilisés.
- **Confirmé** (16/10, 15239-15247, étages 145-151) : 0 Écho sur 19 tours finis par l'arme (22 sur 28 finis par un sort) ;
  fins de tour passives (≥ 5 PA, 2 sorts jouables) 4 sur 54. Étage 145 passé au 1er essai en 2.35.3, puis 146 à 150.

## 2.35.3 — Cartes à condition de lancer écartées du deck conseillé · `en test`

- **Règle** : une carte dont la description dit « ne peut se lancer que … » (Noa : sur la Lance, lanceur Désarmé) n'est
  jamais proposée, et sort du deck actuel.
- **Preuve** : 15235-15237, Noa dans le deck (variante d'exploration), jamais candidate ni jouée : deck à 6 cartes.
- **Code** : `ascdeck.js`, `castOnly`, `usefulCard`, départ de `adviseAscDeck`.
- **Annuler** : retirer `!castOnly(c)` de `usefulCard` et les deux filtres dans `adviseAscDeck`.
- **À surveiller** : une carte à condition qu'on saurait remplir (le moteur ne gère pas les états Désarmé, etc.).

## 2.35.2 — Recalcul du build / deck à chaque défaite, exploration des decks · `en test`

- **Règle 1** : la signature qui déclenche le recalcul (build auto et deck auto) contient la date du dernier essai, pas
  seulement leur nombre.
- **Preuve** : 15213-15230, 13 défaites à l'étage 145 avec le même build et le même deck ; `ascRemember` ne garde que
  10 essais par étage → nombre figé → signature figée.
- **Code** : `ascdeck.js`, `ascAttemptSig`.
- **Règle 2** : un deck qui a perdu `ASC_TRY_LOSSES` (3) fois au même étage n'est plus reproposé ; le conseiller prend la
  meilleure variante à une carte près pas encore épuisée. Essais comptés dans `localStorage.dmAscTried`.
- **Preuve** : demande d'exploration ; constat ci-dessus (même deck rejoué).
- **Code** : `ascdeck.js`, `ascCountTry`, `ascSpent`, fin de `adviseAscDeck` (`explored`).
- **Annuler** : `ASC_TRY_LOSSES = Infinity` (exploration coupée sans toucher au reste).
- **À surveiller** : décrocher l'étage avec une variante ; variantes qui tournent en rond (voisines du même optimum).

## 2.35.1 — Marge de survie : Seuil, Fureur, Lien d'âme · `en test`

- **Règle** : optimiseur objectif Ascension — PV perdus par un boss à Seuil plafonnés à lignes de dégâts du tour × pct %
  de ses PV max ; Fureur : seules les N meilleures cartes du tour comptent ; Lien d'âme : boss tués après son porteur
  ×(1 + pct).
- **Preuve** : étage 145 (15205-15210) : coups plafonnés à ~5,5 k alors que les sorts font 15-22 k ; l'optimiseur
  poussait la puissance, inutile.
- **Code** : `ascdeck.js`, `ascBossLoad` (`cap`, `bond`), `ascOptimizerData` (`furyMax`), `ascSurvival` (paramètre
  `turn`) ; appels dans `build-solver.js`.
- **Annuler** : ne plus passer `turn` à `ascSurvival` (Seuil et Fureur ignorés) ; `bond: 0`.
- **À surveiller** : build auto qui passe de la puissance aux PV / résistances sur les étages à Seuil.

## 2.35.0 — Pilote full auto (build de survie équipé avant chaque essai) · `en test`

- **Règle** : `cfg.ascAutoBuild` — avant chaque étage et après chaque défaite, optimiseur « Ascension (survie) » avec
  les seuls objets possédés à leur vrai tier (`realTiers`), équipement + points appliqués, puis deck auto.
- **Preuve** : 15213 → 15236 : vitalité 29 016 → 31 475, combats de 14-17 tours, XLII à 28 k / 26 k au mieux
  (56 k avant).
- **Code** : `ascdeck.js`, `ascPrepareBuild` ; `build-solver.js`, `opts.realTiers` ; `loop.js` (appel avant
  `ascPrepareDeck`).
- **Annuler** : décocher l'option (rien d'autre ne change).

## 2.34.0 — Optimiseur : deck de 7 cartes au moins, défense proposée · `en test`

- **Règle** : le deck conseillé de l'optimiseur a toujours au moins 7 cartes (minimum du jeu), avec le meilleur bouclier
  et le meilleur soin par PA (`DECK_DEF` = 2) ; code DM-S-… copiable.
- **Preuve** : decks de 5 cartes proposés (refusés par le jeu).
- **Code** : `build-solver.js` (deck), `build-data.js` (`DECK_MIN`, `DECK_DEF`), `spells.js` (`defs`, `deckCode`).
- **Annuler** : `DECK_DEF = 0`.

## 2.33.2 — Fureur : l'arme ne compte pas ; Glas prioritaire même face à un gardien · `en test`

- **Règle 1** : « Fureur déjà chargée » ne compte plus l'arme dans les cartes du tour.
- **Preuve** : 15205-15210 : 21 tours sur 60 crus « déjà chargés » à tort, 10 tours à 3 cartes joués pour rien.
- **Code** : `ascmech.js`, `furyPending` (`weaponName`).
- **Règle 2** : boss sous Glas sonné ou Échange de vie à venir : essayé comme cible même quand un coup fatal sur un
  gardien passe devant.
- **Preuve** : 15208 tour 2 : arme seule sur un gardien, 8 PA et Drain / Tromperie en main, Glas reçu (13 229 PV).
- **Code** : `ascmech.js`, `planTurn`, `picks` (knelled / swapRush).
- **Annuler** : retirer la boucle `for (const f of ok) … picks.push(f)`.
