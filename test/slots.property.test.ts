import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  computeAvailableSlots,
  type AvailabilityWindowInput,
  type BookingStatus,
  type DayOfWeek,
  type ExistingBookingInput,
} from "../src/slots.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const ZONES = [
  "UTC",
  "Europe/Zurich",
  "Europe/Belgrade",
  "America/New_York",
  "Asia/Kolkata",
  "Pacific/Auckland",
] as const;
const DAYS: readonly DayOfWeek[] = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

// Every day of a year that includes both EU changes and both NZ changes.
const dateArb = fc
  .integer({ min: 0, max: 364 })
  .map((n) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10));

const hhmm = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

const windowArb = fc
  .tuple(fc.integer({ min: 0, max: 22 * 60 }), fc.integer({ min: 30, max: 8 * 60 }))
  .map(([start, len]) => ({ start, end: Math.min(start + len, 23 * 60 + 59) }));

const serviceArb = fc.record({
  duration_min: fc.constantFrom(15, 30, 45, 60, 90),
  buffer_min: fc.constantFrom(0, 5, 15, 30),
  min_notice_min: fc.constantFrom(0, 60, 240),
  max_advance_days: fc.constant(3650),
});

const bookingArb = fc
  .record({
    startMs: fc.integer({ min: 0, max: 48 * 60 }),
    lenMin: fc.integer({ min: 15, max: 180 }),
    buffer: fc.constantFrom(0, 10, 30),
    status: fc.constantFrom<BookingStatus[]>("PENDING", "CONFIRMED", "CANCELLED", "NO_SHOW"),
  })
  .map((b) => ({ ...b }));

/** The weekday a date has in `zone`, derived independently of the code under test. */
function weekdayIn(date: string, zone: string): DayOfWeek {
  // Noon UTC is the same calendar day in every zone from UTC-12 to UTC+11;
  // for UTC+12/13 (Auckland) the weekday is read from the zone's own clock.
  const instant = new Date(`${date}T12:00:00.000Z`);
  const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short" }).format(
    instant
  );
  const map: Record<string, DayOfWeek> = {
    Mon: "MON", Tue: "TUE", Wed: "WED", Thu: "THU", Fri: "FRI", Sat: "SAT", Sun: "SUN",
  };
  const day = map[name];
  if (!day) throw new Error(`weekday ${name}`);
  return day;
}

/** Wall-clock "HH:MM" of `instant` in `zone`, independent of the code under test. */
function wallClock(instant: Date, zone: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

describe("computeAvailableSlots properties", () => {
  it("no slot overlaps any active booking plus its buffer (and vice versa)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ZONES),
        dateArb,
        windowArb,
        serviceArb,
        fc.array(bookingArb, { maxLength: 6 }),
        (zone, date, win, service, rawBookings) => {
          const dayStart = new Date(`${date}T00:00:00.000Z`).getTime() - 12 * 3_600_000;
          const bookings: ExistingBookingInput[] = rawBookings.map((b) => ({
            start_at: new Date(dayStart + b.startMs * 60_000),
            end_at: new Date(dayStart + (b.startMs + b.lenMin) * 60_000),
            status: b.status,
            service: { buffer_min: b.buffer },
          }));
          const availability: AvailabilityWindowInput[] = DAYS.map((d) => ({
            day_of_week: d,
            start_time: hhmm(win.start),
            end_time: hhmm(win.end),
          }));
          const slots = computeAvailableSlots({
            availability,
            blockedTimes: [],
            existingBookings: bookings,
            service,
            date,
            resourceTimezone: zone,
            now: NOW,
          });
          for (const slot of slots) {
            for (const b of bookings) {
              if (b.status !== "PENDING" && b.status !== "CONFIRMED") continue;
              // Independent oracle: padded half-open intervals overlap.
              const aEnd = slot.end.getTime() + service.buffer_min * 60_000;
              const bEnd = b.end_at.getTime() + b.service.buffer_min * 60_000;
              const overlap =
                slot.start.getTime() < bEnd && b.start_at.getTime() < aEnd;
              expect(overlap).toBe(false);
            }
          }
        }
      ),
      { numRuns: 300 }
    );
  });

  it("every slot lies inside an availability window in the resource's time zone", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ZONES),
        dateArb,
        windowArb,
        serviceArb,
        (zone, date, win, service) => {
          const day = weekdayIn(date, zone);
          const slots = computeAvailableSlots({
            availability: [
              { day_of_week: day, start_time: hhmm(win.start), end_time: hhmm(win.end) },
            ],
            blockedTimes: [],
            existingBookings: [],
            service,
            date,
            resourceTimezone: zone,
            now: NOW,
          });
          for (const slot of slots) {
            const start = wallClock(slot.start, zone);
            expect(start.date).toBe(date);
            expect(start.minutes).toBeGreaterThanOrEqual(win.start);
            // A slot never extends past the window end, read on the resource's
            // wall clock.
            const end = wallClock(slot.end, zone);
            expect(end.date).toBe(date);
            expect(end.minutes).toBeLessThanOrEqual(win.end);
            // Durations are elapsed minutes (DST days are 23 or 25 hours long).
            expect(slot.end.getTime() - slot.start.getTime()).toBe(
              service.duration_min * 60_000
            );
          }
          // Slots are ordered and never overlap each other.
          for (let i = 1; i < slots.length; i++) {
            const prev = slots[i - 1];
            const cur = slots[i];
            if (prev && cur) expect(cur.start.getTime()).toBeGreaterThanOrEqual(prev.end.getTime());
          }
        }
      ),
      { numRuns: 300 }
    );
  });

  it("more existing bookings never produce more slots", () => {
    fc.assert(
      fc.property(dateArb, windowArb, serviceArb, bookingArb, (date, win, service, b) => {
        const base = {
          availability: DAYS.map((d) => ({
            day_of_week: d, start_time: hhmm(win.start), end_time: hhmm(win.end),
          })),
          blockedTimes: [],
          service,
          date,
          resourceTimezone: "Europe/Zurich",
          now: NOW,
        };
        const dayStart = new Date(`${date}T00:00:00.000Z`).getTime() - 12 * 3_600_000;
        const extra: ExistingBookingInput = {
          start_at: new Date(dayStart + b.startMs * 60_000),
          end_at: new Date(dayStart + (b.startMs + b.lenMin) * 60_000),
          status: "CONFIRMED",
          service: { buffer_min: b.buffer },
        };
        const without = computeAvailableSlots({ ...base, existingBookings: [] });
        const withOne = computeAvailableSlots({ ...base, existingBookings: [extra] });
        expect(withOne.length).toBeLessThanOrEqual(without.length);
      }),
      { numRuns: 200 }
    );
  });
});
