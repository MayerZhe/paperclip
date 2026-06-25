import { cn } from "../lib/utils";

export type AppMode = "agent" | "agenthubs";

interface SidebarModeTabsProps {
  activeMode: AppMode;
  onSwitch: (mode: AppMode) => void;
}

/**
 * Claude Desktop style dual-tab toggle component.
 * Mirrors Claude's [Cowork] [Code] top tab design —
 * text labels + underline indicator, no background chips.
 */
export function SidebarModeTabs({ activeMode, onSwitch }: SidebarModeTabsProps) {
  return (
    <div className="flex border-b border-[var(--sidebar-border-subtle)] px-2 pt-1">
      {(["agent", "agenthubs"] as AppMode[]).map((mode) => (
        <button
          key={mode}
          onClick={() => onSwitch(mode)}
          className={cn(
            "relative flex-1 px-3 py-2 text-[13px] font-medium transition-colors",
            activeMode === mode
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {mode === "agent" ? "Agent" : "AgentHubs"}
          {activeMode === mode && (
            <span className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full bg-primary" />
          )}
        </button>
      ))}
    </div>
  );
}
