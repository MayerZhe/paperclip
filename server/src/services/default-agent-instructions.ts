import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_AGENT_BUNDLE_FILES = {
  default: ["AGENTS.md"],
  ceo: ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
} as const;

type DefaultAgentBundleRole = keyof typeof DEFAULT_AGENT_BUNDLE_FILES;

const serviceDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Read an onboarding asset file, trying multiple candidate base directories.
 * In monorepo dev: server/src/services/ → ../onboarding-assets/ = server/src/onboarding-assets/
 * In esbuild bundle: bundledServer/dist/ → ../../onboarding-assets/ = bundledServer/onboarding-assets/
 */
async function readOnboardingAsset(
  role: DefaultAgentBundleRole,
  fileName: string,
): Promise<string> {
  const candidates = [
    // 1. Monorepo dev: ../onboarding-assets from services/
    path.resolve(serviceDir, "..", "onboarding-assets", role, fileName),
    // 2. Bundle: ../../onboarding-assets from services/ within bundledServer
    path.resolve(serviceDir, "..", "..", "onboarding-assets", role, fileName),
    // 3. import.meta.url-based (original behavior)
    new URL(`../onboarding-assets/${role}/${fileName}`, import.meta.url),
  ];

  for (const candidate of candidates) {
    try {
      if (typeof candidate === "string") {
        return await fs.readFile(candidate, "utf8");
      } else {
        return await fs.readFile(candidate, "utf8");
      }
    } catch {
      // Try next candidate
    }
  }
  throw new Error(
    `Onboarding asset not found: ${role}/${fileName}. Checked: ${candidates.map((c) => (typeof c === "string" ? c : c.href)).join(", ")}`,
  );
}

export async function loadDefaultAgentInstructionsBundle(role: DefaultAgentBundleRole): Promise<Record<string, string>> {
  const fileNames = DEFAULT_AGENT_BUNDLE_FILES[role];
  const entries = await Promise.all(
    fileNames.map(async (fileName) => {
      const content = await readOnboardingAsset(role, fileName);
      return [fileName, content] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export function resolveDefaultAgentInstructionsBundleRole(role: string): DefaultAgentBundleRole {
  return role === "ceo" ? "ceo" : "default";
}
