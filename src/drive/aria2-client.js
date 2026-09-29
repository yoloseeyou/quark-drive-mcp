/**
 * aria2 JSON-RPC 客户端。
 *
 * 协议要点：
 *  - 端点固定为 JSON-RPC 2.0，Body 形如 { id, jsonrpc:"2.0", method, params }；
 *  - 若服务端配置了 rpc-secret，params[0] 必须是 `token:<secret>`，否则整组参数前移；
 *  - addUri 的 options 支持 dir（目录）、out（文件名）、header（请求头数组）。
 *
 * 夸克直链存在防盗链，因此提交任务时统一注入 User-Agent 与 Referer 请求头。
 */
import { getConfig } from "../config.js";
import { logger } from "../logger.js";

/** aria2 RPC 错误 */
export class Aria2RpcError extends Error {
  constructor(message, code = null) {
    super(message);
    this.name = "Aria2RpcError";
    this.code = code;
  }
}

/** 支持的任务控制动作 → aria2 方法名 */
const CONTROL_METHODS = {
  pause: "aria2.pause",
  unpause: "aria2.unpause",
  remove: "aria2.remove",
  forceRemove: "aria2.forceRemove"
};

let nextId = Date.now();

/**
 * 发起一次 RPC 调用。
 * @param {string} method aria2 方法名
 * @param {unknown[]} params 业务参数（不含 token）
 */
async function call (method, params = []) {
  const { aria2 } = getConfig();
  const tokenPrefix = aria2.secret === "" ? [] : [`token:${aria2.secret}`];

  const body = {
    id: ++nextId,
    jsonrpc: "2.0",
    method,
    params: [...tokenPrefix, ...params]
  };

  logger.debug(`aria2 RPC ${method} → ${aria2.rpcUrl}`);

  let response;
  try {
    response = await fetch(aria2.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (err) {
    throw new Aria2RpcError(`无法连接 aria2 RPC（${aria2.rpcUrl}）：${err.message}`);
  }

  const text = await response.text();

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Aria2RpcError(`aria2 RPC 返回了非 JSON 响应（HTTP ${response.status}）：${text.slice(0, 200)}`);
  }

  if (payload.error) {
    throw new Aria2RpcError(
      `aria2 RPC 错误 ${payload.error.code}：${payload.error.message}`,
      payload.error.code
    );
  }

  return payload.result;
}

/** 探测 RPC 连通性与版本信息 */
export async function getVersion () {
  return call("aria2.getVersion");
}

/** 构造下载请求头：夸克直链需要正确的 UA、Referer 与 Cookie 才能下载 */
export function buildDownloadHeaders () {
  const { quark } = getConfig();
  return [
    `User-Agent: ${quark.userAgent}`,
    `Referer: ${quark.referer}`,
    // CDN 存在防盗链校验，缺少 Cookie 时直链会返回 412 Precondition Failed
    `Cookie: ${quark.cookie}`
  ];
}

/**
 * 提交一个下载任务。
 * @param {string|string[]} uris 一个或多个下载地址（同一任务的多源）
 * @param {{dir?: string, out?: string, split?: number}} options
 * @returns {Promise<string>} gid
 */
export async function addUri (uris, { dir, out, split } = {}) {
  const list = (Array.isArray(uris) ? uris : [uris]).map((uri) => String(uri)).filter((uri) => uri !== "");

  if (list.length === 0) throw new Error("uris 不能为空");

  const { aria2 } = getConfig();
  const options = { header: buildDownloadHeaders() };

  const targetDir = dir || aria2.downloadDir;
  if (targetDir !== "") options.dir = targetDir;
  if (out) options.out = out;
  if (Number.isInteger(split) && split > 0) options.split = split;

  return call("aria2.addUri", [list, options]);
}

/**
 * 查询任务状态。
 * @param {string} gid
 * @param {string[]} [keys] 仅返回指定字段，减少传输量
 */
export async function tellStatus (gid, keys) {
  return keys && keys.length > 0 ? call("aria2.tellStatus", [gid, keys]) : call("aria2.tellStatus", [gid]);
}

/**
 * 控制任务：暂停 / 继续 / 删除。
 * @param {"pause"|"unpause"|"remove"|"forceRemove"} action
 * @param {string} gid
 */
export async function controlTask (action, gid) {
  const method = CONTROL_METHODS[action];

  if (method === undefined) {
    throw new Error(`不支持的任务操作：${action}（可选：${Object.keys(CONTROL_METHODS).join(" / ")}）`);
  }

  return call(method, [gid]);
}

/** 导出支持的动作列表，供工具层生成 zod enum */
export const CONTROL_ACTIONS = Object.keys(CONTROL_METHODS);
