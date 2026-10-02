/**
 * 网盘工具集。
 *
 * 覆盖三类能力：
 *  - 查询：drive_list_files（列一层）、drive_resolve_path（路径逐层解析）
 *  - 取链：drive_get_download_links（按 fid 获取带签名直链）
 *  - 缓存：drive_cache_manage（查看统计 / 清理）
 *
 * 所有查询类工具都会在文本与 structuredContent 中带上缓存提示，
 * 方便判断目录数据是复用了缓存还是实时拉取。
 */
import { z } from "zod";

import { cacheClear, cacheInvalidate, cacheStats } from "../drive/cache.js";
import { getDownloadLinks, listFiles, resolvePath } from "../drive/file-service.js";
import { cacheMetaSchema, describeCache, formatBytes, formatTimestamp, toolError } from "./shared.js";

export function registerDriveTools (server) {
  // ── 工具 1：列出目录一层内容 ─────────────────────────────────────────────
  server.registerTool(
    "drive_list_files",
    {
      title: "查询网盘目录",
      description:
        "列出指定目录的直接子项（一层），支持分页。pdir_fid 为父目录 ID，根目录用 \"0\"。" +
        "结果按父目录缓存，重复查询会提示「缓存命中」；如需强制刷新可传 force_refresh=true。",
      inputSchema: {
        pdir_fid: z.string().optional().default("0").describe("父目录 fid，根目录为 \"0\""),
        page: z.number().int().min(1).optional().default(1).describe("页码，从 1 开始"),
        size: z.number().int().min(1).max(200).optional().default(50).describe("每页条数，1~200"),
        sort: z
          .string()
          .optional()
          .describe("排序表达式，默认 file_type:asc,updated_at:desc（目录优先、新文件在前）"),
        force_refresh: z.boolean().optional().default(false).describe("是否跳过缓存强制拉取")
      },
      outputSchema: {
        dirFid: z.string(),
        page: z.number(),
        size: z.number(),
        count: z.number().describe("本页条数"),
        total: z.number().describe("该目录条目总数"),
        cache: cacheMetaSchema,
        items: z.array(
          z.object({
            fid: z.string(),
            file_name: z.string(),
            dir: z.boolean(),
            file: z.boolean(),
            size: z.number(),
            format_type: z.string(),
            updated_at: z.number(),
            include_items: z.number()
          })
        )
      },
      annotations: {
        title: "查询网盘目录",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async ({ pdir_fid, page, size, sort, force_refresh }) => {
      try {
        const listing = await listFiles({ pdirFid: pdir_fid, page, size, sort, forceRefresh: force_refresh });

        const items = listing.items.map((item) => ({
          fid: String(item.fid ?? ""),
          file_name: String(item.file_name ?? ""),
          dir: item.dir === true,
          file: item.file === true,
          size: Number(item.size ?? 0),
          format_type: String(item.format_type ?? ""),
          updated_at: Number(item.updated_at ?? 0),
          include_items: Number(item.include_items ?? 0)
        }));

        const header = [
          `目录 fid=${pdir_fid}`,
          `第 ${listing.page} 页`,
          `本页 ${listing.count} 项`,
          `总计 ${listing.total} 项`,
          describeCache(listing.cache)
        ].join(" · ");

        const body =
          items.length === 0
            ? "（该目录为空）"
            : items
              .map((item) => {
                const meta = item.dir
                  ? `目录，含 ${item.include_items} 项`
                  : `${formatBytes(item.size)} ${item.format_type || "未知类型"}`;
                return `${item.dir ? "[目录]" : "[文件]"} ${item.fid}  ${item.file_name}  （${meta}）`;
              })
              .join("\n");

        return {
          content: [{ type: "text", text: `${header}\n${body}` }],
          structuredContent: {
            dirFid: pdir_fid,
            page: listing.page,
            size: listing.size,
            count: listing.count,
            total: listing.total,
            cache: listing.cache,
            items
          }
        };
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // ── 工具 2：按路径逐层解析 fid ───────────────────────────────────────────
  server.registerTool(
    "drive_resolve_path",
    {
      title: "解析网盘路径",
      description:
        "把形如 /film/明天也要上班 的路径逐层解析为文件或目录 fid。每一层都优先命中缓存，" +
        "因此重复解析同一路径时中间层不再重复请求。同名歧义或路径不存在会返回可读错误。",
      inputSchema: {
        path: z.string().min(1).describe("以 / 分隔的路径，例如 /film/明天也要上班"),
        force_refresh: z.boolean().optional().default(false).describe("是否跳过缓存，逐层强制拉取")
      },
      outputSchema: {
        resolved: z.boolean(),
        fid: z.string(),
        segments: z.array(z.string()),
        steps: z.array(
          z.object({
            name: z.string(),
            fid: z.string(),
            parentFid: z.string(),
            dir: z.boolean(),
            file: z.boolean(),
            updatedAt: z.number(),
            cacheHit: z.boolean(),
            ageSeconds: z.number(),
            source: z.string()
          })
        ),
        error: z.string().optional(),
        hint: z.string().optional()
      },
      annotations: {
        title: "解析网盘路径",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async ({ path, force_refresh }) => {
      try {
        const result = await resolvePath(path, { forceRefresh: force_refresh });

        if (!result.resolved) {
          const hint = buildResolveHint(result.hints);

          return {
            isError: true,
            content: [{ type: "text", text: `❌ ${result.error}${hint === "" ? "" : `\n${hint}`}` }],
            structuredContent: {
              resolved: false,
              fid: result.fid,
              segments: result.segments,
              steps: result.steps,
              error: result.error,
              hint
            }
          };
        }

        const lines =
          result.steps.length === 0
            ? ["（根目录）"]
            : result.steps.map(
              (step, index) =>
                `  ${index + 1}. ${result.segments.slice(0, index + 1).join("/")} → fid=${step.fid} ` +
                `（${step.dir ? "目录" : "文件"}）${describeCache({ source: step.source, ageSeconds: step.ageSeconds, ttlSeconds: 0, hit: step.cacheHit })}`
            );

        const text = [`✅ 路径 ${path} 已解析，最终 fid=${result.fid}`, ...lines].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            resolved: true,
            fid: result.fid,
            segments: result.segments,
            steps: result.steps
          }
        };
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // ── 工具 3：按 fid 获取下载直链 ──────────────────────────────────────────
  server.registerTool(
    "drive_get_download_links",
    {
      title: "获取下载直链",
      description:
        "根据一个或多个文件 fid 获取带签名的下载直链。直链通常约 1 小时过期，且存在防盗链，" +
        "下载时必须携带正确的 User-Agent 与 Referer（drive_push_to_aria2 会自动注入）。" +
        "注意：目录 fid 无法获取直链，请传入文件 fid。",
      inputSchema: {
        fids: z.array(z.string().min(1)).min(1).describe("文件 fid 列表")
      },
      outputSchema: {
        total: z.number(),
        links: z.array(
          z.object({
            fid: z.string(),
            file_name: z.string(),
            size: z.number(),
            format_type: z.string(),
            md5: z.string(),
            download_url: z.string(),
            preview_url: z.string(),
            thumbnail: z.string()
          })
        )
      },
      annotations: {
        title: "获取下载直链",
        readOnlyHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ fids }) => {
      try {
        const links = await getDownloadLinks(fids);

        const text = [
          `获取到 ${links.length} 个直链（有效期约 1 小时，下载需携带 UA 与 Referer）：`,
          ...links.map(
            (link, index) =>
              `${index + 1}. ${link.file_name}  ${formatBytes(link.size)}  ${link.format_type || "未知类型"}\n   ${link.download_url}`
          )
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: { total: links.length, links }
        };
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // ── 工具 4：缓存查看与清理 ───────────────────────────────────────────────
  server.registerTool(
    "drive_cache_manage",
    {
      title: "管理目录缓存",
      description:
        "查看缓存统计（stats），或清理缓存：clear 清空全部，invalidate 仅清理指定目录及其分页。" +
        "缓存为进程内内存缓存，重启即失效；目录结构变化后可用 invalidate/clear 强制下次重新拉取。",
      inputSchema: {
        action: z.enum(["stats", "clear", "invalidate"]).optional().default("stats").describe("操作类型"),
        pdir_fid: z.string().optional().describe("action=invalidate 时必填，指定要失效的父目录 fid")
      },
      outputSchema: {
        action: z.string(),
        message: z.string(),
        stats: z.object({
          enabled: z.boolean().describe("缓存是否启用；DRIVE_CACHE_MAX_ENTRIES=0 时为 false"),
          entries: z.number(),
          maxEntries: z.number(),
          ttlSeconds: z.number(),
          hits: z.number(),
          misses: z.number(),
          evictions: z.number(),
          staleEntries: z.number(),
          inflight: z.number()
        })
      },
      annotations: {
        title: "管理目录缓存",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ action, pdir_fid }) => {
      try {
        let message;

        switch (action) {
          case "clear": {
            const removed = cacheClear();
            message = `已清空缓存，移除 ${removed} 个目录条目。`;
            break;
          }
          case "invalidate": {
            if (!pdir_fid) {
              return toolError(new Error("action=invalidate 时必须提供 pdir_fid（要失效的父目录 fid）。"));
            }
            const removed = cacheInvalidate(pdir_fid);
            message = `已使目录 fid=${pdir_fid} 的缓存失效，移除 ${removed} 个条目。`;
            break;
          }
          default: {
            message = "缓存统计如下（TTL 到期或手动清理后条目会消失）。";
          }
        }

        // ⚠️ SDK 对 structuredContent 严格校验（additionalProperties:false），
        // 因此必须显式裁剪为 schema 声明的字段，不能把 cacheStats() 原样返回。
        const raw = cacheStats();
        const stats = {
          enabled: raw.enabled,
          entries: raw.entries,
          maxEntries: raw.maxEntries,
          ttlSeconds: raw.ttlSeconds,
          hits: raw.hits,
          misses: raw.misses,
          evictions: raw.evictions,
          staleEntries: raw.staleEntries,
          inflight: raw.inflight
        };

        const text = stats.enabled
          ? [
              message,
              `条目 ${stats.entries}/${stats.maxEntries} · 命中 ${stats.hits} · 未命中 ${stats.misses} · ` +
              `过期 ${stats.staleEntries} · 淘汰 ${stats.evictions} · TTL ${stats.ttlSeconds}s`
            ].join("\n")
          : [message, "缓存当前已关闭（DRIVE_CACHE_MAX_ENTRIES=0），所有查询都直接请求夸克接口。"].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: { action, message, stats }
        };
      } catch (err) {
        return toolError(err);
      }
    }
  );
}

/** 把解析失败的补充信息整理成一行提示 */
function buildResolveHint (hints) {
  if (!hints) return "";

  if (Array.isArray(hints.available)) {
    const preview = hints.available.filter((name) => name !== "").slice(0, 20);
    return preview.length === 0
      ? "该目录当前为空。"
      : `该目录下可选项（前 ${preview.length} 个）：${preview.join(" / ")}`;
  }

  if (Array.isArray(hints.candidates)) {
    return `候选：${hints.candidates.map((item) => `${item.fid}(${item.dir ? "目录" : "文件"})`).join(" / ")}`;
  }

  return "";
}
