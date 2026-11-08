import { describe, expect, it } from "vitest";
import {
  computeAvailableSlots,
  zonedDateString,
  type AvailabilityWindowInput,
  type ExistingBookingInput,
  type ServiceInput,
} from "../src/slots.js";

// Zurich and Belgrade share the EU change dates and offsets, so one set of
// expectations covers both. The sources of truth are the UTC instants below.
const ZONES = ["Europe/Zurich", "Europe/Belgrade"] as const;
const NOW = new Date("2026-01-01T00:00:00.000Z");

describe.each(ZONES)("%s", (ZONE) => {
// Europe/Zurich 2026-10-25 (Sunday): 03:00 CEST (+02:00) falls back to 02:00
// CET (+01:00) at 01:00Z. The local day is 25 elapsed hours and 02:00-03:00
// happens twice.
// Europe/Zurich 2027-03-28 (Sunday): 02:00 CET (+01:00) springs to 03:00 CEST
// (+02:00) at 01:00Z. The local day is 23 elapsed hours and 02:00-03:00 does
// not exist.
const FALL = "2026-10-25";
const SPRING = "2027-03-28";

function service(over: Partial<ServiceInput> = {}): ServiceInput {
  return {
    duration_min: 60,
    buffer_min: 0,
    min_notice_min: 0,
    max_advance_days: 3650,
    ...over,
  };
}

function sunday(start_time: string, end_time: string): AvailabilityWindowInput[] {
  return [{ day_of_week: "SUN", start_time, end_time }];
}

function booking(
  startIso: string,
  endIso: string,
  buffer_min = 0
): ExistingBookingInput {
  return {
    start_at: new Date(startIso),
    end_at: new Date(endIso),
    status: "CONFIRMED",
    service: { buffer_min },
  };
}

function starts(slots: { start: Date }[]): string[] {
  return slots.map((s) => s.start.toISOString());
}

function run(
  date: string,
  availability: AvailabilityWindowInput[],
  extra: {
    service?: Partial<ServiceInput>;
    existingBookings?: ExistingBookingInput[];
  } = {}
) {
  return computeAvailableSlots({
    availability,
    blockedTimes: [],
    existingBookings: extra.existingBookings ?? [],
    service: service(extra.service),
    date,
    resourceTimezone: ZONE,
    now: NOW,
  });
}

describe("DST: fall back, Europe/Zurich 2026-10-25", () => {
  it("offers 25 elapsed hours' worth of slots, including the repeated 02:00", () => {
    // 00:00 CEST (22:00Z) to 04:00 CET (03:00Z) is FIVE real hours.
    expect(starts(run(FALL, sunday("00:00", "04:00")))).toEqual([
      "2026-10-24T22:00:00.000Z",
      "2026-10-24T23:00:00.000Z",
      "2026-10-25T00:00:00.000Z", // 02:00 CEST
      "2026-10-25T01:00:00.000Z", // 02:00 CET (the repeat)
      "2026-10-25T02:00:00.000Z", // 03:00 CET
    ]);
  });

  it("resolves a window inside the repeated hour to one deterministic hour", () => {
    // Wall time 02:00 is ambiguous; the implementation takes the later (CET)
    // occurrence, so 02:00-03:00 is exactly one slot, never zero or two.
    expect(starts(run(FALL, sunday("02:00", "03:00")))).toEqual([
      "2026-10-25T01:00:00.000Z",
    ]);
  });

  it("a booking spanning the change removes exactly the elapsed-time overlaps", () => {
    // 02:00 CEST to 02:30 CET = 90 real minutes.
    const slots = run(FALL, sunday("00:00", "05:00"), {
      existingBookings: [
        booking("2026-10-25T00:00:00.000Z", "2026-10-25T01:30:00.000Z"),
      ],
    });
    expect(starts(slots)).toEqual([
      "2026-10-24T22:00:00.000Z",
      "2026-10-24T23:00:00.000Z", // touches the booking start, no overlap
      "2026-10-25T02:00:00.000Z",
      "2026-10-25T03:00:00.000Z",
    ]);
  });

  it("buffers are elapsed minutes across the repeated hour", () => {
    const slots = run(FALL, sunday("00:00", "05:00"), {
      service: { buffer_min: 30 },
      existingBookings: [
        booking(
          "2026-10-24T23:00:00.000Z",
          "2026-10-25T00:00:00.000Z",
          30
        ),
      ],
    });
    // Booking padded to 00:30Z; a candidate is padded by its own 30 minutes,
    // so 22:00Z (to 23:30Z), 23:00Z and 00:00Z conflict; 01:00Z onward is free.
    expect(starts(slots)).toEqual([
      "2026-10-25T01:00:00.000Z",
      "2026-10-25T02:00:00.000Z",
      "2026-10-25T03:00:00.000Z",
    ]);
  });

  it("maps instants either side of the change to the right local date", () => {
    expect(zonedDateString(new Date("2026-10-24T22:00:00.000Z"), ZONE)).toBe(FALL);
    expect(zonedDateString(new Date("2026-10-25T22:59:00.000Z"), ZONE)).toBe(FALL);
    expect(zonedDateString(new Date("2026-10-25T23:00:00.000Z"), ZONE)).toBe(
      "2026-10-26"
    );
  });
});

describe("DST: spring forward, Europe/Zurich 2027-03-28", () => {
  it("offers 23 elapsed hours' worth of slots and skips the missing 02:00", () => {
    // 00:00 CET (23:00Z) to 04:00 CEST (02:00Z) is THREE real hours.
    expect(starts(run(SPRING, sunday("00:00", "04:00")))).toEqual([
      "2027-03-27T23:00:00.000Z",
      "2027-03-28T00:00:00.000Z", // 01:00 CET
      "2027-03-28T01:00:00.000Z", // 03:00 CEST
    ]);
  });

  it("generates no slot inside the nonexistent hour", () => {
    // 01:30 CET to 03:30 CEST is one real hour; half-hour slots land on
    // 01:30 CET and 03:00 CEST, never on a 02:xx wall time.
    expect(
      starts(
        run(SPRING, sunday("01:30", "03:30"), { service: { duration_min: 30 } })
      )
    ).toEqual(["2027-03-28T00:30:00.000Z", "2027-03-28T01:00:00.000Z"]);
  });

  it("a window wholly inside the missing hour yields no slot", () => {
    expect(starts(run(SPRING, sunday("02:00", "03:00")))).toEqual([]);
  });

  it("a booking spanning the change removes exactly the elapsed-time overlaps", () => {
    // 01:30 CET to 03:30 CEST = 60 real minutes.
    const slots = run(SPRING, sunday("00:00", "05:00"), {
      existingBookings: [
        booking("2027-03-28T00:30:00.000Z", "2027-03-28T01:30:00.000Z"),
      ],
    });
    // Window is 4 real hours: 23:00Z..03:00Z. 00:00Z and 01:00Z overlap.
    expect(starts(slots)).toEqual([
      "2027-03-27T23:00:00.000Z",
      "2027-03-28T02:00:00.000Z",
    ]);
  });

  it("buffers are elapsed minutes across the missing hour", () => {
    const slots = run(SPRING, sunday("00:00", "04:00"), {
      service: { buffer_min: 30 },
      existingBookings: [
        booking("2027-03-27T23:00:00.000Z", "2027-03-28T00:00:00.000Z", 30),
      ],
    });
    // Slots 23:00Z, 00:00Z, 01:00Z; first two conflict with the padded booking.
    expect(starts(slots)).toEqual(["2027-03-28T01:00:00.000Z"]);
  });

  it("maps instants either side of the change to the right local date", () => {
    expect(zonedDateString(new Date("2027-03-27T23:00:00.000Z"), ZONE)).toBe(SPRING);
    expect(zonedDateString(new Date("2027-03-28T21:59:00.000Z"), ZONE)).toBe(SPRING);
    expect(zonedDateString(new Date("2027-03-28T22:00:00.000Z"), ZONE)).toBe(
      "2027-03-29"
    );
  });
});

});
