import { useEffect, useState, useCallback } from "react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Card, CardContent } from "../components/ui/card";
import { Cpu, RefreshCw, Download, CheckCircle2, XCircle, Terminal } from "lucide-react";
import { cn } from "../lib/utils";

/**
 * CliScanResult shape returned by the preload bridge (window.paperclip.getCliScan).
 * Mirrors the interface in apps/desktop/src/main/cli-scanner.ts.
 */
interface CliScanResult {
  label: string;
  command: string;
  adapterType: string;
  found: boolean;
  version?: string;
  installHint?: string;
}

/** CLIs that show an Install button (the rest are read-only). */
const INSTALLABLE_TYPES = new Set(["claude_local", "codex_local", "antigravity_local"]);

const SETUP_COMPLETE_KEY = "paperclip.agentCli.setupComplete";

export function InstanceAgentCli() {
  const { setBreadcrumbs } = useBreadcrumbs();

  const [results, setResults] = useState<CliScanResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [setupComplete, setSetupComplete] = useState(() => {
    try {
      return localStorage.getItem(SETUP_COMPLETE_KEY) === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance Settings" },
      { label: "Agent CLI" },
    ]);
  }, [setBreadcrumbs]);

  const fetchScan = useCallback(async () => {
    try {
      setError(null);
      const scan = window.paperclip?.getCliScan;
      if (!scan) {
        // Not running in Electron, show demo data
        setResults(getDemoResults());
        setLoading(false);
        return;
      }
      const data = await scan();
      setResults(data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to scan CLI tools.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchScan();
  }, [fetchScan]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchScan();
  }, [fetchScan]);

  const handleInstall = useCallback(async (adapterType: string) => {
    setInstallError(null);
    setInstalling(adapterType);
    try {
      const installCli = window.paperclip?.installCli;
      if (!installCli) {
        throw new Error("CLI installation is only available in the PaperClip desktop app.");
      }
      await installCli(adapterType);
      await fetchScan();
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : "Installation failed.");
    } finally {
      setInstalling(null);
    }
  }, [fetchScan]);

  const handleCompleteSetup = useCallback(() => {
    try {
      localStorage.setItem(SETUP_COMPLETE_KEY, "true");
      setSetupComplete(true);
    } catch {
      // localStorage unavailable
    }
  }, []);

  const installable = results.filter((r) => INSTALLABLE_TYPES.has(r.adapterType));
  const others = results.filter((r) => !INSTALLABLE_TYPES.has(r.adapterType));

  if (loading) {
    return (
      <div className="max-w-4xl space-y-6">
        <div className="text-sm text-muted-foreground">Scanning installed Agent CLIs...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-4xl space-y-6">
        <div className="text-sm text-destructive">{error}</div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Terminal className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold">Agent CLI</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Manage command-line agent tools available on this machine. Installed CLIs can be
            used as local adapters for running agent tasks directly from your terminal.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={refreshing}
          onClick={handleRefresh}
        >
          <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
          {refreshing ? "Scanning..." : "Refresh Scan"}
        </Button>
      </div>

      {installError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {installError}
        </div>
      )}

      {setupComplete && (
        <div className="rounded-md border border-green-500/40 bg-green-500/5 px-3 py-2 text-sm text-green-700 dark:text-green-400">
          Agent CLI setup is complete.
        </div>
      )}

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Installable CLIs</h2>
            <p className="text-sm text-muted-foreground">
              These agent CLIs can be installed with one click.
            </p>
          </div>

          {installable.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No installable CLIs found. Try refreshing the scan.
            </div>
          ) : (
            <div className="space-y-3">
              {installable.map((cli) => (
                <Card key={cli.adapterType}>
                  <CardContent className="flex items-center justify-between p-4">
                    <div className="flex items-center gap-3">
                      <Cpu className="h-5 w-5 text-muted-foreground shrink-0" />
                      <div>
                        <div className="text-sm font-medium">{cli.label}</div>
                        <div className="text-xs text-muted-foreground">
                          {cli.found && cli.version
                            ? `v${cli.version}`
                            : cli.installHint ?? "Not installed"}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      {cli.found ? (
                        <Badge variant="outline" className="gap-1">
                          <CheckCircle2 className="size-3 text-green-600" />
                          Installed
                        </Badge>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={installing === cli.adapterType}
                          onClick={() => handleInstall(cli.adapterType)}
                        >
                          <Download className="size-4" />
                          {installing === cli.adapterType ? "Installing..." : "Install"}
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Other detected CLIs</h2>
            <p className="text-sm text-muted-foreground">
              These CLIs are detected on your system and shown for reference.
            </p>
          </div>

          {others.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No other CLIs detected. Try refreshing the scan.
            </div>
          ) : (
            <div className="space-y-3">
              {others.map((cli) => (
                <Card key={cli.adapterType}>
                  <CardContent className="flex items-center justify-between p-4">
                    <div className="flex items-center gap-3">
                      <Cpu className="h-5 w-5 text-muted-foreground shrink-0" />
                      <div>
                        <div className="text-sm font-medium">{cli.label}</div>
                        <div className="text-xs text-muted-foreground">
                          {cli.found && cli.version
                            ? `v${cli.version}`
                            : cli.installHint ?? "Not detected"}
                        </div>
                      </div>
                    </div>
                    <Badge variant={cli.found ? "outline" : "secondary"}>
                      {cli.found ? (
                        <span className="flex items-center gap-1">
                          <CheckCircle2 className="size-3 text-green-600" />
                          Detected
                        </span>
                      ) : (
                        <span className="flex items-center gap-1">
                          <XCircle className="size-3 text-muted-foreground" />
                          Not found
                        </span>
                      )}
                    </Badge>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </section>

      {!setupComplete && (
        <section className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1.5">
              <h2 className="text-sm font-semibold">Complete Setup</h2>
              <p className="max-w-2xl text-sm text-muted-foreground">
                Mark the Agent CLI setup as complete. This helps you track onboarding progress.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCompleteSetup}
            >
              <CheckCircle2 className="size-4" />
              Complete Setup
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}

/** Demo data for when not running in Electron (no preload bridge). */
function getDemoResults(): CliScanResult[] {
  return [
    {
      adapterType: "claude_local",
      command: "claude",
      label: "Claude Code",
      found: true,
      version: "2.0.0",
    },
    {
      adapterType: "codex_local",
      command: "codex",
      label: "Codex CLI",
      found: false,
      installHint: "npm install -g @openai/codex",
    },
    {
      adapterType: "cursor",
      command: "cursor-agent",
      label: "Cursor Agent",
      found: true,
      version: "1.2.3",
    },
    {
      adapterType: "cursor_local",
      command: "cursor",
      label: "Cursor (Local)",
      found: false,
      installHint: "Install Cursor IDE",
    },
    {
      adapterType: "acpx_local",
      command: "acpx",
      label: "ACPX Runtime",
      found: false,
      installHint: "See ACPX documentation",
    },
    {
      adapterType: "grok_local",
      command: "grok",
      label: "Grok CLI",
      found: false,
      installHint: "npm install -g grok-cli",
    },
    {
      adapterType: "opencode_local",
      command: "opencode",
      label: "OpenCode",
      found: false,
      installHint: "curl -fsSL https://opencode.ai/install | bash",
    },
    {
      adapterType: "gemini_local",
      command: "gemini",
      label: "Gemini CLI",
      found: true,
      version: "0.9.1",
    },
    {
      adapterType: "pi_local",
      command: "pi",
      label: "Pi Agent",
      found: false,
      installHint: "npm install -g @anthropic/pi",
    },
    {
      adapterType: "antigravity_local",
      command: "antigravity",
      label: "Antigravity CLI",
      found: false,
      installHint: "npm install -g antigravity",
    },
    {
      adapterType: "openclaw_gateway",
      command: "openclaw",
      label: "OpenClaw Gateway",
      found: false,
      installHint: "npm install -g openclaw",
    },
  ];
}
