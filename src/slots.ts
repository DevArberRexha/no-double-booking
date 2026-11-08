// Pure slot computation: weekly windows, per-date overrides, blocked time,
// buffers, minimum notice and advance limits, in the resource's time zone,
// correct across DST changes. No database, no globals besides an injectable
// `now`.

export type DayOfWeek = "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT" | "SUN";
export type BookingStatus = "PENDING" | "CONFIRMED" | "CANCELLED" | "NO_SHOW";

// ─── Types (plain, DB-agnostic — computeAvailableSlots takes no DB objects) ──

export interface AvailabilityWindowInput {
  day_of_week: DayOfWeek;
  start_time: string; // "HH:MM", wall-clock in resourceTimezone
  end_time: string; // "HH:MM", wall-clock in resourceTimezone
}

export interface BlockedTimeInput {
  start_at: Date;
  end_at: Date;
}

export interface ExistingBookingInput {
  start_at: Date;
  end_at: Date;
  status: BookingStatus;
  service: { buffer_min: number };
}

export interface ServiceInput {
  duration_min: number;
  buffer_min: number;
  min_notice_min: number;
  max_advance_days: number;
}

/**
 * A date-specific override for a single calendar date. `is_unavailable`
 * blocks the whole day regardless of the weekly `Availability` windows;
 * otherwise `start_time`/`end_time` windows *replace* that day's weekly
 * windows entirely (not merge with them) — matching cal.com's date-override
 * semantics. Multiple override rows for the same date all apply (e.g. two
 * custom ranges), same as multiple weekly `Availability` rows for a day.
 */
export interface AvailabilityOverrideInput {
  start_time: string | null;
  end_time: string | null;
  is_unavailable: boolean;
}

export interface Slot {
  start: Date;
  end: Date;
}

export interface ComputeAvailableSlotsParams {
  availability: AvailabilityWindowInput[];
  blockedTimes: BlockedTimeInput[];
  existingBookings: ExistingBookingInput[];
  /** Override rows for the specific `date` being computed, if any. */
  overrides?: AvailabilityOverrideInput[];
  service: ServiceInput;
  /** Calendar date, in resourceTimezone, to compute slots for — "YYYY-MM-DD" */
  date: string;
  resourceTimezone: string;
  /** Minimum lead time before a slot can be booked, in minutes. Defaults to the service's own min_notice_min. */
  minNoticeMinutes?: number;
  /** Injectable "current time" for deterministic tests; defaults to `new Date()` */
  now?: Date;
}

const ACTIVE_BOOKING_STATUSES: ReadonlySet<BookingStatus> = new Set([
  "PENDING",
  "CONFIRMED",
]);

const WEEKDAY_TO_DAY_OF_WEEK: Record<string, DayOfWeek> = {
  Mon: "MON",
  Tue: "TUE",
  Wed: "WED",
  Thu: "THU",
  Fri: "FRI",
  Sat: "SAT",
  Sun: "SUN",
};

// ─── Timezone helpers ─────────────────────────────────────────────────────
//
// DST-safe local-wall-clock <-> UTC conversion using Intl.DateTimeFormat
// (never naive UTC-offset arithmetic, which breaks across DST transitions).

/**
 * Returns `asUTC(formatToParts(date, timeZone)) - date.getTime()` — i.e. how
 * far the timezone's wall clock (misread as UTC) differs from the real UTC
 * instant. Used as the offset to solve for the UTC instant matching a given
 * local wall clock.
 */
function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  // Intl reports hour "24" for midnight under hourCycle h23 in some engines —
  // normalize to 0.
  const hour = Number(map.hour) === 24 ? 0 : Number(map.hour);
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    hour,
    Number(map.minute),
    Number(map.second)
  );
  return asUtc - date.getTime();
}

/**
 * Converts a local wall-clock date/time in `timeZone` to the UTC instant it
 * represents. Iterates twice to converge correctly across DST transitions
 * (the offset can differ near a transition depending on which side of it the
 * first guess lands on).
 */
function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date {
  const wallClockAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);

  const offset1 = getTimeZoneOffsetMs(new Date(wallClockAsUtcMs), timeZone);
  let utcMs = wallClockAsUtcMs - offset1;

  const offset2 = getTimeZoneOffsetMs(new Date(utcMs), timeZone);
  if (offset2 !== offset1) {
    utcMs = wallClockAsUtcMs - offset2;
  }

  return new Date(utcMs);
}

function parseDateString(date: string): {
  year: number;
  month: number;
  day: number;
} {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    throw new Error(`Invalid date string, expected YYYY-MM-DD: ${date}`);
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function parseHhMm(time: string): { hour: number; minute: number } {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) {
    throw new Error(`Invalid time string, expected HH:MM: ${time}`);
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * Day-of-week for `date` (a calendar date, "YYYY-MM-DD") as experienced in
 * `timeZone` — resolved via a UTC round-trip through Intl.DateTimeFormat
 * rather than `Date#getDay()`, which reads the *server's* local timezone,
 * not the resource's.
 */
function getDayOfWeekInTimeZone(date: string, timeZone: string): DayOfWeek {
  const { year, month, day } = parseDateString(date);
  const localMidnightUtc = zonedTimeToUtc(year, month, day, 0, 0, timeZone);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(localMidnightUtc);
  const dayOfWeek = WEEKDAY_TO_DAY_OF_WEEK[weekday];
  if (!dayOfWeek) {
    throw new Error(`Unrecognized weekday from Intl: ${weekday}`);
  }
  return dayOfWeek;
}

function rangesOverlap(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date
): boolean {
  return aStart < bEnd && aEnd > bStart;
}

/**
 * The calendar date (`"YYYY-MM-DD"`) that `instant` falls on as observed in
 * `timeZone` — i.e. the resource-local date, not `instant`'s UTC date. Uses
 * `en-CA`, whose short date format is already `YYYY-MM-DD`, sourced from
 * `formatToParts` rather than the formatted string directly so the field
 * order can never depend on locale/engine formatting quirks.
 *
 * Callers deriving a `date` to hand to `computeAvailableSlots` /
 * `getAvailableSlotsForResource` from a UTC instant (e.g. a booking's
 * `start_at`) MUST go through this, not `instant.toISOString().slice(0, 10)`
 * — the latter is the resource's calendar date only when `timeZone` is UTC.
 * In any negative-UTC-offset zone (e.g. America/New_York), a late-evening
 * local instant lands on the *next* UTC calendar day, so the naive slice
 * queries the wrong date and a slot `/slots` just offered comes back absent
 * from the recomputed list.
 */
export function zonedDateString(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string): string => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`Missing date part: ${type}`);
    return part.value;
  };
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Whether two bookings conflict under the SAME rule the `bookings_no_overlap`
 * Postgres EXCLUDE constraint enforces: each side's range is padded by ITS
 * OWN `buffer_min` before overlap is tested — `tstzrange(start_at,
 * add_minutes_immutable(end_at, buffer_min))` per row, for both rows. Padding
 * only one side (e.g. only the existing booking, never the candidate) is the
 * bug this function exists to make impossible to reintroduce: it lets
 * `/slots` offer, and an app-level overlap check accept, a candidate that the
 * DB constraint then rejects — a false SLOT_TAKEN for the customer.
 *
 * Shared by `computeAvailableSlots` (what's offered) and both booking routes
 * (what's accepted) so the two can't independently drift out of parity.
 */
export function bookingRangesConflict(
  aStart: Date,
  aEnd: Date,
  aBufferMin: number,
  bStart: Date,
  bEnd: Date,
  bBufferMin: number
): boolean {
  const aEffectiveEnd = new Date(aEnd.getTime() + aBufferMin * 60_000);
  const bEffectiveEnd = new Date(bEnd.getTime() + bBufferMin * 60_000);
  return rangesOverlap(aStart, aEffectiveEnd, bStart, bEffectiveEnd);
}

/**
 * Sorts `[start, end)` millisecond ranges and merges any that strictly
 * overlap. Ranges that merely touch (one's end equals the next's start) are
 * kept apart. Returns new objects; the input is not mutated.
 */
function mergeOverlappingRanges(
  ranges: { start: number; end: number }[]
): { start: number; end: number }[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.start < last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

// ─── Pure core ──────────────────────────────────────────────────────────────

/**
 * Computes bookable slots for a single service on a single calendar date, in
 * the resource's timezone. Pure — no DB access, no globals besides an
 * injectable `now`.
 */
export function computeAvailableSlots(
  params: ComputeAvailableSlotsParams
): Slot[] {
  const {
    availability,
    blockedTimes,
    existingBookings,
    overrides = [],
    service,
    date,
    resourceTimezone,
    minNoticeMinutes = service.min_notice_min,
    now = new Date(),
  } = params;

  if (overrides.some((override) => override.is_unavailable)) {
    return [];
  }

  const { year, month, day } = parseDateString(date);
  const dayOfWeek = getDayOfWeekInTimeZone(date, resourceTimezone);
  const durationMs = service.duration_min * 60_000;
  const minNoticeCutoff = new Date(now.getTime() + minNoticeMinutes * 60_000);
  const maxAdvanceCutoff = new Date(
    now.getTime() + service.max_advance_days * 24 * 60 * 60 * 1000
  );

  const activeBookings = existingBookings.filter((b) =>
    ACTIVE_BOOKING_STATUSES.has(b.status)
  );

  const effectiveWindows: AvailabilityWindowInput[] =
    overrides.length > 0
      ? overrides
          .filter(
            (
              override
            ): override is AvailabilityOverrideInput & {
              start_time: string;
              end_time: string;
            } => Boolean(override.start_time && override.end_time)
          )
          .map((override) => ({
            day_of_week: dayOfWeek,
            start_time: override.start_time,
            end_time: override.end_time,
          }))
      : availability.filter((window) => window.day_of_week === dayOfWeek);

  // Nothing stops an owner saving two ranges that overlap on one day (or
  // two custom-hours overrides for one date), and each window used to be
  // stepped on its own grid — so 09:00-17:00 twice listed every start time
  // twice, and 09:00-12:00 plus 10:00-13:00 offered slots overlapping each
  // other. Hours are a union: overlapping windows merge into one before
  // stepping. Windows that only TOUCH (09:00-10:00, 10:00-12:00) stay
  // separate so their grids are unchanged — they can never share a start.
  const windowsUtc = mergeOverlappingRanges(
    effectiveWindows.map((window) => {
      const { hour: startHour, minute: startMinute } = parseHhMm(
        window.start_time
      );
      const { hour: endHour, minute: endMinute } = parseHhMm(window.end_time);
      return {
        start: zonedTimeToUtc(
          year,
          month,
          day,
          startHour,
          startMinute,
          resourceTimezone
        ).getTime(),
        end: zonedTimeToUtc(
          year,
          month,
          day,
          endHour,
          endMinute,
          resourceTimezone
        ).getTime(),
      };
    })
  );

  const slots: Slot[] = [];

  for (const window of windowsUtc) {
    for (
      let candidateStart = window.start;
      candidateStart + durationMs <= window.end;
      candidateStart += durationMs
    ) {
      const start = new Date(candidateStart);
      const end = new Date(candidateStart + durationMs);

      if (start < minNoticeCutoff) continue;
      if (start > maxAdvanceCutoff) continue;

      const isBlocked = blockedTimes.some((blocked) =>
        rangesOverlap(start, end, blocked.start_at, blocked.end_at)
      );
      if (isBlocked) continue;

      // Pad the CANDIDATE's own end by this service's buffer_min too, not
      // just the existing booking's — see bookingRangesConflict's docstring.
      // A one-sided pad here is what let /slots offer a slot the book route
      // and the DB EXCLUDE constraint both then reject.
      const conflictsWithBooking = activeBookings.some((booking) =>
        bookingRangesConflict(
          start,
          end,
          service.buffer_min,
          booking.start_at,
          booking.end_at,
          booking.service.buffer_min
        )
      );
      if (conflictsWithBooking) continue;

      slots.push({ start, end });
    }
  }

  return slots;
}
