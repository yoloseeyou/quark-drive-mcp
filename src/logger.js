/**
 * 统一日志工具。
 *
 * ⚠️ 关键点：当使用 stdio 传输时，进程的 stdout 被 JSON-RPC 协议独占，
 * 任何打印到 stdout 的内容都会破坏协议握手。因此所有日志必须写入 stderr。
 */
import { format } from "node:util";

const PREFIX = "[quark-drive]";

/** 可通过环境变量 MCP_LOG_LEVEL=debug|info|warn|error|silent 调整日志级别 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/**
 * 读取当前日志级别。
 *
 * ⚠️ 刻意在每次写入时读取，而不是在模块求值时固化：
 *    .env 由 env.js 加载，而 env.js 与 logger.js 的求值顺序取决于 import 图的细节，
 *    固化会让 MCP_LOG_LEVEL 是否生效变成一个「依赖 import 顺序」的隐式契约。
 *    延迟读取消除了这个隐性依赖，也让测试可以随时改级别。
 */
function currentLevel () {
  const name = String(process.env.MCP_LOG_LEVEL || "info").toLowerCase();
  return LEVELS[name] ?? LEVELS.info;
}

function write (level, stream, args) {
  if (LEVELS[level] < currentLevel()) return;
  const timestamp = new Date().toISOString();
  stream.write(`${timestamp} ${PREFIX} ${level.toUpperCase().padEnd(5)} ${format(...args)}\n`);
}

export const logger = {
  debug: (...args) => write("debug", process.stderr, args),
  info: (...args) => write("info", process.stderr, args),
  warn: (...args) => write("warn", process.stderr, args),
  error: (...args) => write("error", process.stderr, args),
  /** 无论日志级别如何都输出，用于启动横幅等关键信息 */
  always: (...args) => process.stderr.write(`${PREFIX} ${format(...args)}\n`)
};
