import { Router } from "express";

export function createDesktopRouter(options: {
  getServerUptime: () => number;
  isShuttingDown: () => boolean;
}) {
  const router = Router();

  // GET /api/desktop/status
  router.get("/status", (_req, res) => {
    res.json({
      uptime: options.getServerUptime(),
      shuttingDown: options.isShuttingDown(),
    });
  });

  // POST /api/desktop/shutdown
  // Electron 请求优雅关闭。
  // daemon 收到后：标记 shuttingDown → 200 响应 → 短暂延迟 → 发送 SIGTERM
  router.post("/shutdown", async (_req, res) => {
    // 防止重复关闭
    if (options.isShuttingDown()) {
      res.json({ acknowledged: true, alreadyShuttingDown: true });
      return;
    }
    res.json({ acknowledged: true });
    // 延迟确保响应发送完毕
    setTimeout(() => {
      process.kill(process.pid, "SIGTERM");
    }, 300);
  });

  return router;
}
