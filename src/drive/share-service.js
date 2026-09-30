/**
 * 分享（分享链接）只读服务层。
 *
 * 当前仅覆盖只读能力：
 *  - parseShareLink：把分享链接/文本解析为 pwd_id 与提取码
 *  - listShareFiles：换取 stoken 并列出分享内的文件（一层，支持分页与缓存）
 *
 * ⚠️ 重要语义区别：
 *    分享内文件的 fid 属于「分享空间」，与本账号网盘内的 fid 不是同一套，
 *    因此不能直接传给 drive_get_download_links 获取直链；
 *    必须先转存（save）到自己网盘后，才能走「查询 → 直链 → aria2 下载」链路。
 *    转存能力尚未实现，本模块只负责解析与浏览。
 */
import { logger } from "../logger.js";
import { cacheGet, cacheKey, cacheSet, cacheTtlSeconds } from "./cache.js";
import { QuarkApiError, getShareDetail, getShareToken } from "./quark-client.js";

/** 匹配 pan.quark.cn/s/<pwd_id> 与 pan.quark.cn/share/<pwd_id> */
const SHARE_URL_PATTERN = /pan\.quark\.cn\/(?:s|share)\/([A-Za-z0-9]+)/i;

/** 直接把 pwd_id 当作输入时的合法形态（夸克 pwd_id 为字母数字组合） */
const PWD_ID_PATTERN = /^[A-Za-z0-9]{6,}$/;

/** 常见分享域名，用于提示用户输入是否像分享链接 */
const SHARE_HOST_HINT = "pan.quark.cn";

/**
 * 解析分享链接或分享文本。
 *
 * 支持三种输入：
 *  1) 完整链接：https://pan.quark.cn/s/abcdef123456
 *  2) 带提取码的文本：https://pan.quark.cn/s/abcdef123456 提取码：a1b2
 *  3) 直接给 pwd_id：abcdef123456
 *
 * @param {string} input
 * @returns {{valid: boolean, pwdId: string, passcode: string, normalizedUrl: string, message: string}}
 */
export function parseShareLink (input) {
  const raw = String(input ?? "").trim();

  if (raw === "") {
    return buildInvalid("请输入分享链接或 pwd_id。");
  }

  // 先尝试提取提取码：?pwd=xxxx 优先，其次「提取码：xxxx」这类自然语言写法
  let passcode = "";
  const queryMatch = raw.match(/[?&]pwd=([A-Za-z0-9]{4,})/i);
  if (queryMatch) {
    passcode = queryMatch[1];
  } else {
    const textMatch = raw.match(/(?:提取码|访问码|密码|passcode|pwd)\s*[:：=]?\s*([A-Za-z0-9]{4})/i);
    if (textMatch) passcode = textMatch[1];
  }

  const urlMatch = raw.match(SHARE_URL_PATTERN);
  if (urlMatch) {
    const pwdId = urlMatch[1];
    return {
      valid: true,
      pwdId,
      passcode,
      normalizedUrl: `https://pan.quark.cn/s/${pwdId}`,
      message: `已解析分享 ID：${pwdId}${passcode === "" ? "（未检测到提取码，若分享加密请手动提供）" : `，提取码：${passcode}`}`
    };
  }

  // 未匹配到 URL 时，允许直接传 pwd_id
  if (!raw.includes("/") && PWD_ID_PATTERN.test(raw)) {
    return {
      valid: true,
      pwdId: raw,
      passcode,
      normalizedUrl: `https://pan.quark.cn/s/${raw}`,
      message: `已将输入识别为分享 ID：${raw}${passcode === "" ? "（未提供提取码）" : `，提取码：${passcode}`}`
    };
  }

  const containsShareHost = raw.toLowerCase().includes(SHARE_HOST_HINT);
  return buildInvalid(
    containsShareHost
      ? "无法从该链接中提取分享 ID，请确认链接形如 https://pan.quark.cn/s/<pwd_id>。"
      : "无法识别输入，请提供夸克分享链接（https://pan.quark.cn/s/<pwd_id>）或直接提供 pwd_id。"
  );
}

function buildInvalid (message) {
  return { valid: false, pwdId: "", passcode: "", normalizedUrl: "", message };
}

/**
 * 列出分享内某一层的文件。
 *
 * 缓存键为 `share:<pwd_id>:<pdir_fid>` + 分页，与本账号目录缓存共用同一套内存缓存，
 * 但带 `share:` 前缀，二者互不干扰；命中缓存时不会再请求 stoken 与 detail。
 *
 * @param {{pwdId: string, passcode?: string, pdirFid?: string, page?: number, size?: number, sort?: string, forceRefresh?: boolean}} options
 */
export async function listShareFiles ({
  pwdId,
  passcode = "",
  pdirFid = "0",
  page = 1,
  size = 50,
  sort,
  forceRefresh = false
} = {}) {
  if (String(pwdId ?? "").trim() === "") {
    throw new Error("缺少分享 ID（pwd_id），请提供分享链接或 pwd_id。");
  }

  const key = cacheKey(`share:${pwdId}:${pdirFid || "0"}`, page, size);

  if (!forceRefresh) {
    const cached = cacheGet(key);
    if (cached !== null) {
      logger.debug(`分享缓存命中 ${key}（${Math.round(cached.ageMs / 1000)}s 前）`);
      return {
        items: cached.items,
        shareTitle: cached.shareTitle ?? "",
        page: cached.page,
        size: cached.size,
        count: cached.count,
        total: cached.total,
        cache: {
          hit: true,
          ageSeconds: Math.round(cached.ageMs / 1000),
          ttlSeconds: Math.round(cached.ttlMs / 1000),
          source: "cache"
        }
      };
    }
  }

  // 换取 stoken：分享浏览的必要凭证，仅在缓存未命中时才请求
  let token;
  try {
    token = await getShareToken({ pwdId, passcode });
  } catch (err) {
    // 仅对夸克接口返回的业务错误追加提示；
    // 配置缺失（如未设置 QUARK_COOKIE）等错误原样抛出，避免误导排查方向。
    if (err instanceof QuarkApiError) {
      throw new Error(`${err.message}（请检查提取码是否正确，以及分享是否已过期或被取消）`);
    }
    throw err;
  }

  const stoken = String(token?.stoken ?? "");
  if (stoken === "") {
    throw new Error("未能获取分享凭证 stoken，请确认分享链接有效且提取码正确。");
  }

  const detail = await getShareDetail({ pwdId, stoken, pdirFid: pdirFid || "0", page, size, sort });
  const shareTitle = String(detail.share?.title ?? detail.share?.share_name ?? "");

  cacheSet(key, {
    items: detail.items,
    shareTitle,
    page: detail.page,
    size: detail.size,
    count: detail.count,
    total: detail.total,
    subDirs: [],
    reqId: detail.reqId
  });

  return {
    items: detail.items,
    shareTitle,
    page: detail.page,
    size: detail.size,
    count: detail.count,
    total: detail.total,
    cache: {
      hit: false,
      ageSeconds: 0,
      ttlSeconds: cacheTtlSeconds(),
      source: "network"
    }
  };
}

/**
 * 把分享条目裁剪为工具层需要的精简结构。
 * share_fid_token 是后续转存时必需的凭证，因此一并保留。
 * @param {object} item
 */
export function normalizeShareItem (item) {
  return {
    fid: String(item.fid ?? ""),
    share_fid_token: String(item.share_fid_token ?? ""),
    file_name: String(item.file_name ?? ""),
    dir: item.dir === true,
    file: item.file === true,
    size: Number(item.size ?? 0),
    format_type: String(item.format_type ?? ""),
    updated_at: Number(item.updated_at ?? 0)
  };
}
