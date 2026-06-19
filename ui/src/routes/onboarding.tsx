import { useState, useEffect, useCallback, type FormEvent } from "react";
import "./onboarding.css";

// ─── Types ───────────────────────────────────────────────────────────────────

type OnboardingStep = "welcome" | "select-mode" | "complete";
type DeployMode = "agent" | "agenthubs";

// ─── IPC abstraction (safe fallback when not in Electron) ────────────────────

function sendModeToMain(mode: DeployMode): void {
  try {
    // ipcRenderer is injected by Electron preload; not available in browser dev
    const win = window as Window &
      typeof globalThis & {
        ipcRenderer?: {
          send(channel: string, ...args: unknown[]): void;
        };
      };
    if (win.ipcRenderer) {
      win.ipcRenderer.send("onboarding:select-mode", mode);
    } else {
      console.log(
        `[Onboarding] Mode selected: ${mode} (ipcRenderer unavailable — running outside Electron)`,
      );
    }
  } catch {
    console.log(`[Onboarding] Mode selected: ${mode}`);
  }
}

// ─── Welcome step ────────────────────────────────────────────────────────────

function WelcomeScreen({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    // Auto-transition after 1.5 s, but user can also click to skip the wait.
    const timer = setTimeout(onDone, 1_500);
    return () => clearTimeout(timer);
  }, [onDone]);

  return (
    <div className="ob-welcome" onClick={onDone} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onDone(); } }}>
      <div className="ob-welcome__logo">
        <svg
          width="64"
          height="64"
          viewBox="0 0 64 64"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          {/* Simplified PaperClip brand mark — two interlocking rounded rects */}
          <rect x="6" y="14" width="24" height="36" rx="12" fill="var(--ah-brand)" />
          <rect x="34" y="14" width="24" height="36" rx="12" fill="var(--ah-brand-secondary)" />
          <rect x="18" y="6" width="28" height="8" rx="4" fill="var(--ah-brand)" opacity="0.6" />
        </svg>
      </div>
      <h1 className="ob-welcome__title">PaperClip</h1>
      <p className="ob-welcome__tagline">
        Your AI agent platform, local and connected
      </p>
    </div>
  );
}

// ─── Mode-select step ────────────────────────────────────────────────────────

function ModeSelectScreen({
  onSelect,
}: {
  onSelect: (mode: DeployMode) => void;
}) {
  return (
    <div className="ob-select">
      <h2 className="ob-select__heading">Choose your mode</h2>
      <p className="ob-select__subtitle">
        How would you like to use PaperClip?
      </p>

      <div className="ob-select__cards">
        <button
          className="ob-card"
          type="button"
          onClick={() => onSelect("agent")}
        >
          <span className="ob-card__icon" aria-hidden="true">
            🤖
          </span>
          <div className="ob-card__body">
            <h3 className="ob-card__title">Agent Mode</h3>
            <p className="ob-card__desc">
              Manage my AI agent team. Local deployment, full control, no
              containers required.
            </p>
          </div>
        </button>

        <button
          className="ob-card"
          type="button"
          onClick={() => onSelect("agenthubs")}
        >
          <span className="ob-card__icon" aria-hidden="true">
            🌐
          </span>
          <div className="ob-card__body">
            <h3 className="ob-card__title">AgentHubs Mode</h3>
            <p className="ob-card__desc">
              Join the AgentHubs platform and take on work. Docker
              containerised, connected to AgentHubs Cloud, receive HBO orders.
            </p>
          </div>
        </button>
      </div>

      <form
        className="ob-select__skip"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          onSelect("agent");
        }}
      >
        <button type="submit" className="ob-skip-link">
          Skip for now (defaults to Agent Mode)
        </button>
      </form>
    </div>
  );
}

// ─── Complete step ───────────────────────────────────────────────────────────

function CompleteScreen({ mode }: { mode: DeployMode }) {
  useEffect(() => {
    // Fire IPC once the complete animation plays; the Electron main process
    // persists the preference before the window navigates away.
    const timer = setTimeout(() => sendModeToMain(mode), 600);
    return () => clearTimeout(timer);
  }, [mode]);

  const label = mode === "agent" ? "Agent Mode" : "AgentHubs Mode";

  return (
    <div className="ob-complete" aria-live="polite">
      <div className="ob-complete__check" aria-hidden="true">
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
          <circle cx="24" cy="24" r="23" stroke="var(--ah-success)" strokeWidth="2" />
          <path
            d="M14 25l6 6 14-14"
            stroke="var(--ah-success)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <p className="ob-complete__text">
        Starting <strong>{label}</strong>&hellip;
      </p>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const [step, setStep] = useState<OnboardingStep>("welcome");
  const [mode, setMode] = useState<DeployMode | null>(null);

  const goToModeSelect = useCallback(() => setStep("select-mode"), []);

  const handleSelect = useCallback((selected: DeployMode) => {
    setMode(selected);
    setStep("complete");
  }, []);

  return (
    <main className="ob-root">
      <div className="ob-container">
        {step === "welcome" && <WelcomeScreen onDone={goToModeSelect} />}

        {step === "select-mode" && (
          <ModeSelectScreen onSelect={handleSelect} />
        )}

        {step === "complete" && mode && <CompleteScreen mode={mode} />}
      </div>
    </main>
  );
}
