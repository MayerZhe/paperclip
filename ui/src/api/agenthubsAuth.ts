/**
 * agenthubsAuth.ts — JWT-based auth adapter for SuperNode Desktop
 *
 * Token: localStorage key "agenthubs_token"
 * Decode: client-side base64 (display only, no crypto verification)
 *
 * Compatible with three JWT payload formats:
 *   - agenthubs AuthContext: { userId, userEmail, userName }
 *   - Electron auth-bridge:  { sub, email, name }
 *   - cloud-api JWT sign:    { userId, userEmail, userName }
 */

const TOKEN_KEY = "agenthubs_token";

export interface User {
  id: string;
  name: string;
  email: string;
}

/** Decode JWT payload without verification. Handles 3 field-name variants. */
export function decodeJwtPayload(token: string): User | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]));
    return {
      id: payload.userId || payload.sub || "",
      name: payload.userName || payload.name || "Unknown",
      email: payload.userEmail || payload.email || "",
    };
  } catch {
    return null;
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getUser(): User | null {
  const token = getToken();
  return token ? decodeJwtPayload(token) : null;
}

export function isAuthenticated(): boolean {
  return getToken() !== null;
}

export function logout(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // localStorage may be unavailable
  }
  // Notify Electron main process (if in desktop context)
  if (typeof window !== "undefined" && (window as any).paperclip?.signOut) {
    (window as any).paperclip.signOut();
  }
}

export function getAuthHeaders(): HeadersInit {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
