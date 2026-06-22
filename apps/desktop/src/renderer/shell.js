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
}

// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
