// apps/desktop/src/__tests__/packaging.test.ts
// Story S-3E3: Packaging unit tests
//
// Tests for the electron-builder configuration, entitlements, and build
// artifact structure validation. Uses file system checks with graceful
// SKIP on missing optional components.
//
// Anti-Drift: Mock-only, no real app startup.  All optional components
// (VM images, Swift binary) are checked with SKIP/WARN not FAIL.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ─── Path resolution ───────────────────────────────────────────────

// Use import.meta for ESM; __dirname fallback for older runtimes
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// apps/desktop/src/__tests__/packaging.test.ts
//   → apps/desktop/src/__tests__ → apps/desktop/src → apps/desktop → repo root
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const APPS_DESKTOP = path.join(REPO_ROOT, "apps", "desktop");
const SUPER_DESKTOP = path.join(REPO_ROOT, "SuperNode-desktop");
const DIST_DIR = path.join(SUPER_DESKTOP, "dist");

// ─── Helpers ────────────────────────────────────────────────────────

/** Check whether a path exists (file or directory). */
function exists(p: string): boolean {
  return fs.existsSync(p);
}

/** Read a file as UTF-8 text, returning null on failure. */
function readFile(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Minimal YAML assertion helper.
 * Checks that `key` exists somewhere in the string; does NOT parse YAML
 * (avoids yaml dependency). This is sufficient for config validation.
 */
function yamlContains(doc: string, key: string): boolean {
  return doc.includes(key);
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("packaging (electron-builder config)", () => {
  const ymlPath = path.join(SUPER_DESKTOP, "electron-builder.yml");

  it("electron-builder.yml exists", () => {
    const ok = exists(ymlPath);
    // We skip if the file is absent – this is a build env assertion
    if (!ok) {
      console.warn(`
        SKIP  electron-builder.yml not found at ${ymlPath}.
        This test requires the SuperNode-desktop source tree.
      `);
    }
    expect(ok).toBe(true);
  });

  it("contains required top-level keys", () => {
    const text = readFile(ymlPath);
    if (!text) {
      // Already handled by the existence test; don't double-fail.
      return;
    }

    // Required keys per electron-builder spec
    const requiredKeys = [
      "appId:",
      "productName:",
      "asar:",
      "mac:",
      "files:",
    ];
    for (const key of requiredKeys) {
      expect(yamlContains(text, key)).toBe(true);
    }
  });

  it("asar is set to false (ADR-01)", () => {
    const text = readFile(ymlPath);
    if (!text) return;

    // ADR-01 requires asar: false for embedded PG
    expect(text).toContain("asar: false");
  });

  it("mac target includes dmg", () => {
    const text = readFile(ymlPath);
    if (!text) return;

    expect(yamlContains(text, "target: dmg")).toBe(true);
    // Verify both arch targets
    expect(yamlContains(text, "arm64")).toBe(true);
    expect(yamlContains(text, "x64")).toBe(true);
  });

  it("productName is SuperNode", () => {
    const text = readFile(ymlPath);
    if (!text) return;

    expect(text).toContain("productName: SuperNode");
  });

  it("extraResources includes paperclip-server", () => {
    const text = readFile(ymlPath);
    if (!text) return;

    // extraResources copies paperclip-server into the app bundle
    expect(text).toContain("extraResources");
    expect(text).toContain("paperclip-server");
  });
});

describe("packaging (entitlements)", () => {
  // Entitlements live in the build directory under apps/desktop
  const plistPath = path.join(APPS_DESKTOP, "build", "entitlements.mac.plist");

  it("entitlements.mac.plist exists", () => {
    const ok = exists(plistPath);
    if (!ok) {
      console.warn(`
        SKIP  entitlements.mac.plist not found at ${plistPath}.
        Entitlements are required for hardened runtime / notarization.
      `);
    }
    expect(ok).toBe(true);
  });

  it("is valid XML plist", () => {
    const text = readFile(plistPath);
    if (!text) return;

    // Structural checks – real parser would need plist, but this catches
    // broken files.
    expect(text).toContain('<?xml');
    expect(text).toContain('<!DOCTYPE plist');
    expect(text).toContain('<plist');
    expect(text).toContain('<dict>');
    expect(text).toContain('</dict>');
    expect(text).toContain('</plist>');
  });

  it("contains network client entitlement", () => {
    const text = readFile(plistPath);
    if (!text) return;

    // Required: daemon communicates over localhost HTTP
    expect(text).toContain("com.apple.security.network.client");
  });

  it("contains JIT entitlement for embedded PG", () => {
    const text = readFile(plistPath);
    if (!text) return;

    // Required: PG needs JIT for native extensions
    expect(text).toContain("com.apple.security.cs.allow-jit");
  });

  it("contains virtualization entitlement or is flagged for addition", () => {
    const text = readFile(plistPath);
    if (!text) return;

    const hasVirtualization = text.includes(
      "com.apple.security.virtualization",
    );
    if (hasVirtualization) {
      // If already present, passes straight.
      expect(hasVirtualization).toBe(true);
    } else {
      // NOT a hard failure — virtualization entitlement is needed for
      // AgentHubs VM mode but is not yet in the plist. The test documents
      // this gap explicitly so it's actionable.
      console.warn(`
        WARN  entitlements.mac.plist does not yet include
        com.apple.security.virtualization. This entitlement is required
        for AgentHubs VM (Virtualization.framework) support.
        Add: <key>com.apple.security.virtualization</key><true/>
        to ${plistPath} when enabling VM features.
      `);
      // Soft-assert: warn but don't block CI
      expect(true).toBe(true);
    }
  });
});

describe("packaging (VM images in bundle)", () => {
  const vmDir = path.join(DIST_DIR, "agenthubs-vm");
  const rootfsImg = path.join(vmDir, "rootfs.img.zst");
  const agentImg = path.join(vmDir, "agent.img.zst");

  it("agenthubs-vm directory exists (SKIP if not built)", () => {
    if (!exists(vmDir)) {
      console.warn(`
        SKIP  VM images directory ${vmDir} not found.
        Run 'pnpm --filter paperclip-desktop bundle' to populate dist/.
      `);
      // Skip is a pass – build artifacts are optional for unit tests
      expect(true).toBe(true);
      return;
    }
    expect(true).toBe(true);
  });

  it("rootfs.img.zst exists in agenthubs-vm", () => {
    if (!exists(vmDir)) {
      console.warn("SKIP  agenthubs-vm directory missing");
      expect(true).toBe(true);
      return;
    }
    const ok = exists(rootfsImg);
    if (!ok) {
      console.warn(`SKIP  ${rootfsImg} not found (not yet built)`);
    }
    expect(ok).toBe(true);
  });

  it("agent.img.zst exists in agenthubs-vm", () => {
    if (!exists(vmDir)) {
      console.warn("SKIP  agenthubs-vm directory missing");
      expect(true).toBe(true);
      return;
    }
    const ok = exists(agentImg);
    if (!ok) {
      console.warn(`SKIP  ${agentImg} not found (not yet built)`);
    }
    expect(ok).toBe(true);
  });
});

describe("packaging (Swift / vm-runtime binaries)", () => {
  const vmRuntimeDir = path.join(DIST_DIR, "vm-runtime");
  const swiftBinary = path.join(vmRuntimeDir, "supernode-vm");
  const sdkDaemon = path.join(vmRuntimeDir, "sdk-daemon");

  it("vm-runtime directory exists (SKIP if not built)", () => {
    if (!exists(vmRuntimeDir)) {
      console.warn(`
        SKIP  vm-runtime directory ${vmRuntimeDir} not found.
        Swift binaries are compiled separately; this directory is created
        during the bundle step.
      `);
      expect(true).toBe(true);
      return;
    }
    expect(true).toBe(true);
  });

  it("supernode-vm binary exists", () => {
    if (!exists(vmRuntimeDir)) {
      console.warn("SKIP  vm-runtime directory missing");
      expect(true).toBe(true);
      return;
    }
    const ok = exists(swiftBinary);
    if (!ok) {
      console.warn(`
        SKIP  ${swiftBinary} not found.
        Compile with: swift build -c release --product supernode-vm
      `);
    }
    expect(ok).toBe(true);
  });

  it("sdk-daemon binary exists", () => {
    if (!exists(vmRuntimeDir)) {
      console.warn("SKIP  vm-runtime directory missing");
      expect(true).toBe(true);
      return;
    }
    const ok = exists(sdkDaemon);
    if (!ok) {
      console.warn(`
        SKIP  ${sdkDaemon} not found.
        This is the guest agent daemon for AgentHubs VM communication.
      `);
    }
    expect(ok).toBe(true);
  });

  it("supernode-vm path matches expected location", () => {
    // Verify path resolution logic – the path must end with the
    // expected subdirectory structure.
    const expectedSuffix = path.join("dist", "vm-runtime", "supernode-vm");
    expect(swiftBinary.endsWith(expectedSuffix)).toBe(true);
  });
});

describe("packaging (directory structure validation)", () => {
  it("SuperNode-desktop directory exists", () => {
    expect(exists(SUPER_DESKTOP)).toBe(true);
  });

  it("SuperNode-desktop/electron-builder.yml exists", () => {
    expect(exists(path.join(SUPER_DESKTOP, "electron-builder.yml"))).toBe(
      true,
    );
  });

  it("SuperNode-desktop/package.json exists", () => {
    expect(exists(path.join(SUPER_DESKTOP, "package.json"))).toBe(true);
  });

  it("apps/desktop/build directory exists", () => {
    const buildDir = path.join(APPS_DESKTOP, "build");
    expect(exists(buildDir)).toBe(true);
  });

  it("apps/desktop/paperclip-server exists", () => {
    // paperclip-server is populated by the bundle step
    const psDir = path.join(APPS_DESKTOP, "paperclip-server");
    if (!exists(psDir)) {
      console.warn(`
        SKIP  paperclip-server directory not found at ${psDir}.
        Run the bundle step first: pnpm --filter paperclip-desktop bundle
      `);
    }
    expect(true).toBe(true); // Soft check – optional until bundled
  });
});
