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
    console.error("[ShowdownTestBot] Could not save log:", err.message);
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
  if (document.querySelector('button[name="closeAndMainMenu"], button[name="goToEnd"], .replayDownloadButton')) {
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
function getOpponentState(opponentName) {
  const history = document.querySelector('.battle-history, .message-log');
  let teraType = null;
  let tempType = null;
  let hasSwitchedIn = false;
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
          const statMap = { 'Attack': 'atk', 'Defense': 'def', 'Sp. Atk': 'spa', 'Sp. Def': 'spd', 'Speed': 'spe', 'accuracy': 'accuracy', 'evasiveness': 'evasion' };
          const stat = statMap[statMatch[1]];
          const isRose = statMatch[2].toLowerCase() === 'rose';
          const severity = statMatch[3] ? statMatch[3].trim().toLowerCase() : '';
          
          let amount = 1;
          if (severity === 'sharply' || severity === 'harshly') amount = 2;
          else if (severity === 'drastically' || severity === 'severely') amount = 3;
          
          // Since we scan bottom-up, we are retracing steps. We ADD to reconstruct the forward state?
          // Wait, if it's currently +2, and we go backwards and see "rose sharply (+2)", we SUBTRACT to find the previous state?
          // No, we are building the final state from scratch! But since we are reading backwards, if we just SUM them up, the total is the same!
          // (+2) then (-1) = (+1). If we read backwards: (-1) then (+2) = (+1). Summation is commutative!
          if (isRose) boosts[stat] += amount;
          else boosts[stat] -= amount;
        }
        
        if (line.match(bellyDrumRegex)) {
          // Belly drum sets attack to +6. Since we're reading backwards, this overrides everything before it (which we haven't seen yet).
          // But actually, it sets it to +6 going forward. If we've already seen stat changes AFTER belly drum, we should add them to 6!
          boosts.atk = 6 + boosts.atk;
          // We can't perfectly model belly drum bottom-up without a flag, but this is a close approximation.
        }
      }
      
      if (!hasSwitchedIn && switchRegex.test(line)) {
        hasSwitchedIn = true;
      }
      
      // We can't break early anymore because we need to scan until switch-in to get all stat changes!
      if (teraType && tempType && hasSwitchedIn) break;
    }
  }

  // Get status from statbar
  let status = null;
  const statbars = document.querySelectorAll('.statbar');
  for (const bar of statbars) {
    if (bar.classList.contains('rstatbar') || (bar.getAttribute('data-side') || '').startsWith('p2')) {
      const statusSpan = bar.querySelector('.status');
      if (statusSpan && statusSpan.textContent.trim()) {
        status = statusSpan.textContent.trim();
      }
      break;
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

function getOpponentTypes() {
  if (!window.Pokedex) return { name: "Unknown", types: [], revealedMoves: [] };
  const statbars = document.querySelectorAll('.statbar');
  let opponentName = null;
  
  for (const bar of statbars) {
    // Look for opponent statbar
    if (bar.classList.contains('rstatbar') || (bar.getAttribute('data-side') || '').startsWith('p2')) {
      const strong = bar.querySelector('strong');
      if (strong) {
        let rawName = strong.textContent.trim();
        // Remove level (e.g. L78) and gender symbols
        opponentName = rawName.replace(/\s*L\d+.*$/i, '').replace(/[\u2640\u2642]/g, '').trim();
      }
    }
  }
  
  if (!opponentName) {
    const strong = document.querySelector('.statbar strong');
    if (strong) {
      let rawName = strong.textContent.trim();
      opponentName = rawName.replace(/\s*L\d+.*$/i, '').replace(/[\u2640\u2642]/g, '').trim();
    }
  }

  let finalTypes = [];
  let isOverride = false;
  let revealedMoves = [];
  let boosts = {};
  let status = null;

  if (opponentName) {
    revealedMoves = getRevealedMoves(opponentName);
    const oppState = getOpponentState(opponentName);
    
    if (oppState.typeOverride) {
      finalTypes = oppState.typeOverride;
      isOverride = true;
    } else {
      const types = window.Pokedex[opponentName];
      if (types) {
        finalTypes = types;
      } else {
        // Normalize if exact match fails
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
    boosts = oppState.boosts;
    status = oppState.status;
  }
  
  return { 
    name: opponentName || "Unknown", 
    types: finalTypes, 
    isOverride: isOverride,
    revealedMoves: revealedMoves,
    boosts: boosts,
    status: status
  };
}

function getBestMove(buttons) {
  const oppData = getOpponentTypes();
  const oppTypes = oppData.types;
  
  let stateTags = [];
  if (oppData.status) stateTags.push(`Status: ${oppData.status}`);
  if (oppData.boosts) {
    const activeBoosts = Object.entries(oppData.boosts)
      .filter(([stat, val]) => val !== 0)
      .map(([stat, val]) => `${stat}${val > 0 ? '+' : ''}${val}`);
    if (activeBoosts.length > 0) stateTags.push(`Boosts: ${activeBoosts.join(', ')}`);
  }
  if (oppData.revealedMoves && oppData.revealedMoves.length > 0) {
    stateTags.push(`Revealed Moves: ${oppData.revealedMoves.join(', ')}`);
  }
  
  const stateText = stateTags.length > 0 ? ` (${stateTags.join(' | ')})` : '';
  
  log(`--- Evaluating moves against ${oppData.name} (Types: ${oppTypes.join('/') || 'Unknown'})${stateText} ---`);
  
  let bestButtons = [];
  let bestScore = -1;

  for (const btn of buttons) {
    let moveType = null;
    const typeEl = btn.querySelector('.type');
    if (typeEl) {
      moveType = typeEl.textContent.trim();
    } else {
      const match = btn.className.match(/type-([a-zA-Z]+)/);
      if (match) moveType = match[1];
    }

    let score = 1;
    if (moveType && oppTypes.length > 0 && window.getEffectiveness) {
      score = window.getEffectiveness(moveType, oppTypes);
    }
    
    log(`Evaluated move ${btn.textContent.replace(/\s+/g, ' ').trim()} (Type: ${moveType}) -> Score: ${score}`);

    if (score > bestScore) {
      bestScore = score;
      bestButtons = [btn];
    } else if (score === bestScore) {
      bestButtons.push(btn);
    }
  }

  return randomChoice(bestButtons);
}

// ---------------------------------------------------------------------
// Main decision loop
// ---------------------------------------------------------------------

function evaluateAndAct() {
  if (!enabled) {
    setBadge("Showdown Test Bot: OFF", "#888");
    return;
  }

  try {
    const move = queryFirstMatching(SELECTOR_SETS.move);
    const switches = queryFirstMatching(SELECTOR_SETS.switch);
    const teamPreview = queryFirstMatching(SELECTOR_SETS.teamPreview);

    const allButtons = [
      ...move.buttons,
      ...switches.buttons,
      ...teamPreview.buttons,
    ];

    if (allButtons.length === 0) {
      lastActedSignature = null;
      
      // Check if we are at the end of a battle or in a replay
      if (document.querySelector('button[name="closeAndMainMenu"], button[name="goToEnd"], .replayDownloadButton')) {
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

    if (move.buttons.length > 0) {
      chosen = getBestMove(move.buttons);
      category = `move (via ${move.selectorUsed})`;
    } else if (switches.buttons.length > 0) {
      chosen = randomChoice(switches.buttons);
      category = `switch (via ${switches.selectorUsed})`;
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
setInterval(evaluateAndAct, 1000);

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
