// SuperNode Shell — sidebar UI logic
// Handles: tab switching, org info, status dots, sign out, VM download

(function () {
  var currentMode = "agent";

  // ─── DOM helpers ───
  var $ = function (s) { return document.querySelector(s); };

  // ─── Tab switching ───
  $("#tabs").addEventListener("click", function (e) {
    var btn = e.target.closest(".tab");
    if (!btn || btn.classList.contains("active")) return;
    var mode = btn.dataset.mode;
    currentMode = mode;
    $("#tabs").querySelectorAll(".tab").forEach(function (b) {
      b.classList.toggle("active", b === btn);
    });

    // Show/hide AgentHubs empty state
    var agenthubsEmpty = $("#agenthubs-empty");
    if (agenthubsEmpty) {
      agenthubsEmpty.style.display = mode === "agenthubs" ? "block" : "none";
    }

    // Send IPC to main process
    if (window.sidebar && window.sidebar.switchMode) {
      window.sidebar.switchMode(mode);
    }
  });

  // ─── IPC: org info ───
  if (window.sidebar && window.sidebar.onOrgInfo) {
    window.sidebar.onOrgInfo(function (info) {
      if (!info) return;
      if (info.name) {
        var el = $("#org-name");
        if (el) el.textContent = info.name;
      }
      if (info.role) {
        var el = $("#org-role");
        if (el) el.textContent = info.role;
      }
      if (info.balance) {
        var el = $("#org-balance");
        if (el) el.textContent = info.balance;
      }
      if (info.email) {
        var el = $("#user-email");
        if (el) el.textContent = info.email;
      }
    });
  }

  // ─── IPC: service status ───
  if (window.sidebar && window.sidebar.onStatus) {
    window.sidebar.onStatus(function (status) {
      if (!status) return;
      var mode = status.mode;
      var state = status.status; // "online" | "offline" | "loading"

      // Update service dot
      var row = $("#svc-" + mode);
      if (row) {
        var dot = row.querySelector(".dot");
        if (dot) dot.className = "dot " + state;
        var meta = row.querySelector(".svc-meta");
        if (meta) {
          if (state === "online") meta.textContent = "running";
          else if (state === "loading") meta.textContent = "starting...";
          else meta.textContent = state;
        }
      }

      // AgentHubs: show empty state when offline, hide when online
      if (mode === "agenthubs") {
        var agenthubsEmpty = $("#agenthubs-empty");
        if (agenthubsEmpty) {
          agenthubsEmpty.style.display = state === "online" ? "none" : "block";
        }
      }
    });
  }

  // Listen for mode-changed from main process (confirms mode switch)
  if (window.sidebar && window.sidebar.onModeChanged) {
    window.sidebar.onModeChanged(function (data) {
      if (data && data.mode) {
        currentMode = data.mode;
        $("#tabs").querySelectorAll(".tab").forEach(function (b) {
          b.classList.toggle("active", b.dataset.mode === data.mode);
        });
      }
    });
  }

  // ─── Sign out ───
  var btnSignout = $("#btn-signout");
  if (btnSignout) {
    btnSignout.addEventListener("click", function () {
      if (window.sidebar && window.sidebar.signOut) {
        window.sidebar.signOut();
      }
    });
  }

  // ─── VM Download ───
  var btnDownload = $("#btn-download-vm");
  if (btnDownload) {
    btnDownload.addEventListener("click", function () {
      if (window.sidebar && window.sidebar.downloadVm) {
        window.sidebar.downloadVm();
        btnDownload.disabled = true;
        btnDownload.textContent = "Downloading...";

        // Show progress area
        var progressArea = $("#vm-progress-area");
        if (progressArea) progressArea.classList.remove("hidden");
      }
    });
  }

  // Listen for VM download progress
  if (window.sidebar && window.sidebar.onVmDownloadProgress) {
    window.sidebar.onVmDownloadProgress(function (progress) {
      var progressFill = $("#vm-progress-fill");
      var progressStats = $("#vm-progress-stats");
      var btn = $("#btn-download-vm");

      if (progressFill) {
        progressFill.style.width = (progress.percent || 0) + "%";
      }

      if (progressStats) {
        var downloaded = (progress.downloadedMB || 0).toFixed(1);
        var total = (progress.totalMB || 0).toFixed(1);
        progressStats.textContent = (progress.percent || 0) + "% — " + downloaded + "MB / " + total + "MB";
      }

      if (progress.stage === "complete") {
        if (btn) { btn.textContent = "Download complete"; btn.disabled = true; }
        var progressArea = $("#vm-progress-area");
        if (progressArea) {
          setTimeout(function () { progressArea.classList.add("hidden"); }, 2000);
        }
        // Hide empty state since VM is now ready
        var empty = $("#agenthubs-empty");
        if (empty) empty.style.display = "none";
      } else if (progress.stage === "error") {
        if (btn) { btn.textContent = "Retry Download"; btn.disabled = false; }
        if (progressStats) progressStats.textContent = "Download failed";
      }
    });
  }

  // Check VM status on startup
  if (window.sidebar && window.sidebar.checkVmStatus) {
    window.sidebar.checkVmStatus().then(function (result) {
      if (result && result.downloaded) {
        // VM already downloaded — show AgentHubs as ready
        var empty = $("#agenthubs-empty");
        if (empty) empty.style.display = "none";
        if (btnDownload) {
          btnDownload.textContent = "VM ready";
          btnDownload.disabled = true;
        }
      } else {
        // VM not downloaded — show empty state when AgentHubs tab is active
        if (currentMode === "agenthubs") {
          var empty = $("#agenthubs-empty");
          if (empty) empty.style.display = "block";
        }
      }
    }).catch(function () {
      // IPC not available, ignore
    });
  }
})();
