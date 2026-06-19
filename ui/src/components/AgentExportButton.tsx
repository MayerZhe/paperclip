// ui/src/components/AgentExportButton.tsx
// Story 3.3: Agent → AgentHubs 数据桥
// "Export to AgentHubs" button that sends agent config to Electron main
// via IPC, which writes to ~/.paperclip/vm/shared/ for AgentHubs to consume.
//
// Security: API key is cleared before export.
// Direction: one-way Agent Mode → AgentHubs Mode.
// Trigger: manual (user clicks), no auto-sync.

import { useCallback, useState } from "react";
import { useToastActions } from "../context/ToastContext";
import { Button } from "./ui/button";
import { Upload } from "lucide-react";

interface AgentExportData {
  name: string;
  description: string;
  adapterType: string;
  adapterConfig: Record<string, string | number | boolean>;
  skills: string[];
  exportedAt: string;
}

export interface AgentExportButtonProps {
  agent: {
    name: string;
    description: string;
    adapterType: string;
    adapterConfig: Record<string, string | number | boolean>;
    skills: string[];
  };
  disabled?: boolean;
}

export function AgentExportButton({ agent, disabled }: AgentExportButtonProps) {
  const [exporting, setExporting] = useState(false);
  const { pushToast } = useToastActions();

  const handleExport = useCallback(async () => {
    if (!window.paperclip?.exportAgent) {
      pushToast({
        title: "Export unavailable",
        body: "AgentHubs export is only available in the desktop app.",
        tone: "warn",
      });
      return;
    }

    setExporting(true);
    try {
      // Construct export data with API key sanitized
      const exportData: AgentExportData = {
        name: agent.name,
        description: agent.description,
        adapterType: agent.adapterType,
        // Sanitize: clear apiKey before export
        adapterConfig: { ...agent.adapterConfig, apiKey: "" },
        skills: agent.skills,
        exportedAt: new Date().toISOString(),
      };

      const result = await window.paperclip.exportAgent(exportData);

      if (result.success) {
        pushToast({
          title: "Agent exported",
          body: `Saved to ${result.filePath}`,
          tone: "success",
        });
      } else {
        pushToast({
          title: "Export failed",
          body: "Could not export agent to AgentHubs.",
          tone: "error",
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushToast({
        title: "Export failed",
        body: message,
        tone: "error",
      });
    } finally {
      setExporting(false);
    }
  }, [agent, pushToast]);

  // Only show in desktop environment
  if (!window.paperclip?.platform) {
    return <></>;
  }

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled || exporting}
      onClick={handleExport}
    >
      <Upload className="w-4 h-4 mr-1.5" />
      {exporting ? "Exporting..." : "Export to AgentHubs"}
    </Button>
  );
}
