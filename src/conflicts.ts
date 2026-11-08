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

/** SQLSTATE for deadlock_detected: concurrent inserts of partially overlapping ranges can wait on each other. */
const DEADLOCK_DETECTED = "40P01";

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

/** An exclusion violation, a serialization failure or a deadlock victim is a conflict worth one more attempt. */
export function isRetryableConflict(error: unknown): boolean {
  const code = errorCode(error);
  return code === SERIALIZATION_FAILURE || code === DEADLOCK_DETECTED || isExclusionViolation(error);
}

/**
 * Runs `attempt(1)` and, on a retryable conflict, runs `attempt(2)` once.
 * A second conflict propagates, for the caller to map to a 409.
 *
 * Contract: re-running the same insert can only conflict again, so `attempt`
 * must redo its decision on the second call: re-read the current bookings and
 * pick a slot again (or give up by throwing a non-conflict error) before
 * inserting. A serialization failure (40001) or deadlock (40P01) is the case where this helps with
 * no change of slot: the transaction is simply re-run on a fresh snapshot. An
 * exclusion violation (23P01) means the slot is taken, so the second attempt
 * must choose differently.
 */
export async function withConflictRetry<T>(
  attempt: (attemptNumber: 1 | 2) => Promise<T>
): Promise<T> {
  try {
    return await attempt(1);
  } catch (error) {
    if (!isRetryableConflict(error)) throw error;
    return attempt(2);
  }
}
