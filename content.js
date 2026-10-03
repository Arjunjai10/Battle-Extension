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
    '.movemenu button:not(.disabled)',
  ],
  target: [
    'button[name="chooseMoveTarget"]:not([disabled])',
    'button[name="chooseTarget"]:not([disabled])',
    '.targetmenu button:not([disabled])',
  ],
  switch: [
    'button[name="chooseSwitch"]:not([disabled])',
    '.switchmenu button:not(.disabled)',
  ],
  teamPreview: [
    'button[name="chooseTeamPreview"]:not([disabled])',
    '.teampreview button',
  ],
};

const ACTION_DELAY_MS = [300, 900];
const STUCK_THRESHOLD_MS = 10_000;

// Shared constants to avoid duplication across stat-parsing functions
const STAT_MAP = {
  'attack': 'atk', 'defense': 'def', 'sp. atk': 'spa',
  'sp. def': 'spd', 'speed': 'spe', 'accuracy': 'accuracy', 'evasiveness': 'evasion'
};
const DEFAULT_MOVE_DATA = { basePower: 0, category: 'Status', type: 'Normal', priority: 0, accuracy: 100 };
const DEFAULT_BASE_STATS = { hp: 100, atk: 100, def: 100, spa: 100, spd: 100, spe: 100 };

/** Returns true if `status` represents a fainted Pokémon. */
function isFainted(status) {
  return status === 'FNT' || status === 'fnt';
}

/** Parses a stat stage change severity word into a numeric amount (1/2/3). */
function parseSeverity(severityWord) {
  const s = (severityWord || '').trim().toLowerCase();
  if (s === 'sharply' || s === 'harshly') return 2;
  if (s === 'drastically' || s === 'severely') return 3;
  return 1;
}

/**
 * Resolves a raw Pokémon display name (which may include level, gender symbols,
 * or alternate casing) to the canonical Pokedex key.
 * Returns the canonical name, or the cleaned raw name if not found.
 */
function resolvePokedexName(rawName) {
  if (!window.Pokedex) return rawName;
  const cleaned = rawName.replace(/\s*L\d+.*$/i, '').replace(/[\u2640\u2642]/g, '').trim();
  if (window.Pokedex[cleaned]) return cleaned;
  const normalized = cleaned.replace(/[^a-zA-Z0-9-]/g, '');
  for (const key in window.Pokedex) {
    if (key.replace(/[^a-zA-Z0-9-]/g, '') === normalized) return key;
  }
  return cleaned;
}

// --- Injected script to fetch data from main world ---
let cachedMoveData = {};
let cachedOppData = {};

window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.direction !== 'from-page') return;
  if (event.data.type === 'MOVES_RESULT') {
    for (const [m, data] of Object.entries(event.data.result)) {
      cachedMoveData[m] = data || DEFAULT_MOVE_DATA;
    }
  }
  if (event.data.type === 'OPP_RESULT') {
    for (const [name, data] of Object.entries(event.data.result)) {
      const obj = data || { baseStats: { ...DEFAULT_BASE_STATS } };
      if (!obj.baseStats) obj.baseStats = { ...DEFAULT_BASE_STATS };
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
        // Context invalidated (extension updated/reloaded) — drop entries gracefully
        console.warn('[ShowdownTestBot] storage.get error:', chrome.runtime.lastError.message);
        isLogging = false;
        return;
      }
      const bugLog = data.bugLog;
      bugLog.push(...entries);
      // Cap log at 500 entries (FIFO eviction)
      if (bugLog.length > 500) bugLog.splice(0, bugLog.length - 500);
      chrome.storage.local.set({ bugLog }, () => {
        if (chrome.runtime.lastError) {
          console.warn('[ShowdownTestBot] storage.set error:', chrome.runtime.lastError.message);
        }
        isLogging = false;
        if (logQueue.length > 0) processLogQueue();
      });
    });
  } catch (err) {
    // Extension context invalidated — silently stop logging
    console.warn('[ShowdownTestBot] Could not save log (context invalidated):', err.message);
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

function isFainted(status) {
  return status === 'fnt' || status === 'FNT';
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
// Opponent state: type overrides, stat boosts, status from battle history
// ---------------------------------------------------------------------
function getOpponentState(opponentName, bar) {
  const history = document.querySelector('.battle-history, .message-log');
  let teraType = null;
  let tempType = null;
  let hasSwitchedIn = false;
  let bellyDrumSeen = false;
  let boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };

  if (history) {
    const lines = history.innerText.split('\n').map(l => l.trim()).filter(Boolean).reverse();
    const e = opponentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const teraRegex       = new RegExp(`The opposing ${e} terastallized into the ([A-Za-z]+) type`, 'i');
    const typeChangeRegex = new RegExp(`The opposing ${e}.*type changed to ([A-Za-z]+)`, 'i');
    const switchRegex     = new RegExp(`sent out ${e}!|${e} was dragged out!`, 'i');
    const statRegex       = new RegExp(`The opposing ${e}'s (Attack|Defense|Sp\\. Atk|Sp\\. Def|Speed|accuracy|evasiveness) (rose|fell)( sharply| drastically| harshly| severely)?!`, 'i');
    const bellyDrumRegex  = new RegExp(`The opposing ${e} cut its own HP and maximized its Attack!`, 'i');

    for (const line of lines) {
      if (!teraType) {
        const m = line.match(teraRegex);
        if (m) teraType = [m[1]];
      }

      if (!tempType && !hasSwitchedIn) {
        const m = line.match(typeChangeRegex);
        if (m) tempType = [m[1]];
      }

      if (!hasSwitchedIn) {
        const statMatch = line.match(statRegex);
        if (statMatch) {
          const stat = STAT_MAP[statMatch[1].toLowerCase()];
          if (stat) {
            const isRose = statMatch[2].toLowerCase() === 'rose';
            const amount = parseSeverity(statMatch[3]);
            // Ignore atk changes logged before the Belly Drum line (reverse-order iteration)
            if (!(stat === 'atk' && bellyDrumSeen)) {
              boosts[stat] += isRose ? amount : -amount;
            }
          }
        }

        if (!bellyDrumSeen && bellyDrumRegex.test(line)) {
          boosts.atk = 6; // Belly Drum maximises Attack regardless of prior boosts
          bellyDrumSeen = true;
        }
      }

      if (!hasSwitchedIn && switchRegex.test(line)) hasSwitchedIn = true;

      // All three signals collected — stop scanning
      if ((teraType || tempType) && hasSwitchedIn) break;
    }
  }

  for (const key in boosts) boosts[key] = Math.max(-6, Math.min(6, boosts[key]));

  // Derive status from statbar DOM
  let status = null;
  if (bar) {
    const statusSpan = bar.querySelector('.status');
    if (statusSpan?.textContent.trim()) status = statusSpan.textContent.trim().toUpperCase();
    const hpText = bar.querySelector('.hptext');
    if (hpText) {
      const t = hpText.textContent.trim();
      if (t === '0%' || t === '0/0') status = 'FNT';
    }
  }

  return { typeOverride: teraType || tempType || null, boosts, status };
}

function getRevealedMoves(opponentName) {
  const history = document.querySelector('.battle-history, .message-log');
  if (!history) return [];
  const e = opponentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const moveRegex = new RegExp(`The opposing ${e} used (.+)!`, 'i');
  const revealed = new Set();
  for (const line of history.innerText.split('\n')) {
    const m = line.trim().match(moveRegex);
    if (m) revealed.add(m[1]);
  }
  return [...revealed];
}

function getMyActiveTypes() {
  if (!window.Pokedex) return { name: 'Unknown', types: [] };
  const statbars = document.querySelectorAll('.statbar');
  let rawName = null;
  for (const bar of statbars) {
    if (!bar.classList.contains('rstatbar') && !(bar.getAttribute('data-side') || '').startsWith('p2')) {
      rawName = bar.querySelector('strong')?.textContent.trim() || null;
      break;
    }
  }
  if (!rawName) return { name: 'Unknown', types: [] };
  const name = resolvePokedexName(rawName);
  return { name, types: window.Pokedex[name] || [] };
}

function getOpponents() {
  if (!window.Pokedex) return [];
  const opponents = [];
  for (const bar of document.querySelectorAll('.statbar')) {
    const side = bar.getAttribute('data-side') || '';
    const isOppSide = bar.classList.contains('rstatbar') ||
      side.startsWith('p2') || side.startsWith('p3') || side.startsWith('p4');
    if (!isOppSide) continue;
    const strong = bar.querySelector('strong');
    if (!strong) continue;

    const name = resolvePokedexName(strong.textContent.trim());
    const oppState = getOpponentState(name, bar);
    const types = oppState.typeOverride || window.Pokedex[name] || [];

    opponents.push({
      name,
      types,
      isOverride: !!oppState.typeOverride,
      revealedMoves: getRevealedMoves(name),
      boosts: oppState.boosts,
      status: oppState.status,
      hp: getOppHPPercent(bar),
    });
  }
  return opponents;
}

// ---------------------------------------------------------------------
// Own stat-boost tracking (reads our side of the battle log)
// ---------------------------------------------------------------------
function getMyBoosts(myName) {
  const history = document.querySelector('.battle-history, .message-log');
  const boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
  if (!history || !myName) return boosts;

  const lines = history.innerText.split('\n').map(l => l.trim()).filter(Boolean).reverse();
  const e = myName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Our stat lines: "<Name>'s Attack rose!" (no "The opposing" prefix)
  const statRegex      = new RegExp(`^${e}'s (Attack|Defense|Sp\\. Atk|Sp\\. Def|Speed|accuracy|evasiveness) (rose|fell)( sharply| drastically| harshly| severely)?!`, 'i');
  const switchRegex    = /^(Go! |You sent out |Come back, )/i;
  const bellyDrumRegex = new RegExp(`^${e} cut its own HP and maximized its Attack!`, 'i');
  let hasSwitchedIn = false;

  for (const line of lines) {
    if (!hasSwitchedIn) {
      if (bellyDrumRegex.test(line)) {
        boosts.atk = 6;
      } else {
        const m = line.match(statRegex);
        if (m) {
          const stat = STAT_MAP[m[1].toLowerCase()];
          if (stat) {
            const isRose = m[2].toLowerCase() === 'rose';
            boosts[stat] += isRose ? parseSeverity(m[3]) : -parseSeverity(m[3]);
          }
        }
      }
    }
    if (!hasSwitchedIn && switchRegex.test(line)) hasSwitchedIn = true;
    if (hasSwitchedIn) break;
  }
  for (const key in boosts) boosts[key] = Math.max(-6, Math.min(6, boosts[key]));
  return boosts;
}

// ---------------------------------------------------------------------
// Current HP tracking from the battle DOM
// ---------------------------------------------------------------------
function getMyHPPercent() {
  const statbars = document.querySelectorAll('.statbar');
  for (const bar of statbars) {
    if (!bar.classList.contains('rstatbar') && !(bar.getAttribute('data-side') || '').startsWith('p2')) {
      const hpText = bar.querySelector('.hptext');
      if (hpText) {
        const text = hpText.textContent.trim();
        if (text.endsWith('%')) return parseFloat(text) / 100;
        const parts = text.split('/');
        if (parts.length === 2 && parseFloat(parts[1]) > 0)
          return parseFloat(parts[0]) / parseFloat(parts[1]);
      }
      break;
    }
  }
  return 1.0; // assume full HP if unreadable
}

function getOppHPPercent(bar) {
  if (!bar) return 1.0;
  const hpText = bar.querySelector('.hptext');
  if (hpText) {
    const text = hpText.textContent.trim();
    if (text.endsWith('%')) return parseFloat(text) / 100;
    const parts = text.split('/');
    if (parts.length === 2 && parseFloat(parts[1]) > 0)
      return parseFloat(parts[0]) / parseFloat(parts[1]);
  }
  return 1.0;
}

// ---------------------------------------------------------------------
// Per-side entry hazard tracking (Stealth Rock, Spikes, Toxic Spikes)
// ---------------------------------------------------------------------
function getHazardState() {
  const history = document.querySelector('.battle-history, .message-log');
  if (!history) return { ourSide: false, theirSide: false, ourHazardDmg: 0, theirHazardDmg: 0 };
  const text = history.innerText;

  let ourHazardDmg = 0;
  let theirHazardDmg = 0;

  // Stealth Rock (~12.5% on neutral targets)
  if (/pointed stones.*?your\s+(?:team|side)/i.test(text)) ourHazardDmg += 0.125;
  if (/pointed stones.*?opposing/i.test(text)) theirHazardDmg += 0.125;

  // Spikes (each layer ~1/8 HP on neutral, up to 3 layers)
  const ourSpikes = (text.match(/Spikes were scattered all around your\s+(?:team|side)/gi) || []).length;
  const theirSpikes = (text.match(/Spikes were scattered all around the opposing/gi) || []).length;
  ourHazardDmg += Math.min(ourSpikes, 3) * 0.0417;
  theirHazardDmg += Math.min(theirSpikes, 3) * 0.0417;

  // Toxic Spikes (up to 2 layers)
  const ourTSpikes = (text.match(/Toxic Spikes.*?your\s+(?:team|side)/gi) || []).length;
  const theirTSpikes = (text.match(/Toxic Spikes.*?opposing/gi) || []).length;
  ourHazardDmg += Math.min(ourTSpikes, 2) * 0.0313;
  theirHazardDmg += Math.min(theirTSpikes, 2) * 0.0313;

  return { ourSide: ourHazardDmg > 0, theirSide: theirHazardDmg > 0, ourHazardDmg, theirHazardDmg };
}

// ---------------------------------------------------------------------
// Smart modifier activation (Mega, Ultra Burst, Dynamax, Tera, Z-Move)
// ---------------------------------------------------------------------
function shouldActivateModifier(mod, moveData, myTypes, oppTypes, estimatedPctDmg, dangerScore) {
  switch (mod) {
    case 'megaevo':
    case 'ultra':
      return true; // Always Mega / Ultra Burst — no downside
    case 'dynamax':
      // Don't waste Dynamax on a turn we're likely to faint before it matters
      return dangerScore < 0.8;
    case 'terastallize': {
      if (!moveData || moveData.basePower === 0) return false;
      const effectiveness = window.getEffectiveness ? window.getEffectiveness(moveData.type, oppTypes) : 1;
      const alreadyStab = myTypes.includes(moveData.type);
      // Tera when: huge type advantage, defensive emergency, or strong non-STAB move
      return effectiveness >= 2 || dangerScore > 0.7 || (estimatedPctDmg >= 0.5 && !alreadyStab);
    }
    case 'zmove':
      // Use Z-Move when it can nearly KO, or in desperate OHKO-or-bust situations
      return estimatedPctDmg >= 0.7 || (dangerScore >= 1.0 && estimatedPctDmg >= 0.4);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------
// Team-preview lead selection: prefer fewest type weaknesses
// ---------------------------------------------------------------------
function pickTeamPreviewLead(buttons) {
  if (!window.Pokedex || !window.getEffectiveness) return buttons[0];

  const allNames = Object.keys(window.Pokedex).sort((a, b) => b.length - a.length);
  const allTypes = ['Normal','Fire','Water','Electric','Grass','Ice','Fighting','Poison',
                    'Ground','Flying','Psychic','Bug','Rock','Ghost','Dragon','Dark','Steel','Fairy'];

  let bestBtn = buttons[0];
  let bestScore = Infinity;

  for (const btn of buttons) {
    let pkmnName = btn.getAttribute('data-species') || btn.getAttribute('data-name') || null;
    if (!pkmnName) {
      const text = btn.textContent.trim();
      for (const name of allNames) {
        if (text.includes(name)) { pkmnName = name; break; }
      }
    }
    if (!pkmnName) continue;

    const pkmnTypes = window.Pokedex[pkmnName] || [];
    if (pkmnTypes.length === 0) continue;

    // Score by number of type weaknesses (fewer = better lead)
    let weaknesses = 0;
    for (const t of allTypes) {
      if (window.getEffectiveness(t, pkmnTypes) > 1) weaknesses++;
    }
    if (weaknesses < bestScore) {
      bestScore = weaknesses;
      bestBtn = btn;
    }
  }

  log(`Team Preview: selected lead with ${bestScore} type weaknesses.`);
  return bestBtn;
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
  if (bp === 0) {
     if (['Heavy Slam', 'Heat Crash', 'Grass Knot', 'Low Kick', 'Gyro Ball', 'Electro Ball'].includes(move.name)) bp = 80;
     else if (move.category !== 'Status') bp = 50;
     else return 0;
  }

  // Hard zero for type immunities — this prevents the bot from ever selecting
  // a move that literally cannot hit (e.g. Fighting vs Ghost, Psychic vs Dark,
  // Electric vs Ground, Normal vs Ghost, Ground vs Flying without Gravity).
  const effect = window.getEffectiveness ? window.getEffectiveness(move.type, defenderTypes) : 1;
  if (effect === 0) return 0;

  const atk = move.category === 'Physical' ? attackerStats.atk : attackerStats.spa;
  const def = move.category === 'Physical' ? defenderStats.def : defenderStats.spd;

  // Standard Gen-9 damage formula at Lv100
  let damage = (((42 * atk * bp) / def) / 50) + 2;
  damage *= attackerTypes.includes(move.type) ? 1.5 : 1; // STAB
  damage *= effect;                                        // Type effectiveness
  return damage;
}

// ---------------------------------------------------------------------
// Battle-state awareness helpers (derived from history text)
// ---------------------------------------------------------------------

/** Returns true if the currently active opponent is behind a Substitute. */
function hasOpponentSubstitute(oppName) {
  const history = document.querySelector('.battle-history, .message-log');
  if (!history || !oppName) return false;
  const e = oppName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lines = history.innerText.split('\n').map(l => l.trim()).filter(Boolean).reverse();

  for (const line of lines) {
    // Substitute was broken
    if (new RegExp(`The opposing ${e}.*substitute faded`, 'i').test(line)) return false;
    // A new substitute was created
    if (new RegExp(`The opposing ${e} put in a substitute`, 'i').test(line)) return true;
    // Opponent switched — no more sub
    if (new RegExp(`sent out ${e}!`, 'i').test(line)) return false;
    // We switched — sub may still be up
  }
  return false;
}

/**
 * Returns the number of consecutive turns the given opponent has used
 * a recovery/stall move (Roost, Recover, Substitute, etc.) since we last
 * dealt damage to them.  Used to detect recovery-stall loops.
 */
function getOpponentRecoveryTurns(oppName) {
  const history = document.querySelector('.battle-history, .message-log');
  if (!history || !oppName) return 0;
  const e = oppName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const RECOVERY_MOVES = /roost|recover|soft-boiled|moonlight|synthesis|rest|slack off|morning sun|healing wish|wish|lunar dance|substitute/i;
  const lines = history.innerText.split('\n').map(l => l.trim()).filter(Boolean).reverse();
  let count = 0;
  for (const line of lines) {
    if (new RegExp(`The opposing ${e} used`, 'i').test(line)) {
      if (RECOVERY_MOVES.test(line)) { count++; continue; }
      break; // Opponent used a non-recovery move — streak ends
    }
    // Damage we dealt breaks the streak
    if (new RegExp(`The opposing ${e} lost`, 'i').test(line)) break;
  }
  return count;
}

/**
 * Returns true if this Pokémon's entire revealed move set consists of
 * hazard-setting moves, making it a dedicated hazard setter to eliminate ASAP.
 */
function isOpponentHazardSetter(opp) {
  if (!opp.revealedMoves || opp.revealedMoves.length === 0) return false;
  const HAZARD_MOVES = new Set(['Stealth Rock', 'Spikes', 'Toxic Spikes', 'Sticky Web', 'Ceaseless Edge', 'Stone Axe']);
  return opp.revealedMoves.every(m => HAZARD_MOVES.has(m));
}

/**
 * Returns the estimated per-turn poison/burn chip a Pokémon will take if
 * switched in (based on our side's Toxic Spikes layers and their status).
 * Used to penalise switching in an already-statused Pokémon.
 */
function estimateSwitchStatusCost(btnText, hazardState) {
  // If Toxic Spikes are up, any incoming grounded non-Poison/Steel will get poisoned
  // and take 1/8 per turn (regular) or escalating damage (badly poisoned).
  // We approximate: 1 layer = 1/8 per turn, 2 layers = 1/6 per turn chip on top of hazard.
  // This is already captured in switchHazardPenalty; here we add recurring poison cost
  // for Pokémon that are ALREADY poisoned/burned (they pay it every turn they're in).
  // We detect this from the button text (Showdown shows status icons on switch buttons).
  const isBadlyPoisoned = /psn|tox/i.test(btnText);
  const isBurned        = /brn/i.test(btnText);
  if (isBadlyPoisoned) return 0.125; // ~1/8 recurring per turn
  if (isBurned)        return 0.0625;
  return 0;
}

/** Returns true if the last move this turn was a setup/Shell-Smash move. */
let _lastSetupTurn = -1; // Turn number when we last used a setup move
let _turnCounter = 0;    // Incremented each time evaluateAndAct fires a click

function usedSetupThisTurn() {
  return _lastSetupTurn >= _turnCounter - 1;
}

/**
 * Estimates the worst-case damage the opponent can deal as a fraction of our max HP.
 * @param {string[]} myTypes  - Our active Pokémon's types
 * @param {object}  myStats  - Our base stats object (hp/def/spd used; boosts already applied by callers)
 * @param {object}  oppState - Opponent object with {status, types, boosts}
 * @param {object}  oppData  - Cached Showdown Pokémon data with .baseStats
 * @param {object}  [myBoosts] - Our current stat boosts for def/spd (optional)
 */
function getDangerScore(myTypes, myStats, oppState, oppData, myBoosts = {}) {
  // Sleeping/frozen opponent can't attack
  if (oppState.status === 'SLP' || oppState.status === 'FRZ') return { score: 0, expectedType: 'Normal' };

  const oppBase = oppData.baseStats || { ...DEFAULT_BASE_STATS };
  const oppTypes = (oppState.types?.length > 0) ? oppState.types : ['Normal'];

  const oppAtk = estimateStat(oppBase.atk, false, oppState.boosts?.atk ?? 0);
  const oppSpa = estimateStat(oppBase.spa, false, oppState.boosts?.spa ?? 0);
  // Apply our defensive boosts so a +6 Def situation correctly reduces incoming danger
  const myDef = estimateStat(myStats.def, false, myBoosts.def ?? 0);
  const mySpd = estimateStat(myStats.spd, false, myBoosts.spd ?? 0);
  const myHp  = estimateStat(myStats.hp, true, 0);

  const ALL_TYPES = ['Normal','Fire','Water','Electric','Grass','Ice','Fighting','Poison',
                     'Ground','Flying','Psychic','Bug','Rock','Ghost','Dragon','Dark','Steel','Fairy'];

  let maxDamage = 0;
  let mostDangerousType = 'Normal';

  for (const testType of ALL_TYPES) {
    const isStab = oppTypes.includes(testType);
    const bp = isStab ? 90 : 80;
    const stabMult = isStab ? 1.5 : 1.0;
    const effect = window.getEffectiveness ? window.getEffectiveness(testType, myTypes) : 1;
    if (effect === 0) continue; // type immunity — skip

    for (const [atk, def] of [[oppAtk, myDef], [oppSpa, mySpd]]) {
      const dmg = (((42 * atk * bp) / def / 50) + 2) * stabMult * effect;
      if (dmg > maxDamage) { maxDamage = dmg; mostDangerousType = testType; }
    }
  }

  return { score: maxDamage / myHp, expectedType: mostDangerousType };
}

function getRandomAction(moveButtons, switchButtons) {
  const all = [...(moveButtons || []), ...(switchButtons || [])];
  if (all.length === 0) return null;
  const btn = randomChoice(all);
  return { btn, type: (moveButtons || []).includes(btn) ? 'move' : 'switch' };
}

function getBestAction(moveButtons, switchButtons) {
  switch (intelligenceLevel) {
    case 'random':  return getRandomAction(moveButtons, switchButtons);
    case 'max':     return getMaxIntelligenceAction(moveButtons, switchButtons);
    default:        return getHeuristicAction(moveButtons, switchButtons);
  }
}

function getMaxIntelligenceAction(moveButtons, switchButtons) {
  // --- 1. Gather Battle State ---
  const myData = getMyActiveTypes();
  const opponents = getOpponents();
  
  const missingOpps = opponents.map(o => o.name).filter(n => n && !cachedOppData[n]);
  if (missingOpps.length > 0) window.postMessage({ direction: 'from-extension', type: 'FETCH_OPPONENTS', opponents: missingOpps }, '*');
  const missingMoves = moveButtons.map(btn => btn.getAttribute('data-move')).filter(m => m && !cachedMoveData[m]);
  if (missingMoves.length > 0) window.postMessage({ direction: 'from-extension', type: 'FETCH_MOVES', moves: missingMoves }, '*');

  let myBaseStats = {hp:100, atk:100, def:100, spa:100, spd:100, spe:100};
  if (cachedOppData[myData.name]) myBaseStats = cachedOppData[myData.name].baseStats || myBaseStats;
  else if (!cachedOppData[myData.name]) window.postMessage({ direction: 'from-extension', type: 'FETCH_OPPONENTS', opponents: [myData.name] }, '*');

  if (missingOpps.length > 0 || missingMoves.length > 0 || !cachedOppData[myData.name]) return null;

  const myBoosts = getMyBoosts(myData.name);
  const myHPPercent = getMyHPPercent();
  let myStats = {
    hp: estimateStat(myBaseStats.hp, true, 0),
    atk: estimateStat(myBaseStats.atk, false, myBoosts.atk),
    def: estimateStat(myBaseStats.def, false, myBoosts.def),
    spa: estimateStat(myBaseStats.spa, false, myBoosts.spa),
    spd: estimateStat(myBaseStats.spd, false, myBoosts.spd),
    spe: estimateStat(myBaseStats.spe, false, myBoosts.spe)
  };
  
  let opp = opponents.find(o => o.status !== 'FNT' && o.status !== 'fnt') || opponents[0];
  if (!opp) return getRandomAction(moveButtons, switchButtons);
  
  let oppData = cachedOppData[opp.name] || {};
  let oppBase = oppData.baseStats || {hp:100, atk:100, def:100, spa:100, spd:100, spe:100};
  const oppBoosts = opp.boosts || {};
  let oppStats = {
    hp:  estimateStat(oppBase.hp,  true,  0),
    def: estimateStat(oppBase.def, false, oppBoosts.def ?? 0),
    spd: estimateStat(oppBase.spd, false, oppBoosts.spd ?? 0),
    spe: estimateStat(oppBase.spe, false, oppBoosts.spe ?? 0),
  };
  if (opp.status === 'PAR') oppStats.spe *= 0.5;

  // --- 2. Advanced Decision Engine: Simulator ---
  const hazardState = getHazardState();
  let dangerResult = getDangerScore(myData.types, myBaseStats, opp, oppData, myBoosts);
  const oppExpectedMoves = [
    { name: 'Assumed STAB', basePower: 90, type: (opp.types && opp.types.length > 0) ? opp.types[0] : 'Normal', category: oppBase.atk > oppBase.spa ? 'Physical' : 'Special', priority: 0, accuracy: 100 },
    { name: 'Assumed Coverage', basePower: 80, type: dangerResult.expectedType || 'Normal', category: oppBase.atk > oppBase.spa ? 'Physical' : 'Special', priority: 0, accuracy: 100 },
    { name: 'Assumed Status/Switch', category: 'Status', priority: 0, accuracy: 100, isSwitch: true } // Simulates them not attacking us
  ];

  function simulate1Ply(myAction, oppMoveAssumed) {
      let myEndHp = myStats.hp * myHPPercent; 
      let oppEndHp = oppStats.hp * (opp.hp !== undefined ? opp.hp : 1.0);
      let oppEndStatus = opp.status;
      
      let iGoFirst = myStats.spe > oppStats.spe;
      if (myAction.type === 'move') {
          let myPrio = myAction.moveData.priority || 0;
          let oppPrio = oppMoveAssumed.priority || 0;
          if (myPrio > oppPrio) iGoFirst = true;
          else if (myPrio < oppPrio) iGoFirst = false;
      } else {
          iGoFirst = true;
      }

      function resolveMyAction() {
          if (myAction.type === 'switch') return;
          let m = myAction.moveData;
          if (m.category === 'Status') {
              if (!oppEndStatus) {
                 if (['Spore', 'Sleep Powder'].includes(m.name) && !opp.types.includes('Grass')) oppEndStatus = 'SLP';
                 if (m.name === 'Will-O-Wisp' && !opp.types.includes('Fire')) oppEndStatus = 'BRN';
                 if (m.name === 'Thunder Wave' && !opp.types.includes('Ground') && !opp.types.includes('Electric')) oppEndStatus = 'PAR';
                 if (m.name === 'Toxic' && !opp.types.includes('Steel') && !opp.types.includes('Poison')) oppEndStatus = 'TOX';
              }
              if (['Roost', 'Recover', 'Soft-Boiled', 'Synthesis', 'Moonlight', 'Slack Off', 'Morning Sun'].includes(m.name)) myEndHp = Math.min(myStats.hp, myEndHp + myStats.hp * 0.5);
          } else {
              let dmg = calculateEstimatedDamage(myStats, oppStats, m, myData.types, opp.types);
              let acc = m.accuracy === true ? 100 : (m.accuracy || 100);
              if (m.name === 'Sucker Punch') {
                  if (oppMoveAssumed.category === 'Status' || oppMoveAssumed.isSwitch) dmg = 0; // Fails entirely!
                  else acc = 100; // If they attack, it hits (assuming no evasion).
              }
              dmg = dmg * (acc / 100);
              oppEndHp = Math.max(0, oppEndHp - dmg);
          }
      }

      function resolveOppAction() {
          if (oppMoveAssumed.category === 'Status') {
              if (oppMoveAssumed.isSwitch) {
                  // Simulate opponent switching to a resist: our damage is halved.
                  oppEndHp = oppStats.hp * (opp.hp !== undefined ? opp.hp : 1.0); // Reset their HP (new mon)
              }
              return; // They don't do damage to us
          }
          let dmg = calculateEstimatedDamage(oppStats, myStats, oppMoveAssumed, opp.types, myData.types);
          myEndHp = Math.max(0, myEndHp - dmg);
      }

      if (iGoFirst || oppMoveAssumed.isSwitch) {
          if (oppMoveAssumed.isSwitch) resolveOppAction();
          resolveMyAction();
          if (oppEndHp > 0 && !oppMoveAssumed.isSwitch) resolveOppAction();
      } else {
          resolveOppAction();
          if (myEndHp > 0) resolveMyAction();
      }

      // --- 3. Evaluate Resulting State ---
      let myScore = (myEndHp / myStats.hp) * 100;
      let oppScore = (oppEndHp / oppStats.hp) * 100;
      
      if (myEndHp <= 0) myScore -= 200; 
      if (oppEndHp <= 0) myScore += 150; 
      
      if (oppEndStatus && oppEndStatus !== opp.status) oppScore -= 30; 
      
      if (myAction.type === 'move') {
          const mName = myAction.moveData.name;
          if (['Swords Dance', 'Nasty Plot', 'Dragon Dance', 'Quiver Dance', 'Calm Mind', 'Bulk Up', 'Shell Smash'].includes(mName)) {
              let relevantBoost = 0;
              if (['Swords Dance', 'Dragon Dance', 'Bulk Up'].includes(mName)) relevantBoost = myBoosts.atk || 0;
              else relevantBoost = myBoosts.spa || 0;

              if (relevantBoost < 2 && myEndHp > myStats.hp * 0.5) {
                  myScore += 40;
              } else {
                  myScore -= 100;
              }
          }
      }
      
      if (myAction.type === 'move' && myAction.moveData.category === 'Status' && !oppEndStatus && !['Roost', 'Recover', 'Soft-Boiled', 'Synthesis', 'Moonlight', 'Slack Off', 'Morning Sun', 'Swords Dance', 'Nasty Plot', 'Dragon Dance', 'Quiver Dance', 'Calm Mind', 'Bulk Up', 'Shell Smash', 'Substitute', 'Protect'].includes(myAction.moveData.name)) {
         myScore -= 100;
      }

      return myScore - oppScore;
  }

  // --- 4. Cross-Calculation (Minimax) ---
  let bestAction = null;
  let bestScore = -Infinity;

  for (const btn of moveButtons) {
     const moveName = btn.getAttribute('data-move');
     const moveData = cachedMoveData[moveName] || { name: moveName, basePower: 0, category: 'Status', type: 'Normal', priority: 0, accuracy: 100 };
     let myAction = { btn, type: 'move', moveData };
     
     let worstCaseScore = Infinity;
     for (const oppMove of oppExpectedMoves) {
         let score = simulate1Ply(myAction, oppMove);
         if (score < worstCaseScore) worstCaseScore = score;
     }
     
     if (hasOpponentSubstitute(opp.name) || getOpponentRecoveryTurns(opp.name) >= 3) worstCaseScore += 50;
     if (isOpponentHazardSetter(opp)) worstCaseScore += 30;

     if (worstCaseScore > bestScore) {
         bestScore = worstCaseScore;
         bestAction = myAction;
     }
  }

  const allNames = window.Pokedex ? Object.keys(window.Pokedex).sort((a, b) => b.length - a.length) : [];
  for (const btn of switchButtons) {
     if (btn.disabled || btn.classList.contains('disabled')) continue;
     if (btn.textContent.includes('fainted')) continue;
     
     let pkmnName = btn.textContent.trim();
     for (const name of allNames) {
         if (pkmnName.includes(name)) { pkmnName = name; break; }
     }
     
     let switchDangerScore = getDangerScore(window.Pokedex[pkmnName] || [], cachedOppData[pkmnName]?.baseStats || DEFAULT_BASE_STATS, opp, oppData, {}).score;
     
     let switchScore = -(switchDangerScore * 100) - (hazardState.ourHazardDmg * 100) - estimateSwitchStatusCost(btn.textContent, hazardState) * 100;
     
     if (switchScore > bestScore && !(hasOpponentSubstitute(opp.name) || getOpponentRecoveryTurns(opp.name) >= 3)) {
         bestScore = switchScore;
         bestAction = { btn, type: 'switch' };
     }
  }

  if (bestAction?.type === 'move') window.lastIntendedTarget = opp.name;
  return bestAction || { btn: moveButtons[0] || switchButtons[0], type: moveButtons.length > 0 ? 'move' : 'switch' };
}

function getHeuristicAction(moveButtons, switchButtons) {
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
  
  const myBoosts = getMyBoosts(myData.name);
  const myHPPercent = getMyHPPercent();
  let myStats = {
    hp: estimateStat(myBaseStats.hp, true, 0),
    atk: estimateStat(myBaseStats.atk, false, myBoosts.atk),
    def: estimateStat(myBaseStats.def, false, myBoosts.def),
    spa: estimateStat(myBaseStats.spa, false, myBoosts.spa),
    spd: estimateStat(myBaseStats.spd, false, myBoosts.spd),
    spe: estimateStat(myBaseStats.spe, false, myBoosts.spe)
  };
  
  let maxDangerScore = 0; // percent damage we take
  let oppToWorryAbout = null;
  let oppSpeed = 100;
  let predictedAttack = null;
  
  if (opponents && opponents.length > 0) {
    for (const opp of opponents) {
      if (opp.status === 'FNT' || opp.status === 'fnt') continue;
      
      const oppData = cachedOppData[opp.name] || {};
      const dangerResult = getDangerScore(myData.types, myBaseStats, opp, oppData, myBoosts);
      const dangerScore = dangerResult.score;
      if (dangerScore > maxDangerScore) {
        maxDangerScore = dangerScore;
        predictedAttack = dangerResult.expectedType;
        oppToWorryAbout = opp;
        const oppBaseSpe = oppData.baseStats?.spe ?? 100;
        oppSpeed = estimateStat(oppBaseSpe, false, opp.boosts?.spe ?? 0);
        if (opp.status === 'PAR') oppSpeed *= 0.5;
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

  // --- Battle-state context ---
  const oppHasSub     = hasOpponentSubstitute(opp.name);
  const recoveryTurns = getOpponentRecoveryTurns(opp.name);
  const oppIsWalling  = recoveryTurns >= 3;
  const oppIsHazardSetter = isOpponentHazardSetter(opp);
  // Declare hazardState here so it's available in both move scoring and switch scoring
  const hazardState = getHazardState();
  const switchHazardPenalty = hazardState.ourHazardDmg;

  let bestMoveBtns = [];
  let bestMoveScore = -1;
  let bestMoveLog = '';
  let bestTargetName = null;

  for (const btn of moveButtons) {
    const moveName = btn.getAttribute('data-move');
    const moveData = cachedMoveData[moveName] || DEFAULT_MOVE_DATA;

    let score = 0;
    let targetForThisMove = null;

    for (const opp of opponents) {
        if (isFainted(opp.status)) continue;
        const oppData = cachedOppData[opp.name] || {};
        const oppBase = oppData.baseStats || { ...DEFAULT_BASE_STATS };
        const ob = opp.boosts || {};
        const oppStats = {
          hp:  estimateStat(oppBase.hp,  true,  0),
          def: estimateStat(oppBase.def, false, ob.def ?? 0),
          spd: estimateStat(oppBase.spd, false, ob.spd ?? 0),
        };

        let moveScore = 0;

        if (moveData.category === 'Status') {
           // --- Status move heuristics ---
           const statusMoves = ['Thunder Wave', 'Will-O-Wisp', 'Toxic', 'Spore', 'Sleep Powder', 'Stun Spore', 'Poison Powder'];
           if (statusMoves.includes(moveName)) {
               if (opp.status) {
                   moveScore = -2000;
               } else {
                   moveScore = 150;
                   if (moveName === 'Thunder Wave' && (opp.types.includes('Ground') || opp.types.includes('Electric'))) moveScore = -2000;
                   if (moveName === 'Will-O-Wisp' && opp.types.includes('Fire')) moveScore = -2000;
                   if (moveName === 'Toxic' && (opp.types.includes('Poison') || opp.types.includes('Steel'))) moveScore = -2000;
                   if (['Spore', 'Sleep Powder', 'Stun Spore', 'Poison Powder'].includes(moveName) && opp.types.includes('Grass')) moveScore = -2000;
               }
           }
           else if (['Swords Dance', 'Dragon Dance', 'Nasty Plot', 'Calm Mind', 'Quiver Dance', 'Bulk Up', 'Shell Smash'].includes(moveName)) {
               // Only set up if safe; after Shell Smash commit to attacking next turn
               moveScore = maxDangerScore < 0.35 ? 200 : 5;
           }
           else if (['Roost', 'Recover', 'Soft-Boiled', 'Synthesis', 'Moonlight', 'Slack Off', 'Morning Sun'].includes(moveName)) {
               if (myHPPercent === 1) moveScore = -2000;
               else moveScore = (myHPPercent < 0.5 && maxDangerScore < 0.8) ? 180 + (1 - myHPPercent) * 100 : 5;
           }
           else if (['Stealth Rock', 'Spikes', 'Toxic Spikes'].includes(moveName)) {
               moveScore = hazardState.theirSide ? 20 : 140;
           }
           else if (['Wish', 'Healing Wish', 'Lunar Dance'].includes(moveName)) {
               moveScore = myHPPercent < 0.4 ? 160 : 30;
           }
           else if (moveName === 'Trick Room') {
               moveScore = amISlower ? 180 : 5;
           }
           // Strength Sap — only useful against physical attackers; useless vs Special
           else if (moveName === 'Strength Sap') {
               const isPrimarilyPhysical = oppBase.atk > oppBase.spa;
               moveScore = (isPrimarilyPhysical && maxDangerScore > 0.4) ? 160 : 5;
           }
           else {
               moveScore = 10;
           }
        } else {
           // --- Damage move heuristics ---
           let damage = calculateEstimatedDamage(myStats, oppStats, moveData, myData.types, opp.types);
           // damage is 0 for immune matchups — treated as dead score naturally
           let percentDamage = damage / oppStats.hp;

           moveScore = percentDamage * 100;

           // Priority bonus if slower and can KO
           if (moveData.priority > 0 && percentDamage >= (opp.hp ?? 1.0)) moveScore += 500;
           // Last resort: slower + OHKO threat + priority move
           if (amISlower && maxDangerScore >= 1.0 && moveData.priority > 0) moveScore += 300;

           // Momentum moves
           if (['U-turn', 'Volt Switch', 'Flip Turn'].includes(moveName)) {
               if (maxDangerScore > 0.8 && !amISlower) moveScore += 250;
               else if (maxDangerScore < 0.5) moveScore += 40;
           }

           // Accuracy penalty
           const acc = moveData.accuracy === true ? 100 : (moveData.accuracy ?? 100);
           moveScore *= (acc / 100);

           // When opponent has a Substitute, push through it — don't switch
           if (oppHasSub) moveScore += 50;

           // Opponent is stalling with recovery — escalate aggression
           if (oppIsWalling) moveScore += 80;

           // Wipe out hazard setter before they set more
           if (oppIsHazardSetter) moveScore += 120;

           // Common ability immunities
           const abilities = oppData.abilities || {};
           const abilityValues = Object.values(abilities).join(' ').toLowerCase();
           if (moveData.type === 'Ground'    && abilityValues.includes('levitate'))    moveScore = 0;
           if (moveData.type === 'Fire'      && abilityValues.includes('flash fire'))  moveScore = 0;
           if (moveData.type === 'Water'     && (abilityValues.includes('water absorb') || abilityValues.includes('storm drain') || abilityValues.includes('dry skin'))) moveScore = 0;
           if (moveData.type === 'Electric'  && (abilityValues.includes('volt absorb') || abilityValues.includes('motor drive') || abilityValues.includes('lightning rod'))) moveScore = 0;
           if (moveData.type === 'Grass'     && abilityValues.includes('sap sipper')) moveScore = 0;
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

  // Evaluate Switches — suppress when opponent has Substitute or is recovery-walling
  let bestSwitchBtns = [];
  let bestSwitchDanger = 999;

  // hazardState and switchHazardPenalty already declared above (before move scoring)
  // Never switch into a Substitute wall or a recovery loop — attack through it instead
  const dontSwitch = oppHasSub || oppIsWalling;

  if (!dontSwitch && (moveButtons.length === 0 || (maxDangerScore >= 1.0 && amISlower))) {
    log(`Danger score ${Math.round(maxDangerScore*100)}%, moves=${moveButtons.length}. Evaluating switches...`);
    const allNames = window.Pokedex ? Object.keys(window.Pokedex).sort((a, b) => b.length - a.length) : [];

    for (const btn of switchButtons) {
      if (btn.disabled || btn.classList.contains('disabled')) continue;
      if (btn.textContent.includes('fainted')) continue;

      let pkmnName = btn.textContent.trim();
      for (const name of allNames) {
        if (pkmnName.includes(name)) { pkmnName = name; break; }
      }

      const pkmnTypes = window.Pokedex ? (window.Pokedex[pkmnName] || []) : [];
      const pkmnData = cachedOppData[pkmnName] || {};
      const pkmnBase = pkmnData.baseStats || { ...DEFAULT_BASE_STATS };

      let incomingDanger = 0;
      if (pkmnTypes.length > 0 && opponents.length > 0) {
        for (const opp of opponents) {
          if (isFainted(opp.status)) continue;
          const oppData = cachedOppData[opp.name] || {};
          let danger = getDangerScore(pkmnTypes, pkmnBase, opp, oppData).score;

          if (predictedAttack) {
            const effectOnSwitch = window.getEffectiveness ? window.getEffectiveness(predictedAttack, pkmnTypes) : 1;
            if (effectOnSwitch === 0) danger -= 1.0;
            else if (effectOnSwitch < 1) danger -= 0.5;
            else if (effectOnSwitch > 1) danger += 0.5;
          }

          if (danger > incomingDanger) incomingDanger = danger;
        }
      }
      // Penalise switching in a poisoned/burned Pokémon — they take recurring chip every turn
      incomingDanger += estimateSwitchStatusCost(btn.textContent, hazardState);
      incomingDanger += switchHazardPenalty;

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
  if (switchButtons.length > 0) return { btn: randomChoice(switchButtons), type: 'switch' };
  return null; // No valid action available
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
      // FFA/doubles: prefer intended target, then fall back to lowest-HP target (easiest KO)
      chosen = null;
      if (window.lastIntendedTarget) {
        for (const btn of target.buttons) {
          if (btn.textContent.includes(window.lastIntendedTarget)) {
            chosen = btn;
            break;
          }
        }
      }
      if (!chosen) {
        let lowestHP = Infinity;
        const oppBars = document.querySelectorAll(
          '.rstatbar, .statbar[data-side^="p2"], .statbar[data-side^="p3"], .statbar[data-side^="p4"]'
        );
        for (const btn of target.buttons) {
          const btnText = btn.textContent.trim();
          for (const bar of oppBars) {
            const nameEl = bar.querySelector('strong');
            if (nameEl) {
              const barName = nameEl.textContent.replace(/\s*L\d+.*$/i, '').replace(/[\u2640\u2642]/g, '').trim();
              if (btnText.includes(barName)) {
                const hp = getOppHPPercent(bar);
                if (hp < lowestHP) { lowestHP = hp; chosen = btn; }
                break;
              }
            }
          }
        }
        if (!chosen) chosen = randomChoice(target.buttons);
        log(`FFA target selected: lowest HP at ~${Math.round(lowestHP * 100)}%`);
      }
      category = 'target';
    } else if (move.buttons.length > 0 || switches.buttons.length > 0) {
      const action = getBestAction(move.buttons, switches.buttons);
      if (!action) return;
      chosen = action.btn;
      category = action.type;
    } else if (teamPreview.buttons.length > 0) {
      chosen = pickTeamPreviewLead(teamPreview.buttons);
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
          // Gather context for smart per-modifier decisions
          const moveName = chosen ? chosen.getAttribute('data-move') : null;
          const moveData = moveName ? (cachedMoveData[moveName] || null) : null;
          const myInfo = getMyActiveTypes();
          const opps = getOpponents();
          const firstOpp = opps.find(o => o.status !== 'FNT' && o.status !== 'fnt') || opps[0];
          const oppTypes = firstOpp ? firstOpp.types : [];
          const myTypes = myInfo.types;

          let pctDmg = 0;
          let dangerScore = 0;
          if (moveData && firstOpp) {
            const myBase = (cachedOppData[myInfo.name] || {}).baseStats || { atk: 100, spa: 100, def: 100, spd: 100, hp: 100, spe: 100 };
            const oppBase = (cachedOppData[firstOpp.name] || {}).baseStats || { hp: 100, def: 100, spd: 100 };
            const myAtkStat = moveData.category === 'Physical'
              ? estimateStat(myBase.atk, false, 0)
              : estimateStat(myBase.spa, false, 0);
            const oppDefStat = moveData.category === 'Physical'
              ? estimateStat(oppBase.def, false, firstOpp.boosts ? firstOpp.boosts.def : 0)
              : estimateStat(oppBase.spd, false, firstOpp.boosts ? firstOpp.boosts.spd : 0);
            const oppHpStat = estimateStat(oppBase.hp, true, 0);
            const bp = moveData.basePower || 0;
            if (bp > 0) {
              const stab = myTypes.includes(moveData.type) ? 1.5 : 1;
              const eff = window.getEffectiveness ? window.getEffectiveness(moveData.type, oppTypes) : 1;
              pctDmg = (((42 * myAtkStat * bp) / oppDefStat / 50) + 2) * stab * eff / oppHpStat;
            }
            const myBaseForDanger = (cachedOppData[myInfo.name] || {}).baseStats ||
              { hp: 100, atk: 100, def: 100, spa: 100, spd: 100, spe: 100 };
            dangerScore = getDangerScore(myTypes, myBaseForDanger, firstOpp,
              cachedOppData[firstOpp.name] || {}).score;
          }

          // Activate in priority order: Mega first (no downside), then conditional ones
          const modifiers = ['megaevo', 'ultra', 'dynamax', 'terastallize', 'zmove'];
          for (const mod of modifiers) {
            const cb = document.querySelector(`input[name="${mod}"]`);
            if (cb && !cb.checked) {
              if (shouldActivateModifier(mod, moveData, myTypes, oppTypes, pctDmg, dangerScore)) {
                cb.click();
                log(`Activated ${mod}! (pctDmg=${Math.round(pctDmg * 100)}%, danger=${Math.round(dangerScore * 100)}%)`);
              }
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

// intelligenceLevel must be declared BEFORE the observer/poll start so the first
// synchronous evaluateAndAct() call (triggered by mutations during page load) uses
// the correct value even before the async storage.get resolves.
let intelligenceLevel = 'max';

const observer = new MutationObserver(() => scheduleEvaluate());
observer.observe(document.body, { childList: true, subtree: true });
pollInterval = setInterval(evaluateAndAct, 1000);

// Initialise from persisted settings (async)
chrome.storage.local.get({ enabled: false, intelligence: 'max' }, (data) => {
  if (chrome.runtime.lastError) {
    console.warn('[ShowdownTestBot] Could not read settings:', chrome.runtime.lastError.message);
    return;
  }
  enabled = data.enabled;
  intelligenceLevel = data.intelligence;
  log(`Content script loaded. enabled=${enabled}, intelligence=${intelligenceLevel}`);
  evaluateAndAct();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.enabled) {
    enabled = changes.enabled.newValue;
    log(`Toggled ${enabled ? 'ON' : 'OFF'}`);
    lastActedSignature = null;
    lastFoundAnyAt = Date.now();
  }
  if (changes.intelligence) {
    intelligenceLevel = changes.intelligence.newValue;
    log(`Intelligence changed to ${intelligenceLevel}`);
  }
  evaluateAndAct();
});
