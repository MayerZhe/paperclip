import { vi } from "vitest";
import { flushSync } from "react-dom";

const storageEntries = new Map<string, string>();

function installStorageMock(target: Record<string, unknown>) {
  Object.defineProperty(target, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storageEntries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storageEntries.set(key, String(value));
      },
      removeItem: (key: string) => {
        storageEntries.delete(key);
      },
      clear: () => {
        storageEntries.clear();
      },
    },
  });
}

if (
  typeof globalThis.localStorage?.getItem !== "function"
  || typeof globalThis.localStorage?.setItem !== "function"
  || typeof globalThis.localStorage?.removeItem !== "function"
  || typeof globalThis.localStorage?.clear !== "function"
) {
  installStorageMock(globalThis);
}

if (typeof window !== "undefined" && window.localStorage !== globalThis.localStorage) {
  installStorageMock(window as unknown as Record<string, unknown>);
}

// jsdom does not provide window.matchMedia, which is used by ThemeContext,
// SidebarContext, AsciiArtAnimation, reduce-motion, and other components.
// Default to desktop viewport: min-width queries match, max-width don't.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: /min-width/.test(query),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// NOTE: All vi.mock calls MUST be at module top-level (not wrapped in
// try/catch) — Vitest hoists them and wrapping breaks the hoisting,
// producing warnings and unreliable mock application.

// Global safe default for useNodeOrg — prevents "must be used within
// NodeOrgProvider" errors when tests render components that call
// useNodeOrg() without wrapping in NodeOrgProvider. Individual test
// files can override this with their own vi.mock for specific values.
vi.mock("@/context/NodeOrgContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/context/NodeOrgContext")>();
  return {
    ...actual,
    NodeOrgProvider: ({ children }: { children: unknown }) => children,
    useNodeOrg: () => ({
      companies: [],
      selectedCompanyId: null,
      selectedCompany: null,
      selectionSource: "bootstrap" as const,
      loading: false,
      error: null,
      setSelectedCompanyId: vi.fn(),
      reloadCompanies: vi.fn(),
      createCompany: vi.fn(),
    }),
    useOptionalNodeOrg: () => null,
  };
});

// Global safe default for useTheme — prevents "useTheme must be used within
// ThemeProvider" errors when tests render components that call useTheme()
// without wrapping in ThemeProvider.
vi.mock("@/context/ThemeContext", () => ({
  ThemeProvider: ({ children }: { children: unknown }) => children,
  useTheme: () => ({
    theme: "dark" as const,
    resolved: "dark" as const,
    setTheme: vi.fn(),
    toggleTheme: vi.fn(),
  }),
}));

// React 19.2.4 CJS builds do not export `act`. 57 test files import
// `act` from "react" and call it to flush React state synchronously.
// Mock the entire react module to preserve all original exports while
// adding a compatible `act` helper.
//
// React 19 defers createRoot.render() DOM commits to the microtask queue.
// Wrapping the act() callback in flushSync forces the commit to happen
// synchronously, so tests can query the DOM immediately after act().
// Async callbacks are handled by awaiting both the callback and a
// microtask drain.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    act: (callback: () => void | Promise<void>) => {
      let result: void | Promise<void>;
      flushSync(() => {
        result = callback();
      });
      if (result instanceof Promise) {
        return result.then(async () => {
          await Promise.resolve();
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
    },
  };
});
