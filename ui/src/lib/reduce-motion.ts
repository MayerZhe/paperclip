import { useSyncExternalStore } from "react";

/**
 * usePrefersReducedMotion — React hook that reads the system
 * prefers-reduced-motion media query and returns true when the
 * user has requested reduced motion (macOS: System Settings →
 * Accessibility → Display → Reduce motion).
 *
 * Uses useSyncExternalStore for zero-render subscription.
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function getSnapshot(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function getServerSnapshot(): boolean {
  return false;
}

function subscribe(callback: () => void): () => void {
  const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}
