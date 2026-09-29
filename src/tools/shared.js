/**
 * 工具层公共工具：统一错误转换与展示格式化。
 *
 * 约定：可预期的业务错误（凭证缺失、目录不存在、RPC 拒绝等）一律返回 isError，
 * 让模型有机会阅读文案并自我修正；只有真正的程序缺陷才向上抛异常。
 */
import { z } from "zod";

/** 把异常转换成工具的 isError 结果 */
export function toolError (err) {
  const message = err?.message ? String(err.message) : String(err);
  return {
    isError: true,
    content: [{ type: "text", text: `❌ ${message}` }]
  };
}

/** 字节数转可读大小 */
export function formatBytes (bytes) {
  const size = Number(bytes ?? 0);
  if (!Number.isFinite(size) || size <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  const value = size / 1024 ** index;

  return `${index === 0 || value >= 100 ? Math.round(value) : value.toFixed(2)} ${units[index]}`;
}

/** 毫秒时间戳转 ISO 字符串 */
export function formatTimestamp (ms) {
  const value = Number(ms ?? 0);
  if (!Number.isFinite(value) || value <= 0) return "-";
  return new Date(value).toISOString();
}

/**
 * 把缓存元数据转换成人类可读提示。
 * 这是「缓存提示」需求的核心：每次查询都能看出数据是缓存还是实时拉取。
 */
export function describeCache (cache) {
  if (!cache) return "";

  if (cache.source === "cache") {
    return `（缓存命中，数据获取于 ${cache.ageSeconds} 秒前，TTL ${cache.ttlSeconds} 秒）`;
  }

  return cache.coalesced ? "（来自网络，与并发请求合并）" : "（来自网络）";
}

/** 缓存元数据的 zod 结构，供各工具 outputSchema 复用 */
export const cacheMetaSchema = z.object({
  hit: z.boolean().describe("本次是否命中缓存"),
  ageSeconds: z.number().describe("缓存数据距今多少秒"),
  ttlSeconds: z.number().describe("缓存有效期（秒）"),
  source: z.string().describe("cache 或 network"),
  coalesced: z.boolean().optional().describe("是否与其它并发请求合并")
});
