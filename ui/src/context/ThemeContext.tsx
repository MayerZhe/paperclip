import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export type Theme = "dark" | "light" | "system";

interface ThemeContextValue {
  theme: Theme;
  resolved: "dark" | "light";
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
}

const THEME_STORAGE_KEY = "paperclip-theme";
const DEFAULT_THEME: Theme = "dark";
const DARK_THEME_COLOR = "#050505";
const LIGHT_THEME_COLOR = "#ffffff";
const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return DEFAULT_THEME;
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "dark" || stored === "light" || stored === "system") {
      return stored;
    }
  } catch {
    // Ignore local storage read failures in restricted environments.
  }
  return DEFAULT_THEME;
}

function applyTheme(resolved: "dark" | "light") {
  if (typeof document === "undefined") return;
  const isDark = resolved === "dark";
  const root = document.documentElement;
  root.classList.toggle("dark", isDark);
  root.style.colorScheme = isDark ? "dark" : "light";
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  if (themeColorMeta instanceof HTMLMetaElement) {
    themeColorMeta.setAttribute("content", isDark ? DARK_THEME_COLOR : LIGHT_THEME_COLOR);
  }
}

/**
 * Subscribe to system color-scheme preference changes.
 * Uses useSyncExternalStore for tear-free concurrent-mode-safe reads.
 */
function useSystemPreference(): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (typeof window === "undefined") return () => {};
      const mql = window.matchMedia("(prefers-color-scheme: dark)");
      mql.addEventListener("change", onStoreChange);
      return () => mql.removeEventListener("change", onStoreChange);
    },
    [],
  );

  const getSnapshot = useCallback(() => {
    if (typeof window === "undefined") return true;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }, []);

  return useSyncExternalStore(subscribe, getSnapshot);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useStoredThemeState();
  const systemPrefersDark = useSystemPreference();

  const resolved: "dark" | "light" = theme === "system"
    ? (systemPrefersDark ? "dark" : "light")
    : theme;

  const setTheme = useCallback((nextTheme: Theme) => {
    setThemeState(nextTheme);
  }, [setThemeState]);

  const toggleTheme = useCallback(() => {
    setThemeState((current) => {
      // Toggle between explicit dark ↔ light; if currently "system", switch to opposite of resolved
      if (current === "system") {
        return resolved === "dark" ? "light" : "dark";
      }
      return current === "dark" ? "light" : "dark";
    });
  }, [resolved, setThemeState]);

  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  const value = useMemo(
    () => ({
      theme,
      resolved,
      setTheme,
      toggleTheme,
    }),
    [theme, resolved, setTheme, toggleTheme],
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

/**
 * Theme state backed by localStorage, with external change detection for
 * cross-tab synchronization.
 */
function useStoredThemeState() {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (typeof window === "undefined") return () => {};
      const handler = (e: StorageEvent) => {
        if (e.key === THEME_STORAGE_KEY) onStoreChange();
      };
      window.addEventListener("storage", handler);
      return () => window.removeEventListener("storage", handler);
    },
    [],
  );

  const getSnapshot = useCallback((): Theme => {
    if (typeof window === "undefined") return DEFAULT_THEME;
    return readStoredTheme();
  }, []);

  const theme = useSyncExternalStore(subscribe, getSnapshot);

  const setTheme = useCallback((nextThemeOrUpdater: Theme | ((current: Theme) => Theme)) => {
    const next = typeof nextThemeOrUpdater === "function"
      ? nextThemeOrUpdater(readStoredTheme())
      : nextThemeOrUpdater;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Ignore local storage write failures in restricted environments.
    }
    // Dispatch storage event manually so the same tab picks up the change
    // (the native StorageEvent only fires for OTHER tabs).
    window.dispatchEvent(
      new StorageEvent("storage", { key: THEME_STORAGE_KEY, newValue: next }),
    );
  }, []);

  return [theme, setTheme] as const;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
