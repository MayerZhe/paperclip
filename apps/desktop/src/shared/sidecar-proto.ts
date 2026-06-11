// apps/desktop/src/shared/sidecar-proto.ts
// v3: 无变化 — Unix Socket 仅承载生命期信号，不承载业务数据

export const SIDECAR_MESSAGES = {
  STATUS: "status",
  NOTIFY: "notify",
  SHUTDOWN: "shutdown",
} as const;
