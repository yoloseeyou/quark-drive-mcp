/**
 * aria2 RPC 工具集。
 *
 * 覆盖「提交下载任务」与「任务管理」：
 *  - drive_push_to_aria2：两阶段提交（预览待确认清单 → 用户确认后提交），自动注入 UA/Referer 请求头
 *  - aria2_task_status：按 gid 查询任务状态与进度
 *  - aria2_task_control：暂停 / 继续 / 删除 / 清理任务记录
 *
 * ⚠️ 提交下载属于写操作：默认只返回「待确认清单」，此时**不获取直链、不产生任务**；
 *    必须由用户确认后携带一次性 confirm_token 再次调用，才会取直链并真正提交。
 */
import { z } from "zod";

import { getConfig } from "../config.js";
import { CONTROL_ACTIONS, addUri, controlTask, tellStatus } from "../drive/aria2-client.js";
import { consumeConfirmToken, issueConfirmToken } from "../drive/confirm-store.js";
import { getDownloadLinks } from "../drive/file-service.js";
import { getShareDownloadLinks, listShareFiles } from "../drive/share-service.js";
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

/** 取下载地址的主机名，解析失败时返回空串 */
function hostOf (url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return "";
  }
}

/** 把调用方传入的 items 转成「按 fid 或文件名查询描述」的函数 */
function buildDescriptor (items) {
  const list = Array.isArray(items) ? items : [];
  const byKey = new Map();

  for (const item of list) {
    if (item === null || item === undefined) continue;

    const fidKey = String(item.fid ?? "").trim();
    const nameKey = String(item.file_name ?? "").trim();
    const key = fidKey !== "" ? fidKey : nameKey;
    if (key === "") continue;

    byKey.set(key, {
      file_name: nameKey,
      size: Number(item.size ?? 0),
      format_type: String(item.format_type ?? "")
    });
  }

  return (key) => byKey.get(String(key)) ?? { file_name: "", size: 0, format_type: "" };
}

/**
 * 在分享内广度优先查找指定 fid 的元信息，用于补全待确认清单的文件名与大小。
 * 有受限预算（默认最多 6 次列表请求、深度不超过 4）；命中缓存时不会产生额外网络请求。
 * @param {string} pwdId
 * @param {string} passcode
 * @param {string[]} fids
 * @param {{count: number, max: number}} [budget]
 * @returns {Promise<Map<string, {file_name: string, size: number, format_type: string}>>}
 */
async function describeShareItems (pwdId, passcode, fids, budget) {
  const wanted = new Set(fids);
  const found = new Map();
  const queue = [{ fid: "0", depth: 0 }];
  const limit = budget ?? { count: 0, max: 6 };

  while (queue.length > 0 && found.size < wanted.size && limit.count < limit.max) {
    const node = queue.shift();
    if (node.depth > 4) continue;

    limit.count += 1;

    try {
      const listing = await listShareFiles({ pwdId, passcode, pdirFid: node.fid, page: 1, size: 100 });

      for (const item of listing.items) {
        const fid = String(item.fid ?? "");

        if (wanted.has(fid)) {
          found.set(fid, {
            file_name: String(item.file_name ?? ""),
            size: Number(item.size ?? 0),
            format_type: String(item.format_type ?? "")
          });
        }

        if (item.dir === true) queue.push({ fid, depth: node.depth + 1 });
      }
    } catch {
      // 分享不可用时不阻塞「预览」，问题留到提交阶段以可读错误暴露
      break;
    }
  }

  return found;
}

/** 组装一条待确认任务记录 */
function makeTask (index, base, meta) {
  const { source, fid, url, dirLabel, out } = base;
  const fileName =
    meta.file_name !== "" ? meta.file_name : (fid !== "" ? `（名称未知）${fid}` : `（名称未知）${hostOf(url)}`);

  return {
    index,
    file_name: fileName,
    size: Number(meta.size ?? 0),
    format_type: String(meta.format_type ?? ""),
    source,
    fid,
    url,
    out: out ?? "",
    targetPath: out === undefined || out === "" ? `${dirLabel}／（沿用原文件名）` : `${dirLabel}／${out}`
  };
}

/**
 * 阶段一：整理待确认计划。
 * 不获取任何下载直链；分享来源会走一次分享列表（通常命中缓存）以补全文件名。
 * @returns {Promise<object>} 计划对象，会被存入确认令牌存储
 */
async function buildPushPlan ({ fids, share_pwd_id, share_passcode, share_fids, urls, items, dir, out, split }) {
  const ownFids = Array.isArray(fids) ? fids.map(String).filter((value) => value !== "") : [];
  const sharedFids = Array.isArray(share_fids) ? share_fids.map(String).filter((value) => value !== "") : [];
  const directUrls = Array.isArray(urls) ? urls.map(String).filter((value) => value !== "") : [];

  const provided = [ownFids.length > 0, sharedFids.length > 0, directUrls.length > 0].filter(Boolean).length;
  if (provided === 0) throw new Error("请提供 fids（自有网盘）、share_fids（分享内）或 urls（直接地址）之一作为下载目标。");
  if (provided > 1) throw new Error("fids、share_fids、urls 只能三选一，请勿混用。");

  const describe = buildDescriptor(items);
  // 与 addUri 保持同一来源：优先调用方传入的 dir，其次 ARIA2_DOWNLOAD_DIR，最后交给 aria2 自身配置
  const configuredDir = getConfig().aria2.downloadDir;
  const dirLabel = dir !== undefined && dir !== ""
    ? dir
    : (configuredDir !== "" ? configuredDir : "（未配置 ARIA2_DOWNLOAD_DIR，将使用 aria2 自身的 dir）");

  const tasks = [];
  let totalSize = 0;
  let source = "";
  let pwdId = "";
  let passcode = "";

  if (ownFids.length > 0) {
    source = "fid";
    for (const fid of ownFids) {
      const meta = describe(fid);
      tasks.push(makeTask(tasks.length + 1, { source, fid, url: "", dirLabel, out: "" }, meta));
      totalSize += Number(meta.size ?? 0);
    }
  } else if (sharedFids.length > 0) {
    source = "share";
    pwdId = String(share_pwd_id ?? "").trim();
    passcode = String(share_passcode ?? "").trim();

    if (pwdId === "") throw new Error("使用 share_fids 时必须提供 share_pwd_id。");

    const known = await describeShareItems(pwdId, passcode, sharedFids);

    for (const fid of sharedFids) {
      const meta = known.get(fid) ?? describe(fid);
      tasks.push(makeTask(tasks.length + 1, { source, fid, url: "", dirLabel, out: "" }, meta));
      totalSize += Number(meta.size ?? 0);
    }
  } else {
    source = "url";
    for (const url of directUrls) {
      const meta = describe(url);
      tasks.push(makeTask(tasks.length + 1, { source, fid: "", url, dirLabel, out: "" }, meta));
      totalSize += Number(meta.size ?? 0);
    }
  }

  if (out !== undefined && out !== "" && tasks.length > 1) {
    throw new Error(`out 只能用于单个任务，当前需要提交 ${tasks.length} 个任务。`);
  }

  return {
    source,
    fids: [...ownFids, ...sharedFids],
    urls: directUrls,
    pwdId,
    passcode,
    dir,
    dirLabel,
    out,
    split,
    totalSize,
    tasks
  };
}

/**
 * 阶段二：按已确认的计划获取直链并提交任务。
 * 直链只在此刻获取一次，避免误选文件时反复取链。
 * @param {object} plan
 */
async function submitPushPlan (plan) {
  let urls = [];

  if (plan.source === "url") {
    urls = plan.urls;
  } else {
    const links = plan.source === "share"
      ? await getShareDownloadLinks({ pwdId: plan.pwdId, passcode: plan.passcode, fids: plan.fids })
      : await getDownloadLinks(plan.fids);

    urls = plan.fids.map((fid) => String(links.find((link) => link.fid === fid)?.download_url ?? ""));
  }

  const tasks = [];

  for (let index = 0; index < plan.tasks.length; index += 1) {
    const task = plan.tasks[index];
    const url = urls[index] ?? "";

    if (url === "") {
      throw new Error(
        `未能获取「${task.file_name}」的下载直链` +
        (tasks.length > 0 ? `；已提交的 ${tasks.length} 个任务仍然有效。` : "。") +
        "请重新预览后再次确认。"
      );
    }

    const gid = await addUri(url, { dir: plan.dir, out: plan.out, split: plan.split });
    tasks.push({ ...task, url, urlHost: hostOf(url), gid });
  }

  return tasks;
}

export function registerAria2Tools (server) {
  // ── 工具 1：提交下载任务（两阶段：预览确认 → 提交） ──────────────────────
  server.registerTool(
    "drive_push_to_aria2",
    {
      title: "推送到 aria2 下载",
      description:
        "把文件提交到 aria2 RPC 下载，采用「预览 → 用户确认 → 提交」两阶段流程。" +
        "第一次调用（不带 confirm_token）只返回待确认清单与一次性令牌，**此时不会获取直链、也不会产生任何下载任务**；" +
        "请把清单呈现给用户，得到明确确认后再携带 confirm_token 调用一次，服务端才会获取直链并提交。" +
        "目标来源三选一：fids（自有网盘文件）、share_pwd_id + share_fids（分享内文件）、urls（直接地址）；" +
        "可用 items 提供文件名与大小以便清单展示。服务端自动注入夸克直链所需的 UA/Referer 请求头，" +
        "dir 缺省使用 ARIA2_DOWNLOAD_DIR，out 仅单任务可用。",
      inputSchema: {
        fids: z.array(z.string().min(1)).optional().describe("自有网盘文件 fid 列表，服务端会自动获取直链"),
        share_pwd_id: z.string().optional().describe("分享 ID；提交分享内文件时必填"),
        share_passcode: z.string().optional().describe("分享提取码，加密分享必填"),
        share_fids: z.array(z.string().min(1)).optional().describe("分享内文件 fid 列表（来自 drive_list_share_files）"),
        urls: z.array(z.string().min(1)).optional().describe("直接提交的下载地址列表"),
        items: z
          .array(
            z.object({
              fid: z.string().optional(),
              file_name: z.string().optional(),
              size: z.number().optional(),
              format_type: z.string().optional()
            })
          )
          .optional()
          .describe("文件描述（可选），用于让待确认清单显示文件名与大小；不传则标注名称未知"),
        dir: z.string().optional().describe("下载目标目录，缺省使用 ARIA2_DOWNLOAD_DIR"),
        out: z.string().optional().describe("输出文件名，仅在只提交一个任务时可用"),
        split: z.number().int().min(1).max(16).optional().describe("单任务并发连接数（aria2 split 选项）"),
        confirm_token: z
          .string()
          .optional()
          .describe("用户确认后回传的一次性令牌；不传则仅生成待确认清单，不会提交")
      },
      outputSchema: {
        stage: z.enum(["preview", "submitted"]).describe("preview 待用户确认 / submitted 已提交"),
        confirmToken: z.string().describe("待确认令牌，仅 preview 阶段有值"),
        expiresInSeconds: z.number().describe("令牌有效期（秒），仅 preview 阶段有意义"),
        message: z.string().describe("给用户或模型的说明"),
        dir: z.string().describe("实际使用的下载目录"),
        total: z.number().describe("任务数量"),
        totalSize: z.number().describe("合计大小（字节），未知按 0 计"),
        tasks: z.array(
          z.object({
            index: z.number().describe("任务序号，从 1 开始"),
            file_name: z.string(),
            size: z.number(),
            format_type: z.string(),
            source: z.string().describe("目标来源：fid 自有网盘 / share 分享 / url 直接地址"),
            fid: z.string(),
            url: z.string().describe("下载地址；fid 来源在 preview 阶段为空，表示确认后才获取"),
            urlHost: z.string().describe("下载地址主机名"),
            out: z.string(),
            targetPath: z.string().describe("落盘位置预览"),
            gid: z.string().describe("任务 gid，仅 submitted 阶段有值")
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
    async ({ fids, share_pwd_id, share_passcode, share_fids, urls, items, dir, out, split, confirm_token }) => {
      try {
        const hasToken = typeof confirm_token === "string" && confirm_token.trim() !== "";

        // ── 阶段二：用户已确认，校验令牌后按锁定计划取直链并提交 ──
        if (hasToken) {
          const providedTargets = [
            Array.isArray(fids) && fids.length > 0,
            Array.isArray(share_fids) && share_fids.length > 0,
            Array.isArray(urls) && urls.length > 0
          ].filter(Boolean).length;

          if (providedTargets > 0) {
            return toolError(
              new Error("提交阶段请勿再传 fids / share_fids / urls，以免与已确认清单不一致；如需修改请重新预览。")
            );
          }

          const plan = consumeConfirmToken(confirm_token);
          const tasks = await submitPushPlan(plan);

          const text = [
            `✅ 已按确认清单提交 ${tasks.length} 个下载任务（dir=${plan.dirLabel}）：`,
            ...tasks.map((task, index) => `${index + 1}. gid=${task.gid}  ${task.file_name}`),
            "",
            "可用 aria2_task_status 查看进度，用 aria2_task_control 暂停 / 删除 / 清理记录。"
          ].join("\n");

          return {
            content: [{ type: "text", text }],
            structuredContent: {
              stage: "submitted",
              confirmToken: "",
              expiresInSeconds: 0,
              message: "已按用户确认的清单提交下载任务。",
              dir: plan.dirLabel,
              total: tasks.length,
              totalSize: tasks.reduce((sum, task) => sum + task.size, 0),
              tasks
            }
          };
        }

        // ── 阶段一：仅整理清单，不取直链、不提交 ──
        const plan = await buildPushPlan({ fids, share_pwd_id, share_passcode, share_fids, urls, items, dir, out, split });
        const { token, expiresInSeconds } = issueConfirmToken(plan);

        const text = [
          `⏸ 待用户确认：即将提交 ${plan.tasks.length} 个下载任务，合计 ${formatBytes(plan.totalSize)}`,
          `下载位置：${plan.dirLabel}`,
          "",
          ...plan.tasks.map((task) =>
            [
              `${task.index}. ${task.file_name}${task.size > 0 ? `　${formatBytes(task.size)}` : ""}${task.format_type === "" ? "" : `　${task.format_type}`}`,
              `   来源：${task.source}${task.fid === "" ? "" : `　fid=${task.fid}`}`,
              `   地址：${task.source === "url" ? task.url : "（用户确认后才获取直链）"}`,
              `   落盘：${task.targetPath}`
            ].join("\n")
          ),
          "",
          `确认令牌：${token}（${expiresInSeconds} 秒内有效，仅可用一次）`,
          "请把以上清单交给用户确认；用户同意后，携带 confirm_token 再次调用本工具才会真正下载。"
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            stage: "preview",
            confirmToken: token,
            expiresInSeconds,
            message: "待用户确认；确认后请携带 confirm_token 再次调用以提交下载。",
            dir: plan.dirLabel,
            total: plan.tasks.length,
            totalSize: plan.totalSize,
            tasks: plan.tasks.map((task) => ({
              ...task,
              url: task.source === "url" ? task.url : "",
              urlHost: task.source === "url" ? hostOf(task.url) : "",
              gid: ""
            }))
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
        "对任务执行 pause（暂停）、unpause（继续）、remove（移除）、forceRemove（强制移除），" +
        "或 removeResult（清除已完成 / 已失败任务的下载记录）。" +
        "注意：remove 与 forceRemove 只对未结束的任务有效，若报 “Active Download not found”，" +
        "说明任务已结束，应改用 removeResult 清理记录。",
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
