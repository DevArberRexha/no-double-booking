import { describe, expect, it } from "vitest";
import {
  isRetryableConflict,
  isExclusionViolation,
  withConflictRetry,
} from "../src/conflicts.js";

describe("isExclusionViolation", () => {
  it("matches the SQLSTATE and the constraint name, and nothing else", () => {
    expect(isExclusionViolation(Object.assign(new Error("x"), { code: "23P01" }))).toBe(true);
    expect(isExclusionViolation(new Error('conflicting key value violates exclusion constraint "bookings_no_overlap"'))).toBe(true);
    expect(isExclusionViolation(new Error("connection reset"))).toBe(false);
    expect(isExclusionViolation(null)).toBe(false);
  });
});

describe("isRetryableConflict", () => {
  it("accepts 23P01, 40001 and 40P01 and nothing else", () => {
    for (const code of ["23P01", "40001", "40P01"]) {
      expect(isRetryableConflict(Object.assign(new Error("x"), { code }))).toBe(true);
    }
    expect(isRetryableConflict(Object.assign(new Error("x"), { code: "23505" }))).toBe(false);
  });
});

describe("withConflictRetry", () => {
  const conflict = Object.assign(new Error("x"), { code: "23P01" });

  it("retries once on a conflict, then succeeds", async () => {
    let calls = 0;
    const value = await withConflictRetry(async () => {
      calls += 1;
      if (calls === 1) throw conflict;
      return "ok";
    });
    expect([value, calls]).toEqual(["ok", 2]);
  });

  it("tells the callback which attempt it is, so the second can re-pick", async () => {
    const seen: number[] = [];
    await withConflictRetry(async (n) => {
      seen.push(n);
      if (n === 1) throw conflict;
    });
    expect(seen).toEqual([1, 2]);
  });

  it("surfaces a second conflict and never retries other errors", async () => {
    let calls = 0;
    await expect(withConflictRetry(async () => { calls += 1; throw conflict; })).rejects.toBe(conflict);
    expect(calls).toBe(2);
    calls = 0;
    const other = new Error("boom");
    await expect(withConflictRetry(async () => { calls += 1; throw other; })).rejects.toBe(other);
    expect(calls).toBe(1);
  });
});
