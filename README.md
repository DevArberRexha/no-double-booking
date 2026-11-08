# no-double-booking

A small TypeScript library and proof that a booking system can make double
bookings **impossible**, not merely unlikely.

Two parts:

1. `src/slots.ts`: pure slot computation. Weekly windows, per-date overrides,
   blocked time, buffers, minimum notice, advance limits, in the resource's own
   time zone, correct across DST changes (23 and 25 hour days).
2. `sql/schema.sql`: one PostgreSQL `EXCLUDE USING gist` constraint on a
   `tstzrange`. Two overlapping bookings for the same resource cannot both be
   stored, even when the requests arrive at the same instant.

Extracted from the booking engine used in production at
[whenbird.com](https://whenbird.com).

## The problem

Two people click the same 09:00 slot at the same moment. The usual code does:

```
request A: SELECT ... overlapping?  -> none       request B: SELECT ... overlapping?  -> none
request A: INSERT                                  request B: INSERT
```

Both reads happen before either write, so both see a free slot and both inserts
succeed. Wrapping it in a transaction does not help at the default isolation
level, and SERIALIZABLE only turns it into retries you must write correctly
everywhere. An application-level check is a race by construction: the check and
the write are two steps, and the other request runs in between.

## The fix: let the database say no

```sql
ALTER TABLE bookings
  ADD CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist (
    resource_id WITH =,
    tstzrange(start_at, add_minutes_immutable(end_at, buffer_min)) WITH &&
  ) WHERE (status IN ('PENDING', 'CONFIRMED'));
```

The constraint is checked inside the insert, under the index's own locking, so
there is no gap between check and write. Details worth reading in
`sql/schema.sql`:

- Each booking's range is padded by **its own** buffer. `src/slots.ts` pads
  both sides the same way (`bookingRangesConflict`), so what the UI offers and
  what the database accepts cannot drift apart.
- `timestamptz + interval` is only STABLE in Postgres, but an exclusion
  expression must be IMMUTABLE. A whole-minutes interval has no calendar part,
  so it is time-zone independent; `add_minutes_immutable` asserts that.
- A zero-length booking is an empty range that overlaps nothing, which would
  bypass the constraint, so `CHECK (end_at > start_at)` rejects it.
- Cancelled and no-show rows are excluded by the `WHERE`, so they free the slot.

The application then treats the constraint error (SQLSTATE `23P01`) as an
ordinary "slot taken" outcome (`src/conflicts.ts`).

## Run it

Needs Node 22+ and a PostgreSQL 16 you can reach. Create a scratch database
and point the tests at it:

```bash
npm install
export DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres
npm test            # unit, property and race tests
npm run typecheck
```

`test/race.test.ts` drops and recreates the `bookings` table, so use a scratch
database. CI runs the same against a Postgres 16 service container.

## Proof

`test/race.test.ts` fires 25 concurrent inserts for one slot, each on its own
connection, and asserts that exactly one wins and one row is stored.

### Red first: constraint removed

`RACE_DROP_CONSTRAINT=1` drops the constraint after the schema is applied.
Every insert wins:

```
$ RACE_DROP_CONSTRAINT=1 npx vitest run test/race.test.ts

 RUN  v2.1.9 ~/no-double-booking

stdout | test/race.test.ts > the database refuses double bookings > 25 concurrent inserts for one slot: exactly one wins
race: 25 of 25 inserts won; 25 rows stored

 ❯ test/race.test.ts (6 tests | 3 failed) 133ms
   × the database refuses double bookings > 25 concurrent inserts for one slot: exactly one wins 35ms
     → expected 25 to be 1 // Object.is equality
   × the database refuses double bookings > racing OVERLAPPING (not identical) slots: no two stored rows overlap 4ms
     → expected 11 to be +0 // Object.is equality
   × the database refuses double bookings > back-to-back bookings are fine; a buffer makes them collide 2ms
     → expected 'won' to be 'refused' // Object.is equality
```

### Green: constraint in place

```
$ npx vitest run

 ✓ test/conflicts.test.ts (5 tests) 3ms
 ✓ test/slots.test.ts (12 tests) 49ms
 ✓ test/slots-dst.test.ts (22 tests) 53ms
stdout | test/race.test.ts > the database refuses double bookings > 25 concurrent inserts for one slot: exactly one wins
race: 1 of 25 inserts won; 1 rows stored

 ✓ test/race.test.ts (6 tests) 128ms
 ✓ test/slots.property.test.ts (3 tests) 506ms

 Test Files  5 passed (5)
      Tests  48 passed (48)
   Start at  18:46:05
   Duration  1000ms (transform 173ms, setup 0ms, collect 435ms, tests 739ms, environment 1ms, prepare 426ms)
```

## Tests

- **Race** (`test/race.test.ts`): the proof above, plus overlapping-not-identical
  slots racing, different resources, buffers, cancellation, zero-length rows.
- **Property tests** (fast-check, `test/slots.property.test.ts`), over six time
  zones and every day of a year: no offered slot overlaps an active booking plus
  either side's buffer; every slot starts inside an availability window in the
  resource's zone and has exactly the service duration; slots never overlap each
  other; adding a booking never adds slots.
- **DST examples** (`test/slots-dst.test.ts`): Europe/Zurich and Europe/Belgrade
  on 2026-10-25 (25-hour day, repeated 02:00) and 2027-03-28 (23-hour day,
  missing 02:00), including bookings and buffers spanning the change.
- **Examples** (`test/slots.test.ts`, `test/conflicts.test.ts`): overrides,
  merging overlapping windows, minimum notice, retry-once conflict handling,
  paid-hold expiry.

## Notes on time

Wall-clock to UTC conversion uses `Intl.DateTimeFormat` and converges twice
rather than doing offset arithmetic, which breaks on transition days. A wall time
that occurs twice resolves to the later occurrence; one that does not exist
yields no slot. Durations and buffers are elapsed minutes, not wall-clock ones.

## License

MIT
