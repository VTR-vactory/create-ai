import { describe, expect, it } from "vitest";
import { canReindex, REINDEX_STALE_MS } from "./document-status";

const now = new Date("2026-10-22T12:00:00Z");

describe("canReindex", () => {
  it("FAILED 可以重试", () => {
    expect(canReindex("FAILED", new Date(), now)).toBe(true);
  });

  it("PARTIAL 可以重试", () => {
    expect(canReindex("PARTIAL", new Date(), now)).toBe(true);
  });

  it("READY 不允许重试", () => {
    expect(canReindex("READY", new Date(), now)).toBe(false);
  });

  it("刚进入 PROCESSING 不允许接管", () => {
    expect(canReindex("PROCESSING", now, now)).toBe(false);
  });

  it("PROCESSING 超过阈值允许接管", () => {
    const updatedAt = new Date(now.getTime() - REINDEX_STALE_MS - 1);
    expect(canReindex("PROCESSING", updatedAt, now)).toBe(true);
  });
});
