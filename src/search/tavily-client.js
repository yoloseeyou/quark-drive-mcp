/**
 * Tavily 搜索客户端。
 *
 * 封装两个端点：
 *  1) POST /search  —— 关键词 AI 搜索，返回标题 / URL / 摘要等结果
 *  2) POST /extract —— 读取指定页面正文 raw_content
 *
 * 共同点：
 *  - 鉴权走 Authorization: Bearer tvly-xxx 请求头；
 *  - API Key 缺失时不阻塞服务启动，延迟到首次调用才抛出可读错误；
 *  - 非 2xx 或响应结构异常时统一抛 TavilyApiError，便于工具层转换为 isError。
 */
import { getConfig } from "../config.js";
import { logger } from "../logger.js";

/** Tavily 接口业务错误。上层据此把错误转换为工具的 isError 结果 */
export class TavilyApiError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = "TavilyApiError";
    this.status = status;
  }
}

/** 按端点累计的调用统计，用于性能观测 */
const callStats = new Map();

/** 记录一次调用的耗时 */
function recordTavilyCall (pathname, elapsedMs) {
  const entry = callStats.get(pathname) ?? { calls: 0, totalMs: 0, lastMs: 0, maxMs: 0 };

  entry.calls += 1;
  entry.totalMs += elapsedMs;
  entry.lastMs = elapsedMs;
  entry.maxMs = Math.max(entry.maxMs, elapsedMs);

  callStats.set(pathname, entry);
}

/**
 * 获取 Tavily 调用统计（性能观测用）。
 * @returns {{pathname: string, calls: number, avgMs: number, lastMs: number, maxMs: number}[]}
 */
export function tavilyCallStats () {
  return [...callStats.entries()].map(([pathname, entry]) => ({
    pathname,
    calls: entry.calls,
    avgMs: entry.calls > 0 ? Math.round(entry.totalMs / entry.calls) : 0,
    lastMs: entry.lastMs,
    maxMs: entry.maxMs
  }));
}

/** 读取 Tavily 配置；API Key 缺失时抛出可读错误 */
function readTavilyConfig () {
  const { tavily } = getConfig();

  if (tavily.apiKey === "") {
    throw new TavilyApiError(
      "缺少环境变量 TAVILY_API_KEY（Tavily API 密钥）。" +
      "请在项目根目录 .env 中配置，或由 MCP 客户端的 env 传入，可参考 .env.example。"
    );
  }

  return tavily;
}

/**
 * 发起一次 Tavily POST 请求。
 * @param {string} pathname 端点路径，如 /search
 * @param {object} body JSON 请求体
 */
async function request (pathname, body) {
  const tavily = readTavilyConfig();
  const url = `${tavily.baseUrl}${pathname}`;

  logger.debug(`Tavily 请求 ${url}`);

  const startedAt = Date.now();

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tavily.apiKey}`
      },
      body: JSON.stringify(body)
    });
  } catch (err) {
    recordTavilyCall(pathname, Date.now() - startedAt);
    throw new TavilyApiError(`无法连接 Tavily 接口（${tavily.baseUrl}）：${err.message}`);
  }

  const text = await response.text();
  const elapsedMs = Date.now() - startedAt;

  // 性能观测：每次请求的耗时都打点，便于定位瓶颈（MCP_LOG_LEVEL=debug 可见）
  recordTavilyCall(pathname, elapsedMs);
  logger.debug(`Tavily ${pathname} 返回：${elapsedMs}ms（HTTP ${response.status}，响应 ${text.length} 字符）`);

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new TavilyApiError(
      `Tavily 接口返回了非 JSON 响应（HTTP ${response.status}）：${text.slice(0, 200)}`,
      { status: response.status }
    );
  }

  if (!response.ok) {
    const detail = payload?.detail?.error ?? payload?.error ?? payload?.message ?? "(空)";
    throw new TavilyApiError(`Tavily 接口返回错误：HTTP ${response.status}，${String(detail)}`, {
      status: response.status
    });
  }

  return payload;
}

/**
 * 关键词 AI 搜索。
 * @param {{query: string, searchDepth?: string, topic?: string, maxResults?: number,
 *   includeDomains?: string[], includeAnswer?: boolean, includeRawContent?: boolean}} options
 */
export async function search ({
  query,
  searchDepth = "basic",
  topic = "general",
  maxResults = 5,
  includeDomains,
  includeAnswer = true,
  includeRawContent = false
} = {}) {
  const body = {
    query,
    search_depth: searchDepth,
    topic,
    max_results: maxResults,
    include_answer: includeAnswer,
    include_raw_content: includeRawContent
  };

  if (Array.isArray(includeDomains) && includeDomains.length > 0) {
    body.include_domains = includeDomains;
  }

  return request("/search", body);
}

/**
 * 读取一个或多个页面的正文内容。
 * @param {{urls: string[], extractDepth?: string}} options
 */
export async function extract ({ urls, extractDepth = "basic" } = {}) {
  const list = (Array.isArray(urls) ? urls : [urls]).map((url) => String(url)).filter((url) => url !== "");

  if (list.length === 0) throw new Error("urls 不能为空");

  return request("/extract", {
    urls: list,
    extract_depth: extractDepth
  });
}
