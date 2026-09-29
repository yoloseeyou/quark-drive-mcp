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
  -h, --help                显示帮助信息
  -v, --version             显示版本号

示例:
  node src/index.js --transport=http --port=3000
  npx @modelcontextprotocol/inspector node src/index.js
`;

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
    help: false,
    version: false
  };

  const valueFlags = new Set(["transport", "port", "host", "path"]);

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

  // 供 config://server 资源展示当前传输方式
  process.env.MCP_TRANSPORT = options.transport;

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
