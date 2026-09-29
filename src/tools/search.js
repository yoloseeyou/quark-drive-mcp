/**
 * Tavily 搜索工具集。
 *
 * 覆盖两类能力：
 *  - tavily_search：基于关键词的 AI 搜索，返回标题 / URL / 摘要
 *  - tavily_extract_links：读取页面正文，正则提取网盘分享链接
 *
 * 均为只读、幂等。分享链接的「转存到网盘」能力留待后续步骤实现。
 */
import { z } from "zod";

import { extract, search } from "../search/tavily-client.js";
import { toolError } from "./shared.js";

/** 常见网盘分享链接特征，按平台归类 */
const SHARE_LINK_PATTERNS = [
  { type: "quark", pattern: /https?:\/\/pan\.quark\.cn\/s\/[A-Za-z0-9]+/gi },
  { type: "baidu", pattern: /https?:\/\/pan\.baidu\.com\/s\/[A-Za-z0-9_-]+/gi },
  { type: "alipan", pattern: /https?:\/\/(?:www\.)?(?:alipan|aliyundrive)\.com\/s\/[A-Za-z0-9]+/gi },
  { type: "123pan", pattern: /https?:\/\/(?:www\.)?123pan\.com\/s\/[A-Za-z0-9_-]+/gi },
  { type: "xunlei", pattern: /https?:\/\/pan\.xunlei\.com\/s\/[A-Za-z0-9_-]+/gi },
  { type: "lanzou", pattern: /https?:\/\/[A-Za-z0-9.-]*lanzou[A-Za-z0-9]*\.com\/[A-Za-z0-9/_-]+/gi }
];

/**
 * 从一段文本中提取去重后的网盘分享链接。
 * @param {string} text 页面正文
 * @returns {{type: string, url: string}[]}
 */
function extractShareLinks (text) {
  const raw = String(text ?? "");
  const found = new Map();

  for (const { type, pattern } of SHARE_LINK_PATTERNS) {
    for (const match of raw.matchAll(pattern)) {
      // 去掉 URL 尾部可能粘连的标点
      const url = match[0].replace(/[.,;!?)]+$/, "");
      if (!found.has(url)) found.set(url, type);
    }
  }

  return Array.from(found, ([url, type]) => ({ type, url }));
}

export function registerSearchTools (server) {
  // ── 工具 1：关键词 AI 搜索 ──────────────────────────────────────────────
  server.registerTool(
    "tavily_search",
    {
      title: "Tavily 关键词搜索",
      description:
        "基于 Tavily AI 搜索引擎按关键词搜索，返回标题、URL 与内容摘要。" +
        "可选限定搜索域名（如 pan.quark.cn）、调整结果条数与搜索深度。" +
        "需要环境变量 TAVILY_API_KEY。",
      inputSchema: {
        query: z.string().min(1).describe("搜索关键词，例如 某电影 夸克网盘"),
        max_results: z.number().int().min(1).max(10).optional().default(5).describe("返回结果条数，1~10"),
        search_depth: z.enum(["basic", "advanced"]).optional().default("basic").describe("搜索深度，advanced 更全但更慢"),
        topic: z.enum(["general", "news"]).optional().default("general").describe("搜索主题"),
        include_domains: z.array(z.string().min(1)).optional().describe("限定搜索域名，例如 [\"pan.quark.cn\"]"),
        include_answer: z.boolean().optional().default(true).describe("是否返回 AI 生成的摘要答案")
      },
      outputSchema: {
        query: z.string(),
        answer: z.string(),
        responseTime: z.number(),
        count: z.number().describe("结果条数"),
        results: z.array(
          z.object({
            title: z.string(),
            url: z.string(),
            content: z.string(),
            score: z.number()
          })
        )
      },
      annotations: {
        title: "Tavily 关键词搜索",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async ({ query, max_results, search_depth, topic, include_domains, include_answer }) => {
      try {
        const data = await search({
          query,
          maxResults: max_results,
          searchDepth: search_depth,
          topic,
          includeDomains: include_domains,
          includeAnswer: include_answer
        });

        const results = (Array.isArray(data.results) ? data.results : []).map((item) => ({
          title: String(item.title ?? ""),
          url: String(item.url ?? ""),
          content: String(item.content ?? ""),
          score: Number(item.score ?? 0)
        }));

        const answer = data.answer ? String(data.answer) : "";

        const lines = [`🔍 搜索：${query}`, `结果 ${results.length} 条`];
        if (answer !== "") lines.push("", `【摘要】${answer}`);

        if (results.length === 0) {
          lines.push("（无结果）");
        } else {
          lines.push("");
          results.forEach((item, index) => {
            lines.push(`${index + 1}. ${item.title}`);
            lines.push(`   ${item.url}`);
            if (item.content !== "") lines.push(`   ${item.content}`);
          });
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: {
            query,
            answer,
            responseTime: Number(data.response_time ?? 0),
            count: results.length,
            results
          }
        };
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // ── 工具 2：读取页面并提取网盘分享链接 ─────────────────────────────────
  server.registerTool(
    "tavily_extract_links",
    {
      title: "读取页面提取分享链接",
      description:
        "读取一个或多个页面正文，并从中正则提取网盘分享链接（夸克、百度、阿里、123、迅雷、蓝奏等）。" +
        "需要环境变量 TAVILY_API_KEY。提取到的链接只返回给模型，不自动写入网盘。",
      inputSchema: {
        urls: z.array(z.string().min(1)).min(1).max(20).describe("要读取的页面 URL 列表"),
        extract_depth: z.enum(["basic", "advanced"]).optional().default("basic").describe("提取深度，advanced 内容更完整但更慢")
      },
      outputSchema: {
        total: z.number().describe("提取到的分享链接总数"),
        pages: z.array(
          z.object({
            url: z.string(),
            rawLength: z.number(),
            extractedCount: z.number(),
            links: z.array(
              z.object({
                type: z.string(),
                url: z.string()
              })
            )
          })
        ),
        failed: z.array(
          z.object({
            url: z.string(),
            error: z.string()
          })
        )
      },
      annotations: {
        title: "读取页面提取分享链接",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async ({ urls, extract_depth }) => {
      try {
        const data = await extract({ urls, extractDepth: extract_depth });

        const results = Array.isArray(data.results) ? data.results : [];
        const failedRaw = Array.isArray(data.failed_results) ? data.failed_results : [];

        const pages = results.map((page) => {
          const links = extractShareLinks(page.raw_content);
          return {
            url: String(page.url ?? ""),
            rawLength: String(page.raw_content ?? "").length,
            extractedCount: links.length,
            links
          };
        });

        const failed = failedRaw.map((item) => ({
          url: String(item.url ?? ""),
          error: String(item.error ?? "未知错误")
        }));

        const total = pages.reduce((sum, page) => sum + page.links.length, 0);

        const lines = [`🔗 页面读取完成：${pages.length} 个页面，提取到 ${total} 条分享链接`];

        pages.forEach((page) => {
          lines.push("", `【${page.url}】共 ${page.extractedCount} 条链接`);
          if (page.links.length === 0) {
            lines.push("  （未发现网盘分享链接）");
          } else {
            page.links.forEach((link) => lines.push(`  - [${link.type}] ${link.url}`));
          }
        });

        if (failed.length > 0) {
          lines.push("", "⚠️ 以下页面读取失败：");
          failed.forEach((item) => lines.push(`  - ${item.url}：${item.error}`));
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: {
            total,
            pages,
            failed
          }
        };
      } catch (err) {
        return toolError(err);
      }
    }
  );
}
