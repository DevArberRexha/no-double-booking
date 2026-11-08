import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXCLUSION_CONSTRAINT_NAME, isExclusionViolation, isRetryableConflict } from "../src/conflicts.js";
import { bookingRangesConflict } from "../src/slots.js";

const CONNECTION = process.env["DATABASE_URL"];
const CONCURRENT_REQUESTS = 25;

// RACE_DROP_CONSTRAINT=1 removes the EXCLUDE constraint after the schema is
// applied. It exists to prove the tests can fail: without the constraint the
// "exactly one wins" and "must block" assertions go red.
const DROP_CONSTRAINT = process.env["RACE_DROP_CONSTRAINT"] === "1";

if (!CONNECTION) {
  console.warn(
    "race.test.ts: SKIPPED. DATABASE_URL is not set, and these tests need a scratch " +
      "PostgreSQL 16 database (they drop and recreate the `bookings` table). " +
      "Example: DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres npm test"
  );
}

const pool = new pg.Pool({ connectionString: CONNECTION, max: 4 });

async function reset(): Promise<void> {
  await pool.query("DROP TABLE IF EXISTS bookings, bookings_unguarded CASCADE");
  const schema = readFileSync(
    fileURLToPath(new URL("../sql/schema.sql", import.meta.url)),
    "utf8"
  );
  await pool.query(schema);
  // Same columns and CHECKs, no exclusion constraint: the control table for
  // the check-then-insert pattern.
  await pool.query(
    `CREATE TABLE bookings_unguarded
       (LIKE bookings INCLUDING DEFAULTS INCLUDING IDENTITY INCLUDING CONSTRAINTS)`
  );
  if (DROP_CONSTRAINT) {
    await pool.query(`ALTER TABLE bookings DROP CONSTRAINT ${EXCLUSION_CONSTRAINT_NAME}`);
  }
}

interface NewBooking {
  resource: string;
  start: string;
  end: string;
  buffer?: number;
  status?: string;
}

const INSERT_SQL = (table: string): string =>
  `INSERT INTO ${table} (resource_id, start_at, end_at, buffer_min, status)
   VALUES ($1, $2, $3, $4, $5)`;

const params = (b: NewBooking): unknown[] => [
  b.resource,
  b.start,
  b.end,
  b.buffer ?? 0,
  b.status ?? "CONFIRMED",
];

async function insert(b: NewBooking): Promise<void> {
  await pool.query(INSERT_SQL("bookings"), params(b));
}

async function attempt(b: NewBooking): Promise<"won" | "refused"> {
  try {
    await insert(b);
    return "won";
  } catch (error) {
    if (isExclusionViolation(error)) return "refused";
    throw error;
  }
}

/** Dedicated connections, all established before any of them is used. */
async function connectClients(n: number): Promise<pg.Client[]> {
  const clients = Array.from({ length: n }, () => new pg.Client({ connectionString: CONNECTION }));
  await Promise.all(clients.map((c) => c.connect()));
  return clients;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function count(table: string, resource: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM ${table} WHERE resource_id = $1`,
    [resource]
  );
  return Number(rows[0]?.n);
}

describe.skipIf(!CONNECTION)("the database refuses double bookings", () => {
  beforeAll(reset);
  afterAll(() => pool.end());

  it("a held transaction blocks every other insert for the slot, and each loser gets 23P01", async () => {
    const slot: NewBooking = {
      resource: "dr-held",
      start: "2027-03-09T09:00:00Z",
      end: "2027-03-09T09:30:00Z",
    };
    const [holder, ...rivals] = await connectClients(CONCURRENT_REQUESTS);
    if (!holder) throw new Error("no clients");
    try {
      // A inserts and keeps its transaction open: the row is not committed yet.
      await holder.query("BEGIN");
      await holder.query(INSERT_SQL("bookings"), params(slot));

      // B..N each insert the same slot. Their INSERT cannot decide until A's
      // transaction ends, so it must block inside the database. That proves
      // the check happens in the insert, under a lock, with no gap.
      type Outcome = { state: "won" } | { state: "failed"; error: unknown };
      let settled = 0;
      const outcomes = rivals.map(async (c): Promise<Outcome> => {
        await c.query("BEGIN");
        try {
          await c.query(INSERT_SQL("bookings"), params(slot));
          return { state: "won" };
        } catch (error) {
          return { state: "failed", error };
        } finally {
          settled += 1;
        }
      });
      await sleep(200);
      expect(settled, "rival inserts must still be waiting on the open transaction").toBe(0);

      await holder.query("COMMIT");
      const results = await Promise.all(outcomes);

      expect(results).toHaveLength(CONCURRENT_REQUESTS - 1);
      for (const r of results) {
        expect(r.state).toBe("failed");
        if (r.state === "failed") {
          expect((r.error as { code?: string }).code).toBe("23P01");
        }
      }
      expect(await count("bookings", slot.resource)).toBe(1);
    } finally {
      await Promise.all(
        [holder, ...rivals].map(async (c) => {
          await c.query("ROLLBACK").catch(() => undefined);
          await c.end();
        })
      );
    }
  });

  it(`${CONCURRENT_REQUESTS}-way burst from pre-connected clients: exactly one wins`, async () => {
    const slot: NewBooking = {
      resource: "dr-lena",
      start: "2027-03-10T09:00:00Z",
      end: "2027-03-10T09:30:00Z",
    };
    const clients = await connectClients(CONCURRENT_REQUESTS);
    try {
      // Every client is connected and waiting on one shared barrier; the
      // barrier opens only after all of them are queued, so the inserts leave
      // together. The application never asks "is it free?" first.
      let open!: () => void;
      const barrier = new Promise<void>((resolve) => (open = resolve));
      const runs = clients.map(async (c): Promise<"won" | "refused"> => {
        await barrier;
        try {
          await c.query(INSERT_SQL("bookings"), params(slot));
          return "won";
        } catch (error) {
          if (isExclusionViolation(error)) return "refused";
          throw error;
        }
      });
      open();
      const results = await Promise.all(runs);
      const wins = results.filter((r) => r === "won").length;
      const stored = await count("bookings", slot.resource);
      console.log(`race: ${wins} of ${CONCURRENT_REQUESTS} inserts won; ${stored} rows stored`);
      expect(wins).toBe(1);
      expect(stored).toBe(1);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });

  it("RED control: an application-level check-then-insert double-books without the constraint", async () => {
    // Runs against `bookings_unguarded`, which has no exclusion constraint.
    // Each client SELECTs for an overlap, pauses 50 ms (the gap every real
    // check-then-write has), then INSERTs if it saw none.
    const slot: NewBooking = {
      resource: "dr-check-then-insert",
      start: "2027-03-16T09:00:00Z",
      end: "2027-03-16T09:30:00Z",
    };
    const clients = await connectClients(CONCURRENT_REQUESTS);
    try {
      let open!: () => void;
      const barrier = new Promise<void>((resolve) => (open = resolve));
      const runs = clients.map(async (c): Promise<"won" | "saw-conflict"> => {
        await barrier;
        const { rows } = await c.query<{ n: string }>(
          `SELECT count(*) AS n FROM bookings_unguarded
            WHERE resource_id = $1 AND tstzrange(start_at, end_at) && tstzrange($2, $3)`,
          [slot.resource, slot.start, slot.end]
        );
        if (Number(rows[0]?.n) > 0) return "saw-conflict";
        await c.query("SELECT pg_sleep(0.05)");
        await c.query(INSERT_SQL("bookings_unguarded"), params(slot));
        return "won";
      });
      open();
      const results = await Promise.all(runs);
      const wins = results.filter((r) => r === "won").length;
      console.log(`check-then-insert without the constraint: ${wins} of ${CONCURRENT_REQUESTS} won`);
      expect(wins).toBeGreaterThan(1);
      expect(await count("bookings_unguarded", slot.resource)).toBe(wins);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });

  it("racing OVERLAPPING (not identical) slots: no two stored rows overlap", async () => {
    // 10:00-10:30, 10:15-10:45, 10:30-11:00, ... each overlaps its neighbours.
    const starts = Array.from({ length: 12 }, (_, i) => Date.UTC(2027, 2, 11, 10, i * 15));
    // Partially overlapping inserts can wait on each other, and Postgres then
    // aborts one as a deadlock victim (40P01). That insert stores nothing, so
    // it is as safe as a 23P01 refusal; any other error fails the test.
    await Promise.all(
      starts.map(async (s) => {
        try {
          await insert({
            resource: "dr-ana",
            start: new Date(s).toISOString(),
            end: new Date(s + 30 * 60_000).toISOString(),
          });
        } catch (error) {
          if (!isRetryableConflict(error)) throw error;
        }
      })
    );
    const { rows } = await pool.query<{ pairs: string }>(
      `SELECT count(*) AS pairs FROM bookings a JOIN bookings b
         ON a.resource_id = b.resource_id AND a.id < b.id
        WHERE tstzrange(a.start_at, a.end_at) && tstzrange(b.start_at, b.end_at)
          AND a.resource_id = 'dr-ana'`
    );
    expect(Number(rows[0]?.pairs)).toBe(0);
  });

  it("different resources may take the same time", async () => {
    const t = { start: "2027-03-12T09:00:00Z", end: "2027-03-12T09:30:00Z" };
    await expect(attempt({ resource: "r1", ...t })).resolves.toBe("won");
    await expect(attempt({ resource: "r2", ...t })).resolves.toBe("won");
  });

  it("back-to-back bookings are fine; a buffer makes them collide", async () => {
    await insert({ resource: "buf", start: "2027-03-13T09:00:00Z", end: "2027-03-13T10:00:00Z", buffer: 15 });
    await expect(
      attempt({ resource: "buf", start: "2027-03-13T10:00:00Z", end: "2027-03-13T11:00:00Z" })
    ).resolves.toBe("refused");
    await expect(
      attempt({ resource: "buf", start: "2027-03-13T10:15:00Z", end: "2027-03-13T11:00:00Z" })
    ).resolves.toBe("won");
  });

  it("bookingRangesConflict and the database agree on the same buffer cases", async () => {
    const at = (hhmm: string): string => `2027-04-01T${hhmm}:00Z`;
    // [existing start, end, buffer] vs [candidate start, end, buffer]
    const cases: Array<[[string, string, number], [string, string, number]]> = [
      [["09:00", "10:00", 0], ["10:00", "11:00", 0]], // touching, no buffers
      [["09:00", "10:00", 15], ["10:00", "11:00", 0]], // existing buffer reaches candidate
      [["09:00", "10:00", 15], ["10:15", "11:00", 0]], // gap equals existing buffer
      [["09:00", "10:00", 15], ["10:14", "11:00", 0]], // one minute inside the buffer
      [["10:00", "11:00", 0], ["09:00", "10:00", 15]], // candidate buffer reaches existing
      [["10:00", "11:00", 0], ["09:00", "09:45", 15]], // gap equals candidate buffer
      [["10:00", "11:00", 0], ["09:00", "09:46", 15]], // one minute inside candidate buffer
      [["09:00", "10:00", 30], ["10:20", "11:00", 10]], // both buffered, existing wins
      [["10:30", "11:00", 10], ["09:00", "10:25", 10]], // both buffered, candidate wins
      [["09:00", "09:30", 5], ["09:30", "10:00", 5]], // touching with equal buffers
      [["09:00", "10:00", 0], ["09:30", "09:45", 0]], // candidate nested
    ];
    for (const [i, [existing, candidate]] of cases.entries()) {
      const resource = `parity-${i}`;
      await insert({ resource, start: at(existing[0]), end: at(existing[1]), buffer: existing[2] });
      const db = await attempt({
        resource,
        start: at(candidate[0]),
        end: at(candidate[1]),
        buffer: candidate[2],
      });
      const app = bookingRangesConflict(
        new Date(at(candidate[0])),
        new Date(at(candidate[1])),
        candidate[2],
        new Date(at(existing[0])),
        new Date(at(existing[1])),
        existing[2]
      );
      expect(db, `case ${i}: ${JSON.stringify([existing, candidate])}`).toBe(
        app ? "refused" : "won"
      );
    }
  });

  it("a cancelled booking frees its slot", async () => {
    await insert({ resource: "cx", start: "2027-03-14T09:00:00Z", end: "2027-03-14T10:00:00Z", status: "CANCELLED" });
    await expect(
      attempt({ resource: "cx", start: "2027-03-14T09:00:00Z", end: "2027-03-14T10:00:00Z" })
    ).resolves.toBe("won");
  });

  it("a zero-length booking is rejected by the CHECK, not silently accepted", async () => {
    await expect(
      insert({ resource: "z", start: "2027-03-15T09:00:00Z", end: "2027-03-15T09:00:00Z" })
    ).rejects.toThrow(/bookings_end_after_start/);
  });
});
