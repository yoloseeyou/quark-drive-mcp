/**
 * MCP 服务核心：创建并组装 McpServer 实例。
 *
 * 这里把「服务能力」与「传输方式」彻底解耦：
 *  - server.js 只负责注册 tools / resources
 *  - transports/*.js 负责用 stdio 或 HTTP 把服务暴露出去
 * 这样同一个服务既能被本地 CLI 客户端使用，也能被远程 HTTP 客户端使用。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerTools } from "./tools/index.js";
import { registerResources } from "./resources/index.js";

/** 服务元信息，会通过 initialize 响应返回给客户端 */
export const SERVER_INFO = {
  name: "quark-drive-mcp",
  title: "夸克网盘 MCP 服务",
  version: "1.0.0"
};

const INSTRUCTIONS = [
  "这是一个面向夸克网盘的 MCP 服务，提供五类能力：",
  "1) 查询：drive_list_files（列出一层目录）、drive_resolve_path（按路径逐层解析 fid）。",
  "2) 取链：drive_get_download_links（按 fid 获取带签名的下载直链）。",
  "3) 下载：drive_push_to_aria2（提交到 aria2 RPC）、aria2_task_status、aria2_task_control。",
  "4) 搜索：tavily_search（关键词 AI 搜索）、tavily_extract_links（读取指定页面提取分享链接）、",
  "   tavily_search_links（一步完成搜索 → 抓正文 → 提取链接，适合第三方资源站场景）。",
  "5) 分享浏览与直接下载：drive_parse_share_link（解析分享链接）、drive_list_share_files（浏览分享内容）、",
  "   drive_get_share_download_links（按分享内 fid 或路径直接换取直链，无需转存）。",
  "另有 drive_cache_manage 用于查看与清理目录缓存。",
  "两条推荐链路：",
  "A. 分享下载（无需转存）：tavily_search_links 取分享链接 → drive_parse_share_link 解析 → drive_list_share_files 浏览 → ",
  "   drive_get_share_download_links 取直链 → drive_push_to_aria2（urls 参数）提交下载。",
  "B. 自有文件下载：drive_resolve_path 或 drive_list_files 定位 fid → drive_get_download_links 取直链 → drive_push_to_aria2。",
  "注意：分享内 fid 与网盘 fid 不是同一套，后者才是 drive_get_download_links 的输入。",
  "⚠️ 提交下载属于写操作：drive_push_to_aria2 默认只返回待确认清单（文件名、大小、地址、下载位置、合计大小）与一次性 confirm_token，" +
  "必须先把清单交给用户确认，再携带 confirm_token 调用一次才会真正获取直链并提交。",
  "目录查询结果按父目录 fid 缓存并带 TTL，返回文本会明确提示「缓存命中 / 来自网络」。"
].join("\n");

/**
 * 创建一个全新的 MCP 服务实例。
 *
 * 每次创建都返回独立实例，这是 HTTP 有状态会话模式所必需的：
 * 每个客户端会话必须绑定到自己的 McpServer，避免会话之间状态串扰。
 * 注意：目录缓存位于 src/drive/cache.js 的模块级单例中，因此同一进程内多个会话共享缓存。
 *
 * @returns {McpServer}
 */
export function createServer () {
  const server = new McpServer(SERVER_INFO, {
    // 声明服务级能力：logging 允许服务端主动向客户端推送日志消息
    capabilities: { logging: {} },
    instructions: INSTRUCTIONS
  });

  registerTools(server);
  registerResources(server);

  return server;
}
