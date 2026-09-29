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

const currentLevel = LEVELS[(process.env.MCP_LOG_LEVEL || "info").toLowerCase()] ?? LEVELS.info;

function write (level, stream, args) {
  if (LEVELS[level] < currentLevel) return;
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
