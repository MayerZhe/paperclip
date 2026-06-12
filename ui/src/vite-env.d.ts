/// <reference types="vite/client" />

declare global {
  interface Window {
    paperclip?: {
      platform: string;
      version: string;
    };
  }
}

export {}
