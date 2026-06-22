/// <reference types="vite/client" />

declare global {
  interface Window {
    paperclip?: {
      platform: string;
      version: string;
      showContextMenu?: (items: Array<{ label: string; action?: string; enabled?: boolean; separator?: boolean }>) => void;
      showOpenDialog?: (options: {
        title?: string;
        filters?: Array<{ name: string; extensions: string[] }>;
        properties?: Array<"openFile" | "openDirectory" | "multiSelections">;
      }) => Promise<{ canceled: boolean; filePaths: string[] }>;
      getCliScan?: () => Promise<Array<{ label: string; command: string; adapterType: string; found: boolean; version?: string; installHint?: string }>>;
      installCli?: (adapterType: string) => Promise<{ success: boolean; output: string }>;
    };
  }
}

export {}
