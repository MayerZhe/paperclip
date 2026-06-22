// apps/desktop/src/main/cli-scanner.ts
// v2 修订：补全 acpx、grok、openclaw、cursor-local 适配器
// v3: 无变化（已通过审计）

import { execSync } from "node:child_process";

export interface CliScanResult {
  label: string;
  command: string;
  adapterType: string;
  found: boolean;
  version?: string;
  installHint?: string;
}

// 白名单 — 已与 packages/adapters/ 目录逐项对齐
// 10 个适配器：claude, codex, cursor, acpx, grok, opencode, gemini, pi, openclaw, cursor-local
const CLI_WHITELIST: Array<{
  adapterType: string;
  command: string;
  label: string;
  versionFlag: string;
  installHint: string;
}> = [
  {
    adapterType: "claude_local",
    command: "claude",
    label: "Claude Code",
    versionFlag: "--version",
    installHint: "npm install -g @anthropic-ai/claude-code",
  },
  {
    adapterType: "codex_local",
    command: "codex",
    label: "Codex CLI",
    versionFlag: "--version",
    installHint: "npm install -g @openai/codex",
  },
  {
    adapterType: "cursor",
    command: "cursor-agent",
    label: "Cursor Agent",
    versionFlag: "--version",
    installHint: "Install Cursor IDE",
  },
  {
    adapterType: "cursor_local",
    command: "cursor",
    label: "Cursor (Local)",
    versionFlag: "--version",
    installHint: "Install Cursor IDE",
  },
  {
    adapterType: "acpx_local",
    command: "acpx",
    label: "ACPX Runtime",
    versionFlag: "--version",
    installHint: "See ACPX documentation",
  },
  {
    adapterType: "grok_local",
    command: "grok",
    label: "Grok CLI",
    versionFlag: "--version",
    installHint: "npm install -g grok-cli",
  },
  {
    adapterType: "opencode_local",
    command: "opencode",
    label: "OpenCode",
    versionFlag: "--version",
    installHint: "curl -fsSL https://opencode.ai/install | bash",
  },
  {
    adapterType: "gemini_local",
    command: "gemini",
    label: "Gemini CLI",
    versionFlag: "--version",
    installHint: "npm install -g @google/gemini-cli",
  },
  {
    adapterType: "pi_local",
    command: "pi",
    label: "Pi Agent",
    versionFlag: "--version",
    installHint: "npm install -g @anthropic/pi",
  },
  {
    adapterType: "antigravity_local",
    command: "antigravity",
    label: "Antigravity CLI",
    versionFlag: "--version",
    installHint: "npm install -g antigravity",
  },
  {
    adapterType: "openclaw_gateway",
    command: "openclaw",
    label: "OpenClaw Gateway",
    versionFlag: "--version",
    installHint: "npm install -g openclaw",
  },
];

function which(command: string): string | null {
  try {
    const result = execSync(`command -v "${command}" 2>/dev/null || echo ""`, {
      encoding: "utf-8",
    }).trim();
    return result || null;
  } catch {
    return null;
  }
}

function getVersion(command: string, versionFlag: string): string | undefined {
  try {
    return execSync(`${command} ${versionFlag} 2>&1`, {
      encoding: "utf-8",
      timeout: 5000,
    }).trim().split("\n")[0].slice(0, 80);
  } catch {
    return undefined;
  }
}

export async function scanCliAvailability(): Promise<CliScanResult[]> {
  console.log("[PaperClip Desktop] Scanning for installed AI Agent CLIs...");

  return CLI_WHITELIST.map((entry) => {
    const binPath = which(entry.command);
    const version = binPath ? getVersion(entry.command, entry.versionFlag) : undefined;

    console.log(
      `[Scanner] ${entry.label}: ${binPath ? `✅ ${version ?? ""}` : "❌"}`,
    );

    return {
      label: entry.label,
      command: entry.command,
      adapterType: entry.adapterType,
      found: binPath !== null,
      version,
      installHint: binPath ? undefined : entry.installHint,
    };
  });
}
