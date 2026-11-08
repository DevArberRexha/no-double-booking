import { describe, expect, it } from "vitest";
import {
  bookingRangesConflict,
  computeAvailableSlots,
  zonedDateString,
  type ServiceInput,
} from "../src/slots.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const SERVICE: ServiceInput = {
  duration_min: 60,
  buffer_min: 0,
  min_notice_min: 60,
  max_advance_days: 3650,
};

function iso(slots: { start: Date; end: Date }[]): string[] {
  return slots.map((s) => `${s.start.toISOString()}..${s.end.toISOString()}`);
}

const MON_9_12 = [{ day_of_week: "MON", start_time: "09:00", end_time: "12:00" }] as const;

describe("computeAvailableSlots", () => {
  it("steps a weekly window by the service duration", () => {
    const slots = computeAvailableSlots({
      availability: [...MON_9_12],
      blockedTimes: [],
      existingBookings: [],
      service: SERVICE,
      date: "2026-07-06", // a Monday
      resourceTimezone: "UTC",
      now: NOW,
    });
    expect(iso(slots)).toEqual([
      "2026-07-06T09:00:00.000Z..2026-07-06T10:00:00.000Z",
      "2026-07-06T10:00:00.000Z..2026-07-06T11:00:00.000Z",
      "2026-07-06T11:00:00.000Z..2026-07-06T12:00:00.000Z",
    ]);
  });

  it("reads the window in the resource's zone, not the server's", () => {
    const slots = computeAvailableSlots({
      availability: [...MON_9_12],
      blockedTimes: [],
      existingBookings: [],
      service: SERVICE,
      date: "2026-07-06",
      resourceTimezone: "America/New_York", // UTC-4 in July
      now: NOW,
    });
    expect(slots[0]?.start.toISOString()).toBe("2026-07-06T13:00:00.000Z");
  });

  it("drops candidates overlapping blocked time", () => {
    const slots = computeAvailableSlots({
      availability: [...MON_9_12],
      blockedTimes: [
        {
          start_at: new Date("2026-07-06T10:00:00.000Z"),
          end_at: new Date("2026-07-06T10:30:00.000Z"),
        },
      ],
      existingBookings: [],
      service: SERVICE,
      date: "2026-07-06",
      resourceTimezone: "UTC",
      now: NOW,
    });
    expect(iso(slots)).toEqual([
      "2026-07-06T09:00:00.000Z..2026-07-06T10:00:00.000Z",
      "2026-07-06T11:00:00.000Z..2026-07-06T12:00:00.000Z",
    ]);
  });

  it("pads BOTH sides by their own buffer, as the database constraint does", () => {
    const slots = computeAvailableSlots({
      availability: [...MON_9_12],
      blockedTimes: [],
      existingBookings: [
        {
          start_at: new Date("2026-07-06T09:00:00.000Z"),
          end_at: new Date("2026-07-06T10:00:00.000Z"),
          status: "CONFIRMED",
          service: { buffer_min: 15 },
        },
      ],
      service: { ...SERVICE, duration_min: 30, buffer_min: 15 },
      date: "2026-07-06",
      resourceTimezone: "UTC",
      now: NOW,
    });
    // Booking occupies 09:00-10:15. A 30-minute candidate padded by 15
    // minutes starting at 10:15 is the first that does not collide.
    expect(slots[0]?.start.toISOString()).toBe("2026-07-06T10:30:00.000Z");
  });

  it("ignores cancelled bookings", () => {
    const slots = computeAvailableSlots({
      availability: [...MON_9_12],
      blockedTimes: [],
      existingBookings: [
        {
          start_at: new Date("2026-07-06T09:00:00.000Z"),
          end_at: new Date("2026-07-06T10:00:00.000Z"),
          status: "CANCELLED",
          service: { buffer_min: 0 },
        },
      ],
      service: SERVICE,
      date: "2026-07-06",
      resourceTimezone: "UTC",
      now: NOW,
    });
    expect(slots).toHaveLength(3);
  });

  it("an unavailable override closes the whole day", () => {
    const slots = computeAvailableSlots({
      availability: [...MON_9_12],
      overrides: [{ start_time: null, end_time: null, is_unavailable: true }],
      blockedTimes: [],
      existingBookings: [],
      service: SERVICE,
      date: "2026-07-06",
      resourceTimezone: "UTC",
      now: NOW,
    });
    expect(slots).toEqual([]);
  });

  it("override hours replace the weekly windows rather than merging", () => {
    const slots = computeAvailableSlots({
      availability: [...MON_9_12],
      overrides: [{ start_time: "14:00", end_time: "16:00", is_unavailable: false }],
      blockedTimes: [],
      existingBookings: [],
      service: SERVICE,
      date: "2026-07-06",
      resourceTimezone: "UTC",
      now: NOW,
    });
    expect(slots.map((s) => s.start.toISOString())).toEqual([
      "2026-07-06T14:00:00.000Z",
      "2026-07-06T15:00:00.000Z",
    ]);
  });

  it("merges overlapping windows so no start time is offered twice", () => {
    const slots = computeAvailableSlots({
      availability: [
        { day_of_week: "MON", start_time: "09:00", end_time: "12:00" },
        { day_of_week: "MON", start_time: "10:00", end_time: "13:00" },
      ],
      blockedTimes: [],
      existingBookings: [],
      service: SERVICE,
      date: "2026-07-06",
      resourceTimezone: "UTC",
      now: NOW,
    });
    expect(slots).toHaveLength(4);
  });

  it("enforces minimum notice and the advance limit", () => {
    const now = new Date("2026-07-06T08:30:00.000Z");
    const slots = computeAvailableSlots({
      availability: [...MON_9_12],
      blockedTimes: [],
      existingBookings: [],
      service: { ...SERVICE, min_notice_min: 90 },
      date: "2026-07-06",
      resourceTimezone: "UTC",
      now,
    });
    // Earliest allowed start is 10:00.
    expect(slots.map((s) => s.start.toISOString())).toEqual([
      "2026-07-06T10:00:00.000Z",
      "2026-07-06T11:00:00.000Z",
    ]);
    const none = computeAvailableSlots({
      availability: [...MON_9_12],
      blockedTimes: [],
      existingBookings: [],
      service: { ...SERVICE, max_advance_days: 1 },
      date: "2026-07-06",
      resourceTimezone: "UTC",
      now: new Date("2026-06-01T00:00:00.000Z"),
    });
    expect(none).toEqual([]);
  });

  it("rejects a malformed date", () => {
    expect(() =>
      computeAvailableSlots({
        availability: [],
        blockedTimes: [],
        existingBookings: [],
        service: SERVICE,
        date: "06/07/2026",
        resourceTimezone: "UTC",
        now: NOW,
      })
    ).toThrow(/YYYY-MM-DD/);
  });
});

describe("zonedDateString", () => {
  it("returns the resource-local date, not the UTC date", () => {
    // 02:30Z is still the previous evening in New York.
    expect(zonedDateString(new Date("2026-07-07T02:30:00.000Z"), "America/New_York")).toBe(
      "2026-07-06"
    );
  });
});

describe("bookingRangesConflict", () => {
  const t = (h: number) => new Date(Date.UTC(2026, 6, 6, h));
  it("touching ranges do not conflict; a buffer makes them conflict", () => {
    expect(bookingRangesConflict(t(9), t(10), 0, t(10), t(11), 0)).toBe(false);
    expect(bookingRangesConflict(t(9), t(10), 30, t(10), t(11), 0)).toBe(true);
    expect(bookingRangesConflict(t(10), t(11), 0, t(9), t(10), 30)).toBe(true);
  });
});
