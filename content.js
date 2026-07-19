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

function log(message) {
  const entry = { time: new Date().toISOString(), message };
  console.log("[ShowdownTestBot]", message);
  chrome.storage.local.get({ bugLog: [] }, (data) => {
    const bugLog = data.bugLog;
    bugLog.push(entry);
    while (bugLog.length > 500) bugLog.shift();
    chrome.storage.local.set({ bugLog });
  });
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
      setBadge("Showdown Test Bot: ON — waiting for your turn", "#f0ad4e");
      maybeLogDiagnostic();
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
      chosen = randomChoice(move.buttons);
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
