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
      exportAgent?: (data: {
        name: string;
        description: string;
        adapterType: string;
        adapterConfig: Record<string, string | number | boolean>;
        skills: string[];
        exportedAt: string;
      }) => Promise<{ success: boolean; filePath: string }>;
    };
  }
}

export {}
