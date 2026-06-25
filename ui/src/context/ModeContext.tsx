import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

export type AppMode = "agent" | "agenthubs";

interface ModeContextValue {
  mode: AppMode;
  setMode: (mode: AppMode) => void;
  switchMode: () => void; // toggle
}

const STORAGE_KEY = "supernode.activeMode";

function getInitialMode(): AppMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "agenthubs") return "agenthubs";
  } catch {
    // localStorage unavailable
  }
  return "agent";
}

const ModeContext = createContext<ModeContextValue | null>(null);

export function ModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<AppMode>(getInitialMode);

  const setMode = useCallback((next: AppMode) => {
    setModeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // localStorage unavailable
    }
    // Notify Electron main process (tray/menu sync)
    if (typeof window !== "undefined" && (window as any).paperclip?.switchMode) {
      (window as any).paperclip.switchMode(next);
    }
  }, []);

  const switchMode = useCallback(() => {
    setMode(mode === "agent" ? "agenthubs" : "agent");
  }, [mode, setMode]);

  return (
    <ModeContext.Provider value={{ mode, setMode, switchMode }}>
      {children}
    </ModeContext.Provider>
  );
}

export function useMode(): ModeContextValue {
  const ctx = useContext(ModeContext);
  if (!ctx) throw new Error("useMode must be used within ModeProvider");
  return ctx;
}
