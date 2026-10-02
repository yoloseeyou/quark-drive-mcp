/**
 * Streamable HTTP 传输（Hono 实现）：通过 HTTP 把 MCP 服务暴露给远程/浏览器客户端。
 *
 * 为什么改成 Hono：
 *  - 官方 SDK 的 `StreamableHTTPServerTransport` 本身就是一层「Node req/res → Web Standard」
 *    适配（内部同样依赖 `@hono/node-server` 的 `getRequestListener`）。直接用
 *    `WebStandardStreamableHTTPServerTransport` + Hono，可以省掉这层适配，路由、CORS、
 *    鉴权都用声明式中间件表达，不再手写 Node 回调里的一串分支。
 *  - 同一份 handler 在 Node / Bun / Deno / Workers 上语义一致，本文件用
 *    `@hono/node-server` 的 `serve()` 提供 Node 监听。
 *
 * 协议要点（沿用 MCP Streamable HTTP 规范）：
 *  - POST /mcp 携带 initialize 请求 → 响应头返回 mcp-session-id，建立会话；
 *  - 后续请求必须回传该 mcp-session-id 头，服务端据此路由到对应会话；
 *  - GET /mcp 用于服务端到客户端的 SSE 通知流；
 *  - DELETE /mcp 用于客户端主动终止会话。
 *
 * 会话隔离：每个会话绑定一个独立的 McpServer 实例与 transport，
 * 因此工具状态不会在不同客户端之间串扰。
 *
 * ⚠️ 鉴权：本服务持有夸克 Cookie，等价于「你的网盘读取与下载权限」。
 *    只要配置了 token（--token / MCP_HTTP_TOKEN），除 CORS 预检外的所有请求
 *    都必须携带 `Authorization: Bearer <token>`，否则一律返回 401。
 *    未配置 token 时不做校验，因此 index.js 会拒绝「非回环地址 + 无令牌」的启动组合。
 */
import { randomUUID, timingSafeEqual } from "node:crypto";

import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { logger } from "../logger.js";

/** 请求体大小上限，防止超大 payload 拖垮进程（与 SDK 默认值一致） */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** CORS 预检缓存时长（秒） */
const CORS_MAX_AGE_SECONDS = 86400;

/** 请求体超过上限时抛出，便于区分「超限（413）」与「不是合法 JSON（400）」 */
class BodyTooLargeError extends Error {
  constructor (limit) {
    super(`请求体超过 ${limit} 字节上限`);
    this.name = "BodyTooLargeError";
  }
}

/** 常量时间字符串比较，避免通过响应耗时逐字节猜出令牌 */
function safeEqual (a, b) {
  const left = Buffer.from(String(a), "utf8");
  const right = Buffer.from(String(b), "utf8");

  if (left.length !== right.length) return false;

  return timingSafeEqual(left, right);
}

/** 返回符合 JSON-RPC 2.0 规范的错误响应 */
function rpcError (status, code, message, extraHeaders = {}) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders
    }
  });
}

/** 取客户端地址用于日志；环境不具备连接信息时回退为占位符 */
function remoteAddress (c) {
  try {
    return getConnInfo(c).remote.address ?? "未知";
  } catch {
    return "未知";
  }
}

/**
 * 流式读取并解析 JSON 请求体。
 *
 * 不直接 `await c.req.text()`：那样会把任意大小的 body 先读进内存。
 * 这里按块累计，一旦超限立刻取消读取并抛出，避免超大请求拖垮进程。
 */
async function readJsonBody (request, limit = MAX_BODY_BYTES) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLargeError(limit);

  if (request.body === null) return undefined;

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      received += value.byteLength;
      if (received > limit) {
        await reader.cancel().catch(() => { });
        throw new BodyTooLargeError(limit);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  const raw = text.trim();
  if (!raw) return undefined;

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`请求体不是合法 JSON：${err.message}`);
  }
}

/**
 * 启动 HTTP 服务。
 *
 * @param {() => import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} createMcpServer
 *        服务工厂函数，每个会话调用一次以创建独立实例
 * @param {{ port?: number, host?: string, path?: string, token?: string }} options
 *        token 非空时启用 Bearer 鉴权
 */
export async function startHttpServer (
  createMcpServer,
  { port = 3000, host = "127.0.0.1", path = "/mcp", token = "" } = {}
) {
  /** @type {Map<string, { transport: WebStandardStreamableHTTPServerTransport, server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer }>} */
  const sessions = new Map();

  const expectedToken = String(token).trim();
  const authRequired = expectedToken !== "";

  const app = new Hono();

  // ── CORS ────────────────────────────────────────────────────────────────
  // 预检必须排在鉴权之前：浏览器按规范不会在 OPTIONS 预检里携带 Authorization。
  // hono/cors 会对 OPTIONS 直接短路返回 204，不进入后续中间件，因此不构成绕过。
  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "mcp-session-id", "mcp-protocol-version", "Last-Event-ID"],
      // 浏览器端 JS 需要读取 mcp-session-id 才能维持会话
      exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
      maxAge: CORS_MAX_AGE_SECONDS
    })
  );

  // ── 鉴权 ────────────────────────────────────────────────────────────────
  // 先于一切业务分支：健康检查同样需要令牌（它也会暴露会话数等信息）。
  app.use("*", async (c, next) => {
    if (!authRequired) return next();

    const header = c.req.header("authorization")?.trim() ?? "";
    const matched = /^Bearer\s+(.+)$/i.exec(header);

    if (matched === null || !safeEqual(matched[1], expectedToken)) {
      logger.warn(
        `HTTP 401：来自 ${remoteAddress(c)} 的请求未通过令牌校验（${c.req.method} ${c.req.path}）`
      );
      return rpcError(
        401,
        -32001,
        "未授权：请携带 Authorization: Bearer <token> 请求头（令牌由 MCP_HTTP_TOKEN 或 --token 配置）。"
      );
    }

    return next();
  });

  // ── 健康检查 ────────────────────────────────────────────────────────────
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      sessions: sessions.size,
      uptimeSeconds: Math.round(process.uptime()),
      authRequired
    })
  );

  // ── MCP 端点 ────────────────────────────────────────────────────────────
  app.all(path, async (c) => {
    const request = c.req.raw;
    const sessionId = c.req.header("mcp-session-id");
    const existingSession = sessionId ? sessions.get(sessionId) : undefined;

    // 已有会话：GET（SSE 流）/ POST / DELETE 一律交给对应 transport 处理
    if (existingSession) {
      return existingSession.transport.handleRequest(request);
    }

    // 未知 sessionId 属于客户端错误
    if (sessionId) {
      return rpcError(404, -32000, `会话 ${sessionId} 不存在或已过期，请重新 initialize。`);
    }

    if (request.method === "POST") {
      // 只有 initialize 请求才允许建立新会话，因此需要先看请求体。
      // 读过的 body 通过 parsedBody 交给 transport，避免它再读一次已消费的流。
      let body;
      try {
        body = await readJsonBody(request);
      } catch (err) {
        const tooLarge = err instanceof BodyTooLargeError;
        return rpcError(tooLarge ? 413 : 400, tooLarge ? -32600 : -32700, err.message);
      }

      if (!isInitializeRequest(body)) {
        return rpcError(
          400,
          -32000,
          "未找到有效会话。首个请求必须是 initialize，并携带其响应返回的 mcp-session-id 头。"
        );
      }

      /** @type {WebStandardStreamableHTTPServerTransport} */
      let transport;
      const server = createMcpServer();

      transport = new WebStandardStreamableHTTPServerTransport({
        // 返回随机 UUID 作为会话标识（返回 undefined 则退化为无状态模式）
        sessionIdGenerator: () => randomUUID(),
        // 与手写读取保持一致的上限；pre-parsed body 走不到这条校验，仅对会话内请求生效
        maxRequestBodySize: MAX_BODY_BYTES,
        onsessioninitialized: (sid) => {
          sessions.set(sid, { transport, server });
          logger.info(`HTTP 会话已建立：${sid}（当前会话数 ${sessions.size}）`);
        }
      });

      // ⚠️ 必须在 connect 之前赋值：Server.connect 会链式保留已有的 onclose
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && sessions.delete(sid)) {
          logger.info(`HTTP 会话已关闭：${sid}（当前会话数 ${sessions.size}）`);
        }
      };

      await server.connect(transport);

      try {
        return await transport.handleRequest(request, { parsedBody: body });
      } catch (err) {
        // 初始化失败时不留下悬挂会话
        if (transport.sessionId) sessions.delete(transport.sessionId);
        await transport.close().catch(() => { });
        throw err;
      }
    }

    if (request.method === "GET" || request.method === "DELETE") {
      return rpcError(400, -32000, "缺少有效的 mcp-session-id 头。");
    }

    return rpcError(405, -32000, `不支持的 HTTP 方法：${request.method}`);
  });

  // ── 兜底 ────────────────────────────────────────────────────────────────
  app.notFound((c) => rpcError(404, -32000, `未知路径 ${c.req.path}，MCP 端点为 ${path}`));

  app.onError((err, c) => {
    logger.error("处理 HTTP 请求时发生异常：", err);
    return rpcError(500, -32603, `服务端内部错误：${err.message}`);
  });

  // ── 启动监听 ────────────────────────────────────────────────────────────
  const server = serve(
    {
      fetch: app.fetch,
      port,
      hostname: host,
      // 不覆盖全局 Request/Response，避免污染宿主环境的实现
      overrideGlobalObjects: false
    },
    () => { }
  );

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", resolve);
  });

  const actualPort = server.address().port;
  logger.always(
    `HTTP 传输已就绪（Hono）：http://${host}:${actualPort}${path}` +
    `（鉴权：${authRequired ? "已启用 Bearer 令牌" : "未启用，请确保仅监听回环地址"}）`
  );

  return {
    server,
    sessions,
    authRequired,
    /** 关闭所有会话与 HTTP 服务 */
    async close () {
      for (const { transport } of sessions.values()) {
        await transport.close().catch(() => { });
      }
      sessions.clear();

      await new Promise((resolve) => {
        server.close(resolve);
        // 关掉 keep-alive 空闲连接，否则 close 回调可能永远不触发
        server.closeIdleConnections?.();
      });
    }
  };
}
