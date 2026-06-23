// State: current active tab mode
var currentMode = "agenthubs";

// Initialize — set up event listeners and IPC handlers
function init() {
  var tabs = document.querySelectorAll(".tab");
  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      var mode = tab.dataset.mode;
      if (mode && mode !== currentMode) {
        setActiveTab(mode);
        // Send IPC to main process
        if (window.sidebar && window.sidebar.switchMode) {
          window.sidebar.switchMode(mode);
        }
      }
    });
  });

  // Listen for org info updates from main process
  if (window.sidebar && window.sidebar.onOrgInfo) {
    window.sidebar.onOrgInfo(function (info) {
      updateOrgInfo(info);
    });
  }

  // Listen for status updates from main process
  if (window.sidebar && window.sidebar.onStatus) {
    window.sidebar.onStatus(function (status) {
      updateStatus(status.mode, status.status);
    });
  }

  // Sign out button
  var logoutBtn = document.getElementById("btn-logout");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", function () {
      if (window.sidebar && window.sidebar.signOut) {
        window.sidebar.signOut();
      }
    });
  }

  // Download VM button
  initDownloadButton();
}

function setActiveTab(mode) {
  currentMode = mode;
  document.querySelectorAll(".tab").forEach(function (t) {
    t.classList.toggle("active", t.dataset.mode === mode);
  });
}

function updateOrgInfo(info) {
  if (info.name) {
    var nameEl = document.getElementById("org-name");
    if (nameEl) nameEl.textContent = info.name;
  }
  if (info.role) {
    var roleEl = document.getElementById("org-role");
    if (roleEl) roleEl.textContent = info.role;
  }
  if (info.balance) {
    var balanceEl = document.getElementById("org-balance");
    if (balanceEl) balanceEl.textContent = info.balance;
  }
  if (info.email) {
    var emailEl = document.getElementById("user-email");
    if (emailEl) emailEl.textContent = info.email;
  }
}

function updateStatus(mode, status) {
  var elId = mode === "agent" ? "daemon-status" : "agenthubs-status";
  var el = document.getElementById(elId);
  if (!el) return;

  var dot = el.querySelector(".status-dot");
  if (!dot) return;

  dot.className = "status-dot " + status; // online, offline, loading

  var label = mode === "agent" ? "Agent Daemon" : "AgentHubs";
  var labelEl = el.querySelector(".status-label");
  if (labelEl) {
    labelEl.textContent = label;
  }

  // Show download button when AgentHubs is offline (VM not ready)
  if (mode === "agenthubs") {
    var downloadArea = document.getElementById("vm-download-area");
    if (downloadArea) {
      downloadArea.style.display = status === "offline" ? "block" : "none";
    }
  }
}

function initDownloadButton() {
  var btn = document.getElementById("btn-download-vm");
  if (!btn) return;

  btn.addEventListener("click", function () {
    if (window.sidebar && window.sidebar.downloadVm) {
      window.sidebar.downloadVm();
      btn.disabled = true;
      btn.textContent = "Downloading...";
    }
  });

  // Listen for download progress updates
  if (window.sidebar && window.sidebar.onVmDownloadProgress) {
    window.sidebar.onVmDownloadProgress(function (progress) {
      var progressEl = document.getElementById("vm-download-progress");
      if (progressEl) {
        progressEl.textContent = "Downloading... " + progress.percent + "% (" +
          progress.downloadedMB + "MB / " + progress.totalMB + "MB)";
      }

      if (progress.stage === "complete") {
        var btn = document.getElementById("btn-download-vm");
        if (btn) {
          btn.textContent = "Download complete - restart to activate";
          btn.disabled = true;
        }
      } else if (progress.stage === "error") {
        var btn = document.getElementById("btn-download-vm");
        if (btn) {
          btn.textContent = "Download VM (retry)";
          btn.disabled = false;
        }
      }
    });
  }
}

// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
