// apps/desktop/src/main/sidecar-server.ts
// v3: 无变化（已通过审计）
// Unix Socket IPC — 仅用于进程间生命期信号，不承载业务数据

import net from "node:net";
import fs from "node:fs";

export interface SidecarServer {
  close(): void;
}

export function createSidecarServer(
  socketPath: string,
  onMessage: (msg: Record<string, unknown>) => void,
): SidecarServer {
  // 清理旧的 socket 文件
  if (fs.existsSync(socketPath)) {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // 旧 socket 可能还在使用，忽略
    }
  }

  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString("utf-8");
      // 以换行符分隔消息
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          onMessage(msg);
        } catch {
          // 忽略无效 JSON（sidecar 仅接收生命期信号，非业务数据）
        }
      }
    });

    socket.on("error", (err) => {
      console.error("[Sidecar] Socket error:", err.message);
    });
  });

  server.listen(socketPath, () => {
    console.log(`[Sidecar] Listening on ${socketPath}`);
  });

  server.on("error", (err) => {
    console.error("[Sidecar] Server error:", err.message);
  });

  return {
    close() {
      server.close();
      try {
        if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
      } catch {
        // ignore
      }
    },
  };
}
