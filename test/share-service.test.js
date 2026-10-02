/**
 * 分享链接解析单测（parseShareLink 为纯函数，不触发任何网络请求）。
 */
import { describe, expect, it } from "vitest";

import { parseShareLink, splitSharePath } from "../src/drive/share-service.js";

describe("parseShareLink", () => {
  it("解析标准分享链接", () => {
    const result = parseShareLink("https://pan.quark.cn/s/abcdef123456");

    expect(result.valid).toBe(true);
    expect(result.pwdId).toBe("abcdef123456");
    expect(result.passcode).toBe("");
    expect(result.normalizedUrl).toBe("https://pan.quark.cn/s/abcdef123456");
  });

  it("兼容 /share/ 形态", () => {
    expect(parseShareLink("https://pan.quark.cn/share/abcdef123456").pwdId).toBe("abcdef123456");
  });

  it("从链接的 pwd 参数取提取码", () => {
    const result = parseShareLink("https://pan.quark.cn/s/abcdef123456?pwd=a1b2");

    expect(result.pwdId).toBe("abcdef123456");
    expect(result.passcode).toBe("a1b2");
  });

  it("从整段文本中的「提取码：xxxx」取提取码", () => {
    const result = parseShareLink("分享给你 https://pan.quark.cn/s/abcdef123456 提取码：a1b2 复制这段内容");

    expect(result.pwdId).toBe("abcdef123456");
    expect(result.passcode).toBe("a1b2");
  });

  it("允许直接传裸 pwd_id", () => {
    const result = parseShareLink("abcdef123456");

    expect(result.valid).toBe(true);
    expect(result.pwdId).toBe("abcdef123456");
    expect(result.message).toContain("分享 ID");
  });

  it("空输入报错", () => {
    const result = parseShareLink("   ");

    expect(result.valid).toBe(false);
    expect(result.message).toContain("请输入");
  });

  it("非夸克域名的链接报错", () => {
    const result = parseShareLink("https://example.com/a/b");

    expect(result.valid).toBe(false);
    expect(result.message).toContain("无法识别输入");
  });

  it("夸克域名但缺 pwd_id 时给出针对性提示", () => {
    const result = parseShareLink("https://pan.quark.cn/s/");

    expect(result.valid).toBe(false);
    expect(result.message).toContain("无法从该链接中提取分享 ID");
  });
});

describe("splitSharePath", () => {
  it("拆分分享内路径", () => {
    expect(splitSharePath("/剧集/第01集.mkv")).toEqual(["剧集", "第01集.mkv"]);
    expect(splitSharePath("剧集/第01集.mkv")).toEqual(["剧集", "第01集.mkv"]);
    expect(splitSharePath("")).toEqual([]);
  });
});
