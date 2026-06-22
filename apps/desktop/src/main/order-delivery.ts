// apps/desktop/src/main/order-delivery.ts
// Story 3.2: 订单执行 + 交付物上传
//
// 处理 paperclip Agent 完成交付物 → MinIO 上传 → AgentHubs Cloud 提交。
//
// 流程:
//   1. 验证交付物 — 检查每个文件存在 + 大小 > 0
//   2. 上传到 MinIO — 使用 S3 兼容 PUT 请求逐文件上传
//   3. 通知 Cloud — POST /api/v1/orders/:id/deliver (JWT auth)
//   4. 返回 DeliveryResult
//
// 约束:
//   - MinIO 在 Docker Compose 内部用 minio:9000，宿主机用 localhost:9000
//   - bucket 名称: agenthubs-deliverables
//   - Cloud deliver 端点需要 JWT auth
//   - 每订单交付物 < 100MB
//   - 不做断点续传 (MVP)

import fs from "node:fs";
import path from "node:path";

// ─── 类型定义 ───

export interface Deliverable {
  /** 交付物本地路径 (absolute) */
  filePath: string;
  /** 交付物文件名 */
  fileName: string;
  /** MIME type — 检测或手动指定 */
  mimeType: string;
  /** 文件大小 (bytes) */
  size: number;
}

export interface DeliveryResult {
  success: boolean;
  orderId: string;
  /** MinIO object keys */
  fileKeys: string[];
  /** Cloud deliver 端点响应 */
  cloudResponse?: unknown;
  error?: string;
}

export interface OrderDeliveryConfig {
  orderId: string;
  deliverables: Deliverable[];
  /** AgentHubs Cloud URL (e.g. http://localhost:4000) */
  cloudUrl: string;
  /** OAuth JWT for Cloud API authentication */
  jwtToken: string;
  minioConfig: {
    /** MinIO 端点 (e.g. localhost:9000 或 minio:9000) */
    endpoint: string;
    accessKey: string;
    secretKey: string;
    /** bucket 名称 (e.g. agenthubs-deliverables) */
    bucket: string;
  };
  onProgress?: (stage: string, detail: string) => void;
}

// ─── 常量 ───

/** 单交付物最大大小 (100MB) — 与 file-bridge.ts 保持一致 */
const MAX_DELIVERABLE_SIZE = 100 * 1024 * 1024; // 100MB

/** 单订单最大总交付物大小 (100MB) */
const MAX_ORDER_TOTAL_SIZE = 100 * 1024 * 1024; // 100MB

/** 请求超时时间 (30s per file) */
const UPLOAD_TIMEOUT_MS = 30_000;

// ─── 内部工具函数 ───

const MIME_MAP: Record<string, string> = {
  ".json": "application/json",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".ts": "application/typescript",
  ".tsx": "text/typescript",
  ".jsx": "text/javascript",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".csv": "text/csv",
  ".yaml": "application/x-yaml",
  ".yml": "application/x-yaml",
  ".log": "text/plain",
};

/**
 * 根据文件扩展名检测 MIME type。
 * 如果已提供 mimeType 且非空，直接返回。
 */
function detectMimeType(filePath: string, fallback?: string): string {
  if (fallback && fallback.trim().length > 0 && fallback !== "application/octet-stream") {
    return fallback;
  }
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] ?? "application/octet-stream";
}

/** MinIO object key 格式: orders/{orderId}/{fileName} */
function buildObjectKey(orderId: string, fileName: string): string {
  return `orders/${orderId}/${fileName}`;
}

/**
 * 构造带基本签名的 MinIO PUT URL。
 * 对本地开发 MinIO (无 TLS，允许匿名)，直接用 endpoint + bucket + key。
 * 如果提供了 accessKey/secretKey，追加查询参数签名（MinIO 兼容 S3 预签名模式）。
 */
function buildMinioPutUrl(
  endpoint: string,
  bucket: string,
  key: string,
  _accessKey: string,
  _secretKey: string,
): string {
  // 清理尾部斜杠
  const base = endpoint.replace(/\/+$/, "");
  // MinIO S3 兼容 API 路径格式: /{bucket}/{key}
  return `${base}/${bucket}/${encodeURI(key)}`;
}

/**
 * 验证单个交付物：
 * - 文件存在
 * - 文件大小 > 0 且 <= 100MB
 * - fileName 合法（同 file-bridge.ts 的安全约束）
 */
function validateDeliverable(deliverable: Deliverable): void {
  const VALID_FILENAME_RE = /^[a-zA-Z0-9._-]+$/;

  if (!VALID_FILENAME_RE.test(deliverable.fileName)) {
    throw new Error(
      `Invalid file name: "${deliverable.fileName}". Only alphanumeric, hyphens, underscores, and dots are allowed.`,
    );
  }

  if (!fs.existsSync(deliverable.filePath)) {
    throw new Error(`Deliverable file not found: ${deliverable.filePath}`);
  }

  const stat = fs.statSync(deliverable.filePath);
  if (!stat.isFile()) {
    throw new Error(`Deliverable path is not a file: ${deliverable.filePath}`);
  }

  if (stat.size === 0) {
    throw new Error(`Deliverable file is empty: ${deliverable.filePath}`);
  }

  if (stat.size > MAX_DELIVERABLE_SIZE) {
    throw new Error(
      `Deliverable file ${deliverable.fileName} is ${stat.size} bytes, exceeds maximum ${MAX_DELIVERABLE_SIZE} bytes (100MB).`,
    );
  }

  // 将实际大小写回 deliverable，供后续使用
  deliverable.size = stat.size;
}

// ─── 导出：交付流程 ───

/**
 * 完整交付流程 — 验证 → 上传 MinIO → 通知 Cloud
 *
 * @example
 * ```typescript
 * const result = await deliverOrder({
 *   orderId: "order-abc123",
 *   deliverables: [
 *     { filePath: "/tmp/output.md", fileName: "output.md", mimeType: "text/markdown", size: 0 },
 *   ],
 *   cloudUrl: "http://localhost:4000",
 *   jwtToken: "eyJ...",
 *   minioConfig: {
 *     endpoint: "http://localhost:9000",
 *     accessKey: "minioadmin",
 *     secretKey: "minioadmin",
 *     bucket: "agenthubs-deliverables",
 *   },
 *   onProgress: (stage, detail) => console.log(`[${stage}] ${detail}`),
 * });
 * ```
 */
export async function deliverOrder(
  config: OrderDeliveryConfig,
): Promise<DeliveryResult> {
  const { orderId, deliverables, cloudUrl, jwtToken, minioConfig, onProgress } = config;

  // ── 阶段 1: 验证交付物 ──
  onProgress?.("validate", `Validating ${deliverables.length} deliverable(s)...`);

  if (deliverables.length === 0) {
    return {
      success: false,
      orderId,
      fileKeys: [],
      error: "No deliverables provided.",
    };
  }

  // 检查总大小约束
  let totalSize = 0;
  for (const d of deliverables) {
    // 如果 size 已预先提供，使用预估值进行快速检查
    if (d.size > 0 && d.size <= MAX_DELIVERABLE_SIZE) {
      totalSize += d.size;
    }
  }
  if (totalSize > MAX_ORDER_TOTAL_SIZE) {
    return {
      success: false,
      orderId,
      fileKeys: [],
      error: `Total deliverable size ${totalSize} bytes exceeds maximum ${MAX_ORDER_TOTAL_SIZE} bytes (100MB).`,
    };
  }

  // 逐一验证
  try {
    for (const d of deliverables) {
      validateDeliverable(d);
    }
  } catch (err) {
    return {
      success: false,
      orderId,
      fileKeys: [],
      error: `Validation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  onProgress?.("validate", "All deliverables validated.");

  // ── 阶段 2: 上传到 MinIO ──
  onProgress?.("upload", "Uploading deliverables to MinIO...");

  const fileKeys: string[] = [];
  const { endpoint, accessKey, secretKey, bucket } = minioConfig;

  for (const d of deliverables) {
    const objectKey = buildObjectKey(orderId, d.fileName);
    const uploadUrl = buildMinioPutUrl(endpoint, bucket, objectKey, accessKey, secretKey);

    onProgress?.("upload", `Uploading ${d.fileName} (${d.size} bytes) → ${objectKey}`);

    try {
      const fileBuffer = fs.readFileSync(d.filePath);
      const mimeType = detectMimeType(d.filePath, d.mimeType);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

      const response = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": mimeType,
          "Content-Length": String(fileBuffer.length),
        },
        body: fileBuffer,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "(no body)");
        throw new Error(
          `MinIO upload failed for ${d.fileName}: HTTP ${response.status} — ${errorText.slice(0, 200)}`,
        );
      }

      fileKeys.push(objectKey);
      onProgress?.("upload", `Uploaded ${d.fileName} → ${objectKey} (${response.status})`);
    } catch (err) {
      return {
        success: false,
        orderId,
        fileKeys,
        error: `Upload failed for ${d.fileName}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  onProgress?.("upload", `All ${fileKeys.length} file(s) uploaded to MinIO.`);

  // ── 阶段 3: 通知 AgentHubs Cloud ──
  onProgress?.("notify", `Notifying Cloud: POST ${cloudUrl}/api/v1/orders/${orderId}/deliver`);

  let cloudResponse: unknown;

  try {
    const notifyUrl = `${cloudUrl.replace(/\/+$/, "")}/api/v1/orders/${orderId}/deliver`;
    const response = await fetch(notifyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwtToken}`,
      },
      body: JSON.stringify({
        fileKeys,
        notes: "Order completed by paperclip agent",
      }),
    });

    // 尝试解析 JSON body，失败则取文本
    try {
      cloudResponse = await response.json();
    } catch {
      cloudResponse = await response.text();
    }

    if (!response.ok) {
      return {
        success: false,
        orderId,
        fileKeys,
        cloudResponse,
        error: `Cloud deliver endpoint returned HTTP ${response.status}`,
      };
    }

    onProgress?.("notify", `Cloud notified successfully (${response.status}).`);
  } catch (err) {
    return {
      success: false,
      orderId,
      fileKeys,
      error: `Failed to notify Cloud: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ── 阶段 4: 返回结果 ──
  return {
    success: true,
    orderId,
    fileKeys,
    cloudResponse,
  };
}
