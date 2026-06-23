// State: current active tab mode
var currentMode = "agenthubs";

// Welcome screen state
var welcomeState = {
  vmDownloaded: false,
  vmDownloading: false,
  vmReady: false,
  vmError: false,
};

// Download speed tracking
var downloadSpeedData = {
  lastBytes: 0,
  lastTimestamp: 0,
  currentSpeed: 0,
};

// Initialize — set up event listeners and IPC handlers
function init() {
  // Check VM status on startup
  checkVmStatus();

  // Welcome screen buttons
  initWelcomeScreen();

  // Tab navigation buttons
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

  // Download VM button (in sidebar status panel)
  initDownloadButton();

  // Listen for VM download progress from main process
  if (window.sidebar && window.sidebar.onVmDownloadProgress) {
    window.sidebar.onVmDownloadProgress(function (progress) {
      handleVmProgress(progress);
    });
  }
}

// ─── Welcome Screen ───

function checkVmStatus() {
  if (window.sidebar && window.sidebar.checkVmStatus) {
    window.sidebar.checkVmStatus().then(function (result) {
      if (result && result.downloaded) {
        welcomeState.vmDownloaded = true;
        welcomeState.vmReady = true;
        updateAgentHubsCardButton();
      }
    }).catch(function () {
      // IPC not available or error — keep default state
    });
  }
}

function initWelcomeScreen() {
  var btnStartAgent = document.getElementById("btn-start-agent");
  var btnStartAgenthubs = document.getElementById("btn-start-agenthubs");
  var btnDownloadAgenthubs = document.getElementById("btn-download-agenthubs");
  var btnVmRetry = document.getElementById("btn-vm-retry");
  var btnVmSkip = document.getElementById("btn-vm-skip");

  // Agent Mode: "Start Now" → switch to agent mode and hide welcome
  if (btnStartAgent) {
    btnStartAgent.addEventListener("click", function () {
      enterMode("agent");
    });
  }

  // AgentHubs Mode: "Enter AgentHubs" → switch to agenthubs mode and hide welcome
  if (btnStartAgenthubs) {
    btnStartAgenthubs.addEventListener("click", function () {
      enterMode("agenthubs");
    });
  }

  // AgentHubs Mode: "Download VM (20MB)" → trigger download
  if (btnDownloadAgenthubs) {
    btnDownloadAgenthubs.addEventListener("click", function () {
      startVmDownload();
    });
  }

  // Retry button in progress area
  if (btnVmRetry) {
    btnVmRetry.addEventListener("click", function () {
      retryVmDownload();
    });
  }

  // Skip button in progress area
  if (btnVmSkip) {
    btnVmSkip.addEventListener("click", function () {
      skipVmDownload();
    });
  }
}

function updateAgentHubsCardButton() {
  var btnEnter = document.getElementById("btn-start-agenthubs");
  var btnDownload = document.getElementById("btn-download-agenthubs");

  if (!btnEnter || !btnDownload) return;

  if (welcomeState.vmDownloaded || welcomeState.vmReady) {
    btnEnter.style.display = "block";
    btnDownload.style.display = "none";
  } else {
    btnEnter.style.display = "none";
    btnDownload.style.display = "block";
  }
}

function enterMode(mode) {
  // Hide welcome screen, show sidebar
  var welcomeScreen = document.getElementById("welcome-screen");
  var sidebar = document.getElementById("sidebar");

  if (welcomeScreen) {
    welcomeScreen.style.display = "none";
  }
  if (sidebar) {
    sidebar.style.display = "flex";
  }

  // Switch to the requested mode
  if (mode === "agent" || mode === "agenthubs") {
    setActiveTab(mode);
    if (window.sidebar && window.sidebar.switchMode) {
      window.sidebar.switchMode(mode);
    }
  }
}

// ─── VM Download ───

function startVmDownload() {
  if (!window.sidebar || !window.sidebar.downloadVm) return;

  welcomeState.vmDownloading = true;
  welcomeState.vmError = false;

  // Show progress area, hide buttons
  var progressArea = document.getElementById("vm-progress-area");
  var btnEnter = document.getElementById("btn-start-agenthubs");
  var btnDownload = document.getElementById("btn-download-agenthubs");

  if (progressArea) progressArea.classList.remove("hidden");
  if (btnEnter) btnEnter.style.display = "none";
  if (btnDownload) btnDownload.style.display = "none";

  // Reset progress UI
  var progressFill = document.getElementById("vm-progress-fill");
  var progressStats = document.getElementById("vm-progress-stats");
  if (progressFill) progressFill.style.width = "0%";
  if (progressStats) progressStats.textContent = "0% — 0 MB/s — --:--";

  // Reset speed tracking
  downloadSpeedData.lastBytes = 0;
  downloadSpeedData.lastTimestamp = Date.now();
  downloadSpeedData.currentSpeed = 0;

  // Trigger download via IPC
  window.sidebar.downloadVm();
}

function retryVmDownload() {
  welcomeState.vmError = false;
  welcomeState.vmDownloading = false;
  startVmDownload();
}

function skipVmDownload() {
  // Hide progress, go straight to AgentHubs mode
  welcomeState.vmDownloading = false;
  welcomeState.vmError = false;
  enterMode("agenthubs");
}

function cancelVmDownload() {
  if (window.sidebar && window.sidebar.cancelVmDownload) {
    window.sidebar.cancelVmDownload();
  }
  welcomeState.vmDownloading = false;
  welcomeState.vmError = false;

  // Reset UI
  var progressArea = document.getElementById("vm-progress-area");
  if (progressArea) progressArea.classList.add("hidden");
  updateAgentHubsCardButton();
}

function handleVmProgress(progress) {
  // Update progress bar in welcome screen (if visible)
  var progressFill = document.getElementById("vm-progress-fill");
  var progressStats = document.getElementById("vm-progress-stats");

  // Calculate download speed
  var now = Date.now();
  var downloadedMB = progress.downloadedMB || 0;
  var totalMB = progress.totalMB || 0;

  if (downloadSpeedData.lastTimestamp > 0 && now > downloadSpeedData.lastTimestamp) {
    var timeDelta = (now - downloadSpeedData.lastTimestamp) / 1000; // seconds
    var bytesDelta = downloadedMB - downloadSpeedData.lastBytes;
    if (timeDelta > 0.5 && bytesDelta > 0) {
      downloadSpeedData.currentSpeed = bytesDelta / timeDelta; // MB/s
    }
    downloadSpeedData.lastBytes = downloadedMB;
    downloadSpeedData.lastTimestamp = now;
  } else if (downloadSpeedData.lastTimestamp === 0) {
    downloadSpeedData.lastBytes = downloadedMB;
    downloadSpeedData.lastTimestamp = now;
  }

  // Calculate ETA
  var speedMBps = downloadSpeedData.currentSpeed;
  var remainingMB = totalMB - downloadedMB;
  var etaText = "--:--";
  if (speedMBps > 0 && remainingMB > 0) {
    var etaSeconds = Math.round(remainingMB / speedMBps);
    var etaMins = Math.floor(etaSeconds / 60);
    var etaSecs = etaSeconds % 60;
    etaText = etaMins + ":" + (etaSecs < 10 ? "0" : "") + etaSecs;
  }

  // Update progress bar
  if (progressFill) {
    progressFill.style.width = progress.percent + "%";
  }

  // Update stats text
  if (progressStats) {
    var speedText = speedMBps > 0 ? speedMBps.toFixed(1) + " MB/s" : "0 MB/s";
    progressStats.textContent = progress.percent + "% — " + speedText + " — " + etaText;
  }

  // Handle terminal stages
  if (progress.stage === "complete") {
    welcomeState.vmDownloading = false;
    welcomeState.vmDownloaded = true;
    welcomeState.vmReady = true;
    welcomeState.vmError = false;

    var progressArea = document.getElementById("vm-progress-area");
    if (progressArea) progressArea.classList.add("hidden");
    updateAgentHubsCardButton();
  } else if (progress.stage === "error") {
    welcomeState.vmDownloading = false;
    welcomeState.vmError = true;

    if (progressStats) {
      progressStats.textContent = "Download failed — try again or skip";
      progressStats.style.color = "#F85149";
    }

    // Reset stats color for next attempt
    setTimeout(function () {
      if (progressStats) progressStats.style.color = "#8B949E";
    }, 5000);
  }

  // Also update the sidebar download progress (existing UI)
  var sidebarProgressEl = document.getElementById("vm-download-progress");
  if (sidebarProgressEl) {
    sidebarProgressEl.textContent = "Downloading... " + progress.percent + "% (" +
      progress.downloadedMB + "MB / " + progress.totalMB + "MB)";
  }

  // Update sidebar download button state
  var sidebarBtn = document.getElementById("btn-download-vm");
  if (progress.stage === "downloading" || progress.stage === "fetching_manifest" || progress.stage === "verifying" || progress.stage === "decompressing") {
    if (sidebarBtn) {
      sidebarBtn.disabled = true;
      sidebarBtn.textContent = "Downloading...";
    }
  } else if (progress.stage === "complete") {
    if (sidebarBtn) {
      sidebarBtn.textContent = "Download complete - restart to activate";
      sidebarBtn.disabled = true;
    }
  } else if (progress.stage === "error") {
    if (sidebarBtn) {
      sidebarBtn.textContent = "Download VM (retry)";
      sidebarBtn.disabled = false;
    }
  }
}

// ─── Sidebar UI ───

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
}

// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
