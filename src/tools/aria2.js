/**
 * aria2 RPC 工具集。
 *
 * 覆盖「提交下载任务」与「任务管理」：
 *  - drive_push_to_aria2：按 fid 或直链提交下载任务（自动注入 UA/Referer 请求头）
 *  - aria2_task_status：按 gid 查询任务状态与进度
 *  - aria2_task_control：暂停 / 继续 / 删除任务
 */
import { z } from "zod";

import { CONTROL_ACTIONS, addUri, controlTask, tellStatus } from "../drive/aria2-client.js";
import { getDownloadLinks } from "../drive/file-service.js";
import { formatBytes, toolError } from "./shared.js";

/** aria2 任务状态 → 中文展示 */
const STATUS_TEXT = {
  active: "下载中",
  waiting: "等待中",
  paused: "已暂停",
  complete: "已完成",
  error: "出错",
  removed: "已移除"
};

/** 查询任务时只取必要字段，减少 RPC 传输量 */
const STATUS_KEYS = [
  "gid",
  "status",
  "totalLength",
  "completedLength",
  "downloadSpeed",
  "dir",
  "files",
  "errorCode",
  "errorMessage"
];

export function registerAria2Tools (server) {
  // ── 工具 1：提交下载任务 ────────────────────────────────────────────────
  server.registerTool(
    "drive_push_to_aria2",
    {
      title: "推送到 aria2 下载",
      description:
        "把网盘文件提交到 aria2 RPC 服务器下载。可传 fids（服务端自动换取直链）或 urls（直接提交直链）。" +
        "服务端会自动注入夸克直链所需的 UA/Referer 请求头；dir 缺省时使用环境变量 ARIA2_DOWNLOAD_DIR。" +
        "out 仅在只提交一个任务时可用。返回每个任务的 gid，可用于后续查询或控制。",
      inputSchema: {
        fids: z.array(z.string().min(1)).optional().describe("网盘文件 fid 列表，服务端会自动获取直链"),
        urls: z.array(z.string().min(1)).optional().describe("直接提交的下载地址列表"),
        dir: z.string().optional().describe("下载目标目录，缺省使用 ARIA2_DOWNLOAD_DIR"),
        out: z.string().optional().describe("输出文件名，仅在只提交一个任务时可用"),
        split: z.number().int().min(1).max(16).optional().describe("单任务并发连接数（aria2 split 选项）")
      },
      outputSchema: {
        total: z.number(),
        dir: z.string().describe("实际使用的下载目录"),
        tasks: z.array(
          z.object({
            gid: z.string(),
            fid: z.string().optional(),
            file_name: z.string().optional(),
            url: z.string().optional()
          })
        )
      },
      annotations: {
        title: "推送到 aria2 下载",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ fids, urls, dir, out, split }) => {
      try {
        const jobs = [];

        if (Array.isArray(fids) && fids.length > 0) {
          const links = await getDownloadLinks(fids);
          for (const link of links) {
            jobs.push({ fid: link.fid, file_name: link.file_name, url: link.download_url });
          }
        }

        if (Array.isArray(urls) && urls.length > 0) {
          for (const url of urls) jobs.push({ url });
        }

        if (jobs.length === 0) {
          return toolError(new Error("请至少提供 fids 或 urls 之一。"));
        }

        if (typeof out === "string" && out !== "" && jobs.length > 1) {
          return toolError(new Error(`out 只能用于单个任务，当前需要提交 ${jobs.length} 个任务。`));
        }

        const tasks = [];
        for (const job of jobs) {
          if (!job.url) {
            return toolError(new Error(`文件 ${job.file_name || job.fid} 未返回可用的下载直链。`));
          }

          const gid = await addUri(job.url, { dir, out, split });
          tasks.push({ gid, fid: job.fid, file_name: job.file_name, url: job.url });
        }

        const targetDir = dir && dir !== "" ? dir : (process.env.ARIA2_DOWNLOAD_DIR || "(aria2 默认目录)");

        const text = [
          `已提交 ${tasks.length} 个下载任务（dir=${targetDir}）：`,
          ...tasks.map((task, index) => `${index + 1}. gid=${task.gid}  ${task.file_name ?? task.url}`)
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            total: tasks.length,
            dir: targetDir,
            tasks
          }
        };
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // ── 工具 2：查询任务状态 ────────────────────────────────────────────────
  server.registerTool(
    "aria2_task_status",
    {
      title: "查询下载任务状态",
      description:
        "按 gid 查询 aria2 任务的状态、进度、速度与保存路径。status 常见取值：" +
        "active 下载中 / waiting 等待中 / paused 已暂停 / complete 已完成 / error 出错 / removed 已移除。",
      inputSchema: {
        gids: z.array(z.string().min(1)).min(1).describe("要查询的任务 gid 列表")
      },
      outputSchema: {
        total: z.number(),
        tasks: z.array(
          z.object({
            gid: z.string(),
            status: z.string(),
            progress: z.number().describe("完成百分比，0~100"),
            totalLength: z.number(),
            completedLength: z.number(),
            downloadSpeed: z.number(),
            dir: z.string(),
            path: z.string(),
            errorMessage: z.string().optional()
          })
        )
      },
      annotations: {
        title: "查询下载任务状态",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async ({ gids }) => {
      const tasks = [];

      for (const gid of gids) {
        try {
          const info = await tellStatus(gid, STATUS_KEYS);
          const totalLength = Number(info.totalLength ?? 0);
          const completedLength = Number(info.completedLength ?? 0);

          tasks.push({
            gid: String(info.gid ?? gid),
            status: String(info.status ?? "unknown"),
            progress: totalLength > 0 ? Math.round((completedLength / totalLength) * 1000) / 10 : 0,
            totalLength,
            completedLength,
            downloadSpeed: Number(info.downloadSpeed ?? 0),
            dir: String(info.dir ?? ""),
            path: String(info.files?.[0]?.path ?? ""),
            errorMessage: info.errorMessage ? String(info.errorMessage) : undefined
          });
        } catch (err) {
          tasks.push({
            gid,
            status: "error",
            progress: 0,
            totalLength: 0,
            completedLength: 0,
            downloadSpeed: 0,
            dir: "",
            path: "",
            errorMessage: err?.message ? String(err.message) : String(err)
          });
        }
      }

      const text = tasks
        .map((task) => {
          const label = STATUS_TEXT[task.status] ?? task.status;
          const base = `${task.gid}  ${label}  ${task.progress}%  ${formatBytes(task.completedLength)}/${formatBytes(task.totalLength)}  ${formatBytes(task.downloadSpeed)}/s`;

          if (task.errorMessage) return `${base}\n   错误：${task.errorMessage}`;
          return task.path === "" ? base : `${base}\n   ${task.path}`;
        })
        .join("\n");

      return {
        content: [{ type: "text", text: `共 ${tasks.length} 个任务：\n${text}` }],
        structuredContent: { total: tasks.length, tasks }
      };
    }
  );

  // ── 工具 3：任务控制 ────────────────────────────────────────────────────
  server.registerTool(
    "aria2_task_control",
    {
      title: "控制下载任务",
      description:
        "对任务执行 pause（暂停）、unpause（继续）、remove（移除）或 forceRemove（强制移除）。" +
        "注意：aria2 不允许直接移除 active 状态的任务，遇到该错误请先 pause 再 remove，或改用 forceRemove。",
      inputSchema: {
        gids: z.array(z.string().min(1)).min(1).describe("要操作的任务 gid 列表"),
        action: z.enum(CONTROL_ACTIONS).describe(`操作类型：${CONTROL_ACTIONS.join(" / ")}`)
      },
      outputSchema: {
        action: z.string(),
        total: z.number(),
        succeeded: z.number(),
        results: z.array(
          z.object({
            gid: z.string(),
            ok: z.boolean(),
            message: z.string().optional()
          })
        )
      },
      annotations: {
        title: "控制下载任务",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ gids, action }) => {
      const results = [];
      let succeeded = 0;

      for (const gid of gids) {
        try {
          await controlTask(action, gid);
          results.push({ gid, ok: true });
          succeeded += 1;
        } catch (err) {
          results.push({ gid, ok: false, message: err?.message ? String(err.message) : String(err) });
        }
      }

      const text = [
        `操作 ${action}：成功 ${succeeded}/${results.length}`,
        ...results.map((item) => `  ${item.ok ? "✅" : "❌"} ${item.gid}${item.message ? ` — ${item.message}` : ""}`)
      ].join("\n");

      return {
        content: [{ type: "text", text }],
        structuredContent: {
          action,
          total: results.length,
          succeeded,
          results
        }
      };
    }
  );
}
