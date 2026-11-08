-- One table, one guarantee: two bookings for the same resource can never hold
-- overlapping time, no matter how many requests race.
--
-- btree_gist lets a GiST index use plain `=` (on resource_id) next to the range
-- overlap operator `&&`. Native GiST supports only range and geometric ops.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- `timestamptz + interval` is declared STABLE in Postgres, not IMMUTABLE: with
-- day/month components its result under DST could depend on the session's
-- TimeZone. An index or exclusion-constraint expression must be IMMUTABLE. A
-- whole-minutes interval (make_interval(mins => n)) has no calendar component,
-- so it is a fixed physical duration and genuinely time-zone independent. The
-- function below is declared IMMUTABLE on that basis, and takes `mins integer`,
-- so no calendar interval (days, months) can be passed to it; Postgres does not
-- verify the IMMUTABLE claim, the integer parameter is what keeps it true.
CREATE OR REPLACE FUNCTION add_minutes_immutable(ts timestamptz, mins integer)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$ SELECT ts + make_interval(mins => mins) $$;

CREATE TABLE bookings (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  resource_id text        NOT NULL,
  start_at    timestamptz NOT NULL,
  end_at      timestamptz NOT NULL,
  -- Snapshot of the service's buffer at booking time. The constraint reads this
  -- column, not a live join, so changing a service's buffer later cannot make
  -- the application and the database disagree about old bookings.
  buffer_min  integer     NOT NULL DEFAULT 0 CHECK (buffer_min >= 0),
  status      text        NOT NULL DEFAULT 'CONFIRMED'
              CHECK (status IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'NO_SHOW')),

  -- A zero-length booking normalizes to an EMPTY range, which overlaps nothing
  -- under `&&` (not even an identical row), so it would silently bypass the
  -- exclusion below. Reject it outright.
  CONSTRAINT bookings_end_after_start CHECK (end_at > start_at)
);

-- The double-booking guarantee. Same resource AND buffer-padded ranges
-- overlapping is refused, but only for bookings that still hold their slot:
-- cancelled and no-show rows free the time.
--
-- NOTE: ADD CONSTRAINT ... EXCLUDE takes ACCESS EXCLUSIVE on the table while it
-- builds and has no CONCURRENTLY form. On a table with real data, apply in a
-- quiet window and check for existing overlaps first.
ALTER TABLE bookings
  ADD CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist (
    resource_id WITH =,
    tstzrange(start_at, add_minutes_immutable(end_at, buffer_min)) WITH &&
  ) WHERE (status IN ('PENDING', 'CONFIRMED'));
