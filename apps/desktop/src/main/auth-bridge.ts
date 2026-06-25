// apps/desktop/src/main/auth-bridge.ts
// S-A2: Login BrowserWindow + Token Extraction for AgentHubs auth
//
// Provides:
//   - createAuthBridge() — opens a login BrowserWindow, watches navigation,
//     extracts the JWT from localStorage, fetches orgs, and returns LoginResult.
//   - checkExistingSession() — checks for a persisted token in the "agenthubs"
//     partition, validates it, and returns LoginResult or null.
//
// Self-contained module — does not import from any other desktop module.

import { BrowserWindow, session } from "electron";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LoginResult {
  token: string;
  user: { id: string; email: string; name: string };
  orgs: Array<{ id: string; name: string; type: string; slug: string }>;
  selectedOrgId?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const LOGIN_URL = "http://localhost:3000/login";
const ORGS_API_URL = "http://localhost:4000/api/v1/orgs";
const PARTITION_NAME = "persist:agenthubs";
const TOKEN_KEY = "agenthubs_token";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const SESSION_CHECK_TIMEOUT_MS = 10 * 1000; // 10 seconds

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract token from a BrowserWindow by evaluating JavaScript in the
 * renderer to read localStorage.  Returns the token string or null.
 */
async function extractTokenFromWindow(win: BrowserWindow): Promise<string | null> {
  try {
    const token: unknown = await win.webContents.executeJavaScript(
      `localStorage.getItem(${JSON.stringify(TOKEN_KEY)})`,
    );
    if (typeof token === "string" && token.length > 0) {
      return token;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch org list from AgentHubs API using a Bearer token.
 * Returns the parsed JSON array or throws on failure.
 */
async function fetchOrgs(token: string): Promise<
  Array<{ id: string; name: string; type: string; slug: string }>
> {
  const response = await fetch(ORGS_API_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Org fetch failed with status ${response.status}`);
  }

  const body: unknown = await response.json();
  if (!Array.isArray(body)) {
    throw new Error("Unexpected org API response: not an array");
  }

  return body as Array<{ id: string; name: string; type: string; slug: string }>;
}

/**
 * Parse a JWT payload without verifying the signature.
 * Returns a user object { id, email, name } or throws on invalid token.
 * NEVER logs the raw token — only derived payload fields.
 */
function decodeTokenPayload(token: string): { id: string; email: string; name: string } {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid token format");
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("Failed to decode token payload");
  }

  const id = typeof payload.sub === "string" ? payload.sub : "";
  const email = typeof payload.email === "string" ? payload.email : "";
  const name = typeof payload.name === "string" ? payload.name : "";

  if (!id || !email) {
    throw new Error("Token payload missing required fields (sub, email)");
  }

  return { id, email, name };
}

/**
 * Determine whether a URL pathname represents a "post-login" page
 * where we should try to extract the token.
 */
function isPostLoginPath(pathname: string): boolean {
  return (
    pathname === "/select-org" ||
    pathname === "/dashboard" ||
    pathname.includes("/console/")
  );
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Open a BrowserWindow that loads the AgentHubs login page.
 * Watches navigation events to detect when the user has logged in,
 * extracts the JWT from localStorage, fetches orgs, and calls
 * `opts.onLoginComplete` with the result.
 *
 * On cancel (window close without login) or error, calls `opts.onLoginFailed`.
 *
 * The returned BrowserWindow is owned by the caller; the caller should
 * call `.destroy()` when done with it.
 */
export function createAuthBridge(opts: {
  onLoginComplete: (result: LoginResult) => void;
  onLoginFailed: (error: Error) => void;
}): BrowserWindow {
  const ses = session.fromPartition(PARTITION_NAME);

  const win = new BrowserWindow({
    width: 800,
    height: 700,
    title: "SuperNode - Login",
    show: false,
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  let settled = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  // ── Cleanup ────────────────────────────────────────────────────────────────

  const cleanup = () => {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    // Remove listeners to avoid leaks after settlement.
    win.webContents.removeAllListeners("did-navigate");
    win.webContents.removeAllListeners("will-navigate");
    win.removeAllListeners("close");
  };

  const fail = (message: string) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (!win.isDestroyed()) {
      win.close();
    }
    opts.onLoginFailed(new Error(message));
  };

  const succeed = (result: LoginResult) => {
    if (settled) return;
    settled = true;
    cleanup();
    opts.onLoginComplete(result);
  };

  // ── Timeout ────────────────────────────────────────────────────────────────

  timeoutHandle = setTimeout(() => {
    fail("Login timed out after 5 minutes");
  }, LOGIN_TIMEOUT_MS);

  // ── Window close → cancelled ───────────────────────────────────────────────

  win.on("close", () => {
    if (!settled) {
      fail("Login cancelled");
    }
  });

  // ── Navigation watchers ────────────────────────────────────────────────────

  /**
   * Core login flow: after a successful login the server redirects through
   * several pages.  We watch for post-login URLs and extract the token.
   */
  const onDidNavigate = async (
    _event: unknown,
    url: string,
    _httpResponseCode: number,
    _httpStatusText: string,
  ) => {
    if (settled) return;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return; // malformed URL — ignore
    }

    if (isPostLoginPath(parsed.pathname)) {
      // Wait a beat for the SPA to hydrate and write the token to localStorage.
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const token = await extractTokenFromWindow(win);
      if (!token) {
        console.log("[auth-bridge] Post-login page detected but no token found");
        return;
      }

      try {
        const user = decodeTokenPayload(token);
        const orgs = await fetchOrgs(token);

        // If we arrived at /select-org we haven't selected one yet.
        // If we arrived at /dashboard or /console/<id> the server may have
        // already set a selected org in localStorage — we leave that to the
        // caller to determine.
        let selectedOrgId: string | undefined;
        if (parsed.pathname === "/select-org") {
          selectedOrgId = undefined;
        } else if (parsed.pathname.includes("/console/")) {
          // e.g. /console/org_abc123 — extract the slug
          const segments = parsed.pathname.split("/").filter(Boolean);
          const slugCandidate = segments[segments.length - 1];
          const matched = orgs.find((o) => o.slug === slugCandidate || o.id === slugCandidate);
          selectedOrgId = matched?.id;
        }

        console.log(
          `[auth-bridge] Login complete for ${user.email} with ${orgs.length} org(s)` +
            (selectedOrgId ? `, selected ${selectedOrgId}` : ""),
        );

        succeed({ token, user, orgs, selectedOrgId });
      } catch (err: unknown) {
        // Token extraction or org fetch failed.
        console.error("[auth-bridge] Login flow error:", err);
        fail(
          err instanceof Error
            ? `Login failed: ${err.message}`
            : "Login failed: unable to complete authentication",
        );
      }
    }
  };

  /**
   * Intercept redirects to http://localhost:4000 — the AgentHubs auth
   * flow may redirect back to the local developer server.  We prevent
   * that and instead extract the token from the login window.
   *
   * We also handle the edge case where the URL already carries a token
   * (e.g. a callback with ?token=...) by extracting it and proceeding.
   */
  const onWillNavigate = async (
    event: { preventDefault: () => void },
    url: string,
  ) => {
    if (settled) return;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }

    // Intercept localhost redirects — these happen during the OAuth-like flow
    // when the server wants to redirect back to a local client.  Instead of
    // navigating away from our login window, extract the token and proceed.
    if (parsed.hostname === "localhost" && (parsed.port === "3000" || parsed.port === "4000")) {
      event.preventDefault();
      console.log("[auth-bridge] Intercepted localhost:${parsed.port} redirect, extracting token");

      // Try query param token first, then fall back to localStorage.
      let token = parsed.searchParams.get("token");
      if (!token) {
        token = await extractTokenFromWindow(win);
      }

      if (!token) {
        fail("Login failed: no token found after redirect");
        return;
      }

      try {
        const user = decodeTokenPayload(token);
        const orgs = await fetchOrgs(token);
        console.log(
          `[auth-bridge] Login complete for ${user.email} via redirect intercept`,
        );
        succeed({ token, user, orgs });
      } catch (err: unknown) {
        console.error("[auth-bridge] Redirect token flow error:", err);
        fail(
          err instanceof Error
            ? `Login failed: ${err.message}`
            : "Login failed: unable to complete authentication",
        );
      }
    }
  };

  win.webContents.on("did-navigate", onDidNavigate);
  win.webContents.on("will-navigate", onWillNavigate);

  // ── Show when ready ────────────────────────────────────────────────────────

  win.once("ready-to-show", () => {
    win.show();
  });

  // ── Load ───────────────────────────────────────────────────────────────────

  win.loadURL(LOGIN_URL).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    fail(`Failed to load login page: ${message}`);
  });

  return win;
}

/**
 * Check for an existing, valid AgentHubs session.
 *
 * Creates a minimal hidden BrowserWindow with the "persist:agenthubs" partition,
 * reads localStorage for the token, validates it against the API, and returns
 * LoginResult if valid.  Returns null if there is no token, the token is
 * invalid, or any error occurs.
 *
 * The temporary window is always destroyed before this function resolves.
 */
export async function checkExistingSession(): Promise<LoginResult | null> {
  // Agent Mode (local_trusted): skip cloud login — return a local session
  // that lets the user go straight to the SuperNode Agent UI.
  // No AgentHubs cloud API calls are made.
  if (process.env.PAPERCLIP_DEPLOYMENT_MODE === "local_trusted" ||
      process.env.DEPLOYMENT_MODE === "local_trusted") {
    const localUser = { id: "agent-local", email: "agent@local.paperclip", name: "Agent User" };
    const localOrgs = [{ id: "agent-org", name: "Local Agent", type: "personal" as const, slug: "local" }];
    console.log("[auth-bridge] Agent mode (local_trusted) — skipping cloud login");
    return {
      token: "agent-local-token",
      user: localUser,
      orgs: localOrgs,
      selectedOrgId: "agent-org",
    } satisfies LoginResult;
  }

  const ses = session.fromPartition(PARTITION_NAME);

  // A minimal hidden window is the only way to access localStorage for a
  // specific session partition in Electron.
  const win = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  let settled = false;

  const cleanup = () => {
    if (!win.isDestroyed()) {
      win.destroy();
    }
  };

  try {
    // Load a minimal page to get access to localStorage in this session.
    await Promise.race([
      win.loadURL("about:blank"),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("Session check timed out")), SESSION_CHECK_TIMEOUT_MS),
      ),
    ]);

    const token = await extractTokenFromWindow(win);

    if (!token) {
      settled = true;
      cleanup();
      return null;
    }

    // Validate the token by calling the orgs API.
    let orgs: Array<{ id: string; name: string; type: string; slug: string }>;
    try {
      orgs = await Promise.race([
        fetchOrgs(token),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Org API validation timed out")),
            SESSION_CHECK_TIMEOUT_MS,
          ),
        ),
      ]);
    } catch {
      // Token exists but is invalid / expired / network down.
      // Treat as no session.
      settled = true;
      cleanup();
      return null;
    }

    const user = decodeTokenPayload(token);

    settled = true;
    cleanup();

    console.log(`[auth-bridge] Existing session found for ${user.email}`);
    return { token, user, orgs };
  } catch (err: unknown) {
    if (!settled) {
      settled = true;
      cleanup();
    }
    console.error("[auth-bridge] Session check error:", err);
    return null;
  } finally {
    if (!settled) {
      cleanup();
    }
  }
}
