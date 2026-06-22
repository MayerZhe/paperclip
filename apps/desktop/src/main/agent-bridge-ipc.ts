// apps/desktop/src/main/agent-bridge-ipc.ts
// Story 3.3: Agent → AgentHubs 数据桥 — IPC handler
//
// Registers ipcMain.handle('file-bridge:export-agent', ...) which:
//   1. Sanitizes the API key (set to empty string)
//   2. Writes the agent config JSON to ~/.paperclip/vm/shared/
//   3. Returns { success, filePath }
//
// Security constraints:
//   - API key is always cleared before writing (defense-in-depth:
//     the renderer also clears it, but we double-check here)
//   - writeSharedFile() enforces fileName charset + path traversal checks
//   - writeSharedFile() enforces 100MB file size limit
//   - Direction: one-way Agent Mode → AgentHubs Mode

import { ipcMain } from "electron";
import { writeSharedFile } from "./file-bridge.js";
import path from "node:path";
import os from "node:os";

export interface AgentExportData {
  name: string;
  description: string;
  adapterType: string;
  adapterConfig: Record<string, string | number | boolean>;
  skills: string[];
  exportedAt: string; // ISO timestamp
}

export function registerAgentBridgeIPC(): void {
  ipcMain.handle(
    "file-bridge:export-agent",
    async (_event, data: AgentExportData) => {
      const homeDir = path.join(os.homedir(), ".paperclip");

      // Defense-in-depth: always sanitize API key before writing,
      // even though the renderer already does this.
      const safeData: AgentExportData = {
        ...data,
        adapterConfig: { ...data.adapterConfig, apiKey: "" },
      };

      // Sanitize name for use as filename — only [a-zA-Z0-9_-]
      const safeName = data.name.replace(/[^a-zA-Z0-9_-]/g, "-");
      const fileName = `agent-${safeName}.json`;

      const filePath = writeSharedFile(
        homeDir,
        fileName,
        JSON.stringify(safeData, null, 2),
      );

      return { success: true, filePath };
    },
  );
}
