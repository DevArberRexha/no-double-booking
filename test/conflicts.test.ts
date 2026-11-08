import { describe, expect, it } from "vitest";
import {
  HOLD_SKEW_MS,
  holdsSlot,
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

describe("holdsSlot", () => {
  const now = new Date("2027-01-01T12:00:00Z");
  it("a paid hold frees the slot only after the deadline plus skew", () => {
    const deadline = new Date(now.getTime() - HOLD_SKEW_MS + 1_000);
    expect(holdsSlot({ status: "PENDING", awaitingPayment: true, paymentExpiresAt: deadline }, now)).toBe(true);
    const lapsed = new Date(now.getTime() - HOLD_SKEW_MS - 1_000);
    expect(holdsSlot({ status: "PENDING", awaitingPayment: true, paymentExpiresAt: lapsed }, now)).toBe(false);
  });
  it("cancelled never holds; a hold without a deadline always holds", () => {
    expect(holdsSlot({ status: "CANCELLED", awaitingPayment: false, paymentExpiresAt: null }, now)).toBe(false);
    expect(holdsSlot({ status: "PENDING", awaitingPayment: true, paymentExpiresAt: null }, now)).toBe(true);
  });
});
