/**
 * 服务信息资源。
 *
 * 与工具的区别：工具由模型决定调用，资源由客户端/用户读取，只提供只读上下文。
 * 这里暴露两个静态资源：
 *  - config://server：当前配置（敏感值脱敏）与缓存统计
 *  - docs://usage：本服务的工具清单与推荐调用顺序
 */
import { describeConfig } from "../config.js";
import { cacheStats } from "../drive/cache.js";
import { confirmStoreStats } from "../drive/confirm-store.js";
import { SERVER_INFO } from "../server.js";
import { tavilyCallStats } from "../search/tavily-client.js";

/** 服务启动时间，用于说明资源内容可以动态计算 */
const STARTED_AT = new Date().toISOString();

export function registerAppInfoResources (server) {
  // 资源一：以 JSON 形式暴露服务自身配置（Cookie 与 RPC 密钥已脱敏）
  server.registerResource(
    "server-config",
    "config://server",
    {
      title: "服务配置",
      description: "当前 MCP 服务的名称、版本、传输方式、网盘/Aria2 配置（脱敏）与目录缓存统计（JSON 格式）。",
      mimeType: "application/json"
    },
    async (uri) => {
      const config = {
        name: SERVER_INFO.name,
        title: SERVER_INFO.title,
        version: SERVER_INFO.version,
        protocolVersionHint: "由客户端在 initialize 时协商确定",
        transport: process.env.MCP_TRANSPORT || "stdio",
        // 仅暴露「是否启用」的布尔量，绝不回显令牌本身
        httpAuthRequired: (process.env.MCP_HTTP_TOKEN || "").trim() !== "",
        pid: process.pid,
        nodeVersion: process.version,
        startedAt: STARTED_AT,
        logLevel: process.env.MCP_LOG_LEVEL || "info",
        drive: describeConfig(),
        cache: cacheStats(),
        // 性能观测：Tavily 各端点的累计调用次数与耗时，以及写操作确认令牌的统计
        tavilyCalls: tavilyCallStats(),
        confirmTokens: confirmStoreStats()
      };

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(config, null, 2)
          }
        ]
      };
    }
  );

  // 资源二：以 Markdown 形式提供使用说明，客户端可直接注入模型上下文
  server.registerResource(
    "usage-docs",
    "docs://usage",
    {
      title: "使用说明",
      description: "网盘 MCP 服务的工具清单、推荐调用顺序与缓存说明（Markdown 格式）。",
      mimeType: "text/markdown"
    },
    async (uri) => {
      const markdown = [
        "# 夸克网盘 MCP 服务使用说明",
        "",
        "## 推荐调用顺序 A：分享下载（无需转存）",
        "1. `tavily_search_links`：搜索并提取网盘分享链接（也可用 `tavily_search` + `tavily_extract_links` 分两步）",
        "2. `drive_parse_share_link` → `drive_list_share_files`：解析并浏览分享内容（只读）",
        "3. `drive_get_share_download_links`：按分享内 `fid` 或路径直接换取下载直链",
        "4. `drive_push_to_aria2`：把直链作为 `urls` 提交下载（写操作，需用户确认）",
        "5. `aria2_task_status` / `aria2_task_control`：查看进度、暂停或删除任务",
        "",
        "## 推荐调用顺序 B：自有网盘文件下载",
        "1. `drive_resolve_path` 或 `drive_list_files`：定位文件 `fid`",
        "2. `drive_get_download_links`：用 `fid` 换取带签名的下载直链",
        "3. `drive_push_to_aria2`：提交下载（写操作，需用户确认）",
        "",
        "## 写操作确认闸门",
        "- `drive_push_to_aria2` 默认只返回待确认清单与一次性 `confirm_token`，此时**不取直链、不产生任务**",
        "- 清单包含：文件名、大小、类型、地址、下载位置与合计大小，请完整呈现给用户确认",
        "- 用户确认后携带 `confirm_token` 再次调用才会提交；令牌默认 5 分钟有效（`CONFIRM_TTL_MS` 可调）且仅可用一次",
        "- 提交阶段若再传 `fids` / `share_fids` / `urls` 会被拒绝，避免与已确认清单不一致",
        "",
        "## 工具（Tools）",
        "| 名称 | 说明 |",
        "| --- | --- |",
        "| `drive_list_files` | 列出一层目录，支持分页与缓存提示 |",
        "| `drive_resolve_path` | 按 / 分隔路径逐层解析为 fid |",
        "| `drive_get_download_links` | 按文件 fid 获取直链（约 1 小时有效） |",
        "| `drive_push_to_aria2` | 按 fid 或直链提交下载任务 |",
        "| `aria2_task_status` | 查询任务状态与进度 |",
        "| `aria2_task_control` | 暂停 / 继续 / 删除任务 |",
        "| `drive_cache_manage` | 查看统计或清理目录缓存 |",
        "| `tavily_search` | 关键词 AI 搜索（需 TAVILY_API_KEY） |",
        "| `tavily_extract_links` | 读取指定页面并提取网盘分享链接（需 TAVILY_API_KEY） |",
        "| `tavily_search_links` | 一步完成搜索 + 抓正文 + 提取网盘链接，含提取码与来源（需 TAVILY_API_KEY） |",
        "| `drive_parse_share_link` | 解析夸克分享链接，得到 `pwd_id` 与提取码（不联网） |",
        "| `drive_list_share_files` | 浏览分享内文件（只读） |",
        "| `drive_get_share_download_links` | 按分享内 fid 或路径直接取直链，**无需转存** |",
        "",
        "## 缓存说明",
        "- 目录查询结果按父目录 `fid` 缓存在内存中，键为 `pdir_fid:page:size`",
        "- 默认 TTL 为 1 小时，可用环境变量 `DRIVE_CACHE_TTL_MS` 调整",
        "- 每次查询的返回文本都会标注「缓存命中 / 来自网络」及数据年龄",
        "- 缓存仅在当前进程内有效，重启即失效；可用 `drive_cache_manage` 手动清理",
        "- 下载直链带签名有效期，因此不做缓存，每次实时获取",
        "",
        "## 提示",
        "若工具返回 `isError: true`，请阅读错误文案后修正参数重试；" +
        "例如路径不存在时会给出该目录的可选项，同名歧义时会给出候选 fid。"
      ].join("\n");

      return {
        contents: [{ uri: uri.href, mimeType: "text/markdown", text: markdown }]
      };
    }
  );
}
