/**
 * 分享浏览工具集（只读）。
 *
 * 用途：配合搜索工具（如 Tavily）拿到夸克分享链接后，先解析链接、再浏览分享内容，
 * 为后续「转存到自己网盘」做准备。
 *
 * 当前仅提供只读能力；转存（save）为写操作，尚未实现。
 * 需要特别提醒模型：分享内的 fid 与本账号网盘 fid 不是同一套，
 * 不能直接用于 drive_get_download_links。
 */
import { z } from "zod";

import { listShareFiles, normalizeShareItem, parseShareLink } from "../drive/share-service.js";
import { cacheMetaSchema, describeCache, formatBytes, toolError } from "./shared.js";

/** 分享内 fid 与网盘 fid 语义不同的统一提示语 */
const FID_SEMANTICS_NOTE =
  "⚠️ 以上 fid 属于「分享空间」，不能直接用于 drive_get_download_links；" +
  "需先转存到自己网盘（转存功能尚未提供），再对网盘内的 fid 获取直链。";

export function registerShareTools (server) {
  // ── 工具 1：解析分享链接 ────────────────────────────────────────────────
  server.registerTool(
    "drive_parse_share_link",
    {
      title: "解析分享链接",
      description:
        "把夸克分享链接或分享文本解析为 pwd_id 与提取码，不产生任何网络请求。" +
        "支持 https://pan.quark.cn/s/<pwd_id>、带「提取码：xxxx」的整段文本，或直接传 pwd_id。" +
        "解析结果可作为 drive_list_share_files 的入参。",
      inputSchema: {
        link: z.string().min(1).describe("分享链接、含提取码的分享文本，或直接是 pwd_id")
      },
      outputSchema: {
        valid: z.boolean().describe("是否解析成功"),
        pwdId: z.string().describe("分享 ID（pwd_id）"),
        passcode: z.string().describe("提取码，未检测到则为空字符串"),
        normalizedUrl: z.string().describe("归一化后的分享链接"),
        message: z.string().describe("可读的解析说明")
      },
      annotations: {
        title: "解析分享链接",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ link }) => {
      const result = parseShareLink(link);

      if (!result.valid) {
        return {
          isError: true,
          content: [{ type: "text", text: `❌ ${result.message}` }],
          structuredContent: result
        };
      }

      const text = [
        `✅ ${result.message}`,
        `pwd_id：${result.pwdId}`,
        `提取码：${result.passcode === "" ? "（无）" : result.passcode}`,
        `规范链接：${result.normalizedUrl}`,
        "",
        "下一步可调用 drive_list_share_files 浏览分享内容。"
      ].join("\n");

      return {
        content: [{ type: "text", text }],
        structuredContent: result
      };
    }
  );

  // ── 工具 2：浏览分享内容 ────────────────────────────────────────────────
  server.registerTool(
    "drive_list_share_files",
    {
      title: "浏览分享内容",
      description:
        "列出夸克分享中的文件（一层，支持分页）。可传分享链接或直接传 pwd_id，加密分享还需提取码。" +
        "结果按「分享 ID + 目录 + 分页」缓存并提示命中情况。注意分享内 fid 不等于网盘 fid，" +
        "要下载需先转存到自己网盘。",
      inputSchema: {
        link: z.string().optional().describe("分享链接或含提取码的分享文本，与 pwd_id 二选一"),
        pwd_id: z.string().optional().describe("分享 ID，与 link 二选一"),
        passcode: z.string().optional().describe("提取码，加密分享必填；若 link 中含提取码可省略"),
        pdir_fid: z.string().optional().default("0").describe("分享内目录 fid，根目录为 \"0\""),
        page: z.number().int().min(1).optional().default(1).describe("页码，从 1 开始"),
        size: z.number().int().min(1).max(200).optional().default(50).describe("每页条数，1~200"),
        force_refresh: z.boolean().optional().default(false).describe("是否跳过缓存强制拉取")
      },
      outputSchema: {
        pwdId: z.string(),
        shareTitle: z.string().describe("分享标题，可能为空"),
        page: z.number(),
        size: z.number(),
        count: z.number().describe("本页条数"),
        total: z.number().describe("分享内该层条目总数"),
        cache: cacheMetaSchema,
        items: z.array(
          z.object({
            fid: z.string().describe("分享内文件 fid（非本账号网盘 fid）"),
            share_fid_token: z.string().describe("转存时需要的分享凭证"),
            file_name: z.string(),
            dir: z.boolean(),
            file: z.boolean(),
            size: z.number(),
            format_type: z.string(),
            updated_at: z.number()
          })
        )
      },
      annotations: {
        title: "浏览分享内容",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async ({ link, pwd_id, passcode, pdir_fid, page, size, force_refresh }) => {
      try {
        let pwdId = String(pwd_id ?? "").trim();
        let passcode_ = String(passcode ?? "").trim();

        if (link !== undefined && link.trim() !== "") {
          const parsed = parseShareLink(link);
          if (!parsed.valid) {
            return toolError(new Error(parsed.message));
          }
          pwdId = parsed.pwdId;
          // 显式传入的提取码优先于链接中解析出的
          if (passcode_ === "") passcode_ = parsed.passcode;
        }

        if (pwdId === "") {
          return toolError(new Error("请提供分享链接（link）或分享 ID（pwd_id）。"));
        }

        const result = await listShareFiles({
          pwdId,
          passcode: passcode_,
          pdirFid: pdir_fid,
          page,
          size,
          forceRefresh: force_refresh
        });

        const items = result.items.map(normalizeShareItem);

        const header = [
          `分享 ${pwdId}${result.shareTitle === "" ? "" : `（${result.shareTitle}）`}`,
          `第 ${result.page} 页`,
          `本页 ${result.count} 项`,
          `总计 ${result.total} 项`,
          describeCache(result.cache)
        ].join(" · ");

        const body =
          items.length === 0
            ? "（该目录为空）"
            : items
              .map((item) => {
                const meta = item.dir
                  ? "目录"
                  : `${formatBytes(item.size)} ${item.format_type || "未知类型"}`;
                return `${item.dir ? "[目录]" : "[文件]"} ${item.fid}  ${item.file_name}  （${meta}）`;
              })
              .join("\n");

        return {
          content: [{ type: "text", text: `${header}\n${body}\n\n${FID_SEMANTICS_NOTE}` }],
          structuredContent: {
            pwdId,
            shareTitle: result.shareTitle,
            page: result.page,
            size: result.size,
            count: result.count,
            total: result.total,
            cache: result.cache,
            items
          }
        };
      } catch (err) {
        return toolError(err);
      }
    }
  );
}
