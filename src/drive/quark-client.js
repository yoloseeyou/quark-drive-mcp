/**
 * 夸克网盘接口客户端。
 *
 * 封装两个接口：
 *  1) 列目录 GET  /1/clouddrive/file/sort    —— 按父目录 fid 分页列出直接子项
 *  2) 取直链 POST /1/clouddrive/file/download —— 按 fids 批量获取带签名的下载地址
 *
 * 共同点：
 *  - 鉴权走 Cookie 请求头，并统一伪装 UA / Referer / Origin；
 *  - 公共 query（pr、fr、uc_param_str）自动注入；
 *  - 响应 HTTP 200 不代表成功，必须校验 code === 0；
 *  - 分页元数据位于响应「顶层」metadata（_page / _size / _count / _total）。
 */
import { requireQuarkConfig } from "../config.js";
import { logger } from "../logger.js";

/** 夸克接口业务错误。code 非 0 时抛出，便于上层区分「凭证失效」「目录不存在」等情况 */
export class QuarkApiError extends Error {
  constructor(message, { code = null, status = null, reqId = null } = {}) {
    super(message);
    this.name = "QuarkApiError";
    this.code = code;
    this.status = status;
    this.reqId = reqId;
  }
}

function buildHeaders () {
  // 未配置 QUARK_COOKIE 时在此抛出可读错误，由工具层转为 isError
  const quark = requireQuarkConfig();

  return {
    cookie: quark.cookie,
    "user-agent": quark.userAgent,
    referer: quark.referer,
    origin: quark.origin,
    accept: "application/json, text/plain, */*"
  };
}

/**
 * 发起一次夸克接口请求。
 * @param {string} pathname 接口路径，如 /1/clouddrive/file/sort
 * @param {{method?: string, query?: Record<string, unknown>, body?: unknown}} options
 */
async function request (pathname, { method = "GET", query = {}, body } = {}) {
  const quark = requireQuarkConfig();

  const url = new URL(`${quark.baseUrl}${pathname}`);
  url.searchParams.set("pr", quark.pr);
  url.searchParams.set("fr", quark.fr);
  if (quark.ucParamStr !== "") url.searchParams.set("uc_param_str", quark.ucParamStr);

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  const headers = buildHeaders();
  const init = { method, headers };

  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  logger.debug(`夸克请求 ${method} ${url.pathname}${url.search.replace(/cookie=[^&]*/i, "cookie=***")}`);

  let response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    throw new QuarkApiError(`无法连接夸克接口（${url.origin}）：${err.message}`);
  }

  const text = await response.text();

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new QuarkApiError(
      `夸克接口返回了非 JSON 响应（HTTP ${response.status}）：${text.slice(0, 200)}`,
      { status: response.status }
    );
  }

  if (payload.code !== 0) {
    throw new QuarkApiError(
      `夸克接口返回错误：code=${payload.code}，message=${payload.message || "(空)"}`,
      { code: payload.code, status: response.status, reqId: payload.metadata?.req_id ?? null }
    );
  }

  return payload;
}

/** 从响应中提取分页元数据：优先顶层 metadata，兼容 data.metadata */
function readMetadata (payload, fallback) {
  const meta = payload.metadata ?? payload.data?.metadata ?? {};

  return {
    page: Number(meta._page ?? fallback.page),
    size: Number(meta._size ?? fallback.size),
    count: Number(meta._count ?? 0),
    total: Number(meta._total ?? 0),
    reqId: meta.req_id ?? null
  };
}

/**
 * 列出一个目录的直接子项（一层）。
 * @param {{pdirFid?: string, page?: number, size?: number, sort?: string, fetchSubDirs?: boolean, fetchRiskFileName?: boolean}} options
 */
export async function listFiles ({
  pdirFid = "0",
  page = 1,
  size = 50,
  sort,
  fetchSubDirs = true,
  fetchRiskFileName = true
} = {}) {
  const query = {
    pdir_fid: pdirFid || "0",
    _page: page,
    _size: size,
    _sort: sort || "file_type:asc,updated_at:desc",
    _fetch_total: 1,
    _fetch_sub_dirs: fetchSubDirs ? 1 : 0,
    fetch_all_file: 0,
    fetch_risk_file_name: fetchRiskFileName ? 1 : 0
  };

  const payload = await request("/1/clouddrive/file/sort", { query });
  const meta = readMetadata(payload, { page, size });

  return {
    items: Array.isArray(payload.data?.list) ? payload.data.list : [],
    subDirs: Array.isArray(payload.data?.sub_dirs) ? payload.data.sub_dirs : [],
    page: meta.page,
    size: meta.size,
    count: meta.count,
    total: meta.total,
    reqId: meta.reqId
  };
}

/**
 * 批量获取下载直链。
 *
 * ⚠️ 返回的 download_url 带 auth_key 签名，通常约 1 小时过期，且存在防盗链，
 *    下载时必须携带 UA 与 Referer（由 aria2 请求头注入）。
 *
 * 传入 pwdId 与 stoken 时，可以直接获取「分享内文件」的直链而无需先转存：
 * 实测仅带 fids 会返回 code=21001 file not found；加上分享上下文后返回 code=0。
 *
 * @param {string[]} fids 文件 fid（本账号网盘 fid 或分享空间 fid）
 * @param {{pwdId?: string, stoken?: string}} [shareContext] 分享上下文，二者同时提供才生效
 */
export async function getDownloadLinks (fids, { pwdId = "", stoken = "" } = {}) {
  const list = (Array.isArray(fids) ? fids : [fids]).map((fid) => String(fid)).filter((fid) => fid !== "");

  if (list.length === 0) throw new Error("fids 不能为空");

  const body = { fids: list };

  if (pwdId !== "" && stoken !== "") {
    body.pwd_id = pwdId;
    body.stoken = stoken;
  }

  const payload = await request("/1/clouddrive/file/download", {
    method: "POST",
    body
  });

  return Array.isArray(payload.data) ? payload.data : [];
}

/**
 * 获取分享会话凭证（stoken）。
 *
 * 浏览分享内容前必须先换取 stoken；带提取码的分享需要同时提供 passcode。
 * @param {{pwdId: string, passcode?: string}} params
 * @returns {Promise<object>} 通常包含 stoken、pwd_id、title 等字段
 */
export async function getShareToken ({ pwdId, passcode = "" }) {
  const payload = await request("/1/clouddrive/share/sharepage/token", {
    method: "POST",
    body: { pwd_id: pwdId, passcode }
  });

  return payload.data ?? {};
}

/**
 * 列出分享内某一层的文件。
 *
 * 注意：返回条目中的 fid 属于分享空间，与本账号网盘 fid 不同；
 * share_fid_token 是后续转存操作所需的凭证。
 * @param {{pwdId: string, stoken: string, pdirFid?: string, page?: number, size?: number, sort?: string}} params
 */
export async function getShareDetail ({ pwdId, stoken, pdirFid = "0", page = 1, size = 50, sort }) {
  const query = {
    pwd_id: pwdId,
    stoken,
    pdir_fid: pdirFid || "0",
    force: 0,
    _page: page,
    _size: size,
    _fetch_banner: 0,
    _fetch_share: 1,
    _fetch_total: 1,
    _sort: sort || "file_type:asc,updated_at:desc"
  };

  const payload = await request("/1/clouddrive/share/sharepage/detail", { query });
  const meta = readMetadata(payload, { page, size });

  return {
    items: Array.isArray(payload.data?.list) ? payload.data.list : [],
    share: payload.data?.share ?? null,
    page: meta.page,
    size: meta.size,
    count: meta.count,
    total: meta.total,
    reqId: meta.reqId
  };
}
