/**
 * 网盘文件服务层。
 *
 * 在 quark-client（纯接口调用）与 MCP 工具（面向模型）之间，承担三件事：
 *  1) 缓存读写与并发合并；
 *  2) 把「路径」解析为 fid（逐层查询，每层优先命中缓存）；
 *  3) 把原始响应裁剪成模型易读的精简结构。
 *
 * 缓存键为 `pdir_fid:page:size`；缓存命中情况会作为 cache 元数据一路透传给工具层，
 * 最终在返回文本中体现为「命中缓存 / 来自网络」提示。
 */
import { logger } from "../logger.js";
import {
  cacheInflightClear,
  cacheInflightGet,
  cacheInflightSet,
  cacheKey,
  cacheGet,
  cacheSet,
  cacheTtlSeconds
} from "./cache.js";
import { getDownloadLinks as quarkGetDownloadLinks, listFiles as quarkListFiles } from "./quark-client.js";

/**
 * 列出一层目录，缓存优先。
 * @param {{pdirFid?: string, page?: number, size?: number, sort?: string, forceRefresh?: boolean}} options
 * @returns {Promise<{items: object[], page: number, size: number, count: number, total: number, cache: object}>}
 */
export async function listFiles ({ pdirFid = "0", page = 1, size = 50, sort, forceRefresh = false } = {}) {
  const key = cacheKey(pdirFid, page, size);

  if (!forceRefresh) {
    const cached = cacheGet(key);
    if (cached !== null) {
      logger.debug(`缓存命中 ${key}（${Math.round(cached.ageMs / 1000)}s 前）`);
      return {
        items: cached.items,
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

  // 并发合并：同一目录同时未命中时，复用同一个进行中的请求
  const inflight = cacheInflightGet(key);
  if (inflight !== null) {
    logger.debug(`复用进行中的请求 ${key}`);
    const shared = await inflight;
    return { ...shared, cache: { ...shared.cache, coalesced: true } };
  }

  const task = quarkListFiles({ pdirFid, page, size, sort }).then((result) => {
    cacheSet(key, result);

    return {
      items: result.items,
      page: result.page,
      size: result.size,
      count: result.count,
      total: result.total,
      cache: {
        hit: false,
        ageSeconds: 0,
        ttlSeconds: cacheTtlSeconds(),
        source: "network"
      }
    };
  });

  cacheInflightSet(key, task);
  try {
    return await task;
  } finally {
    cacheInflightClear(key);
  }
}

/**
 * 拆分路径为层级名称数组。
 * 支持 `/film/明天也要上班` 与 `film/明天也要上班` 两种写法。
 * @param {string} input
 * @returns {string[]}
 */
export function splitPath (input) {
  return String(input ?? "")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
}

/**
 * 把路径逐层解析为 fid。
 *
 * 每一层都调用 listFiles（因此自动享受缓存），并按 file_name 精确匹配。
 * 匹配到 0 个或多个同名项时返回错误信息，交由工具层转成 isError。
 *
 * @param {string} input 形如 /film/明天也要上班 的路径
 * @param {{forceRefresh?: boolean}} [options]
 * @returns {Promise<{resolved: boolean, fid: string, segments: string[], steps: object[], error?: string, hints?: object}>}
 */
export async function resolvePath (input, { forceRefresh = false } = {}) {
  const segments = splitPath(input);

  if (segments.length === 0) {
    return { resolved: true, fid: "0", segments: [], steps: [] };
  }

  let currentFid = "0";
  const steps = [];

  for (const name of segments) {
    const listing = await listFiles({ pdirFid: currentFid, forceRefresh });

    const candidates = listing.items.filter((item) => String(item.file_name ?? "") === name);

    if (candidates.length === 0) {
      return {
        resolved: false,
        fid: currentFid,
        segments,
        steps,
        error: `在目录 fid=${currentFid} 下找不到名为「${name}」的条目。`,
        hints: {
          parentFid: currentFid,
          parentCache: listing.cache,
          available: listing.items.slice(0, 20).map((item) => item.file_name)
        }
      };
    }

    if (candidates.length > 1) {
      return {
        resolved: false,
        fid: currentFid,
        segments,
        steps,
        error: `目录 fid=${currentFid} 下存在 ${candidates.length} 个同名条目「${name}」，请改用 fid 精确定位。`,
        hints: {
          parentFid: currentFid,
          parentCache: listing.cache,
          candidates: candidates.map((item) => ({ fid: item.fid, dir: item.dir === true, updated_at: item.updated_at }))
        }
      };
    }

    const match = candidates[0];

    steps.push({
      name,
      fid: match.fid,
      parentFid: currentFid,
      dir: match.dir === true,
      file: match.file === true,
      updatedAt: Number(match.updated_at ?? 0),
      cacheHit: listing.cache.hit,
      ageSeconds: listing.cache.ageSeconds,
      source: listing.cache.source
    });

    currentFid = match.fid;
  }

  return { resolved: true, fid: currentFid, segments, steps };
}

/**
 * 按 fid 获取下载直链，并裁剪为精简结构。
 * 直链带签名有效期，因此不做缓存，每次实时获取。
 * @param {string[]} fids
 */
export async function getDownloadLinks (fids) {
  const items = await quarkGetDownloadLinks(fids);

  return items.map((item) => ({
    fid: String(item.fid ?? ""),
    file_name: String(item.file_name ?? ""),
    size: Number(item.size ?? 0),
    format_type: String(item.format_type ?? ""),
    md5: String(item.md5 ?? ""),
    download_url: String(item.download_url ?? ""),
    preview_url: String(item.preview_url ?? ""),
    thumbnail: String(item.thumbnail ?? "")
  }));
}
