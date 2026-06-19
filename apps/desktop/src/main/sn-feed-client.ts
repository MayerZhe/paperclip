// apps/desktop/src/main/sn-feed-client.ts
// Story 3.1: HBO 订单接收 (WebSocket / Polling)
//
// 本地 VM 连接 AgentHubs Cloud 的 WebSocket feed 客户端。
// Cloud 端点:
//   - WS  /api/v1/sn/feed?token=JWT          — 实时 feed (order:new + heartbeat 每30s)
//   - GET /api/v1/sn/orders?status=open,claimed — HTTP fallback polling
//   - PATCH /api/v1/orgs/:orgId/metrics       — SN 注册 + metrics 推送
//
// WebSocket 鉴权: token 通过 URL query 传递，匹配 Cloud 的 extractTokenFromUrl()
// Node.js 22+ 内置 WebSocket (global)，fallback 到 ws 包

import { EventEmitter } from "node:events";

// ─── 类型定义 ───

export interface SnFeedConfig {
  /** AgentHubs Cloud URL (e.g. https://agenthubs.dev) */
  cloudUrl: string;
  /** OAuth JWT for Cloud auth */
  jwtToken: string;
  /** SN org ID on Cloud */
  orgId: string;
  /** 新订单回调 */
  onOrder: (order: SnOrder) => void;
  /** 错误回调 */
  onError?: (error: Error) => void;
}

export interface SnOrder {
  id: string;
  title: string;
  description: string;
  budget: number;
  status: string;
  createdAt: string;
  hmoOrgId: string;
  hmoOrgName: string;
}

export interface SnMetrics {
  services: string[];
  serviceCategories: string[];
  /** 起始价格 (USD cents) */
  startingPrice: number;
}

export type SnFeedState = "disconnected" | "connecting" | "connected" | "error";

// ─── 轮询响应类型 ───

interface PollResponse {
  orders: SnOrder[];
  total: number;
}

// ─── 常量 ───

/** 重连指数退避序列 (ms): 1s, 2s, 4s, 8s, 16s, 30s, 30s... */
const RECONNECT_BACKOFF = [1000, 2000, 4000, 8000, 16000];
const MAX_RECONNECT_DELAY = 30000;

/** HTTP fallback 轮询间隔 (ms) */
const POLL_INTERVAL = 30000;

/** 轮询每页获取数量 */
const POLL_LIMIT = 20;

// ─── SnFeedClient ───

export class SnFeedClient extends EventEmitter {
  private readonly config: SnFeedConfig;
  private state: SnFeedState = "disconnected";

  // WebSocket
  private ws: import("ws").WebSocket | globalThis.WebSocket | null = null;

  // 重连
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;

  // HTTP polling
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private processedOrderIds = new Set<string>();

  // 生命周期
  private stopped = false;

  constructor(config: SnFeedConfig) {
    super();
    this.config = config;

    // 绑定回调到 EventEmitter，便于外部监听（兼容 onOrder 回调 + 事件模式）
    if (config.onOrder) {
      this.on("order:new", config.onOrder);
    }
    if (config.onError) {
      this.on("error", config.onError);
    }
  }

  // ─── Public API ───

  /** 启动：建立 WS 连接 + 启动 heartbeat 定时器 */
  async start(): Promise<void> {
    if (this.stopped) {
      throw new Error("SnFeedClient has been stopped and cannot be restarted. Create a new instance.");
    }

    if (this.state === "connected" || this.state === "connecting") {
      console.warn("[SnFeedClient] Already connecting or connected, skipping start");
      return;
    }

    console.log("[SnFeedClient] Starting feed client...");
    await this.connectWebSocket();
  }

  /** 停止：关闭 WS + 清除所有定时器 + 移除所有监听器 */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;

    console.log("[SnFeedClient] Stopping feed client...");

    // 清除重连定时器
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // 清除轮询定时器
    this.stopPolling();

    // 关闭 WebSocket
    this.closeWebSocket();

    // 移除所有 EventEmitter 监听器，防止内存泄漏
    this.removeAllListeners();

    this.state = "disconnected";
    console.log("[SnFeedClient] Feed client stopped");
  }

  /** 注册 SN：PATCH metrics → 推 services + serviceCategories + startingPrice */
  async registerSn(metrics: SnMetrics): Promise<void> {
    const { cloudUrl, jwtToken, orgId } = this.config;

    const url = `${cloudUrl}/api/v1/orgs/${encodeURIComponent(orgId)}/metrics`;
    const body = {
      services: metrics.services,
      serviceCategories: metrics.serviceCategories,
      startingPrice: metrics.startingPrice,
      totalOrders: 0,
      completedOrders: 0,
    };

    console.log("[SnFeedClient] Registering SN metrics:", JSON.stringify(body));

    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwtToken}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "(no body)");
      throw new Error(
        `SN registration failed: HTTP ${response.status} ${response.statusText} — ${text}`,
      );
    }

    console.log("[SnFeedClient] SN registered successfully");
  }

  /** 获取当前连接状态 */
  getState(): SnFeedState {
    return this.state;
  }

  // ─── WebSocket 连接管理 ───

  private async connectWebSocket(): Promise<void> {
    if (this.stopped) return;

    this.state = "connecting";
    this.emit("state", "connecting");

    const { cloudUrl, jwtToken } = this.config;

    // 构建 WS URL: wss://<host>/api/v1/sn/feed?token=JWT
    // 生产: https:// → wss://
    // 本地 Docker: http:// → ws://
    const httpUrl = new URL(cloudUrl);
    const wsProtocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProtocol}//${httpUrl.host}/api/v1/sn/feed?token=${encodeURIComponent(jwtToken)}`;

    console.log("[SnFeedClient] Connecting WebSocket:", wsUrl);

    try {
      this.ws = this.createWebSocket(wsUrl);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.handleError(new Error(`WebSocket creation failed: ${error.message}`));
      return;
    }

    this.ws.onopen = () => {
      console.log("[SnFeedClient] WebSocket connected");
      this.state = "connected";
      this.emit("state", "connected");
      this.reconnectAttempt = 0;

      // WS 连接成功 → 停止 HTTP polling
      this.stopPolling();
    };

    this.ws.onmessage = (event: { data: unknown }) => {
      this.handleMessage(event.data);
    };

    this.ws.onclose = (event: { code: number; reason: string }) => {
      console.log(
        `[SnFeedClient] WebSocket closed: code=${event.code} reason="${event.reason}"`,
      );
      this.ws = null;

      if (this.stopped) return;

      // 连接关闭 → 启动 HTTP polling 作为 fallback
      this.startPolling();

      // 启动重连（除非主动停止）
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose 通常紧接着 onerror，这里仅记录，重连逻辑在 onclose
      console.warn("[SnFeedClient] WebSocket error occurred");
    };
  }

  private closeWebSocket(): void {
    if (!this.ws) return;

    // 移除监听器防止 onclose 触发重连
    this.ws.onopen = null;
    this.ws.onmessage = null;
    this.ws.onclose = null;
    this.ws.onerror = null;

    try {
      this.ws.close(1000, "Client stopped");
    } catch {
      // WebSocket 可能已处于 CLOSING/CLOSED 状态
    }

    this.ws = null;
  }

  /**
   * 创建 WebSocket 连接。
   * Node.js 22+ 有内置 globalThis.WebSocket，旧版本 fallback 到 ws 包。
   */
  private createWebSocket(url: string): import("ws").WebSocket | globalThis.WebSocket {
    // Node.js 22+ 内置 WebSocket（globalThis.WebSocket）
    if (typeof globalThis.WebSocket !== "undefined") {
      console.log("[SnFeedClient] Using native WebSocket (Node.js 22+)");
      return new globalThis.WebSocket(url);
    }

    // Fallback: ws 包
    console.log("[SnFeedClient] Native WebSocket not available, using ws package");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { WebSocket: WsClient } = require("ws") as typeof import("ws");
    return new WsClient(url);
  }

  // ─── 消息处理 ───

  private handleMessage(data: unknown): void {
    let parsed: Record<string, unknown>;

    try {
      const raw = typeof data === "string" ? data : String(data);
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      console.warn("[SnFeedClient] Failed to parse WS message:", String(data));
      return;
    }

    if (!parsed || typeof parsed.type !== "string") {
      console.warn("[SnFeedClient] Invalid WS message format:", JSON.stringify(parsed));
      return;
    }

    switch (parsed.type) {
      case "order:new": {
        const order = parsed.order as SnOrder | undefined;
        if (!order) {
          console.warn("[SnFeedClient] order:new message missing 'order' field");
          return;
        }

        // 去重检查
        if (this.processedOrderIds.has(order.id)) {
          console.log(`[SnFeedClient] Duplicate order ${order.id}, skipping`);
          return;
        }

        this.processedOrderIds.add(order.id);
        console.log(`[SnFeedClient] New order received: ${order.id} — ${order.title}`);

        this.emit("order:new", order);
        break;
      }

      case "heartbeat": {
        // 仅日志记录
        const ts = typeof parsed.timestamp === "string" ? parsed.timestamp : "unknown";
        console.log(`[SnFeedClient] Heartbeat received: ${ts}`);
        break;
      }

      default:
        console.warn(`[SnFeedClient] Unknown message type: "${String(parsed.type)}"`);
        break;
    }
  }

  // ─── 重连逻辑 ───

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.state === "connected" || this.state === "connecting") return;

    const delay = this.nextReconnectDelay();
    console.log(
      `[SnFeedClient] Scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempt + 1})`,
    );

    this.reconnectTimer = setTimeout(() => {
      if (this.stopped) return;
      console.log(`[SnFeedClient] Reconnecting... (attempt ${this.reconnectAttempt + 1})`);
      this.connectWebSocket().catch((err) => {
        console.error("[SnFeedClient] Reconnect failed:", err);
      });
    }, delay);
  }

  /** 指数退避: 1s, 2s, 4s, 8s, 16s, 30s, 30s... */
  private nextReconnectDelay(): number {
    if (this.reconnectAttempt < RECONNECT_BACKOFF.length) {
      return RECONNECT_BACKOFF[this.reconnectAttempt++];
    }
    this.reconnectAttempt++;
    return MAX_RECONNECT_DELAY;
  }

  // ─── HTTP Fallback Polling ───

  /**
   * 启动 HTTP polling fallback。
   * 当 WebSocket 断开时自动启动，每 30s 轮询一次。
   */
  private startPolling(): void {
    if (this.stopped) return;
    if (this.pollTimer !== null) return;

    console.log("[SnFeedClient] Starting HTTP polling fallback (every 30s)");

    // 立即拉取一次
    this.pollOrders().catch((err) => {
      console.error("[SnFeedClient] Initial poll failed:", err);
    });

    this.pollTimer = setInterval(() => {
      if (this.stopped) {
        this.stopPolling();
        return;
      }
      this.pollOrders().catch((err) => {
        console.error("[SnFeedClient] Poll failed:", err);
      });
    }, POLL_INTERVAL);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      console.log("[SnFeedClient] HTTP polling stopped");
    }
  }

  /**
   * 轮询 AgentHubs Cloud 的 GET /api/v1/sn/orders 端点。
   * 去重：已处理的订单 ID 不会再次触发 onOrder。
   */
  private async pollOrders(): Promise<void> {
    const { cloudUrl, jwtToken } = this.config;

    const url = `${cloudUrl}/api/v1/sn/orders?status=open,claimed&limit=${POLL_LIMIT}&offset=0`;

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${jwtToken}`,
        },
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.handleError(new Error(`HTTP poll request failed: ${error.message}`));
      return;
    }

    if (!response.ok) {
      this.handleError(
        new Error(`HTTP poll returned ${response.status}: ${response.statusText}`),
      );
      return;
    }

    let body: PollResponse;
    try {
      body = (await response.json()) as PollResponse;
    } catch (err) {
      this.handleError(new Error(`HTTP poll JSON parse failed: ${String(err)}`));
      return;
    }

    if (!body || !Array.isArray(body.orders)) {
      this.handleError(new Error(`HTTP poll unexpected response format: ${JSON.stringify(body)}`));
      return;
    }

    if (body.orders.length === 0) {
      console.log("[SnFeedClient] Poll: no new orders");
      return;
    }

    let newCount = 0;
    for (const order of body.orders) {
      if (this.processedOrderIds.has(order.id)) continue;

      this.processedOrderIds.add(order.id);
      newCount++;
      console.log(`[SnFeedClient] New order (via poll): ${order.id} — ${order.title}`);
      this.emit("order:new", order);
    }

    if (newCount > 0) {
      console.log(`[SnFeedClient] Poll: ${newCount} new order(s) received`);
    }
  }

  // ─── 错误处理 ───

  private handleError(error: Error): void {
    this.state = "error";
    this.emit("state", "error");
    this.emit("error", error);
    console.error("[SnFeedClient] Error:", error.message);
  }
}
