#!/usr/bin/env node --experimental-strip-types
// SuperNode-desktop/scripts/desktop/generate-icons.ts
// v3 Sprint 2: 程序化生成占位图标（16x16, 32x32, 256x256, 512x512 PNG）
// 生成简单的圆形图标用于开发阶段（最终图标应由设计师提供）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, "..", "..", "apps", "desktop", "resources");

// 图标颜色
const ICON_COLORS = {
  background: [30, 30, 46, 255],    // 深色背景 #1E1E2E
  foreground: [203, 166, 247, 255], // 浅紫色文字/图形 #CBA6F7
  accent: [137, 180, 250, 255],     // 蓝色强调 #89B4FA
};

/**
 * 生成指定大小的 PNG 图标 buffer
 * 创建带 "PC" 文字和彩色圆圈的占位图标
 * @param size - 图标尺寸（像素）
 * @returns PNG buffer
 */
function generateIconPng(size: number): Buffer {
  // 使用简单的 32-bit RGBA 像素缓冲区
  const pixels = Buffer.alloc(size * size * 4, 0);

  const [br, bg, bb, ba] = ICON_COLORS.background;
  const [fr, fg, fb] = ICON_COLORS.foreground;
  const [ar, ag, ab] = ICON_COLORS.accent;

  const cx = size / 2;
  const cy = size / 2;
  const outerRadius = size * 0.45;
  const innerRadius = size * 0.36;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= outerRadius) {
        if (dist <= innerRadius) {
          // 内部圆圈：强调色
          pixels[idx] = ar;
          pixels[idx + 1] = ag;
          pixels[idx + 2] = ab;
          pixels[idx + 3] = 255;
        } else {
          // 外圈：前景色
          pixels[idx] = fr;
          pixels[idx + 1] = fg;
          pixels[idx + 2] = fb;
          pixels[idx + 3] = 255;
        }
      } else if (dist <= outerRadius + 1) {
        // 边缘抗锯齿
        const alpha = Math.max(0, 1 - (dist - outerRadius));
        pixels[idx] = fr;
        pixels[idx + 1] = fg;
        pixels[idx + 2] = fb;
        pixels[idx + 3] = Math.floor(255 * alpha);
      }
      // 外部透明
    }
  }

  // 打包为最简单的 PNG（IHDR + IDAT + IEND）
  return encodePng(pixels, size, size);
}

/**
 * 极简 PNG 编码器（无压缩，IDAT 存原始 RGBA）
 * 只能生成开发者占位图标，不能用于生产环境
 * @param pixels - RGBA 像素缓冲区
 * @param width - 图像宽度
 * @param height - 图像高度
 * @returns PNG 文件 buffer
 */
function encodePng(pixels: Buffer, width: number, height: number): Buffer {
  const chunks: Buffer[] = [];

  // PNG signature
  chunks.push(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8);   // bit depth
  ihdrData.writeUInt8(6, 9);   // color type (RGBA)
  ihdrData.writeUInt8(0, 10);  // compression
  ihdrData.writeUInt8(0, 11);  // filter
  ihdrData.writeUInt8(0, 12);  // interlace
  chunks.push(makePngChunk("IHDR", ihdrData));

  // IDAT chunk — 原始像素数据（每行前加 filter byte = 0）
  const rawData = Buffer.alloc(height * (1 + width * 4), 0);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    rawData[rowStart] = 0; // filter: None
    pixels.copy(rawData, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  chunks.push(makePngChunk("IDAT", rawData));

  // IEND chunk
  chunks.push(makePngChunk("IEND", Buffer.alloc(0)));

  return Buffer.concat(chunks);
}

/** 创建 PNG chunk（length + type + data + crc32） */
function makePngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuffer = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBuffer, data]);
  const crc = crc32(crcInput);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc, 0);

  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

/** CRC32 计算（PNG chunk 校验） */
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 1) {
        crc = (crc >>> 1) ^ 0xedb88320;
      } else {
        crc = crc >>> 1;
      }
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ─── Main ───

function main(): void {
  console.log("[PaperClip Desktop] Generating placeholder icons...");

  // 确保输出目录存在
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const sizes = [
    { size: 16, name: "icon-16.png" },
    { size: 32, name: "icon-32.png" },
    { size: 256, name: "icon-256.png" },
    { size: 512, name: "icon-512.png" },
  ];

  for (const { size, name } of sizes) {
    const pngBuf = generateIconPng(size);
    const outPath = path.join(OUTPUT_DIR, name);
    fs.writeFileSync(outPath, pngBuf);
    console.log(`  ${name} (${size}x${size}) — ${pngBuf.length} bytes`);
  }

  // 同时生成托盘图标 (16x16)
  const trayDir = path.join(OUTPUT_DIR, "tray");
  fs.mkdirSync(trayDir, { recursive: true });
  const trayPng = generateIconPng(16);
  const trayPath = path.join(trayDir, "tray-icon.png");
  fs.writeFileSync(trayPath, trayPng);
  console.log(`  tray/tray-icon.png (16x16) — ${trayPng.length} bytes`);

  console.log("[PaperClip Desktop] Icons generated successfully");
}

main();
