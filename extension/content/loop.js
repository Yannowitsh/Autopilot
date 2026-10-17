// Autopilot-DM — content script : boucle principale.
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.

// ---------- Boucle ----------
let seasonWaitAt = 0;   // mode saison : début de l'attente d'une zone de chasse (leveling, farm de drop…)
async function step() {
  const path = location.pathname;

  // Priorité absolue : répondre à la vérification de présence si elle est affichée.
  const dlg = presenceDialog();
  if (dlg) {
    const ok = await solvePresence(dlg);
    setStatus(ok ? 'Vérification de présence résolue ✔' : 'Vérification de présence — en attente…');
    return progress();
  }

  if (path.startsWith('/connexion')) {
    await save({ enabled: false, paused: false, status: 'Arrêté : déconnecté' });
    notify('errors', '🔒 Déconnecté de DofusMasters : pilote auto arrêté.');
    return;
  }

  if (path.startsWith('/file-attente')) return queuePage();

  // Activité « Continuer » : au démarrage (popup, menu 🤖…), on reprend l'activité de la page affichée ; ▶ le fait déjà.
  // Page sans activité (accueil, inventaire…) : dernière activité. Farm de drop / leveling / échantillonnage : ils pilotent.
  if (continueOn() && cfg.continueDone === false && !dropOn() && !sampleOn() && !levelOn() && !archiOn() && !orbOn()) {
    const ctx = await playContext().catch(() => ({}));
    await save({ ...(ctx.mode ? ctx : {}), continueDone: true });
    // combat en cours sur la page : le pilote le prend en main, puis relance en boucle (comme ▶)
    if (ctx.mode && path.startsWith('/combat') && !endTitle()) { lastAutoClick = 0; await save({ botFight: true }); markLaunch(); }
    DM.log(`activité « Continuer » : ${ctx.mode ? DM.modeLabel(cfg) : `${ctx.error || 'page sans activité'} → dernière activité (${DM.modeLabel(cfg)})`}`);
  }

  // Mode saison : jamais d'Aventure (étapes de boss) ni d'Ascension, seulement la chasse d'une zone choisie.
  // Leveling / farm de drop / échantillonnage qui cherchent encore leur zone : on attend (2 min au plus).
  if (seasonOn() && !isHunt() && cfg.mode === 'chasse' && (levelOn() || dropOn() || sampleOn() || archiOn() || orbOn()) && Date.now() - (seasonWaitAt ||= Date.now()) < 120000) {
    setStatus('Mode saison : recherche d’une zone de chasse…');
    return progress();
  }
  if (isHunt()) seasonWaitAt = 0;
  if (seasonOn() && !isHunt()) {
    seasonWaitAt = 0;
    await save({ enabled: false, paused: false, botFight: false,
      status: `Arrêté : ${SEASON_ONLY_HUNT}${cfg.mode === 'chasse' ? ' — choisis une zone' : ''}` });
    return;
  }

  // Boss de chasse : un seul essai dans cet onglet, puis retour à l'activité.
  if (bossFighting()) {
    const end = path.startsWith('/combat') && endTitle();
    // écran de fin du combat d'avant (boss pas encore lancé) ou autre page : direction le bouton du boss
    if (!path.startsWith('/combat') || (end && !cfg.bossRun.clickedAt)) return bossLaunch();
    if (end) return bossDone(endWon(end) ? 'victoire ✔' : 'défaite ✖');
    // combat du boss en cours : le mode Auto est activé plus bas, comme pour un combat normal
  } else if (cfg.bossRun?.phase === 'waiting' && !(path.startsWith('/combat') && !endTitle())) {
    // Boss apparu : pas de relance, on y va dès qu'aucun combat n'est en cours. Le dernier combat est compté maintenant.
    const end = path.startsWith('/combat') && endTitle();
    if (end && cfg.botFight) {
      timeFightEnd();
      await save(endWon(end)
        ? { botFight: false, wins: (cfg.wins || 0) + 1, lossStreak: 0 }
        : { botFight: false, losses: (cfg.losses || 0) + 1 });
    }
    if (!isOwner()) return progress();
    DM.log(`boss de chasse : ${cfg.bossRun.name || 'boss'} → essai (retour ensuite à ${home()})`);
    await save({ bossRun: { ...cfg.bossRun, phase: 'fighting', startedAt: Date.now() } });
    setStatus(`Boss de chasse apparu (${cfg.bossRun.name || 'boss'}) — on y va…`);
    return bossLaunch();
  }

  if (path.startsWith('/combat')) {
    const end = endTitle();

    if (!end) endRetries = 0, endSince = 0;
    // relance réussie (combat en cours : bouton « Fuir ») → compteur des rechargements de l'écran de fin remis à zéro
    // (pas sur une page encore en chargement, sans titre de fin : ça rechargerait sans fin)
    if (!end && endReloads().length && visibleButtons().some((b) => /^Fuir/.test(btnText(b)))) endReloadsClear();
    if (end && (!endSince || weightedBusy)) endSince = Date.now();   // combat par poids relancé : pas bloqué
    // Écran de fin depuis plus d'une minute (relance refusée sans message, bouton absent…) : retour à la zone du mode
    // (Leveling : nouveau scan et nouveau groupe)
    if (end && Date.now() - endSince > END_STUCK_MS) {
      endSince = 0; endRetries = 0;
      if (endReload('écran de fin bloqué')) return;
      DM.log(`écran de fin bloqué depuis ${Math.round(END_STUCK_MS / 1000)} s → retour à ${levelOn() && isHunt() ? 'la zone (nouveau scan)' : home()}`);
      return levelOn() && isHunt() ? levelPick('relance bloquée sur l’écran de fin') : orbOn() && isHunt() ? orbPick('relance bloquée sur l’écran de fin') : goHome();
    }
    if (end && (weightedBusy || Date.now() - relaunchAt < RELAUNCH_WAIT_MS)) {
      setStatus(weightedBusy ? 'Combat relancé (auto par poids) en cours…' : 'Relance envoyée — on attend le combat…');
      return progress();
    }
    if (end && (isDim() || isKrala())) return guildModeEnd(end);
    if (end && isArena()) return arenaEnd(end);
    if (end && isAbyss()) return abyssEnd(end);
    if (end) {
      const hunt = huntEnd();
      const asc = !hunt && visibleButtons().some((b) => ASC_END.test(btnText(b)));
      const pathFight = !hunt && !asc && visibleButtons().some((b) => NEXT_STAGE.test(btnText(b)));
      // fin d'un combat qui n'est pas celui du mode choisi (boss de chasse, combat manuel…)
      if (isAsc() ? !asc : isHunt() ? !hunt : !pathFight) return goHome();

      if (/^Défaite/.test(end)) {
        const hint = () => document.querySelector('p.text-gold.italic')?.textContent.trim();
        if (cfg.botFight) {
          // On réessaie jusqu'à N défaites d'affilée : MAX_PATH_RETRIES (aventure, ascension), cfg.huntRetries (chasse).
          const streak = (cfg.lossStreak || 0) + 1;
          const stop = streak > maxRetries();
          timeFightEnd();
          await save({ botFight: false, losses: (cfg.losses || 0) + 1, lossStreak: stop ? 0 : streak });
          if (levelOn() && isHunt()) return levelOnDefeat(streak, hint());   // leveling : prudence en baisse, autre groupe
          if (stop && dropOn() && isHunt()) {   // farm de drop : zone abandonnée, on passe à la suivante
            const z = cfg.huntZone;
            notify('drop', `❌ Farm de drop : ${streak} défaites d’affilée dans **${dropZoneName(z)}** — zone abandonnée, passage à la suivante.${hint() ? `\n> 💡 ${hint()}` : ''}`);
            await save({ dropRun: { ...cfg.dropRun, skipped: [...(cfg.dropRun.skipped || []), z] } });
            return dropGoZone(`${streak} défaites dans ${dropZoneName(z)}`);
          }
          if (stop && sampleOn() && isHunt()) return sampleOnDefeats(streak, hint());   // échantillonnage : zone abandonnée
          if (stop && archiOn() && isHunt()) return archiOnDefeats(streak, hint());   // farm archi : groupe abandonné
          if (stop && orbOn() && isHunt()) return orbOnDefeats(streak, hint());   // farm orbe : groupe abandonné
          if (stop) {
            await save({ enabled: false, paused: false, status: 'Arrêté : combat perdu' });
            const where = `${isHunt() ? ` en chasse (${cfg.huntZoneName || 'zone ' + cfg.huntZone})` : ` en ${isAsc() ? 'ascension' : 'aventure'}`}`
              + (streak > 1 ? ` (${streak} défaites d’affilée)` : '');
            notify('defeat', `❌ **Combat perdu**${where} sur DofusMasters. Pilote auto arrêté.${hint() ? `\n> 💡 ${hint()}` : ''}\n${DM.ORIGIN}${home()}`);
            return;
          }
        }
        if (!cfg.lossStreak) return;   // défaite d'un combat lancé à la main : on n'y touche pas

        // Réessai de l'étape / du groupe (Auto de préférence)
        if (!(await gate())) return progress();
        await autoEquipTick();
        if (eqAutoBusy) return progress();
        // bouton sans effet : écran de fin rechargé, puis accueil du mode
        if (++endRetries > 2) { endRetries = 0; if (endReload('relance sans effet')) return; return goHome(); }
        setStatus(`Défaite — nouvel essai ${cfg.lossStreak}/${maxRetries()}…`);
        await sleep(relaunchDelay());
        if (!isOwner()) return;
        // deck auto : la défaite apporte des infos (mécaniques, stats des boss) → deck recalculé depuis la page Ascension
        if (isAsc() && (cfg.ascAutoDeck || cfg.ascAutoBuild) && modOn('spells')) { endRetries = 0; return goHome(); }
        const autoRetry = weightsOn() ? null : findBtn(/^Réessayer en auto$/i);
        const retry = autoRetry || findBtn(isHunt() ? HUNT_RETRY : isAsc() ? /^Réessayer l.étage$/i : /^Réessayer l.étape$/i);
        if (!retry) return;
        await save({ botFight: true });
        spendEnergy();
        lastAutoClick = autoRetry ? Date.now() : 0;
        markLaunch();
        relaunchAt = Date.now();
        retry.click();
        progress();
        await sleep(3000);
        return;
      }

      const ended = !!cfg.botFight;   // 1er passage sur cet écran de fin : victoire pas encore comptée
      if (cfg.botFight) { timeFightEnd(); await save({ botFight: false, wins: (cfg.wins || 0) + 1, lossStreak: 0 }); }
      if (dropOn() && isHunt()) {
        if (cfg.dropRun.tried?.length) await save({ dropRun: { ...cfg.dropRun, tried: [] } });
        await dropSyncInventory();   // toutes les 5 min : objets arrivés par d'autres moyens (coffres…)
        if (!dropOn()) return;
        if (!dropTargets(cfg.huntZone).size) return dropGoZone(`${dropZoneName(cfg.huntZone)} : plus rien à y dropper`);
      }
      // échantillonnage : zone suivante si l'objectif est atteint, sinon retour à la zone pour rechoisir le groupe
      // une seule fois par combat : repassé à chaque tour de boucle, le compteur de relances ne montait jamais (Leveling
      // bloqué sur « on relance le groupe en auto… ») et les victoires du Leveling étaient comptées plusieurs fois
      if (ended && sampleOn() && isHunt()) { endRetries = 0; if (await sampleAfterWin()) return; }
      if (ended && levelOn() && isHunt()) { endRetries = 0; if (await levelAfterWin()) return; }
      if (ended && archiOn() && isHunt()) { endRetries = 0; if (await archiAfterWin()) return; }   // farm archi : X combats puis groupe suivant
      if (ended && orbOn() && isHunt()) { endRetries = 0; if (await orbAfterWin()) return; }   // farm orbe : groupes renouvelés → nouveau scan
      if (!(await gate())) return progress();
      // Auto-équipement : entre deux combats (le seul moment où le jeu l'accepte), avant la relance
      await autoEquipTick();
      if (eqAutoBusy) return progress();
      // Relance sans effet (page inerte après un rechargement, groupes renouvelés…) : écran de fin rechargé d'abord,
      // puis page de la zone (Leveling : nouveau scan).
      if (++endRetries > 2) {
        endRetries = 0;
        if (endReload('relance sans effet')) return;
        return levelOn() && isHunt() ? levelPick('relance refusée') : archiOn() && isHunt() ? archiPick('relance refusée') : orbOn() && isHunt() ? orbPick('relance refusée') : goHome();
      }

      setStatus(isHunt() ? 'Victoire ✔ — on relance le groupe en auto…' : isAsc() ? 'Victoire ✔ — étage suivant en auto…' : 'Victoire ✔ — combat suivant en auto…');
      await sleep(relaunchDelay());
      if (!isOwner()) return;
      // Bouton « en auto » de préférence ; sinon relance simple, le mode Auto sera activé dans le combat.
      const autoNext = weightsOn() ? null : findBtn(AUTO_NEXT);
      // deck auto : on repasse par la page Ascension pour voir les boss de l'étage suivant et préparer le deck
      if (isAsc() && (cfg.ascAutoDeck || cfg.ascAutoBuild) && modOn('spells')) { endRetries = 0; return goHome(); }
      const next = autoNext || findBtn(isHunt() ? HUNT_RETRY : isAsc() ? /^Étage suivant$/ : /^Étape suivante$/);
      if (!next) return;
      await save({ botFight: true, ...(isAsc() && cfg.ascFloor ? { ascFloor: cfg.ascFloor + 1, ascDiff: null, ascBosses: null } : {}) });   // difficulté de l'étage suivant : inconnue
      spendEnergy();
      lastAutoClick = autoNext ? Date.now() : 0;
      markLaunch();
      relaunchAt = Date.now();
      next.click();
      progress();
      await sleep(3000);
      return;
    }

    // Combat rapide : le serveur a déjà renvoyé le résultat ; recharger affiche directement l'écran de fin.
    const fightEnd = (document.documentElement.dataset.dmFightEnd || '').split(':');
    if (fastFight() && cfg.botFight && +fightEnd[1] >= pageLoadedAt && !presenceDialog()) {
      DM.log(`combat rapide : résultat reçu (${fightEnd[0]}) ${((Date.now() - (cfg.lastLaunchAt || Date.now())) / 1000).toFixed(1)} s après le lancement → rechargement`);
      setStatus(`Combat rapide : ${fightEnd[0] === 'won' ? 'victoire' : 'défaite'} reçue — affichage du résultat…`);
      progress();
      location.reload();
      await sleep(5000);
      return;
    }
    if (!cfg.botFight) {   // combat lancé à la main : on n'y touche pas
      setStatus('Combat manuel en cours — le pilote attend', true);
      return progress();
    }
    // Auto par poids : le pilote joue lui-même les cartes (sauf repli sur l'Auto du jeu pour cette page)
    if (weightsOn() && !useGameAuto) {
      if (isOwner() && !weightedBusy) weightedFight();
      return progress();
    }
    // combat déjà lancé en Auto (« Suivant en auto »…), animation en cours
    if (Date.now() - lastAutoClick < 30000) return;
    await sleep(300 + Math.random() * 400);
    const auto = isOwner() && !endTitle() && findBtn(SEMI_AUTO);
    if (auto) {
      lastAutoClick = Date.now();
      auto.click();
      progress();
      setStatus('Combat en mode Auto (semi-auto)…');
    }
    return;
  }

  // Sur une autre page de chasse, on laisse choisir un groupe à la main (pas de retour forcé).
  if (path.startsWith('/chasse') && !onHome()) {
    setStatus('En attente : choisis un groupe de chasse (clic sur « Attaquer »)');
    return progress();
  }

  if (isHunt()) {
    if (!onHome()) return goHome();
    // retour du boss en leveling : les groupes ont pu être renouvelés → nouveau scan de la zone
    if (cfg.bossReturn && levelOn()) { await save({ bossReturn: false }); return levelPick('retour du boss de chasse'); }
    if (levelOn() && await levelNeedPick()) return;
    if (archiOn() && await archiNeedPick()) return;   // farm archi : groupe renouvelé → nouveau scan
    if (orbOn() && await orbNeedPick()) return;   // farm orbe : groupe renouvelé ou inattaquable → nouveau scan
    if (dropOn()) {
      const g = dropPickGroup();
      if (g === null) return;   // page pas encore chargée
      if (g === false) return dropGoZone(`plus de groupe utile dans ${dropZoneName(cfg.huntZone)}`);
      if (cfg.huntGroup !== g) await save({ huntGroup: g });
    } else if (sampleOn()) {
      if (sampleCount(cfg.huntZone) >= cfg.sampleRun.target) return sampleGoZone(`${sampleZoneName(cfg.huntZone)} à l’objectif`);
      const g = samplePickGroup();
      if (g === null) return;   // page pas encore chargée
      if (g === false) {   // zone sans groupe : abandonnée
        await save({ sampleRun: { ...cfg.sampleRun, skipped: [...(cfg.sampleRun.skipped || []), cfg.huntZone] } });
        return sampleGoZone(`aucun groupe dans ${sampleZoneName(cfg.huntZone)}`);
      }
      if (cfg.huntGroup !== g) await save({ huntGroup: g });
    }
    const group = targetGroup();
    if (!group) return;   // page pas encore chargée
    // Groupe d'avis de recherche choisi à la main, renouvelé depuis (combat perdu au rechargement…) :
    // attaquer le nouveau groupe n'a pas de sens → arrêt.
    const t = cfg.huntTarget;
    const isTarget = (m) => targetMatch(m, ALL_KINDS);
    if (!dropOn() && !sampleOn() && !levelOn() && !archiOn() && !orbOn() && cfg.huntGroup && t?.zone === cfg.huntZone && t.group === cfg.huntGroup && t.monsters?.some(isTarget)) {
      const now = groupMonsters(group);
      if (now.length && now.join('|') !== t.monsters.join('|') && cfg.bossReturn) {
        // retour du boss : le groupe suivi a été renouvelé pendant le boss → groupe de la zone avec une cible, sinon le plus dur
        const other = groupCards().find((p) => groupMonsters(p).some(isTarget));
        DM.log(`retour du boss : groupe ${cfg.huntGroup} renouvelé → ${other ? `groupe ${groupNumber(other)} (cible)` : 'groupe le plus dur'}`);
        await save({ huntGroup: other ? groupNumber(other) : null, huntTarget: null, bossReturn: false });
        return progress();
      }
      if (now.length && now.join('|') !== t.monsters.join('|')) {
        await save({ enabled: false, paused: false, botFight: false, huntTarget: null,
          status: 'Arrêté : le groupe ciblé (avis / archi) a été renouvelé' });
        notify('wanted', `⏹️ Le groupe ciblé (${t.monsters.filter(isTarget).join(', ')}) a été renouvelé dans **${cfg.huntZoneName || 'zone ' + cfg.huntZone}** : pilote auto arrêté.`);
        return;
      }
    }
    if ([...group.querySelectorAll('button')].some((b) => /Plus d.énergie/.test(b.textContent))) {
      lastEnergyCheck = 0;   // force une lecture : gate() mettra en pause
    }
    if (!(await gate())) return progress();
    const attack = () => [...targetGroup()?.querySelectorAll('button') || []]
      .find((b) => !b.disabled && b.offsetParent !== null && /^Attaquer$/.test(b.textContent.trim()));
    if (!attack()) return;
    setStatus(`${dropOn() ? `Farm de drop (${dropLeft().length} objet(s) restant(s))` : sampleOn() ? `Échantillonnage (${sampleCount(cfg.huntZone)}/${cfg.sampleRun.target})` : levelOn() ? `📈 Leveling niv. ${cfg.levelRun.lastLvl || '?'}` : archiOn() ? `👑 Farm archi (combat ${(cfg.archiRun.fights || 0) + 1}/${cfg.archiRun.perGroup})` : orbOn() ? `🔮 Farm orbe (combat ${(cfg.orbRun.fights || 0) + 1})` : 'Chasse'} : attaque du groupe ${cfg.huntGroup || groupNumber(group)} (${cfg.huntZoneName || 'zone ' + cfg.huntZone})…`);
    await sleep(launchDelay());
    const btn = isOwner() && attack();
    if (!btn) return;
    rememberHuntTarget(groupCardOf(btn));
    await save({ botFight: true, bossReturn: false });
    spendEnergy();
    lastAutoClick = 0;   // le combat démarre en manuel : le mode Auto sera activé au tick suivant
    markLaunch();
    btn.click();
    progress();
    await sleep(3000);
    return;
  }

  if (isAsc()) {
    if (!onHome()) return goHome();
    const start = () => findBtn(ASC_START);
    if (!start()) {
      const off = visibleButtons().find((b) => b.disabled && ASC_START.test(btnText(b)));
      if (off) lastEnergyCheck = 0;   // bouton grisé (« Pas assez d’énergie ») : gate() mettra en pause si besoin
      else if (Date.now() - loadedAt > 20000) setStatus('Ascension : bouton « Affronter l’étage » introuvable (niveau 200 requis)', true);
      if (!off) return progress();
    }
    if (!(await gate())) return progress();
    // option « deck auto » : deck conseillé enregistré et activé avant le lancement (la page est rechargée s'il change)
    if (!(await ascPrepareBuild())) return progress();   // full auto : équipement et points d'abord (le deck suit)
    if (!(await ascPrepareDeck())) return progress();
    // moteur de cet étage : celui qui y gagne le plus (essais enregistrés), l'Auto du jeu par défaut
    {
      const fl = floorOf(start()?.textContent.trim());
      const engine = ascPickEngine(fl ? await ascSeenAll(fl).catch(() => []) : []);
      if ((engine === 'ours') !== (cfg.ascUseOurs === true)) DM.log(`ascension étage ${fl ?? '?'} : ${engine === 'ours' ? 'notre moteur' : 'Auto du jeu'}`);
      await save({ ascUseOurs: engine === 'ours' });
    }
    const label = start()?.textContent.trim();
    if (!label) return;
    setStatus(`Ascension : ${label.toLowerCase()}…`);
    await sleep(launchDelay());
    const btn = isOwner() && start();
    if (!btn) return;
    // difficulté affichée (« difficulté Cauchemar ») : choisit les mécaniques des boss
    const ascDiff = document.body.innerText.match(/difficulté\s+(Initiation|Facile|Normale|Difficile|Cauchemar)/)?.[1] || null;
    await save({ botFight: true, ascFloor: floorOf(label), ascDiff });   // étage : mécaniques des boss (ascmech.js)
    spendEnergy();
    lastAutoClick = 0;   // le combat démarre en manuel : le mode Auto sera activé au tick suivant
    markLaunch();
    btn.click();
    progress();
    await sleep(3000);
    return;
  }

  if (isDim()) return dimensionPage();
  if (isKrala()) return kralaPage();
  if (isArena()) return arenaPage();
  if (isAbyss()) return abyssPage();

  if (path.startsWith('/aventure')) {
    if (visibleButtons().some((b) => /Pas assez d.énergie/.test(b.textContent))) {
      lastEnergyCheck = 0;   // force une lecture : gate() mettra en pause
    }
    if (!(await gate())) return progress();
    if (!findBtn(/^(Combattre|Affronter le boss)$/)) return;
    setStatus('Lancement du combat…');
    await sleep(launchDelay());
    const btn = isOwner() && findBtn(/^(Combattre|Affronter le boss)$/);
    if (!btn) return;
    await save({ botFight: true });
    spendEnergy(/boss/i.test(btn.textContent) ? 2 : 1);
    lastAutoClick = 0;
    markLaunch();
    btn.click();
    progress();
    await sleep(3000);
    return;
  }

  return goHome();
}

// Autre page : on revient à l'aventure / à la zone de chasse, sauf pendant une pause énergie (l'utilisateur peut naviguer).
async function goHome() {
  if (cfg.pauseReason === 'energy' && !seasonOn()) return progress();
  setStatus(isHunt() ? 'Retour à la zone de chasse…' : isAsc() ? 'Retour à l’Ascension…' : isDim() ? 'Retour à la Dimension…'
    : isKrala() ? 'Retour à la Faille du Kralamoure…' : isArena() ? 'Retour à l’arène…' : isAbyss() ? 'Retour aux Abysses…' : 'Retour à l’aventure…');
  await sleep(humanDelay());
  if (isOwner()) location.assign(home());
}

// ---------- Inactivité / file d'attente (/file-attente) ----------
// Relevé le 12/10/2026 (bighar2.har + code du site) : sans activité (clic, combat, mode Auto) depuis 10 min, le serveur
// libère la place et toute page du jeu renvoie vers /file-attente?afk=1 (« Tu étais inactif », bouton « Je suis là, je
// reviens » → /api/file?ago=0, puis /jeu si une place est libre). Serveur plein : /file-attente (« File d’attente »,
// « Ta place »), que la page interroge elle-même toutes les 10 s avant de renvoyer vers /jeu.
// Avant, le pilote repartait à sa zone, aussitôt renvoyée ici : un rechargement toutes les 2-3 s pendant 40 min.
const AFK_BACK = /^Je suis là, je reviens$/;
let afkClickAt = 0, afkClicks = 0;
async function queuePage() {
  progress();
  if (!findBtn(AFK_BACK)) {
    const place = document.body.innerText.match(/Ta place\s*(\d[\d\s ]*)/)?.[1].replace(/\D/g, '');
    return setStatus(place ? `Serveur plein — file d’attente, place ${place}…` : 'File d’attente…');
  }
  if (Date.now() - afkClickAt < 30000) return setStatus('Inactif — retour demandé, on attend le jeu…');
  setStatus('Le jeu nous a cru inactif — « Je suis là, je reviens »…');
  await sleep(humanDelay());
  const btn = isOwner() && findBtn(AFK_BACK);
  if (!btn) return;
  afkClickAt = Date.now();
  DM.log(`inactivité : « Je suis là, je reviens »${afkClicks ? ` (essai ${afkClicks + 1})` : ''}`);
  // bouton sans effet au 1er essai (page pas encore active ?) : on fait nous-mêmes ce qu'il fait
  if (afkClicks++) {
    const r = await fetch('/api/file?ago=0', { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
    if (r?.ok) return location.assign(home());
  }
  btn.click();
}

// ---------- Modes de guilde : Dimension Écarlate, Faille du Kralamoure ----------
// Relevé le 12/10/2026 (rescan3.har + code du site) :
// - /guilde/dimension : descente en cours → « Reprendre : vague N » ; sinon difficulté (radios « dimension-diff ») puis
//   « Entrer dans la Dimension (20 énergie) » (startDimensionRun(diff)). Les vagues suivantes sont gratuites.
// - fin de vague gagnée : « Vague N en auto » (l'Auto du jeu enchaîne mais s'arrête avant chaque boss) et « Vague N à la main »
//   (startDimensionWave) : on prend toujours « à la main », la vague (boss compris) est jouée comme un combat normal
//   (Auto par poids ou Auto du jeu). Défaite / fuite : descente terminée, lien « Retour à la Dimension ».
// - /guilde : « Combattre le Krala » (startFaille) ; « En récupération » (grisé) pendant 20 min après un combat
//   (FAILLE.cooldownMs, props readyAt) ; 100 essais par jour, 10 tours. Fin : lien « Retour à la guilde ».
const DIM_ENTER = /^Entrer dans la Dimension/;
const DIM_RESUME = /^Reprendre : vague \d+$/;
const DIM_NEXT = /^Vague (\d+) à la main$/;
const KRALA_GO = /^Combattre le Krala$/;
let kralaReadyAt = 0, kralaReadyRead = 0;

async function guildModeEnd(end) {
  const won = endWon(end);
  const dim = isDim();
  // le combat affiché n'est pas de ce mode (boss de chasse, combat manuel…) : retour à la page du mode
  const mine = dim ? !!findBtn(DIM_NEXT) || [...document.querySelectorAll('a')].some((a) => /^(Retour à la|Page de la) Dimension/.test(a.textContent.trim()))
    : [...document.querySelectorAll('a')].some((a) => /^Retour à la guilde/.test(a.textContent.trim()));
  if (!mine) return goHome();
  if (cfg.botFight) {
    timeFightEnd();
    await save({ botFight: false, ...(won ? { wins: (cfg.wins || 0) + 1, lossStreak: 0 } : { losses: (cfg.losses || 0) + 1 }) });
    if (dim && !won) {
      const pts = document.body.innerText.match(/Descente terminée à la vague (\d+)/);
      DM.log(`Dimension : descente terminée${pts ? ` à la vague ${pts[1]}` : ''}`);
      notify('defeat', `🌀 Dimension Écarlate : descente terminée${pts ? ` à la vague **${pts[1]}**` : ''}.${cfg.dimRestart === false ? ' Pilote arrêté.' : ' Nouvelle descente…'}`);
      if (cfg.dimRestart === false) { await save({ enabled: false, paused: false, status: 'Arrêté : descente de la Dimension terminée' }); return; }
    }
  }
  if (!dim) return goHome();   // Kralamoure : retour à la guilde, prochain combat dès qu'il est prêt
  const next = findBtn(DIM_NEXT);
  if (!won || !next) return goHome();   // descente terminée : nouvelle descente depuis la page de la Dimension
  if (!(await gate())) return progress();
  await autoEquipTick();
  if (eqAutoBusy) return progress();
  if (++endRetries > 2) { endRetries = 0; if (endReload('relance de la vague sans effet')) return; return goHome(); }
  const wave = +btnText(next).match(DIM_NEXT)[1];
  const boss = document.body.innerText.match(/Prochaine vague : (Seigneur de la Dimension|boss)/)?.[1];
  setStatus(`Victoire ✔ — Dimension : vague ${wave}${boss ? ` (${boss === 'boss' ? 'boss' : boss})` : ''}…`);
  await sleep(relaunchDelay());
  const btn = isOwner() && findBtn(DIM_NEXT);
  if (!btn) return;
  await save({ botFight: true });
  lastAutoClick = 0;   // vague lancée « à la main » : Auto par poids ou Auto du jeu au tick suivant
  markLaunch();
  relaunchAt = Date.now();
  btn.click();
  progress();
  await sleep(3000);
}

async function dimensionPage() {
  if (location.pathname !== '/guilde/dimension') return goHome();
  const resume = findBtn(DIM_RESUME), enter = findBtn(DIM_ENTER);
  if (!resume && !enter) {
    const off = visibleButtons().find((b) => b.disabled && DIM_ENTER.test(btnText(b)));
    if (off) lastEnergyCheck = 0;   // bouton grisé : pas assez d'énergie → gate() met en pause
    else if (Date.now() - loadedAt > 20000) setStatus('Dimension : bouton d’entrée introuvable (guilde requise ?)', true);
    if (!off) return progress();
    if (!(await gate())) return progress();
    setStatus('Dimension : entrée impossible pour l’instant (20 énergie requises)', true);
    return progress();
  }
  if (!(await gate())) return progress();
  if (resume) {
    setStatus(`Dimension : ${btnText(resume).toLowerCase()}…`);
  } else {
    // difficulté choisie : radio n° dimDiff (ordre de la page = ids 0 à 4)
    const radios = [...document.querySelectorAll('input[type=radio][name="dimension-diff"]')];
    const r = radios[Math.max(0, Math.min(radios.length - 1, +cfg.dimDiff || 0))];
    if (r && !r.checked) { r.closest('label')?.click(); await sleep(400); }
    setStatus(`Dimension : nouvelle descente (${DM.DIM_DIFFS[+cfg.dimDiff] || '?'}, 20 énergie)…`);
  }
  await sleep(launchDelay());
  const btn = isOwner() && (findBtn(DIM_RESUME) || findBtn(DIM_ENTER));
  if (!btn) return;
  await save({ botFight: true });
  if (DIM_ENTER.test(btnText(btn))) spendEnergy(20);
  lastAutoClick = 0;
  markLaunch();
  btn.click();
  progress();
  await sleep(3000);
}

async function kralaPage() {
  if (location.pathname !== '/guilde') return goHome();
  const go = findBtn(KRALA_GO);
  if (!go) {
    const wait = visibleButtons().find((b) => b.disabled && /^En récupération$/.test(btnText(b)));
    if (!wait) {
      if (Date.now() - loadedAt > 20000) setStatus('Kralamoure : bouton « Combattre le Krala » introuvable (guilde requise, essais du jour épuisés ?)', true);
      return progress();
    }
    // heure de fin de la récupération : props « readyAt » du bouton (relues au plus une fois par minute)
    if (Date.now() - kralaReadyRead > 60000) {
      kralaReadyRead = Date.now();
      try { kralaReadyAt = +((await fetchFlight('/guilde')).flight.match(/"label":"En récupération","readyAt":(\d+)/)?.[1] || 0); } catch { /* rien */ }
    }
    if (kralaReadyAt && Date.now() > kralaReadyAt + 3000) { kralaReadyAt = 0; location.reload(); return; }
    setStatus(`Kralamoure en récupération${kralaReadyAt ? ` — prochain combat à ${DM.hhmm(kralaReadyAt)}` : '…'}`);
    return progress();
  }
  setStatus('Kralamoure : combat…');
  await sleep(launchDelay());
  const btn = isOwner() && findBtn(KRALA_GO);
  if (!btn) return;
  await save({ botFight: true });
  lastAutoClick = 0;
  markLaunch();
  btn.click();
  progress();
  await sleep(3000);
}

// ---------- Arène ----------
// Relevé le 12/10/2026 (arene.har + code du site) :
// - /arene : une carte par adversaire (liste fixe 10 min), bouton « Défier » (startPvp(opponentId) → /combat) ;
//   « Déjà affronté N× en 24 h » sur ceux déjà combattus (gain d'Elo réduit : ½, ¼, puis 0).
// - « Tickets : X du jour + Y en stock » : 1 ticket par défi, 10 gratuits par jour (remis à minuit, non cumulables)
//   dépensés d'abord, puis ceux du stock (coffres). Combat « pvp » sans énergie, fin : retour à /arene.
// Le pilote défie une fois chaque adversaire pas encore affronté, en vérifiant les tickets avant chaque défi, puis s'arrête.
const ARENA_GO = /^Défier$/;
const arenaTried = {};   // adversaire → défis cliqués sans combat (bouton sans effet : on passe au suivant)

function arenaTickets() {
  const m = document.body.innerText.match(/Tickets\s*:\s*(\d+)\s*du jour\s*\+\s*(\d+)\s*en stock/);
  return m ? { day: +m[1], stock: +m[2] } : null;
}

function arenaCards() {
  return visibleButtons().filter((b) => ARENA_GO.test(btnText(b))).map((btn) => {
    let card = btn.closest('[class*="__arena"]');
    for (let el = btn.parentElement; !card && el && el !== document.body; el = el.parentElement) if (el.querySelector('.title')) card = el;
    const name = card?.querySelector('.title')?.textContent.trim() || '?';
    const error = btn.parentElement?.querySelector('.text-ember')?.textContent.trim() || '';
    return { btn, name, faced: /Déjà affronté/.test(card?.textContent || ''), error };
  });
}

async function arenaStop(status, msg) {
  DM.log(`arène : ${status}`);
  await save({ enabled: false, paused: false, botFight: false, status: `Arrêté : ${status}` });
  if (msg) notify('errors', msg);
}

async function arenaEnd(end) {
  if (cfg.botFight) {
    const won = endWon(end);
    timeFightEnd();
    await save({ botFight: false, ...(won ? { wins: (cfg.wins || 0) + 1, lossStreak: 0 } : { losses: (cfg.losses || 0) + 1 }) });
    DM.log(`arène : ${won ? 'victoire' : 'défaite'}`);
  }
  return goHome();   // prochain adversaire depuis la page de l'arène (tickets relus)
}

async function arenaPage() {
  if (location.pathname !== '/arene') return goHome();
  const cards = arenaCards(), t = arenaTickets();
  if (!t || !cards.length) {
    if (Date.now() - loadedAt > 20000) {
      if (!t) setStatus('Arène : nombre de tickets illisible — aucun défi lancé', true);
      else return arenaStop('aucun adversaire dans l’arène');
    }
    return progress();
  }
  const err = cards.find((c) => c.error);
  if (err) return arenaStop(`arène — ${err.error}`, `⚔️ Arène : défi refusé (${err.error}). Pilote auto arrêté.`);
  const todo = cards.filter((c) => !c.faced && !c.btn.disabled && (arenaTried[c.name] || 0) < 2);
  if (!todo.length) {
    const n = cards.filter((c) => c.faced).length;
    return arenaStop(`arène terminée (${n}/${cards.length} adversaires affrontés en 24 h)`);
  }
  // 1 ticket par défi : ceux du jour, puis le stock seulement si la case est cochée
  const usable = t.day + (cfg.arenaStock ? t.stock : 0);
  if (usable < 1) {
    return arenaStop(`plus de tickets d’arène${t.stock && !cfg.arenaStock ? ` du jour (${t.stock} en stock gardés)` : ''} — ${todo.length} adversaire${todo.length > 1 ? 's' : ''} non affronté${todo.length > 1 ? 's' : ''}`,
      `⚔️ Arène : plus de tickets${t.stock && !cfg.arenaStock ? ' du jour' : ''}, ${todo.length} adversaire(s) non affronté(s). Pilote auto arrêté.`);
  }
  const c = todo[0];
  setStatus(`Arène : défi contre ${c.name} (${todo.length} restant${todo.length > 1 ? 's' : ''}, tickets : ${t.day} du jour + ${t.stock} en stock)…`);
  await sleep(launchDelay());
  const btn = isOwner() && arenaCards().find((x) => x.name === c.name && !x.faced && !x.btn.disabled)?.btn;
  if (!btn) return;
  arenaTried[c.name] = (arenaTried[c.name] || 0) + 1;
  await save({ botFight: true });
  lastAutoClick = 0;   // le combat démarre en manuel : Auto par poids ou Auto du jeu au tick suivant
  markLaunch();
  btn.click();
  progress();
  await sleep(3000);
}
