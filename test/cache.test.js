/**
 * 目录缓存单测：TTL 过期、LRU 淘汰、按目录失效、容量为 0 时关闭。
 *
 * 两个注意点：
 *  1) cache.js 的 store 是模块级单例，每个用例前必须清空，避免相互污染；
 *  2) cacheClear() 只清条目、不清计数器（计数是「进程启动以来」累计的），
 *     因此对 hits / misses / evictions 的断言一律用增量。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cacheClear,
  cacheEnabled,
  cacheGet,
  cacheInvalidate,
  cacheKey,
  cacheSet,
  cacheStats
} from "../src/drive/cache.js";

/** 取当前累计计数，用于计算增量 */
function counters () {
  const stats = cacheStats();
  return { hits: stats.hits, misses: stats.misses, evictions: stats.evictions };
}

/** 造一份最小可用的目录载荷 */
function payload (name) {
  return {
    items: [{ fid: `fid-${name}`, file_name: name, dir: false, file: true }],
    subDirs: [],
    page: 1,
    size: 50,
    count: 1,
    total: 1,
    reqId: null
  };
}

beforeEach(() => {
  cacheClear();
  vi.stubEnv("DRIVE_CACHE_TTL_MS", "");
  vi.stubEnv("DRIVE_CACHE_MAX_ENTRIES", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  cacheClear();
});

describe("cacheKey", () => {
  it("拼出 pdir_fid:page:size，缺省值有兜底", () => {
    expect(cacheKey("abc", 2, 100)).toBe("abc:2:100");
    expect(cacheKey("", 0, 0)).toBe("0:1:50");
    expect(cacheKey(undefined, undefined, undefined)).toBe("0:1:50");
  });
});

describe("读写与统计", () => {
  it("写入后能命中，并带上数据年龄与 TTL", () => {
    cacheSet("k1", payload("a"));

    const hit = cacheGet("k1");
    expect(hit).not.toBeNull();
    expect(hit.items[0].file_name).toBe("a");
    expect(hit.ageMs).toBe(0);
    expect(hit.ttlMs).toBe(3600000);
  });

  it("未命中时返回 null 并计入 misses", () => {
    const before = counters();

    expect(cacheGet("missing")).toBeNull();
    expect(counters().misses - before.misses).toBe(1);
  });

  it("cacheStats 汇总条目数、命中与容量", () => {
    cacheClear();
    const before = counters();

    cacheSet("k1", payload("a"));
    cacheGet("k1");
    cacheGet("nope");

    const stats = cacheStats();
    expect(stats.enabled).toBe(true);
    expect(stats.entries).toBe(1);
    expect(stats.maxEntries).toBe(500);
    expect(stats.hits - before.hits).toBe(1);
    expect(stats.misses - before.misses).toBe(1);
  });
});

describe("TTL 过期", () => {
  it("超过 TTL 后按未命中处理，并删除该条目", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    vi.stubEnv("DRIVE_CACHE_TTL_MS", "1000");

    cacheSet("k1", payload("a"));
    expect(cacheGet("k1")).not.toBeNull();

    vi.advanceTimersByTime(1001);

    expect(cacheGet("k1")).toBeNull();
    expect(cacheStats().entries).toBe(0);
  });

  it("恰好等于 TTL 时仍算命中（判定为 age > ttl）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    vi.stubEnv("DRIVE_CACHE_TTL_MS", "1000");

    cacheSet("k1", payload("a"));
    vi.advanceTimersByTime(1000);

    expect(cacheGet("k1")).not.toBeNull();
  });
});

describe("LRU 淘汰", () => {
  it("容量超限时淘汰最久未使用者，命中的条目会被刷新", () => {
    vi.stubEnv("DRIVE_CACHE_MAX_ENTRIES", "3");
    const before = counters();

    cacheSet("k1", payload("a"));
    cacheSet("k2", payload("b"));
    cacheSet("k3", payload("c"));

    // k1 被读一次 → 移到最近使用端，此时顺序为 k2 / k3 / k1
    cacheGet("k1");

    cacheSet("k4", payload("d"));

    expect(cacheGet("k2")).toBeNull();
    expect(cacheGet("k3")).not.toBeNull();
    expect(cacheGet("k1")).not.toBeNull();
    expect(cacheGet("k4")).not.toBeNull();
    expect(counters().evictions - before.evictions).toBe(1);
  });

  it("容量为 0 时完全关闭缓存", () => {
    vi.stubEnv("DRIVE_CACHE_MAX_ENTRIES", "0");
    expect(cacheEnabled()).toBe(false);

    cacheSet("k1", payload("a"));

    expect(cacheGet("k1")).toBeNull();
    expect(cacheStats().entries).toBe(0);
    expect(cacheStats().enabled).toBe(false);
    expect(cacheStats().maxEntries).toBe(0);
  });
});

describe("失效与清空", () => {
  it("cacheInvalidate 只清理指定目录的全部分页", () => {
    cacheSet("dir1:1:50", payload("a"));
    cacheSet("dir1:2:50", payload("b"));
    cacheSet("dir10:1:50", payload("c"));

    const removed = cacheInvalidate("dir1");

    expect(removed).toBe(2);
    expect(cacheGet("dir1:1:50")).toBeNull();
    expect(cacheGet("dir1:2:50")).toBeNull();
    // 前缀匹配不会误伤 dir10
    expect(cacheGet("dir10:1:50")).not.toBeNull();
  });

  it("cacheClear 返回被清空的条目数", () => {
    cacheSet("k1", payload("a"));
    cacheSet("k2", payload("b"));

    expect(cacheClear()).toBe(2);
    expect(cacheStats().entries).toBe(0);
  });
});
