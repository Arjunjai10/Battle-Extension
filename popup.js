/**
 * popup.js — Extension popup controller
 *
 * Manages the bot's on/off toggle, intelligence level selector,
 * log export, and log clearing. All state is persisted in
 * chrome.storage.local and picked up live by content.js via
 * chrome.storage.onChanged.
 */

'use strict';

const toggle           = document.getElementById('enabledToggle');
const intelligenceSelect = document.getElementById('intelligenceSelect');
const exportBtn        = document.getElementById('exportBtn');
const clearBtn         = document.getElementById('clearBtn');
const statusEl         = document.getElementById('status');

// ── Helpers ────────────────────────────────────────────────────────────────

/** Show a transient status message, optionally auto-clearing after a timeout. */
function showStatus(message, autoClearMs = 0) {
  statusEl.textContent = message;
  if (autoClearMs > 0) {
    setTimeout(() => {
      // Only clear if the message hasn't already changed
      if (statusEl.textContent === message) statusEl.textContent = '';
    }, autoClearMs);
  }
}

// ── Initialise from storage ────────────────────────────────────────────────

chrome.storage.local.get({ enabled: false, intelligence: 'max', bugLog: [] }, (data) => {
  if (chrome.runtime.lastError) {
    showStatus('Error reading settings.');
    return;
  }
  toggle.checked = data.enabled;
  intelligenceSelect.value = data.intelligence;
  const count = Array.isArray(data.bugLog) ? data.bugLog.length : 0;
  showStatus(`${count} log entr${count === 1 ? 'y' : 'ies'} stored.`);
});

// ── Event listeners ────────────────────────────────────────────────────────

toggle.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: toggle.checked }, () => {
    if (chrome.runtime.lastError) {
      showStatus('Error saving toggle state.');
    }
  });
});

intelligenceSelect.addEventListener('change', () => {
  chrome.storage.local.set({ intelligence: intelligenceSelect.value }, () => {
    if (chrome.runtime.lastError) {
      showStatus('Error saving intelligence level.');
    }
  });
});

exportBtn.addEventListener('click', () => {
  exportBtn.disabled = true;
  chrome.storage.local.get({ bugLog: [] }, (data) => {
    exportBtn.disabled = false;
    if (chrome.runtime.lastError) {
      showStatus('Error reading log.');
      return;
    }
    const log = Array.isArray(data.bugLog) ? data.bugLog : [];
    if (log.length === 0) {
      showStatus('Log is empty — nothing to export.', 3000);
      return;
    }
    const text = log.map((e) => `[${e.time}] ${e.message}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    // Opens the log in a new tab; use Ctrl+S / Cmd+S to save it as a file.
    const tab = window.open(url, '_blank');
    // Revoke after a short delay — the tab will have loaded by then.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    if (!tab) showStatus('Pop-up blocked. Allow pop-ups for this page.', 4000);
  });
});

clearBtn.addEventListener('click', () => {
  clearBtn.disabled = true;
  chrome.storage.local.set({ bugLog: [] }, () => {
    clearBtn.disabled = false;
    if (chrome.runtime.lastError) {
      showStatus('Error clearing log.');
      return;
    }
    showStatus('Log cleared.', 3000);
  });
});
