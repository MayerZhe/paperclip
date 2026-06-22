import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("sidebar", {
  /**
   * Send: user clicked tab to switch mode.
   * Main process handles routing to agenthubs or agent mode.
   */
  switchMode: (mode: string) => ipcRenderer.send("shell:switch-mode", { mode }),

  /**
   * Send: user clicked sign out button.
   * Main process clears auth state and navigates to login.
   */
  signOut: () => ipcRenderer.send("shell:sign-out"),

  /**
   * Receive: organization info pushed from main process.
   * Includes name, role, CPDR balance, and user email.
   */
  onOrgInfo: (
    callback: (info: {
      name: string;
      role: string;
      balance: string;
      email: string;
    }) => void
  ) => {
    ipcRenderer.on("sidebar:org-info", (_event, info) => callback(info));
  },

  /**
   * Receive: service status updates pushed from main process.
   * mode: "agent" for Agent Daemon, "agenthubs" for AgentHubs
   * status: "online" | "offline" | "loading"
   */
  onStatus: (
    callback: (status: {
      mode: string;
      status: "online" | "offline" | "loading";
    }) => void
  ) => {
    ipcRenderer.on("sidebar:status", (_event, status) => callback(status));
  },

  /**
   * Invoke: retrieve the current JWT token.
   * Returns the token string or null if not authenticated.
   */
  getToken: () => ipcRenderer.invoke("shell:get-token"),

  /**
   * Invoke: refresh CPDR balance for an organization.
   * Fetches the latest balance from the AgentHubs contract.
   */
  refreshBalance: (orgId: string) =>
    ipcRenderer.invoke("shell:refresh-balance", { orgId }),
});
