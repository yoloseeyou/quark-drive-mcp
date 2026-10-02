/**
 * 写操作确认令牌单测：一次性消费、绑定计划内容、过期失效。
 *
 * 这些性质直接决定「预览 A、提交 B」与「重复提交」能否被挡住，是下载闸门的核心保证。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  confirmStoreStats,
  consumeConfirmToken,
  issueConfirmToken
} from "../src/drive/confirm-store.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("issueConfirmToken", () => {
  it("签发带前缀的随机令牌与有效期", () => {
    const { token, expiresInSeconds } = issueConfirmToken({ source: "url", urls: ["u"] });

    expect(token).toMatch(/^cf_[0-9a-f]{24}$/);
    expect(expiresInSeconds).toBe(300);
  });

  it("每次签发的令牌都不同", () => {
    const first = issueConfirmToken({ n: 1 }).token;
    const second = issueConfirmToken({ n: 2 }).token;

    expect(first).not.toBe(second);
  });
});

describe("consumeConfirmToken", () => {
  it("取回的正是签发时锁定的计划（提交阶段不重新解析入参）", () => {
    const plan = { source: "fid", fids: ["a", "b"], dir: "/film", tasks: [{ index: 1 }] };
    const { token } = issueConfirmToken(plan);

    expect(consumeConfirmToken(token)).toBe(plan);
  });

  it("一次性：消费后立即销毁，重复使用报错", () => {
    const { token } = issueConfirmToken({ n: 1 });

    consumeConfirmToken(token);

    expect(() => consumeConfirmToken(token)).toThrow(/无效、已被使用或已过期/);
  });

  it("未知令牌报错并提示重新预览", () => {
    expect(() => consumeConfirmToken("cf_deadbeef")).toThrow(/请重新调用本工具生成待确认清单/);
  });

  it("空令牌报错而不是抛类型错误", () => {
    expect(() => consumeConfirmToken(undefined)).toThrow(/无效、已被使用或已过期/);
    expect(() => consumeConfirmToken("")).toThrow(/无效、已被使用或已过期/);
  });

  it("超过有效期后无法消费", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const before = confirmStoreStats();
    const { token } = issueConfirmToken({ n: 1 });

    vi.advanceTimersByTime(301_000);

    expect(() => consumeConfirmToken(token)).toThrow(/无效、已被使用或已过期/);
    expect(confirmStoreStats().expired - before.expired).toBe(1);
  });

  it("未过期时仍可正常消费", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const { token } = issueConfirmToken({ n: 1 });
    vi.advanceTimersByTime(299_000);

    expect(consumeConfirmToken(token)).toEqual({ n: 1 });
  });
});

describe("confirmStoreStats", () => {
  it("统计签发、消费、拒绝、过期与有效期", () => {
    const before = confirmStoreStats();

    const { token } = issueConfirmToken({ n: 1 });
    consumeConfirmToken(token);
    expect(() => consumeConfirmToken("cf_nope")).toThrow();

    const after = confirmStoreStats();

    expect(after.ttlSeconds).toBe(300);
    expect(after.issued - before.issued).toBe(1);
    expect(after.consumed - before.consumed).toBe(1);
    expect(after.rejected - before.rejected).toBe(1);
  });

  it("未消费的令牌计入 pending", () => {
    const before = confirmStoreStats();

    issueConfirmToken({ n: 1 });

    expect(confirmStoreStats().pending).toBe(before.pending + 1);
  });
});
