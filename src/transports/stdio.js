/**
 * stdio 传输：通过标准输入/输出与宿主进程（如 Claude Desktop、VS Code、Cursor）通信。
 *
 * 这是最常用的本地接入方式：客户端把本服务作为子进程启动，用换行分隔的 JSON-RPC 消息通信。
 * 要点：stdout 只能承载协议消息，日志等一切输出必须走 stderr（见 logger.js）。
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { logger } from "../logger.js";

/**
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 */
export async function startStdioServer (server) {
  const transport = new StdioServerTransport();

  await server.connect(transport);

  logger.always(`stdio 传输已就绪（pid=${process.pid}），等待客户端消息。`);

  return transport;
}
