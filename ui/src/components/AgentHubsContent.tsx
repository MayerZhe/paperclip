import { useEffect, useState, useCallback } from "react";
import { useMode } from "../context/ModeContext";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw, Download } from "lucide-react";

interface HealthStatus {
  cloudApi: boolean;
  paperclip: boolean;
  minio: boolean;
}

type ContentState = "loading" | "loaded" | "error" | "vm_not_ready";

/**
 * AgentHubs tab content area.
 *
 * State machine:
 *   loading → loaded (cloud-api :4000 reachable)
 *   loading → vm_not_ready (VM bundle not downloaded)
 *   loading → error (cloud-api unreachable)
 *   loaded  → error (runtime disconnect)
 */
export function AgentHubsContent() {
  const { mode } = useMode();
  const [state, setState] = useState<ContentState>("loading");
  const [health, setHealth] = useState<HealthStatus | null>(null);

  // Detect Electron environment (for <webview> vs <iframe> fallback)
  const isElectron =
    typeof window !== "undefined" && !!(window as any).paperclip?.platform;

  const degradedServices = health
    ? Object.entries(health)
        .filter(([, ok]) => !ok)
        .map(([name]) => name)
    : [];

  // ── Initial load ──
  const tryConnect = useCallback(async () => {
    setState("loading");

    // 1. Check if VM bundle is ready (Electron only)
    if (isElectron) {
      const vmReady = await (window as any).paperclip?.isVmReady?.();
      if (!vmReady) {
        setState("vm_not_ready");
        return;
      }
    }

    // 2. Poll health
    const h = await (window as any).paperclip?.getAgentHubsHealth?.();
    if (h) {
      setHealth(h);
      setState(h.cloudApi ? "loaded" : "error");
    } else {
      setState("error");
    }
  }, [isElectron]);

  useEffect(() => {
    if (mode === "agenthubs") {
      tryConnect();
    }
  }, [mode, tryConnect]);

  // ── Periodic health polling ──
  useEffect(() => {
    if (mode !== "agenthubs" || state !== "loaded") return;
    const interval = setInterval(async () => {
      const h = await (window as any).paperclip?.getAgentHubsHealth?.();
      if (h) {
        setHealth(h);
        if (!h.cloudApi) setState("error");
      }
    }, 30000);
    return () => clearInterval(interval);
  }, [mode, state]);

  // ── VM not ready ──
  if (state === "vm_not_ready") {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-8">
        <Download className="size-12 text-muted-foreground" />
        <h2 className="text-lg font-semibold">AgentHubs VM Not Installed</h2>
        <p className="text-sm text-muted-foreground text-center max-w-md">
          The AgentHubs virtual machine bundle is required for local AgentHubs
          mode. Download it to enable full AgentHubs functionality.
        </p>
        <Button
          onClick={() => {
            if (isElectron) {
              // Trigger VM download via IPC
              (window as any).paperclip?.onVmDownloadProgress?.(() => {});
            }
          }}
        >
          Download VM Bundle
        </Button>
      </div>
    );
  }

  // ── cloud-api unreachable ──
  if (state === "error") {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-8">
        <AlertTriangle className="size-12 text-destructive" />
        <h2 className="text-lg font-semibold">AgentHubs Unavailable</h2>
        <p className="text-sm text-muted-foreground text-center max-w-md">
          cloud-api is not responding. The AgentHubs console cannot be
          displayed. Agent mode is still available.
        </p>
        <Button variant="outline" onClick={tryConnect}>
          <RefreshCw className="size-4 mr-2" />
          Retry
        </Button>
      </div>
    );
  }

  // ── Normal display ──
  return (
    <div className="flex-1 relative">
      {/* Degraded banner */}
      {degradedServices.length > 0 && (
        <div className="absolute top-0 left-0 right-0 z-10 bg-yellow-500/10 border-b border-yellow-500/20 px-4 py-1.5 text-xs text-yellow-600">
          ⚠️ Degraded: {degradedServices.join(", ")} unavailable. Some features
          may not work.
        </div>
      )}

      {/* webview / iframe */}
      <div className="w-full h-full">
        {isElectron ? (
          <webview
            src="http://127.0.0.1:4000"
            style={{ width: "100%", height: "100%" }}
            onDidFinishLoad={() => setState("loaded")}
            onDidFailLoad={() => setState("error")}
          />
        ) : (
          <iframe
            src="http://127.0.0.1:4000"
            style={{ width: "100%", height: "100%", border: "none" }}
            title="AgentHubs Console"
            onLoad={() => setState("loaded")}
            onError={() => setState("error")}
          />
        )}
      </div>

      {/* Loading overlay */}
      {state === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80">
          <div className="flex items-center gap-3">
            <RefreshCw className="size-5 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              Connecting to AgentHubs...
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
