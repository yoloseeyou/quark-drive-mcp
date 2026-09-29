/**
 * 工具注册入口：集中挂载所有 Tool。
 * 新增一个工具时，只需在 tools/ 下新建文件并在此处引入一行即可。
 */
import { registerAria2Tools } from "./aria2.js";
import { registerDriveTools } from "./drive.js";

/**
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 */
export function registerTools (server) {
  registerDriveTools(server);
  registerAria2Tools(server);
}
