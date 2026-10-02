/**
 * 落盘文件名清洗单测。
 *
 * aria2 的 out 会被当作相对路径解析，因此外部字符串必须经过清洗才能下发：
 * 这里覆盖路径分隔符、控制字符、`.` / `..` 以及「名称未知」占位符。
 */
import { describe, expect, it } from "vitest";

import { toSafeOutName } from "../src/tools/aria2.js";

describe("toSafeOutName", () => {
  it("正常文件名原样保留", () => {
    expect(toSafeOutName("明天也要上班.mkv")).toBe("明天也要上班.mkv");
    expect(toSafeOutName("movie.2026.1080p.mkv")).toBe("movie.2026.1080p.mkv");
  });

  it("去掉首尾空白", () => {
    expect(toSafeOutName("  movie.mkv  ")).toBe("movie.mkv");
  });

  it("把路径分隔符替换成下划线，避免写到目标目录之外", () => {
    expect(toSafeOutName("a/b/c.mkv")).toBe("a_b_c.mkv");
    expect(toSafeOutName("a\\b\\c.mkv")).toBe("a_b_c.mkv");
    expect(toSafeOutName("../evil.mkv")).toBe(".._evil.mkv");
  });

  it("拒绝指向目录自身或父目录的名称", () => {
    expect(toSafeOutName(".")).toBe("");
    expect(toSafeOutName("..")).toBe("");
    expect(toSafeOutName("  ..  ")).toBe("");
  });

  it("剔除控制字符", () => {
    expect(toSafeOutName("a\u0000b\u001fc")).toBe("abc");
    expect(toSafeOutName("a\u007fb")).toBe("ab");
  });

  it("「名称未知」占位符不能当文件名写入磁盘", () => {
    expect(toSafeOutName("（名称未知）fid-abc")).toBe("");
    expect(toSafeOutName("（名称未知）dl-pc-zb.drive.quark.cn")).toBe("");
  });

  it("空值返回空串，交由 aria2 自行取名", () => {
    expect(toSafeOutName("")).toBe("");
    expect(toSafeOutName("   ")).toBe("");
    expect(toSafeOutName(undefined)).toBe("");
    expect(toSafeOutName(null)).toBe("");
  });
});
