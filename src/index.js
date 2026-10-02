#!/usr/bin/env node
/**
 * MCP 示例服务入口。
 *
 * 用法：
 *   node src/index.js                        # 默认 stdio 传输（供本地 MCP 客户端拉起）
 *   node src/index.js --transport=http       # Streamable HTTP 传输
 *   node src/index.js --transport=http --port=3000 --host=0.0.0.0 --path=/mcp
 *   node src/index.js --help
 */
import { createServer, SERVER_INFO } from "./server.js";
import { startStdioServer } from "./transports/stdio.js";
import { startHttpServer } from "./transports/http.js";
import { logger } from "./logger.js";

const VALID_TRANSPORTS = ["stdio", "http"];

const USAGE = `
${SERVER_INFO.title}（${SERVER_INFO.name} v${SERVER_INFO.version}）

用法:
  quark-drive-mcp [选项]

选项:
  --transport <stdio|http>  传输方式，默认 stdio（也可用环境变量 MCP_TRANSPORT）
  --port <number>           HTTP 模式监听端口，默认 3000
  --host <string>           HTTP 模式监听地址，默认 127.0.0.1
  --path <string>           HTTP 模式 MCP 端点路径，默认 /mcp
  --token <string>          HTTP 模式访问令牌（也可用环境变量 MCP_HTTP_TOKEN）；
                            配置后请求必须携带 Authorization: Bearer <token>
  --allow-insecure          允许「非回环地址 + 无令牌」的 HTTP 监听（会把网盘能力暴露出去，谨慎使用）
  -h, --help                显示帮助信息
  -v, --version             显示版本号

示例:
  node src/index.js --transport=http --port=3000
  node src/index.js --transport=http --host=0.0.0.0 --token=my-secret-token
  npx @modelcontextprotocol/inspector node src/index.js
`;

/** 判断监听地址是否为回环地址（只有回环地址才允许无令牌暴露） */
function isLoopbackHost (host) {
  const value = String(host ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");

  if (value === "localhost" || value === "::1" || value === "0:0:0:0:0:0:0:1") return true;
  if (value.startsWith("127.")) return true;
  // IPv4 映射的 IPv6 回环地址，如 ::ffff:127.0.0.1
  if (value.startsWith("::ffff:127.")) return true;

  return false;
}

/** 环境变量里的布尔开关：1/true/yes/on 视为开启 */
function envFlag (name) {
  const value = String(process.env[name] ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/**
 * 解析命令行参数，同时支持 `--key=value` 与 `--key value` 两种写法。
 * @param {string[]} argv
 */
function parseArgs (argv) {
  const options = {
    transport: (process.env.MCP_TRANSPORT || "stdio").toLowerCase(),
    port: Number(process.env.PORT || 3000),
    host: process.env.HOST || "127.0.0.1",
    path: process.env.MCP_PATH || "/mcp",
    token: process.env.MCP_HTTP_TOKEN || "",
    allowInsecure: envFlag("MCP_HTTP_ALLOW_INSECURE"),
    help: false,
    version: false
  };

  const valueFlags = new Set(["transport", "port", "host", "path", "token"]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // 忽略位置参数，兼容 `-h` 与 `--help` 两种写法
    if (!arg.startsWith("-") || arg === "-") continue;

    const raw = arg.startsWith("--") ? arg.slice(2) : arg.slice(1);
    const eqIndex = raw.indexOf("=");
    const key = eqIndex === -1 ? raw : raw.slice(0, eqIndex);
    const inlineValue = eqIndex === -1 ? undefined : raw.slice(eqIndex + 1);
    const value = inlineValue ?? (valueFlags.has(key) ? argv[++i] : undefined);

    switch (key) {
      case "transport":
        options.transport = String(value || "").toLowerCase();
        break;
      case "port":
        options.port = Number(value);
        break;
      case "host":
        options.host = String(value || "");
        break;
      case "path":
        options.path = String(value || "");
        break;
      case "token":
        options.token = String(value || "").trim();
        break;
      case "allow-insecure":
        options.allowInsecure = true;
        break;
      case "help":
      case "h":
        options.help = true;
        break;
      case "version":
      case "v":
        options.version = true;
        break;
      default:
        logger.warn(`忽略未知参数：--${key}`);
    }
  }

  return options;
}

/** 注册信号处理，确保退出前释放监听端口与连接 */
function setupGracefulShutdown (cleanup) {
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.always(`收到 ${signal}，正在关闭服务……`);
    try {
      await cleanup();
    } catch (err) {
      logger.error("关闭过程中出现异常：", err);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

async function main () {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(USAGE.trimStart());
    return;
  }

  if (options.version) {
    process.stdout.write(`${SERVER_INFO.name} ${SERVER_INFO.version}\n`);
    return;
  }

  if (!VALID_TRANSPORTS.includes(options.transport)) {
    logger.error(`不支持的传输方式：${options.transport}，可选值：${VALID_TRANSPORTS.join(" | ")}`);
    process.exit(1);
  }

  if (options.transport === "http" && (!Number.isInteger(options.port) || options.port <= 0)) {
    logger.error(`端口号无效：${options.port}`);
    process.exit(1);
  }

  // ── 暴露面防护 ────────────────────────────────────────────────────────────
  // 本服务持有夸克 Cookie，等价于「网盘读取 + 下载」权限。
  // 监听非回环地址且未配置令牌时，任何能访问该端口的人都继承了这份权限，因此默认拒绝启动。
  const exposed = !isLoopbackHost(options.host);

  if (options.transport === "http" && exposed && options.token === "" && !options.allowInsecure) {
    logger.error(
      [
        `拒绝启动：HTTP 监听地址 ${options.host} 不是回环地址，且未配置访问令牌。`,
        "  这会把你的夸克网盘能力（读目录、取直链、提交下载）暴露给任何能访问该端口的人。",
        "  请二选一：",
        "    1) 配置令牌：--token=<令牌> 或环境变量 MCP_HTTP_TOKEN；",
        "       客户端随后必须携带请求头 Authorization: Bearer <令牌>。",
        "    2) 确认已由外层（如反向代理 / 内网隔离）保护，显式接受风险：",
        "       加 --allow-insecure 或设置 MCP_HTTP_ALLOW_INSECURE=1。",
        "  仅本机使用请保持默认的 --host=127.0.0.1。"
      ].join("\n")
    );
    process.exit(1);
  }

  // 供 config://server 资源展示当前传输方式
  process.env.MCP_TRANSPORT = options.transport;
  if (options.token !== "") process.env.MCP_HTTP_TOKEN = options.token;

  if (options.transport === "http") {
    if (exposed) {
      logger.warn(
        `⚠️ HTTP 正在监听非回环地址 ${options.host}，服务已暴露到本机之外` +
        (options.token === ""
          ? "，且未启用令牌校验（--allow-insecure）。"
          : "（已启用 Bearer 令牌校验）。")
      );
    } else if (options.token !== "") {
      logger.info("HTTP 已启用 Bearer 令牌校验。");
    } else if (options.allowInsecure) {
      logger.info("已启用 --allow-insecure，但监听地址仍是回环地址，风险可控。");
    }
  }

  logger.always(`启动 ${SERVER_INFO.name} v${SERVER_INFO.version}（transport=${options.transport}）`);

  if (options.transport === "http") {
    const { close } = await startHttpServer(createServer, options);
    setupGracefulShutdown(close);
  } else {
    const server = createServer();
    await startStdioServer(server);
    setupGracefulShutdown(() => server.close());
  }
}

main().catch((err) => {
  logger.error("服务启动失败：", err);
  process.exit(1);
});
