/**
 * Showdown Battle Test Bot - content script
 *
 * Watches the page for Showdown's move/switch/teampreview buttons and
 * auto-clicks one when it's your turn to choose. Intended for your own
 * unrated (direct-challenge / room) battles, for learning and bug
 * catching -- not for the ranked ladder.
 *
 * This script has NO way to detect whether a given battle is ranked or
 * not. Only enable it (via the popup) during battles you intend to test.
 *
 * Robustness notes:
 * - Each button type has a PRIMARY selector (Showdown's documented
 *   name= convention) and FALLBACK selectors (older class-based
 *   markup), tried in order.
 * - A MutationObserver AND a 1-second poll both trigger checks, so a
 *   missed DOM event can't silently stall the bot.
 * - If it's stuck for 10+ seconds with no recognized button found
 *   while battle UI is clearly present, it logs a diagnostic snapshot
 *   of the controls area so a selector fix can be made quickly.
 * - A small on-page badge shows live status without needing DevTools.
 */

const SELECTOR_SETS = {
  move: [
    'button[name="chooseMove"]:not([disabled])',
    ".movemenu button:not(.disabled)",
  ],
  target: [
    'button[name="chooseMoveTarget"]:not([disabled])',
    'button[name="chooseTarget"]:not([disabled])',
    ".targetmenu button:not([disabled])"
  ],
  switch: [
    'button[name="chooseSwitch"]:not([disabled])',
    ".switchmenu button:not(.disabled)",
  ],
  teamPreview: [
    'button[name="chooseTeamPreview"]:not([disabled])',
    ".teampreview button",
  ],
};

const ACTION_DELAY_MS = [300, 900];
const STUCK_THRESHOLD_MS = 10000;

// --- Injected script to fetch data from main world ---
let cachedMoveData = {};
let cachedOppData = {};

window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.direction !== 'from-page') return;
  if (event.data.type === 'MOVES_RESULT') {
    for (const [m, data] of Object.entries(event.data.result)) {
       cachedMoveData[m] = data || { basePower: 0, category: 'Status', type: 'Normal', priority: 0, accuracy: 100 };
    }
  }
  if (event.data.type === 'OPP_RESULT') {
    for (const [name, data] of Object.entries(event.data.result)) {
       let obj = data || { baseStats: { hp: 100, atk: 100, def: 100, spa: 100, spd: 100, spe: 100 } };
       if (!obj.baseStats) obj.baseStats = { hp: 100, atk: 100, def: 100, spa: 100, spd: 100, spe: 100 };
       cachedOppData[name] = obj;
    }
  }
});

let enabled = false;
let lastActedSignature = null;
let lastFoundAnyAt = Date.now();
let lastDiagnosticAt = 0;

let logQueue = [];
let isLogging = false;

function processLogQueue() {
  if (isLogging || logQueue.length === 0) return;
  isLogging = true;
  
  const entries = [...logQueue];
  logQueue = [];
  
  try {
    chrome.storage.local.get({ bugLog: [] }, (data) => {
      if (chrome.runtime.lastError) {
        isLogging = false;
        return;
      }
      const bugLog = data.bugLog;
      bugLog.push(...entries);
      while (bugLog.length > 500) bugLog.shift();
      chrome.storage.local.set({ bugLog }, () => {
        isLogging = false;
        if (logQueue.length > 0) processLogQueue();
      });
    });
  } catch (err) {
    console.log("[ShowdownTestBot] Could not save log (context invalidated).");
    isLogging = false;
  }
}

function log(message) {
  const entry = { time: new Date().toISOString(), message };
  console.log("[ShowdownTestBot]", message);
  logQueue.push(entry);
  processLogQueue();
}

function queryFirstMatching(selectorList) {
  for (const sel of selectorList) {
    const found = Array.from(document.querySelectorAll(sel));
    if (found.length > 0) return { buttons: found, selectorUsed: sel };
  }
  return { buttons: [], selectorUsed: null };
}

function randomChoice(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function signatureFor(buttons) {
  return buttons.map((b) => b.outerHTML).join("|");
}

// ---------------------------------------------------------------------
// On-page status badge (no DevTools needed to see what's happening)
// ---------------------------------------------------------------------

function ensureBadge() {
  let badge = document.getElementById("showdown-test-bot-badge");
  if (badge) return badge;
  badge = document.createElement("div");
  badge.id = "showdown-test-bot-badge";
  badge.style.cssText = [
    "position:fixed",
    "bottom:10px",
    "right:10px",
    "z-index:999999",
    "background:#222",
    "color:#fff",
    "font:12px system-ui,sans-serif",
    "padding:6px 10px",
    "border-radius:6px",
    "opacity:0.85",
    "max-width:260px",
    "line-height:1.4",
    "pointer-events:none",
  ].join(";");
  document.documentElement.appendChild(badge);
  return badge;
}

let lastBadgeText = null;

function setBadge(text, color) {
  if (text === lastBadgeText) return; // avoid needless DOM writes
  lastBadgeText = text;
  const badge = ensureBadge();
  badge.style.borderLeft = `4px solid ${color}`;
  badge.textContent = text;
}

// ---------------------------------------------------------------------
// Diagnostics: dump the likely controls area if we seem stuck
// ---------------------------------------------------------------------

function maybeLogDiagnostic() {
  const now = Date.now();
  if (now - lastFoundAnyAt < STUCK_THRESHOLD_MS) return;
  if (now - lastDiagnosticAt < STUCK_THRESHOLD_MS) return; // don't spam
  lastDiagnosticAt = now;
  
  // Don't log if the battle is over or we are in a replay
  if (document.querySelector('button[name="closeAndMainMenu"], button[name="goToEnd"], button[name="instantReplay"], .replayDownloadButton')) {
    return;
  }

  const candidates = document.querySelectorAll(
    '.controls, .battle-controls, [class*="control"]'
  );
  if (candidates.length === 0) {
    log(
      "DIAGNOSTIC: no known button matched, and no '.controls'-like " +
        "container found either -- are you in an active battle right now?"
    );
    return;
  }
  const snippet = Array.from(candidates)
    .slice(0, 2)
    .map((el) => el.outerHTML.slice(0, 800))
    .join("\n---\n");
  log(
    "DIAGNOSTIC: enabled but no recognized move/switch/teampreview " +
      "button matched for 10+ seconds. Nearby controls markup:\n" + snippet
  );
}

// ---------------------------------------------------------------------
function getOpponentState(opponentName, bar) {
  const history = document.querySelector('.battle-history, .message-log');
  let teraType = null;
  let tempType = null;
  let hasSwitchedIn = false;
  let bellyDrumSeen = false;
  let boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
  
  if (history) {
    const lines = history.innerText.split('\n').map(l => l.trim()).filter(l => l.length > 0).reverse();
    const escapedName = opponentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    
    const teraRegex = new RegExp(`The opposing ${escapedName} terastallized into the ([A-Za-z]+) type`, 'i');
    const typeChangeRegex = new RegExp(`The opposing ${escapedName}.*type changed to ([A-Za-z]+)`, 'i');
    const switchRegex = new RegExp(`sent out ${escapedName}!|${escapedName} was dragged out!`, 'i');
    const statRegex = new RegExp(`The opposing ${escapedName}'s (Attack|Defense|Sp\\. Atk|Sp\\. Def|Speed|accuracy|evasiveness) (rose|fell)( sharply| drastically| harshly| severely)?!`, 'i');
    const bellyDrumRegex = new RegExp(`The opposing ${escapedName} cut its own HP and maximized its Attack!`, 'i');

    for (const line of lines) {
      if (!teraType) {
        const teraMatch = line.match(teraRegex);
        if (teraMatch) teraType = [teraMatch[1]];
      }
      
      if (!tempType && !hasSwitchedIn) {
        const typeChangeMatch = line.match(typeChangeRegex);
        if (typeChangeMatch) tempType = [typeChangeMatch[1]];
      }
      
      if (!hasSwitchedIn) {
        const statMatch = line.match(statRegex);
        if (statMatch) {
          const statMap = { 'attack': 'atk', 'defense': 'def', 'sp. atk': 'spa', 'sp. def': 'spd', 'speed': 'spe', 'accuracy': 'accuracy', 'evasiveness': 'evasion' };
          const stat = statMap[statMatch[1].toLowerCase()];
          if (stat) {
            const isRose = statMatch[2].toLowerCase() === 'rose';
            const severity = statMatch[3] ? statMatch[3].trim().toLowerCase() : '';
            
            let amount = 1;
            if (severity === 'sharply' || severity === 'harshly') amount = 2;
            else if (severity === 'drastically' || severity === 'severely') amount = 3;
            
            if (stat === 'atk' && bellyDrumSeen) {
              // Ignore attack changes chronologically before Belly Drum
            } else {
              if (isRose) boosts[stat] += amount;
              else boosts[stat] -= amount;
            }
          }
        }
        
        if (line.match(bellyDrumRegex) && !bellyDrumSeen) {
          boosts.atk = 6 + boosts.atk;
          bellyDrumSeen = true;
        }
      }
      
      if (!hasSwitchedIn && switchRegex.test(line)) {
        hasSwitchedIn = true;
      }
      
      if (teraType && tempType && hasSwitchedIn) break;
    }
  }

  // Clamp boosts to valid ranges
  for (let key in boosts) {
    boosts[key] = Math.max(-6, Math.min(6, boosts[key]));
  }

  // Get status from statbar
  let status = null;
  if (bar) {
    const statusSpan = bar.querySelector('.status');
    if (statusSpan && statusSpan.textContent.trim()) {
      status = statusSpan.textContent.trim();
    }
    const hpText = bar.querySelector('.hptext');
    if (hpText && (hpText.textContent.trim() === '0%' || hpText.textContent.trim() === '0/0')) {
      status = 'FNT';
    }
  }
  
  return {
    typeOverride: teraType || tempType || null,
    boosts: boosts,
    status: status
  };
}

function getRevealedMoves(opponentName) {
  const history = document.querySelector('.battle-history, .message-log');
  if (!history) return [];
  
  const revealedMoves = new Set();
  const escapedName = opponentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const moveRegex = new RegExp(`The opposing ${escapedName} used (.*)!`, 'i');
  
  const lines = history.innerText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  
  for (const line of lines) {
    const match = line.match(moveRegex);
    if (match) {
      revealedMoves.add(match[1]);
    }
  }
  
  return Array.from(revealedMoves);
}

function getMyActiveTypes() {
  if (!window.Pokedex) return { name: "Unknown", types: [] };
  const statbars = document.querySelectorAll('.statbar');
  let myName = null;
  
  for (const bar of statbars) {
    // Look for our statbar (not rstatbar or p2)
    if (!bar.classList.contains('rstatbar') && !(bar.getAttribute('data-side') || '').startsWith('p2')) {
      const strong = bar.querySelector('strong');
      if (strong) {
        let rawName = strong.textContent.trim();
        myName = rawName.replace(/\s*L\d+.*$/i, '').replace(/[\u2640\u2642]/g, '').trim();
      }
      break;
    }
  }
  
  let finalTypes = [];
  if (myName) {
    const types = window.Pokedex[myName];
    if (types) {
      finalTypes = types;
    } else {
      const normalized = myName.replace(/[^a-zA-Z0-9-]/g, '');
      for (const key in window.Pokedex) {
        if (key.replace(/[^a-zA-Z0-9-]/g, '') === normalized) {
          finalTypes = window.Pokedex[key];
          myName = key;
          break;
        }
      }
    }
  }
  
  return { name: myName || "Unknown", types: finalTypes };
}

function getOpponents() {
  if (!window.Pokedex) return [];
  const statbars = document.querySelectorAll('.statbar');
  let opponents = [];
  
  for (const bar of statbars) {
    if (bar.classList.contains('rstatbar') || (bar.getAttribute('data-side') || '').startsWith('p2') || (bar.getAttribute('data-side') || '').startsWith('p3') || (bar.getAttribute('data-side') || '').startsWith('p4')) {
      const strong = bar.querySelector('strong');
      if (strong) {
        let rawName = strong.textContent.trim();
        let opponentName = rawName.replace(/\s*L\d+.*$/i, '').replace(/[\u2640\u2642]/g, '').trim();
        
        let finalTypes = [];
        let isOverride = false;
        let revealedMoves = getRevealedMoves(opponentName);
        const oppState = getOpponentState(opponentName, bar);
        
        if (oppState.typeOverride) {
          finalTypes = oppState.typeOverride;
          isOverride = true;
        } else {
          const types = window.Pokedex[opponentName];
          if (types) {
            finalTypes = types;
          } else {
            const normalized = opponentName.replace(/[^a-zA-Z0-9-]/g, '');
            for (const key in window.Pokedex) {
              if (key.replace(/[^a-zA-Z0-9-]/g, '') === normalized) {
                finalTypes = window.Pokedex[key];
                opponentName = key;
                break;
              }
            }
          }
        }
        
        opponents.push({
          name: opponentName || "Unknown",
          types: finalTypes,
          isOverride: isOverride,
          revealedMoves: revealedMoves,
          boosts: oppState.boosts,
          status: oppState.status
        });
      }
    }
  }
  return opponents;
}

function estimateStat(baseStat, isHp = false, boosts = 0) {
  // Assume Level 100, 84 EVs, neutral nature for a rough estimate
  let stat = isHp ? (baseStat * 2 + 100 + 10 + 42) : (baseStat * 2 + 5 + 21);
  if (boosts > 0) stat *= (2 + boosts) / 2;
  if (boosts < 0) stat *= 2 / (2 - boosts);
  return stat;
}

function calculateEstimatedDamage(attackerStats, defenderStats, move, attackerTypes, defenderTypes) {
  let bp = move.basePower || 0;
  if (bp === 0) return 0;
  
  let atk = move.category === 'Physical' ? attackerStats.atk : attackerStats.spa;
  let def = move.category === 'Physical' ? defenderStats.def : defenderStats.spd;
  
  // Level 100 formula
  let damage = ((((42 * atk * bp) / def) / 50) + 2);
  
  // STAB
  let stab = attackerTypes.includes(move.type) ? 1.5 : 1;
  damage *= stab;
  
  // Effectiveness
  let effect = window.getEffectiveness ? window.getEffectiveness(move.type, defenderTypes) : 1;
  damage *= effect;
  
  return damage; // Raw HP estimate
}

function getDangerScore(myTypes, myStats, oppState, oppData) {
  if (oppState.status === 'SLP' || oppState.status === 'FRZ') return 0;
  
  let maxDamage = 0;
  let oppBase = oppData.baseStats || {hp:100, atk:100, def:100, spa:100, spd:100, spe:100};
  
  let oppEstStats = {
    atk: estimateStat(oppBase.atk, false, oppState.boosts.atk),
    spa: estimateStat(oppBase.spa, false, oppState.boosts.spa),
  };
  
  let myEstStats = {
    def: estimateStat(myStats.def, false, 0), // Ignoring our boosts for now for danger score simplicity
    spd: estimateStat(myStats.spd, false, 0),
  };

  // Estimate max damage opponent can do assuming they have a STAB move of their type with 90 BP
  const oppTypes = oppState.types && oppState.types.length > 0 ? oppState.types : ['Normal'];
  for (const oppType of oppTypes) {
    // Check both physical and special 90 BP moves
    for (const cat of ['Physical', 'Special']) {
      const effect = window.getEffectiveness ? window.getEffectiveness(oppType, myTypes) : 1;
      let atk = cat === 'Physical' ? oppEstStats.atk : oppEstStats.spa;
      let def = cat === 'Physical' ? myEstStats.def : myEstStats.spd;
      let dmg = ((((42 * atk * 90) / def) / 50) + 2) * 1.5 * effect;
      if (dmg > maxDamage) maxDamage = dmg;
    }
  }
  
  // Convert damage to a % of our estimated HP
  let myHp = estimateStat(myStats.hp, true, 0);
  let percentDamage = maxDamage / myHp;
  
  return percentDamage; // e.g., 0.5 means 50% health, >1 means OHKO
}

function getBestAction(moveButtons, switchButtons) {
  const myData = getMyActiveTypes();
  const opponents = getOpponents();
  
  // Ask for opponent data if we don't have it
  const missingOpps = opponents.map(o => o.name).filter(n => n && !cachedOppData[n]);
  if (missingOpps.length > 0) {
    window.postMessage({ direction: 'from-extension', type: 'FETCH_OPPONENTS', opponents: missingOpps }, '*');
  }

  // Ask for move data if we don't have it
  const missingMoves = moveButtons.map(btn => btn.getAttribute('data-move')).filter(m => m && !cachedMoveData[m]);
  if (missingMoves.length > 0) {
    window.postMessage({ direction: 'from-extension', type: 'FETCH_MOVES', moves: missingMoves }, '*');
  }

  // Get our base stats
  let myBaseStats = {hp:100, atk:100, def:100, spa:100, spd:100, spe:100};
  if (cachedOppData[myData.name]) { // We can use the opponent cache to cache our own base stats too since it queries pokedex
      myBaseStats = cachedOppData[myData.name].baseStats || myBaseStats;
  } else if (!cachedOppData[myData.name]) {
      window.postMessage({ direction: 'from-extension', type: 'FETCH_OPPONENTS', opponents: [myData.name] }, '*');
  }

  if (missingOpps.length > 0 || missingMoves.length > 0 || !cachedOppData[myData.name]) {
    log("Waiting for game data to load from page...");
    return null; // wait
  }
  
  let myStats = {
    hp: estimateStat(myBaseStats.hp, true, 0),
    atk: estimateStat(myBaseStats.atk, false, 0), // TODO: parse our own boosts from DOM?
    def: estimateStat(myBaseStats.def, false, 0),
    spa: estimateStat(myBaseStats.spa, false, 0),
    spd: estimateStat(myBaseStats.spd, false, 0),
    spe: estimateStat(myBaseStats.spe, false, 0)
  };
  
  let maxDangerScore = 0; // percent damage we take
  let oppToWorryAbout = null;
  let oppSpeed = 100;
  
  if (opponents && opponents.length > 0) {
    for (const opp of opponents) {
      if (opp.status === 'FNT' || opp.status === 'fnt') continue;
      
      let oppData = cachedOppData[opp.name] || {};
      let dangerScore = getDangerScore(myData.types, myBaseStats, opp, oppData);
      if (dangerScore > maxDangerScore) {
        maxDangerScore = dangerScore;
        oppToWorryAbout = opp;
        let oppBaseSpe = (oppData.baseStats && oppData.baseStats.spe) || 100;
        oppSpeed = estimateStat(oppBaseSpe, false, opp.boosts.spe);
        if (opp.status === 'PAR') oppSpeed /= 2;
      }
    }
  }
  
  let opp = oppToWorryAbout || (opponents && opponents.length > 0 ? opponents[0] : null);
  if (!opp) {
    log("No opponents found (FFA or weird state). Falling back to random action.");
    if (moveButtons.length > 0) return { btn: moveButtons[Math.floor(Math.random() * moveButtons.length)], type: 'move' };
    if (switchButtons.length > 0) return { btn: switchButtons[Math.floor(Math.random() * switchButtons.length)], type: 'switch' };
    return null;
  }
  
  let amISlower = myStats.spe < oppSpeed;
  log(`Active Matchup: ${myData.name} takes estimated ${Math.round(maxDangerScore * 100)}% damage. Am I slower? ${amISlower}`);

  let bestMoveBtns = [];
  let bestMoveScore = -1;
  let bestMoveLog = "";
  let bestTargetName = null;

  for (const btn of moveButtons) {
    const moveName = btn.getAttribute('data-move');
    const moveData = cachedMoveData[moveName] || { basePower: 0, category: 'Status', type: 'Normal', priority: 0, accuracy: 100 };
    
    let score = 0;
    let targetForThisMove = null;
    
    for (const opp of opponents) {
        if (opp.status === 'FNT' || opp.status === 'fnt') continue;
        let oppData = cachedOppData[opp.name] || {};
        let oppBase = oppData.baseStats || {hp:100, atk:100, def:100, spa:100, spd:100, spe:100};
        
        let oppStats = {
          hp: estimateStat(oppBase.hp, true, 0),
          def: estimateStat(oppBase.def, false, opp.boosts.def),
          spd: estimateStat(oppBase.spd, false, opp.boosts.spd),
        };
        
        let moveScore = 0;
        
        if (moveData.category === 'Status') {
           // Heuristics for status moves
           if (['Thunder Wave', 'Will-O-Wisp', 'Toxic', 'Spore', 'Sleep Powder'].includes(moveName)) {
               if (!opp.status) {
                   moveScore = 150; // High value for inflicting status
                   if (moveName === 'Thunder Wave' && opp.types.includes('Ground')) moveScore = 0;
                   if (moveName === 'Will-O-Wisp' && opp.types.includes('Fire')) moveScore = 0;
                   if (moveName === 'Toxic' && (opp.types.includes('Poison') || opp.types.includes('Steel'))) moveScore = 0;
               } else {
                   moveScore = 0; // Don't use if already statused
               }
           }
           else if (['Swords Dance', 'Dragon Dance', 'Nasty Plot', 'Calm Mind'].includes(moveName)) {
               if (maxDangerScore < 0.4) {
                   moveScore = 200; // Very high value if safe to setup
               } else {
                   moveScore = 10; // Unsafe to setup
               }
           }
           else if (['Roost', 'Recover', 'Soft-Boiled', 'Synthesis'].includes(moveName)) {
               // If taking moderate damage but we can heal it off
               if (maxDangerScore < 0.6) {
                   moveScore = 180;
               } else {
                   moveScore = 5;
               }
           }
           else if (['Stealth Rock', 'Spikes', 'Toxic Spikes'].includes(moveName)) {
               moveScore = 140; // Good early game
           }
           else {
               moveScore = 10; // Generic status move
           }
        } else {
           // Damage move
           let damage = calculateEstimatedDamage(myStats, oppStats, moveData, myData.types, opp.types);
           let percentDamage = damage / oppStats.hp;
           
           moveScore = percentDamage * 100; // Base score is % damage dealt
           
           // Priority bonus if we are slower and can KO
           if (moveData.priority > 0 && percentDamage >= 1.0) {
               moveScore += 500; // Almost definitely do this
           }
           
           // If we are slower and will get OHKO'd, priority is our only hope
           if (amISlower && maxDangerScore >= 1.0 && moveData.priority > 0) {
               moveScore += 300;
           }
           
           // Accuracy penalty
           let acc = moveData.accuracy;
           if (acc === true) acc = 100; // Swift, etc.
           moveScore *= (acc / 100);
           
           // Common Immunities Check
           let abilities = oppData.abilities || {};
           let abilityValues = Object.values(abilities).join(' ').toLowerCase();
           if (moveData.type === 'Ground' && abilityValues.includes('levitate')) moveScore = 0;
           if (moveData.type === 'Fire' && abilityValues.includes('flash fire')) moveScore = 0;
           if (moveData.type === 'Water' && (abilityValues.includes('water absorb') || abilityValues.includes('storm drain') || abilityValues.includes('dry skin'))) moveScore = 0;
           if (moveData.type === 'Electric' && (abilityValues.includes('volt absorb') || abilityValues.includes('motor drive') || abilityValues.includes('lightning rod'))) moveScore = 0;
           if (moveData.type === 'Grass' && abilityValues.includes('sap sipper')) moveScore = 0;
        }
        
        if (moveScore > score) {
            score = moveScore;
            targetForThisMove = opp.name;
        }
    }
    
    if (score > bestMoveScore) {
      bestMoveScore = score;
      bestMoveBtns = [btn];
      bestTargetName = targetForThisMove;
      bestMoveLog = `Evaluated moves, best: ${moveName} score: ${Math.round(bestMoveScore)} vs ${bestTargetName}`;
    } else if (score === bestMoveScore && bestMoveScore > -1) {
      bestMoveBtns.push(btn);
    }
  }
  
  let bestMoveBtn = bestMoveBtns.length > 0 ? randomChoice(bestMoveBtns) : null;

  // Evaluate Switches
  let bestSwitchBtns = [];
  let bestSwitchDanger = 999;
  
  // Basic Hazard Check - read the battle text for stealth rock
  const historyText = (document.querySelector('.battle-history, .message-log') || {}).innerText || "";
  let hazardsUp = historyText.includes('pointed stones') || historyText.includes('Spikes');
  
  if (moveButtons.length === 0 || maxDangerScore >= 1.0) { // If about to be OHKO'd
    log(`Danger score ${Math.round(maxDangerScore*100)}%, moves=${moveButtons.length}. Evaluating switches...`);
    const allNames = window.Pokedex ? Object.keys(window.Pokedex).sort((a, b) => b.length - a.length) : [];
    
    for (const btn of switchButtons) {
      if (btn.disabled || btn.classList.contains('disabled')) continue;
      if (btn.textContent.includes('fainted')) continue;
      
      let pkmnName = btn.textContent.trim();
      for (const name of allNames) {
        if (pkmnName.includes(name)) {
          pkmnName = name;
          break;
        }
      }
      
      const pkmnTypes = window.Pokedex ? (window.Pokedex[pkmnName] || []) : [];
      let pkmnData = cachedOppData[pkmnName] || {};
      let pkmnBase = pkmnData.baseStats || {hp:100, atk:100, def:100, spa:100, spd:100, spe:100};
      
      let incomingDanger = 0;
      if (pkmnTypes.length > 0 && opponents.length > 0) {
        for (const opp of opponents) {
            if (opp.status === 'FNT' || opp.status === 'fnt') continue;
            let oppData = cachedOppData[opp.name] || {};
            // Simulate danger for the incoming pokemon
            let danger = getDangerScore(pkmnTypes, pkmnBase, opp, oppData);
            if (danger > incomingDanger) incomingDanger = danger;
        }
      }
      
      // Add a penalty to incomingDanger if hazards are up (pseudo 12.5% damage added)
      if (hazardsUp) incomingDanger += 0.125;
      
      if (incomingDanger < bestSwitchDanger) {
        bestSwitchDanger = incomingDanger;
        bestSwitchBtns = [btn];
      } else if (incomingDanger === bestSwitchDanger) {
        bestSwitchBtns.push(btn);
      }
    }
  }
  
  let bestSwitchBtn = bestSwitchBtns.length > 0 ? randomChoice(bestSwitchBtns) : null;

  if (moveButtons.length === 0 && bestSwitchBtn) {
    log(`Must switch (no moves). Chose defensively best option (Takes est ${Math.round(bestSwitchDanger*100)}% damage).`);
    return { btn: bestSwitchBtn, type: 'switch' };
  }
  
  if (bestMoveBtn) log(bestMoveLog);

  // If a switch is significantly safer than staying in, and we are in OHKO danger, then switch
  if (bestSwitchBtn && maxDangerScore >= 1.0 && bestSwitchDanger < 0.6) {
    log(`DANGER AVERTED: Retreating! Best switch takes est ${Math.round(bestSwitchDanger*100)}% vs active taking ${Math.round(maxDangerScore*100)}%.`);
    return { btn: bestSwitchBtn, type: 'switch' };
  }
  
  if (bestMoveBtn) {
    if (maxDangerScore >= 1.0) log(`DANGER WARNING: Staying in! Danger = ${Math.round(maxDangerScore*100)}%, but attacking anyway.`);
    window.lastIntendedTarget = bestTargetName;
    return { btn: bestMoveBtn, type: 'move' };
  }
  
  if (moveButtons.length > 0) return { btn: moveButtons[0], type: 'move' };
  if (switchButtons.length > 0) return { btn: switchButtons[0], type: 'switch' };

  return { btn: switchButtons[0], type: 'switch' }; // Fallback
}


// ---------------------------------------------------------------------
// Main decision loop
// ---------------------------------------------------------------------

let pollInterval = null;

function killBot() {
  if (observer) observer.disconnect();
  if (pollInterval) clearInterval(pollInterval);
  let badge = document.getElementById("showdown-test-bot-badge");
  if (badge) badge.remove();
}

function evaluateAndAct() {
  try {
    if (!chrome.runtime || !chrome.runtime.id) {
      killBot();
      return;
    }
  } catch (e) {
    killBot();
    return;
  }

  if (!enabled) {
    setBadge("Showdown Test Bot: OFF", "#888");
    return;
  }

  try {
    const move = queryFirstMatching(SELECTOR_SETS.move);
    const target = queryFirstMatching(SELECTOR_SETS.target);
    const switches = queryFirstMatching(SELECTOR_SETS.switch);
    const teamPreview = queryFirstMatching(SELECTOR_SETS.teamPreview);

    const allButtons = [
      ...move.buttons,
      ...target.buttons,
      ...switches.buttons,
      ...teamPreview.buttons,
    ];

    if (allButtons.length === 0) {
      lastActedSignature = null;
      
      // Check if we are at the end of a battle or in a replay
      if (document.querySelector('button[name="closeAndMainMenu"], button[name="goToEnd"], button[name="instantReplay"], .replayDownloadButton')) {
        setBadge("Showdown Test Bot: ON — Battle Over / Replay", "#5bc0de");
      } else {
        setBadge("Showdown Test Bot: ON — waiting for your turn", "#f0ad4e");
        maybeLogDiagnostic();
      }
      return;
    }

    lastFoundAnyAt = Date.now();
    setBadge("Showdown Test Bot: ON — buttons found", "#5cb85c");

    const signature = signatureFor(allButtons);
    if (signature === lastActedSignature) {
      return; // already acted on this exact prompt
    }

    let chosen = null;
    let category = "";

    if (target.buttons.length > 0) {
      chosen = randomChoice(target.buttons);
      if (window.lastIntendedTarget) {
          for (const btn of target.buttons) {
              if (btn.textContent.includes(window.lastIntendedTarget)) {
                  chosen = btn;
                  break;
              }
          }
      }
      category = 'target';
    } else if (move.buttons.length > 0 || switches.buttons.length > 0) {
      const action = getBestAction(move.buttons, switches.buttons);
      if (!action) return;
      chosen = action.btn;
      category = action.type;
    } else if (teamPreview.buttons.length > 0) {
      chosen = teamPreview.buttons[0];
      category = `teampreview (via ${teamPreview.selectorUsed})`;
    }

    if (!chosen) return;

    lastActedSignature = signature;
    const label = chosen.textContent.trim().replace(/\s+/g, " ");
    log(`Choosing ${category}: "${label}"`);

    const delay =
      ACTION_DELAY_MS[0] +
      Math.random() * (ACTION_DELAY_MS[1] - ACTION_DELAY_MS[0]);
    setTimeout(() => {
      try {
        if (category === 'move') {
          const modifiers = ['terastallize', 'megaevo', 'zmove', 'dynamax', 'ultra'];
          for (const mod of modifiers) {
            const cb = document.querySelector(`input[name="${mod}"]`);
            if (cb && !cb.checked) {
              cb.click();
              log(`Activated ${mod}!`);
            }
          }
        }
        chosen.click();
        setBadge(`Showdown Test Bot: clicked "${label}"`, "#5cb85c");
      } catch (err) {
        log(`ERROR clicking button: ${err.message}\n${err.stack}`);
        setBadge("Showdown Test Bot: click FAILED — see log", "#d9534f");
      }
    }, delay);
  } catch (err) {
    log(`ERROR in evaluateAndAct: ${err.message}\n${err.stack}`);
    setBadge("Showdown Test Bot: ERROR — see log", "#d9534f");
  }
}

// Two independent triggers, so a missed DOM event can't stall the bot silently.
// Mutation bursts are coalesced into one evaluateAndAct() call per tick, since
// Showdown's chat/animations can fire many mutations per second.
let scheduled = false;
function scheduleEvaluate() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    evaluateAndAct();
  });
}

const observer = new MutationObserver(() => scheduleEvaluate());
observer.observe(document.body, { childList: true, subtree: true });
pollInterval = setInterval(evaluateAndAct, 1000);

chrome.storage.local.get({ enabled: false }, (data) => {
  enabled = data.enabled;
  log(`Content script loaded. Enabled=${enabled}`);
  evaluateAndAct();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.enabled) {
    enabled = changes.enabled.newValue;
    log(`Toggled ${enabled ? "ON" : "OFF"}`);
    lastActedSignature = null;
    lastFoundAnyAt = Date.now();
    evaluateAndAct();
  }
});
