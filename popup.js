const toggle = document.getElementById("enabledToggle");
const exportBtn = document.getElementById("exportBtn");
const clearBtn = document.getElementById("clearBtn");
const status = document.getElementById("status");

chrome.storage.local.get({ enabled: false, bugLog: [] }, (data) => {
  toggle.checked = data.enabled;
  status.textContent = `${data.bugLog.length} log entries stored.`;
});

toggle.addEventListener("change", () => {
  chrome.storage.local.set({ enabled: toggle.checked });
});

exportBtn.addEventListener("click", () => {
  chrome.storage.local.get({ bugLog: [] }, (data) => {
    const text = data.bugLog
      .map((e) => `[${e.time}] ${e.message}`)
      .join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    // Opens the log in a new tab; use Ctrl+S / Cmd+S there to save it as a file.
    window.open(url, "_blank");
  });
});

clearBtn.addEventListener("click", () => {
  chrome.storage.local.set({ bugLog: [] }, () => {
    status.textContent = "Log cleared.";
  });
});
