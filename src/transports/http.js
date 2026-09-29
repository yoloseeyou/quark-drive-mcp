/**
 * Streamable HTTP 传输：通过 HTTP 把 MCP 服务暴露给远程/浏览器客户端。
 *
 * 协议要点：
 *  - POST /mcp 携带 initialize 请求 → 服务端返回 mcp-session-id 响应头，建立会话；
 *  - 后续请求必须回传该 mcp-session-id 头，服务端据此路由到对应会话；
 *  - GET /mcp 用于服务端到客户端的 SSE 通知流；
 *  - DELETE /mcp 用于客户端主动终止会话。
 *
 * 会话隔离：每个会话绑定一个独立的 McpServer 实例，
 * 因此 todo 工具的状态不会在不同客户端之间串扰。
 */
import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { logger } from "../logger.js";

/** 请求体大小上限，防止超大 payload 拖垮进程 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers":
    "content-type, authorization, mcp-session-id, mcp-protocol-version, last-event-id",
  // 浏览器端 JS 需要读取 mcp-session-id 才能维持会话
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
  "access-control-max-age": "86400"
};

/** 读取并解析 JSON 请求体 */
function readJsonBody (req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`请求体超过 ${limit} 字节上限`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`请求体不是合法 JSON：${err.message}`));
      }
    });

    req.on("error", reject);
  });
}

function sendJson (res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    ...CORS_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

/** 返回符合 JSON-RPC 2.0 规范的错误响应 */
function sendRpcError (res, statusCode, code, message) {
  logger.warn(`HTTP ${statusCode}：${message}`);
  sendJson(res, statusCode, { jsonrpc: "2.0", error: { code, message }, id: null });
}

/**
 * 启动 HTTP 服务。
 *
 * @param {() => import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} createMcpServer
 *        服务工厂函数，每个会话调用一次以创建独立实例
 * @param {{ port?: number, host?: string, path?: string }} options
 */
export async function startHttpServer (createMcpServer, { port = 3000, host = "127.0.0.1", path = "/mcp" } = {}) {
  /** @type {Map<string, { transport: StreamableHTTPServerTransport, server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer }>} */
  const sessions = new Map();

  const httpServer = createHttpServer(async (req, res) => {
    try {
      // 浏览器跨域预检
      if (req.method === "OPTIONS") {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
      }

      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);

      // 健康检查端点，便于容器编排与人工排查
      if (url.pathname === "/health" && req.method === "GET") {
        sendJson(res, 200, {
          status: "ok",
          sessions: sessions.size,
          uptimeSeconds: Math.round(process.uptime())
        });
        return;
      }

      if (url.pathname !== path) {
        sendRpcError(res, 404, -32000, `未知路径 ${url.pathname}，MCP 端点为 ${path}`);
        return;
      }

      const sessionHeader = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
      const existingSession = sessionId ? sessions.get(sessionId) : undefined;

      // 已有会话：GET（SSE 流）/ POST / DELETE 一律交给对应 transport 处理
      if (existingSession) {
        await existingSession.transport.handleRequest(req, res);
        return;
      }

      // 未知 sessionId 属于客户端错误
      if (sessionId) {
        sendRpcError(res, 404, -32000, `会话 ${sessionId} 不存在或已过期，请重新 initialize。`);
        return;
      }

      if (req.method === "POST") {
        const body = await readJsonBody(req).catch((err) => {
          sendRpcError(res, 400, -32700, err.message);
          return Symbol.for("body-error");
        });

        if (body === Symbol.for("body-error")) return;

        // 只有 initialize 请求才允许建立新会话
        if (!isInitializeRequest(body)) {
          sendRpcError(
            res,
            400,
            -32000,
            "未找到有效会话。首个请求必须是 initialize，并携带其响应返回的 mcp-session-id 头。"
          );
          return;
        }

        /** @type {StreamableHTTPServerTransport} */
        let transport;
        const server = createMcpServer();

        transport = new StreamableHTTPServerTransport({
          // 返回随机 UUID 作为会话标识（返回 undefined 则退化为无状态模式）
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, { transport, server });
            logger.info(`HTTP 会话已建立：${sid}（当前会话数 ${sessions.size}）`);
          }
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && sessions.delete(sid)) {
            logger.info(`HTTP 会话已关闭：${sid}（当前会话数 ${sessions.size}）`);
          }
        };

        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        sendRpcError(res, 400, -32000, "缺少有效的 mcp-session-id 头。");
        return;
      }

      sendRpcError(res, 405, -32000, `不支持的 HTTP 方法：${req.method}`);
    } catch (err) {
      logger.error("处理 HTTP 请求时发生异常：", err);

      if (!res.headersSent) {
        sendRpcError(res, 500, -32603, `服务端内部错误：${err.message}`);
      } else {
        res.end();
      }
    }
  });

  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, resolve);
  });

  const actualPort = httpServer.address().port;
  logger.always(`HTTP 传输已就绪：http://${host}:${actualPort}${path}`);

  return {
    httpServer,
    sessions,
    /** 关闭所有会话与 HTTP 服务 */
    async close () {
      for (const { transport } of sessions.values()) {
        await transport.close().catch(() => { });
      }
      sessions.clear();
      await new Promise((resolve) => httpServer.close(resolve));
    }
  };
}
