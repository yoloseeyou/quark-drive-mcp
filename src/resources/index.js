/**
 * 资源注册入口：集中挂载所有 Resource 与 ResourceTemplate。
 */
import { registerAppInfoResources } from "./app-info.js";

/**
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 */
export function registerResources (server) {
  registerAppInfoResources(server);
}
