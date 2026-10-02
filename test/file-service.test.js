/**
 * 路径解析单测。
 *
 * resolvePath 依赖 quark-client 发请求，这里把该模块整体 mock 掉，
 * 用一棵内存目录树替代真实网盘，从而覆盖：逐层解析、找不到、同名歧义、缓存复用与强制刷新。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/drive/quark-client.js", () => ({
  listFiles: vi.fn(),
  getDownloadLinks: vi.fn()
}));

import { listFiles as quarkListFiles } from "../src/drive/quark-client.js";
import { cacheClear } from "../src/drive/cache.js";
import { resolvePath, splitPath } from "../src/drive/file-service.js";

/** 内存目录树：pdir_fid -> 直接子项 */
const TREE = {
  "0": [
    { fid: "f-film", file_name: "film", dir: true, file: false, updated_at: 1 },
    // 同名歧义：一个目录 + 一个文件，名字都叫 dup
    { fid: "f-dup-dir", file_name: "dup", dir: true, file: false, updated_at: 2 },
    { fid: "f-dup-file", file_name: "dup", dir: false, file: true, updated_at: 3 }
  ],
  "f-film": [
    { fid: "f-movie", file_name: "明天也要上班.mkv", dir: false, file: true, updated_at: 4 }
  ],
  "f-dup-dir": [],
  "f-dup-file": []
};

beforeEach(() => {
  cacheClear();
  quarkListFiles.mockReset();
  quarkListFiles.mockImplementation(({ pdirFid = "0", page = 1, size = 50 } = {}) => {
    const items = TREE[pdirFid] ?? [];
    return Promise.resolve({
      items,
      subDirs: [],
      page,
      size,
      count: items.length,
      total: items.length,
      reqId: null
    });
  });
});

describe("splitPath", () => {
  it("同时接受带前导 / 与不带前导 / 的写法", () => {
    expect(splitPath("/film/明天也要上班")).toEqual(["film", "明天也要上班"]);
    expect(splitPath("film/明天也要上班")).toEqual(["film", "明天也要上班"]);
  });

  it("忽略空段与首尾多余分隔符", () => {
    expect(splitPath("//a//b//")).toEqual(["a", "b"]);
    expect(splitPath("  a / b  ")).toEqual(["a", "b"]);
  });

  it("空输入得到空数组", () => {
    expect(splitPath("")).toEqual([]);
    expect(splitPath(null)).toEqual([]);
  });
});

describe("resolvePath", () => {
  it("空路径直接落在根目录", async () => {
    const result = await resolvePath("");

    expect(result.resolved).toBe(true);
    expect(result.fid).toBe("0");
    expect(result.steps).toEqual([]);
    expect(quarkListFiles).not.toHaveBeenCalled();
  });

  it("逐层解析路径并记录每一步", async () => {
    const result = await resolvePath("/film/明天也要上班.mkv");

    expect(result.resolved).toBe(true);
    expect(result.fid).toBe("f-movie");
    expect(result.segments).toEqual(["film", "明天也要上班.mkv"]);
    expect(result.steps).toHaveLength(2);

    expect(result.steps[0]).toMatchObject({
      name: "film",
      fid: "f-film",
      parentFid: "0",
      dir: true,
      cacheHit: false,
      source: "network"
    });
    expect(result.steps[1]).toMatchObject({
      name: "明天也要上班.mkv",
      fid: "f-movie",
      parentFid: "f-film",
      file: true
    });
  });

  it("路径不存在时返回可读错误与该目录的可选项", async () => {
    const result = await resolvePath("/film/不存在的东西");

    expect(result.resolved).toBe(false);
    expect(result.fid).toBe("f-film");
    expect(result.error).toContain("不存在的东西");
    expect(result.hints.available).toContain("明天也要上班.mkv");
  });

  it("同名歧义时给出候选 fid，不擅自选择一个", async () => {
    const result = await resolvePath("/dup");

    expect(result.resolved).toBe(false);
    expect(result.error).toContain("2 个同名条目");
    expect(result.hints.candidates).toHaveLength(2);
    expect(result.hints.candidates.map((item) => item.fid).sort())
      .toEqual(["f-dup-dir", "f-dup-file"]);
  });

  it("重复解析同一路径时中间层命中缓存，不再请求接口", async () => {
    await resolvePath("/film/明天也要上班.mkv");
    const callsAfterFirst = quarkListFiles.mock.calls.length;

    const second = await resolvePath("/film/明天也要上班.mkv");

    expect(quarkListFiles.mock.calls.length).toBe(callsAfterFirst);
    expect(second.resolved).toBe(true);
    expect(second.steps.every((step) => step.cacheHit)).toBe(true);
    expect(second.steps[0].source).toBe("cache");
  });

  it("force_refresh 会绕过缓存重新拉取", async () => {
    await resolvePath("/film/明天也要上班.mkv");
    const callsAfterFirst = quarkListFiles.mock.calls.length;

    const refreshed = await resolvePath("/film/明天也要上班.mkv", { forceRefresh: true });

    expect(quarkListFiles.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    expect(refreshed.steps.every((step) => step.cacheHit)).toBe(false);
  });
});
