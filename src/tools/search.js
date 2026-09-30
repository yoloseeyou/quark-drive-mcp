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

import { dedupeShareLinks, extractShareLinks } from "../search/share-links.js";
import { extract, search } from "../search/tavily-client.js";
import { toolError } from "./shared.js";

/** 网盘链接记录结构，供本文件各工具的输出 schema 复用 */
const shareLinkSchema = z.object({
  type: z.string().describe("网盘类型：quark / baidu / alipan / 123pan / xunlei / lanzou"),
  url: z.string().describe("规范化后的分享链接（仅保留 pwd 查询参数）"),
  pwdId: z.string().describe("夸克分享的 pwd_id，其它平台为空字符串"),
  passcode: z.string().describe("提取码，未识别到则为空字符串"),
  sourceUrl: z.string().describe("链接来源页面 URL"),
  sourceTitle: z.string().describe("来源页面标题"),
  foundIn: z.string().describe("来源位置：url 结果地址本身 / snippet 搜索摘要 / raw 页面正文")
});

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
        include_answer: z.boolean().optional().default(true).describe("是否返回 AI 生成的摘要答案"),
        include_raw_content: z
          .boolean()
          .optional()
          .default(false)
          .describe("是否一并抓取页面正文并从中提取网盘链接；正文本身不会返回，避免响应过大")
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
            score: z.number(),
            extractedCount: z.number().describe("该结果提取到的网盘链接数")
          })
        ),
        links: z.array(shareLinkSchema).describe("汇总去重后的网盘链接，来自结果地址、摘要与正文")
      },
      annotations: {
        title: "Tavily 关键词搜索",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async ({ query, max_results, search_depth, topic, include_domains, include_answer, include_raw_content }) => {
      try {
        const data = await search({
          query,
          maxResults: max_results,
          searchDepth: search_depth,
          topic,
          includeDomains: include_domains,
          includeAnswer: include_answer,
          includeRawContent: include_raw_content
        });

        const rawResults = Array.isArray(data.results) ? data.results : [];
        const collected = [];

        const results = rawResults.map((item) => {
          const url = String(item.url ?? "");
          const title = String(item.title ?? "");
          const content = String(item.content ?? "");
          const rawContent = String(item.raw_content ?? "");

          // 结果地址本身、搜索摘要、页面正文三处都尝试提取
          const extracted = [
            ...extractShareLinks(url, { sourceUrl: url, sourceTitle: title, foundIn: "url" }),
            ...extractShareLinks(content, { sourceUrl: url, sourceTitle: title, foundIn: "snippet" }),
            ...(include_raw_content
              ? extractShareLinks(rawContent, { sourceUrl: url, sourceTitle: title, foundIn: "raw" })
              : [])
          ];

          collected.push(...extracted);

          return {
            title,
            url,
            content,
            score: Number(item.score ?? 0),
            extractedCount: dedupeShareLinks(extracted).length
          };
        });

        const links = dedupeShareLinks(collected);
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
            if (item.extractedCount > 0) lines.push(`   ↳ 提取到 ${item.extractedCount} 条网盘链接`);
          });
        }

        if (links.length > 0) {
          lines.push("", `🔗 提取到 ${links.length} 条网盘链接：`);
          links.forEach((link) =>
            lines.push(`  - [${link.type}] ${link.url}${link.passcode === "" ? "" : `　提取码：${link.passcode}`}`)
          );
        } else if (include_raw_content) {
          lines.push("", "（未从摘要与正文中提取到网盘链接）");
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: {
            query,
            answer,
            responseTime: Number(data.response_time ?? 0),
            count: results.length,
            results,
            links
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
            links: z.array(shareLinkSchema)
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
          const pageUrl = String(page.url ?? "");
          const links = extractShareLinks(page.raw_content, {
            sourceUrl: pageUrl,
            sourceTitle: "",
            foundIn: "raw"
          });

          return {
            url: pageUrl,
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
            page.links.forEach((link) =>
              lines.push(`  - [${link.type}] ${link.url}${link.passcode === "" ? "" : `　提取码：${link.passcode}`}`)
            );
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

  // ── 工具 3：搜索并直接提取网盘链接 ─────────────────────────────────────
  server.registerTool(
    "tavily_search_links",
    {
      title: "搜索并提取网盘链接",
      description:
        "一步完成「关键词搜索 → 抓取结果页正文 → 提取网盘分享链接」，适用于搜索结果多为第三方资源站、" +
        "真实网盘链接藏在页面正文里的场景。会同时从结果地址、搜索摘要与页面正文三处提取，按规范化 URL 去重，" +
        "并尽力捕获提取码；正文抓取失败的页面会记入 failed 并降级为仅用摘要提取。需要环境变量 TAVILY_API_KEY。",
      inputSchema: {
        query: z.string().min(1).describe("搜索关键词，例如 某剧 夸克网盘"),
        max_results: z.number().int().min(1).max(10).optional().default(5).describe("搜索返回的结果条数，1~10"),
        extract_limit: z
          .number()
          .int()
          .min(0)
          .max(10)
          .optional()
          .default(5)
          .describe("最多抓取多少个结果页正文，0 表示只从搜索结果摘要中提取"),
        extract_depth: z
          .enum(["basic", "advanced"])
          .optional()
          .default("advanced")
          .describe("页面抓取深度，advanced 正文更完整但更慢"),
        search_depth: z.enum(["basic", "advanced"]).optional().default("basic").describe("搜索深度"),
        include_domains: z
          .array(z.string().min(1))
          .optional()
          .describe("限定搜索域名，例如 [\"pan.quark.cn\"]")
      },
      outputSchema: {
        query: z.string(),
        searched: z.number().describe("搜索结果条数"),
        extractedPages: z.number().describe("抓取到正文且提取出链接的页面数"),
        total: z.number().describe("去重后的网盘链接总数"),
        links: z.array(shareLinkSchema),
        failed: z.array(
          z.object({
            url: z.string(),
            error: z.string()
          })
        )
      },
      annotations: {
        title: "搜索并提取网盘链接",
        readOnlyHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ query, max_results, extract_limit, extract_depth, search_depth, include_domains }) => {
      try {
        const data = await search({
          query,
          maxResults: max_results,
          searchDepth: search_depth,
          includeDomains: include_domains,
          includeAnswer: false
        });

        const rawResults = Array.isArray(data.results) ? data.results : [];
        const collected = [];
        const pageTargets = [];

        // 来源一与来源二：结果地址本身、搜索摘要，均不需要额外请求
        for (const item of rawResults) {
          const url = String(item.url ?? "");
          const title = String(item.title ?? "");
          const content = String(item.content ?? "");

          collected.push(...extractShareLinks(url, { sourceUrl: url, sourceTitle: title, foundIn: "url" }));
          collected.push(...extractShareLinks(content, { sourceUrl: url, sourceTitle: title, foundIn: "snippet" }));

          // 只对「自身不是网盘链接」的普通网页做正文抓取
          const isDirectShareLink = extractShareLinks(url).length > 0;
          if (!isDirectShareLink && url !== "") pageTargets.push({ url, title });
        }

        const targets = pageTargets.slice(0, extract_limit);
        const failed = [];
        let extractedPages = 0;

        // 来源三：批量抓取正文（一次请求覆盖多个页面）
        if (targets.length > 0) {
          try {
            const extracted = await extract({
              urls: targets.map((item) => item.url),
              extractDepth: extract_depth
            });

            const pages = Array.isArray(extracted.results) ? extracted.results : [];

            for (const page of pages) {
              const pageUrl = String(page.url ?? "");
              const title = targets.find((item) => item.url === pageUrl)?.title ?? "";
              const links = extractShareLinks(page.raw_content, {
                sourceUrl: pageUrl,
                sourceTitle: title,
                foundIn: "raw"
              });

              if (links.length > 0) extractedPages += 1;
              collected.push(...links);
            }

            const failedRaw = Array.isArray(extracted.failed_results) ? extracted.failed_results : [];
            for (const item of failedRaw) {
              failed.push({
                url: String(item.url ?? ""),
                error: String(item.error ?? "未知错误")
              });
            }
          } catch (err) {
            // 正文抓取整体失败时降级：保留摘要中已提取的链接，并把失败页面如实上报
            for (const item of targets) {
              failed.push({ url: item.url, error: err?.message ? String(err.message) : String(err) });
            }
          }
        }

        const links = dedupeShareLinks(collected);

        const lines = [
          `🔍 搜索：${query}`,
          `结果 ${rawResults.length} 条 · 抓取页面 ${targets.length} 个（有产出 ${extractedPages} 个）· 去重后 ${links.length} 条网盘链接`
        ];

        if (links.length === 0) {
          lines.push(
            "",
            "（未提取到网盘链接。常见原因：结果页需要登录或验证码、正文由 JS 渲染、链接被变形书写、或该关键词确实没有资源）"
          );
        } else {
          lines.push("");
          links.forEach((link, index) => {
            lines.push(
              `${index + 1}. [${link.type}] ${link.url}${link.passcode === "" ? "" : `　提取码：${link.passcode}`}`
            );
            lines.push(`   来源：${link.sourceTitle || link.sourceUrl}（${link.foundIn}）`);
          });
        }

        if (failed.length > 0) {
          lines.push("", "⚠️ 以下页面正文抓取失败，已降级为仅用摘要提取：");
          failed.forEach((item) => lines.push(`  - ${item.url}：${item.error}`));
        }

        lines.push("", "下一步：用 drive_parse_share_link 解析链接，再用 drive_list_share_files 浏览分享内容。");

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: {
            query,
            searched: rawResults.length,
            extractedPages,
            total: links.length,
            links,
            failed
          }
        };
      } catch (err) {
        return toolError(err);
      }
    }
  );
}
