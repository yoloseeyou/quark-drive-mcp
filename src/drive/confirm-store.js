/**
 * 写操作的人工确认令牌存储（进程内、一次性）。
 *
 * 用途：给「会产生副作用的操作」（当前是提交 aria2 下载任务）加一道人工确认闸门。
 * 流程是两阶段的：
 *  1) 调用方先请求「预览」→ 服务端把待执行计划存入本存储并签发一个随机令牌；
 *  2) 用户确认后，调用方携带令牌再次请求 → 服务端取出**已锁定的计划**执行。
 *
 * 关键安全性质：
 *  - 令牌绑定计划内容，提交时不重新解析入参，杜绝「预览 A、提交 B」；
 *  - 一次性使用，消费后立即销毁，避免重复提交；
 *  - 有有效期（CONFIRM_TTL_MS，默认 5 分钟），过期即失效，保证确认的是最近的清单；
 *  - 不落盘、不入日志，仅存在于内存，进程退出即清空。
 */
import crypto from "node:crypto";

import { getConfig } from "../config.js";

/** token -> { plan, createdAt, expiresAt } */
const store = new Map();

const counters = { issued: 0, consumed: 0, expired: 0, rejected: 0 };

function ttlMs () {
  return getConfig().confirm.ttlMs;
}

/** 清理过期令牌 */
function purgeExpired () {
  const now = Date.now();

  for (const [token, entry] of store) {
    if (entry.expiresAt <= now) {
      store.delete(token);
      counters.expired += 1;
    }
  }
}

/**
 * 签发一个一次性确认令牌。
 * @param {object} plan 待执行计划（会被原样存储，提交时按它执行）
 * @returns {{token: string, expiresInSeconds: number}}
 */
export function issueConfirmToken (plan) {
  purgeExpired();

  const token = `cf_${crypto.randomBytes(12).toString("hex")}`;
  const now = Date.now();
  const ttl = ttlMs();

  store.set(token, { plan, createdAt: now, expiresAt: now + ttl });
  counters.issued += 1;

  return { token, expiresInSeconds: Math.round(ttl / 1000) };
}

/**
 * 消费令牌并取出锁定的计划。
 * 令牌无效、已使用或已过期都会抛出可读错误，提示重新预览。
 * @param {string} token
 * @returns {object} 签发时存入的计划
 */
export function consumeConfirmToken (token) {
  purgeExpired();

  const key = String(token ?? "");
  const entry = store.get(key);

  if (entry === undefined) {
    counters.rejected += 1;
    throw new Error(
      "确认令牌无效、已被使用或已过期。请重新调用本工具生成待确认清单，" +
      "待用户确认后再携带新的 confirm_token 提交。"
    );
  }

  // 一次性：取出即销毁
  store.delete(key);
  counters.consumed += 1;

  return entry.plan;
}

/** 令牌存储统计，供 config://server 资源展示 */
export function confirmStoreStats () {
  purgeExpired();

  return {
    pending: store.size,
    issued: counters.issued,
    consumed: counters.consumed,
    expired: counters.expired,
    rejected: counters.rejected,
    ttlSeconds: Math.round(ttlMs() / 1000)
  };
}
