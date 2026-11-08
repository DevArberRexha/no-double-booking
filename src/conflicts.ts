// Conflict rules shared by "what we offer" and "what we accept", plus the
// classification of the database's own refusal. The database constraint
// (sql/schema.sql) is the authority; these helpers keep the application's view
// in step with it and turn its error into a normal "slot taken" outcome.

/** Name of the EXCLUDE constraint in sql/schema.sql. */
export const EXCLUSION_CONSTRAINT_NAME = "bookings_no_overlap";

/** SQLSTATE for exclusion_violation. */
const EXCLUSION_VIOLATION = "23P01";

/** SQLSTATE for serialization_failure under SERIALIZABLE isolation. */
const SERIALIZATION_FAILURE = "40001";

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when Postgres refused an insert because it would overlap another booking. */
export function isExclusionViolation(error: unknown): boolean {
  return (
    errorCode(error) === EXCLUSION_VIOLATION ||
    errorMessage(error).includes(EXCLUSION_CONSTRAINT_NAME)
  );
}

/** Both an exclusion violation and a serialization failure are safe to retry once. */
export function isRetryableConflict(error: unknown): boolean {
  return errorCode(error) === SERIALIZATION_FAILURE || isExclusionViolation(error);
}

/**
 * Runs `attempt` once and retries exactly once on a retryable conflict. A
 * second conflict propagates, for the caller to map to a 409.
 */
export async function withConflictRetry<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (!isRetryableConflict(error)) throw error;
    return attempt();
  }
}

// ─── Paid holds ─────────────────────────────────────────────────────────────
//
// A booking awaiting payment holds its slot (it counts against the
// constraint) until `paymentExpiresAt`. A lapsed hold is free time; it must be
// released before the next insert, because the constraint would otherwise
// refuse it.

/** Grace past the deadline before a hold counts as lapsed, so a checkout finishing right at the deadline is not raced. */
export const HOLD_SKEW_MS = 2 * 60 * 1000;

export interface HoldState {
  status: "PENDING" | "CONFIRMED" | "CANCELLED" | "NO_SHOW";
  awaitingPayment: boolean;
  paymentExpiresAt: Date | null;
}

export function holdCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - HOLD_SKEW_MS);
}

/** A paid hold whose checkout window has lapsed. */
export function isLapsedHold(hold: HoldState, now: Date = new Date()): boolean {
  return (
    hold.awaitingPayment &&
    hold.paymentExpiresAt !== null &&
    hold.paymentExpiresAt < holdCutoff(now)
  );
}

/** Whether a booking still occupies its slot: PENDING or CONFIRMED, minus lapsed holds. */
export function holdsSlot(hold: HoldState, now: Date = new Date()): boolean {
  return (
    (hold.status === "PENDING" || hold.status === "CONFIRMED") &&
    !isLapsedHold(hold, now)
  );
}
