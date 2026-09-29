/**
 * 环境变量加载与安全读取工具。
 *
 * 职责边界：
 *  - 只负责「加载 .env」与「带默认值的安全读取」；
 *  - 不校验业务必填项（那是 config.js 的职责），这样即使未配置 Cookie 也能正常执行 --help。
 *
 * ⚠️ stdio 传输下 stdout 被 JSON-RPC 协议独占，dotenv 必须以 quiet 模式加载，
 *    避免任何输出污染协议握手。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

/** 项目根目录（src/env.js 的上一级），保证无论进程 cwd 在哪都能找到 .env */
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// dotenv 默认不会覆盖已存在的真实环境变量，因此「客户端注入的 env」优先级最高
dotenv.config({ path: path.join(projectRoot, ".env"), quiet: true });

/** 读取字符串环境变量，空字符串按「未设置」处理 */
export function envStr (name, fallback = "") {
  const value = process.env[name];
  if (value === undefined || value === null) return fallback;
  const trimmed = String(value).trim();
  return trimmed === "" ? fallback : trimmed;
}

/** 读取正整数环境变量，非法值回退到默认值 */
export function envInt (name, fallback) {
  const parsed = Number.parseInt(String(process.env[name] ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
