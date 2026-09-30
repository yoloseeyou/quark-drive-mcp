/**
 * 目录查询内存缓存。
 *
 * 为什么需要它：逐层解析一个路径需要「每层一次请求」，而目录结构变化并不频繁。
 * 按「父目录 fid」缓存一层结果后，重复解析同一路径时可复用中间层，显著减少请求次数。
 *
 * 关键设计：
 *  - 缓存键为 `pdir_fid:page:size`，支持分页结果共存；
 *  - TTL 通过 DRIVE_CACHE_TTL_MS 控制，过期即视为未命中；
 *  - 容量上限 DRIVE_CACHE_MAX_ENTRIES，超限按 LRU 淘汰；
 *  - inflight 表用于并发合并（防击穿），同一键并发未命中时只发起一次真实请求；
 *  - 模块级单例，进程内所有会话共享；进程退出即失效。
 */
import { envInt } from "../env.js";

/** 成功的查询结果：key -> { items, page, size, count, total, subDirs, fetchedAt } */
const store = new Map();

/** 进行中的请求：key -> Promise，用于并发合并 */
const inflight = new Map();

const counters = { hits: 0, misses: 0, evictions: 0 };

function ttlMs () {
  return envInt("DRIVE_CACHE_TTL_MS", 60 * 60 * 1000);
}

function maxEntries () {
  return envInt("DRIVE_CACHE_MAX_ENTRIES", 500);
}

/** 构造缓存键 */
export function cacheKey (pdirFid, page, size) {
  return `${pdirFid || "0"}:${page || 1}:${size || 50}`;
}

/**
 * 读取缓存。
 * @param {string} key
 * @returns {object|null} 命中时返回 { ..., fetchedAt, ageMs, ttlMs }，未命中或已过期返回 null
 */
export function cacheGet (key) {
  const entry = store.get(key);

  if (entry === undefined) {
    counters.misses += 1;
    return null;
  }

  const ageMs = Date.now() - entry.fetchedAt;
  if (ageMs > ttlMs()) {
    store.delete(key);
    counters.misses += 1;
    return null;
  }

  // LRU：命中后重新插入到 Map 末尾，保证末尾是最久未使用
  store.delete(key);
  store.set(key, entry);
  counters.hits += 1;

  return { ...entry, ageMs, ttlMs: ttlMs() };
}

/** 写入缓存 */
export function cacheSet (key, payload) {
  if (store.size >= maxEntries()) evict();

  store.set(key, {
    items: payload.items ?? [],
    subDirs: payload.subDirs ?? [],
    page: payload.page ?? 1,
    size: payload.size ?? 0,
    count: payload.count ?? 0,
    total: payload.total ?? 0,
    // 分享浏览时用于展示的分享标题，普通目录查询为 undefined
    shareTitle: payload.shareTitle ?? "",
    reqId: payload.reqId ?? null,
    fetchedAt: Date.now()
  });
}

function evict () {
  while (store.size >= maxEntries() && store.size > 0) {
    const oldestKey = store.keys().next().value;
    store.delete(oldestKey);
    counters.evictions += 1;
  }
}

/**
 * 使某个目录及其全部分页缓存失效。
 * 当前功能均为只读，仅在手动操作或未来加入写操作时使用。
 * @param {string} pdirFid
 * @returns {number} 被移除的条目数
 */
export function cacheInvalidate (pdirFid) {
  const prefix = `${pdirFid}:`;
  let removed = 0;

  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) {
      store.delete(key);
      removed += 1;
    }
  }

  return removed;
}

/**
 * 清空全部缓存。
 * @returns {number} 被清空的条目数
 */
export function cacheClear () {
  const size = store.size;
  store.clear();
  return size;
}

/** 缓存运行统计，供 drive_cache_manage 展示 */
export function cacheStats () {
  const now = Date.now();
  const ttl = ttlMs();
  let staleEntries = 0;

  for (const entry of store.values()) {
    if (now - entry.fetchedAt > ttl) staleEntries += 1;
  }

  return {
    entries: store.size,
    maxEntries: maxEntries(),
    ttlMs: ttl,
    ttlSeconds: Math.round(ttl / 1000),
    hits: counters.hits,
    misses: counters.misses,
    evictions: counters.evictions,
    staleEntries,
    inflight: inflight.size
  };
}

/** 读取进行中的请求（用于并发合并） */
export function cacheInflightGet (key) {
  return inflight.get(key) ?? null;
}

/** 登记进行中的请求 */
export function cacheInflightSet (key, promise) {
  inflight.set(key, promise);
}

/** 移除进行中的请求登记 */
export function cacheInflightClear (key) {
  inflight.delete(key);
}

/** 当前 TTL（秒），供工具在「来自网络」时填充提示元数据 */
export function cacheTtlSeconds () {
  return Math.round(ttlMs() / 1000);
}
