/**
 * 网盘分享链接的提取与规范化。
 *
 * 为什么单独成模块：搜索结果里的 URL 往往只是第三方资源站的页面，真正的网盘链接藏在页面正文中，
 * 且同一链接会以多种形态重复出现（带追踪参数、带提取码、尾部粘连标点）。这里统一处理三件事：
 *  1) 从任意文本中提取各平台分享链接；
 *  2) 规范化 URL：去掉尾部标点与追踪参数，仅保留有意义的 pwd；
 *  3) 尽力捕获提取码：优先取 URL 的 pwd 参数，其次看链接附近文本里的「提取码：xxxx」。
 */

/**
 * 各平台分享链接特征。
 * 末尾可选查询串用于保留 ?pwd=xxxx，否则规范化时会把提取码一起丢掉。
 */
const SHARE_PATTERNS = [
  { type: "quark", pattern: /https?:\/\/pan\.quark\.cn\/(?:s|share)\/[A-Za-z0-9]+(?:\?[^\s"'<>「」【】（）()，,；;。]*)?/gi },
  { type: "baidu", pattern: /https?:\/\/pan\.baidu\.com\/s\/[A-Za-z0-9_-]+(?:\?[^\s"'<>「」【】（）()，,；;。]*)?/gi },
  { type: "alipan", pattern: /https?:\/\/(?:www\.)?(?:alipan|aliyundrive)\.com\/s\/[A-Za-z0-9]+(?:\?[^\s"'<>「」【】（）()，,；;。]*)?/gi },
  { type: "123pan", pattern: /https?:\/\/(?:www\.)?123pan\.com\/s\/[A-Za-z0-9_-]+(?:\?[^\s"'<>「」【】（）()，,；;。]*)?/gi },
  { type: "xunlei", pattern: /https?:\/\/pan\.xunlei\.com\/s\/[A-Za-z0-9_-]+(?:\?[^\s"'<>「」【】（）()，,；;。]*)?/gi },
  { type: "lanzou", pattern: /https?:\/\/[A-Za-z0-9.-]*lanzou[A-Za-z0-9]*\.com\/[A-Za-z0-9/_-]+(?:\?[^\s"'<>「」【】（）()，,；;。]*)?/gi }
];

/** 正文中提取码的常见写法 */
const PASSCODE_TEXT_PATTERN = /(?:提取码|访问码|提取密码|密码|passcode|pwd)\s*[:：=]?\s*([A-Za-z0-9]{4})/i;

/** URL 尾部可能粘连的标点 */
const TRAILING_PUNCTUATION = /[.,;:!?、。，；：！）)】」"'<>]+$/;

/** 来源位置的可信度排序，去重时保留更高者 */
const FOUND_IN_RANK = { snippet: 1, url: 2, raw: 3 };

/** 从 URL 的 pwd 参数中取出提取码 */
export function extractPasscodeFromUrl (input) {
  const match = String(input ?? "").match(/[?&]pwd=([A-Za-z0-9]+)/i);
  return match === null ? "" : match[1];
}

/**
 * 规范化分享链接：去掉尾部标点，仅保留 pwd 查询参数（丢弃 utm 之类的追踪串）。
 * @param {string} input
 */
export function normalizeShareUrl (input) {
  const cleaned = String(input ?? "").trim().replace(TRAILING_PUNCTUATION, "");

  const parts = cleaned.match(/^(https?:\/\/[^?#]+)(\?[^#]*)?/i);
  if (parts === null) return cleaned;

  const base = parts[1];
  const pwd = extractPasscodeFromUrl(parts[2] ?? "");

  return pwd === "" ? base : `${base}?pwd=${pwd}`;
}

/** 提取夸克分享的 pwd_id，其它平台返回空字符串 */
export function extractQuarkPwdId (url) {
  const match = String(url ?? "").match(/pan\.quark\.cn\/(?:s|share)\/([A-Za-z0-9]+)/i);
  return match === null ? "" : match[1];
}

/** 在链接周围的文本窗口中寻找提取码 */
function extractPasscodeFromText (text) {
  const match = String(text ?? "").match(PASSCODE_TEXT_PATTERN);
  return match === null ? "" : match[1];
}

/**
 * 从一段文本中提取网盘分享链接（已去重）。
 *
 * @param {string} text 待提取的文本，可以是页面正文、搜索摘要，甚至是一个 URL
 * @param {{sourceUrl?: string, sourceTitle?: string, foundIn?: string, window?: number}} [options]
 *   foundIn 取值：url / snippet / raw，用于标注链接是从哪里找到的
 * @returns {{type: string, url: string, pwdId: string, passcode: string, sourceUrl: string, sourceTitle: string, foundIn: string}[]}
 */
export function extractShareLinks (text, { sourceUrl = "", sourceTitle = "", foundIn = "raw", window = 100 } = {}) {
  const raw = String(text ?? "");
  if (raw === "") return [];

  const records = [];

  for (const { type, pattern } of SHARE_PATTERNS) {
    for (const match of raw.matchAll(pattern)) {
      const matched = match[0];
      const url = normalizeShareUrl(matched);
      if (url === "") continue;

      const index = match.index ?? 0;
      // 以链接为中心取一段窗口文本，用于寻找「提取码：xxxx」这类写法
      const around = raw.slice(Math.max(0, index - window), index + matched.length + window);

      records.push({
        type,
        url,
        pwdId: extractQuarkPwdId(url),
        passcode: extractPasscodeFromUrl(matched) || extractPasscodeFromText(around),
        sourceUrl,
        sourceTitle,
        foundIn
      });
    }
  }

  return dedupeShareLinks(records);
}

/**
 * 按规范化 URL 去重，并合并提取码与来源信息。
 * 同一链接若同时来自摘要与正文，保留可信度更高的来源位置。
 * @param {object[]} records
 */
export function dedupeShareLinks (records) {
  const map = new Map();

  for (const record of records) {
    if (record === null || record === undefined || record.url === "") continue;

    const existing = map.get(record.url);

    if (existing === undefined) {
      map.set(record.url, { ...record });
      continue;
    }

    if (existing.passcode === "" && record.passcode !== "") existing.passcode = record.passcode;
    if (existing.pwdId === "" && record.pwdId !== "") existing.pwdId = record.pwdId;

    if ((FOUND_IN_RANK[record.foundIn] ?? 0) > (FOUND_IN_RANK[existing.foundIn] ?? 0)) {
      existing.foundIn = record.foundIn;
      if (record.sourceUrl !== "") existing.sourceUrl = record.sourceUrl;
      if (record.sourceTitle !== "") existing.sourceTitle = record.sourceTitle;
    }
  }

  return [...map.values()];
}
