# no-double-booking

A small TypeScript reference implementation and proof that a booking system can make double
bookings **impossible**, not merely unlikely.

Two parts:

1. `src/slots.ts`: pure slot computation. Weekly windows, per-date overrides,
   blocked time, buffers, minimum notice, advance limits, in the resource's own
   time zone, correct across DST changes (23 and 25 hour days).
2. `sql/schema.sql`: one PostgreSQL `EXCLUDE USING gist` constraint on a
   `tstzrange`. Two overlapping bookings for the same resource cannot both be
   stored, even when the requests arrive at the same instant.

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
  both sides the same way (`bookingRangesConflict`). The two are separate
  implementations of the same rule, so tests pin both on the same cases
  (`test/race.test.ts`, "agree on the same buffer cases").
- `timestamptz + interval` is only STABLE in Postgres, but an exclusion
  expression must be IMMUTABLE. A whole-minutes interval has no calendar part,
  so it is time-zone independent. `add_minutes_immutable` is declared IMMUTABLE on
  that basis and takes `mins integer`, so no calendar interval can be passed to
  it (Postgres does not check the IMMUTABLE claim; the integer parameter keeps
  it true).
- A zero-length booking is an empty range that overlaps nothing, which would
  bypass the constraint, so `CHECK (end_at > start_at)` rejects it.
- Cancelled and no-show rows are excluded by the `WHERE`, so they free the slot.

The application then treats the constraint error (SQLSTATE `23P01`) as an
ordinary "slot taken" outcome (`src/conflicts.ts`). `withConflictRetry` runs the
callback a second time on 23P01, 40001 or 40P01 (deadlock victim; concurrent
inserts of partially overlapping ranges can wait on each other). Re-running an
identical insert can only conflict again, so the callback receives the attempt
number and must re-read and re-pick a slot on the second call.

## Run it

Needs Node 22+ and a PostgreSQL 16 you can reach. Create a scratch database
and point the tests at it. `DATABASE_URL` is required: without it the database
tests are skipped, with a message saying so.

```bash
npm install
export DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres
npm test            # unit, property and race tests
npm run typecheck
```

`test/race.test.ts` drops and recreates the `bookings` table, so use a scratch
database. CI runs the same against a Postgres 16 service container.

## Proof

`test/race.test.ts` proves it three ways, all on dedicated connections that are
established before anything is sent:

1. **Held transaction (deterministic overlap).** Client A runs `BEGIN; INSERT`
   and keeps the transaction open. 24 other clients each `BEGIN; INSERT` the
   same slot. The test asserts all 24 are still pending after 200 ms (the
   database makes them wait on A's uncommitted row), then A commits and every
   one of the 24 fails with SQLSTATE `23P01`. One row is stored.
2. **25-way burst.** 25 pre-connected clients wait on one shared barrier and
   insert the same slot together. Exactly one wins, one row is stored. This is
   a stress test, not a proof of overlap: how closely the inserts interleave is
   up to the scheduler. Test 1 is the part that does not depend on timing.
3. **Control.** The same 25 clients run the usual application-level
   check-then-insert (`SELECT` for an overlap, pause 50 ms, `INSERT`) on a table
   without the constraint. More than one wins, which is the bug the
   constraint exists to remove.

### Red first: constraint removed

`RACE_DROP_CONSTRAINT=1` drops the constraint after the schema is applied.
Tests 1 and 2 go red (the rivals no longer block; every insert wins). The
control stays green, since it never had a constraint.

```
$ RACE_DROP_CONSTRAINT=1 npx vitest run test/race.test.ts
 RUN  v2.1.9

stdout | test/race.test.ts > the database refuses double bookings > 25-way burst from pre-connected clients: exactly one wins
race: 25 of 25 inserts won; 25 rows stored

stdout | test/race.test.ts > the database refuses double bookings > RED control: an application-level check-then-insert double-books without the constraint
check-then-insert without the constraint: 25 of 25 won

 ❯ test/race.test.ts (9 tests | 5 failed) 360ms
   × the database refuses double bookings > a held transaction blocks every other insert for the slot, and each loser gets 23P01 235ms
     → rival inserts must still be waiting on the open transaction: expected 24 to be +0 // Object.is equality
   × the database refuses double bookings > 25-way burst from pre-connected clients: exactly one wins 27ms
     → expected 25 to be 1 // Object.is equality
   × the database refuses double bookings > racing OVERLAPPING (not identical) slots: no two stored rows overlap 6ms
     → expected 11 to be +0 // Object.is equality
   × the database refuses double bookings > back-to-back bookings are fine; a buffer makes them collide 2ms
     → expected 'won' to be 'refused' // Object.is equality
   × the database refuses double bookings > bookingRangesConflict and the database agree on the same buffer cases 1ms
     → case 1: [["09:00","10:00",15],["10:00","11:00",0]]: expected 'won' to be 'refused' // Object.is equality
```

### Green: constraint in place

```
$ npx vitest run
 RUN  v2.1.9

 ✓ test/conflicts.test.ts (5 tests) 2ms
 ✓ test/slots.test.ts (12 tests) 20ms
 ✓ test/slots-dst.test.ts (22 tests) 24ms
stdout | test/race.test.ts > the database refuses double bookings > 25-way burst from pre-connected clients: exactly one wins
race: 1 of 25 inserts won; 1 rows stored

stdout | test/race.test.ts > the database refuses double bookings > RED control: an application-level check-then-insert double-books without the constraint
check-then-insert without the constraint: 25 of 25 won

 ✓ test/race.test.ts (9 tests) 405ms
 ✓ test/slots.property.test.ts (3 tests) 577ms

 Test Files  5 passed (5)
      Tests  51 passed (51)
   Start at  18:54:59
   Duration  940ms (transform 155ms, setup 0ms, collect 318ms, tests 1.03s, environment 0ms, prepare 246ms)
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
  merging overlapping windows, minimum notice, conflict classification and retry-once handling.

## Notes on time

Wall-clock to UTC conversion uses `Intl.DateTimeFormat` and converges twice
rather than doing offset arithmetic, which breaks on transition days. A wall time
that occurs twice resolves to the later occurrence; one that does not exist
yields no slot. Durations and buffers are elapsed minutes, not wall-clock ones.

## License

MIT
