/**
 * 分享链接提取与规范化单测。
 *
 * 覆盖三件事：从任意文本里捞出各平台链接、把链接规范化（去标点与追踪参数）、
 * 去重时丢弃「互为前缀」的被截断短链。
 */
import { describe, expect, it } from "vitest";

import {
  dedupeShareLinks,
  extractPasscodeFromUrl,
  extractQuarkPwdId,
  extractShareLinks,
  normalizeShareUrl,
  sortShareLinks
} from "../src/search/share-links.js";

/** 造一条链接记录，便于直接测去重规则 */
function record (overrides) {
  return {
    type: "quark",
    url: "",
    pwdId: "",
    passcode: "",
    sourceUrl: "",
    sourceTitle: "",
    foundIn: "raw",
    ...overrides
  };
}

describe("extractPasscodeFromUrl", () => {
  it("取 pwd 参数", () => {
    expect(extractPasscodeFromUrl("https://pan.quark.cn/s/abc?pwd=a1b2")).toBe("a1b2");
    expect(extractPasscodeFromUrl("https://pan.quark.cn/s/abc?x=1&pwd=9z8y")).toBe("9z8y");
  });

  it("没有 pwd 参数时返回空串", () => {
    expect(extractPasscodeFromUrl("https://pan.quark.cn/s/abc")).toBe("");
    expect(extractPasscodeFromUrl("")).toBe("");
  });
});

describe("extractQuarkPwdId", () => {
  it("只识别夸克域名", () => {
    expect(extractQuarkPwdId("https://pan.quark.cn/s/abcdef123456")).toBe("abcdef123456");
    expect(extractQuarkPwdId("https://pan.quark.cn/share/abcdef123456")).toBe("abcdef123456");
    expect(extractQuarkPwdId("https://pan.baidu.com/s/abcdef123456")).toBe("");
  });
});

describe("normalizeShareUrl", () => {
  it("丢掉尾部标点", () => {
    expect(normalizeShareUrl("https://pan.quark.cn/s/abcdef123456。")).toBe("https://pan.quark.cn/s/abcdef123456");
    expect(normalizeShareUrl("https://pan.quark.cn/s/abcdef123456)")).toBe("https://pan.quark.cn/s/abcdef123456");
  });

  it("只保留有意义的 pwd 参数，丢弃追踪串", () => {
    expect(normalizeShareUrl("https://pan.quark.cn/s/abcdef123456?pwd=a1b2&utm_source=x"))
      .toBe("https://pan.quark.cn/s/abcdef123456?pwd=a1b2");
  });

  it("没有 pwd 时把整段查询串去掉", () => {
    expect(normalizeShareUrl("https://pan.quark.cn/s/abcdef123456?utm_source=x"))
      .toBe("https://pan.quark.cn/s/abcdef123456");
  });
});

describe("extractShareLinks", () => {
  it("从整段文本中提取夸克链接并捕获附近提取码", () => {
    const text = "推荐资源：https://pan.quark.cn/s/abcdef123456 提取码：a1b2 请尽快保存";

    const links = extractShareLinks(text, { sourceUrl: "https://example.com/post", foundIn: "raw" });

    expect(links).toHaveLength(1);
    expect(links[0].type).toBe("quark");
    expect(links[0].url).toBe("https://pan.quark.cn/s/abcdef123456");
    expect(links[0].pwdId).toBe("abcdef123456");
    expect(links[0].passcode).toBe("a1b2");
    expect(links[0].foundIn).toBe("raw");
    expect(links[0].sourceUrl).toBe("https://example.com/post");
  });

  it("URL 上的 pwd 参数优先于正文里的提取码", () => {
    const text = "https://pan.quark.cn/s/abcdef123456?pwd=zzzz 提取码：a1b2";

    expect(extractShareLinks(text)[0].passcode).toBe("zzzz");
  });

  it("丢弃被省略号截断的残链", () => {
    const text = "https://pan.quark.cn/s/abcdefghij… 后面还有内容";

    expect(extractShareLinks(text)).toHaveLength(0);
  });

  it("丢弃 ID 过短的残链", () => {
    expect(extractShareLinks("见 https://pan.quark.cn/s/abc123 谢谢")).toHaveLength(0);
  });

  it("识别其它平台", () => {
    const text = "百度：https://pan.baidu.com/s/1abcdefghij 迅雷：https://pan.xunlei.com/s/Vabcdefghij";
    const types = extractShareLinks(text).map((link) => link.type).sort();

    expect(types).toEqual(["baidu", "xunlei"]);
  });

  it("没有分享链接时返回空数组", () => {
    expect(extractShareLinks("这里只有 https://example.com/a/b 一个普通链接")).toHaveLength(0);
    expect(extractShareLinks("")).toHaveLength(0);
  });
});

describe("dedupeShareLinks", () => {
  it("按规范化 URL 去重并合并提取码", () => {
    const merged = dedupeShareLinks([
      record({ url: "https://pan.quark.cn/s/abcdef123456", passcode: "", foundIn: "snippet" }),
      record({ url: "https://pan.quark.cn/s/abcdef123456", passcode: "a1b2", foundIn: "raw" })
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].passcode).toBe("a1b2");
    // 来源位置取可信度更高的 raw
    expect(merged[0].foundIn).toBe("raw");
  });

  it("不把 snippet 覆盖降级掉更高可信度的来源", () => {
    const merged = dedupeShareLinks([
      record({ url: "https://pan.quark.cn/s/abcdef123456", foundIn: "raw" }),
      record({ url: "https://pan.quark.cn/s/abcdef123456", foundIn: "snippet" })
    ]);

    expect(merged[0].foundIn).toBe("raw");
  });

  it("丢弃互为前缀的短链，保留完整的长链", () => {
    const merged = dedupeShareLinks([
      record({ url: "https://pan.quark.cn/s/AAAA1111" }),
      record({ url: "https://pan.quark.cn/s/AAAA1111BBBB2222" })
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].url).toBe("https://pan.quark.cn/s/AAAA1111BBBB2222");
  });

  it("不同平台的链接互不影响", () => {
    const merged = dedupeShareLinks([
      record({ type: "quark", url: "https://pan.quark.cn/s/AAAA1111" }),
      record({ type: "baidu", url: "https://pan.baidu.com/s/AAAA1111BBBB2222" })
    ]);

    expect(merged).toHaveLength(2);
  });
});

describe("sortShareLinks", () => {
  it("按 raw > url > snippet 排序", () => {
    const sorted = sortShareLinks([
      record({ url: "https://pan.quark.cn/s/aaaa1111", foundIn: "snippet" }),
      record({ url: "https://pan.quark.cn/s/bbbb1111", foundIn: "raw" }),
      record({ url: "https://pan.quark.cn/s/cccc1111", foundIn: "url" })
    ]);

    expect(sorted.map((link) => link.foundIn)).toEqual(["raw", "url", "snippet"]);
  });
});
