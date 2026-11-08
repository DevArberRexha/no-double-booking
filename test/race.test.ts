import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXCLUSION_CONSTRAINT_NAME, isExclusionViolation } from "../src/conflicts.js";

const CONNECTION =
  process.env["DATABASE_URL"] ?? "postgres://postgres@127.0.0.1:54329/postgres";
const CONCURRENT_REQUESTS = 25;

// RACE_DROP_CONSTRAINT=1 removes the EXCLUDE constraint after the schema is
// applied. It exists to prove the test can fail: without the constraint the
// "exactly one wins" assertions must go red.
const DROP_CONSTRAINT = process.env["RACE_DROP_CONSTRAINT"] === "1";

const pool = new pg.Pool({ connectionString: CONNECTION, max: CONCURRENT_REQUESTS });

async function reset(): Promise<void> {
  await pool.query("DROP TABLE IF EXISTS bookings CASCADE");
  const schema = readFileSync(
    fileURLToPath(new URL("../sql/schema.sql", import.meta.url)),
    "utf8"
  );
  await pool.query(schema);
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

async function insert(b: NewBooking): Promise<void> {
  await pool.query(
    `INSERT INTO bookings (resource_id, start_at, end_at, buffer_min, status)
     VALUES ($1, $2, $3, $4, $5)`,
    [b.resource, b.start, b.end, b.buffer ?? 0, b.status ?? "CONFIRMED"]
  );
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

beforeAll(reset);
afterAll(() => pool.end());

describe("the database refuses double bookings", () => {
  it(`${CONCURRENT_REQUESTS} concurrent inserts for one slot: exactly one wins`, async () => {
    const slot: NewBooking = {
      resource: "dr-lena",
      start: "2027-03-10T09:00:00Z",
      end: "2027-03-10T09:30:00Z",
    };
    // Each insert takes its own connection, so they genuinely race. There is no
    // check-then-insert here at all: the application never asks "is it free?".
    const results = await Promise.all(
      Array.from({ length: CONCURRENT_REQUESTS }, () => attempt(slot))
    );
    const wins = results.filter((r) => r === "won").length;
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM bookings WHERE resource_id = $1",
      [slot.resource]
    );
    console.log(`race: ${wins} of ${CONCURRENT_REQUESTS} inserts won; ${rows[0]?.n} rows stored`);
    expect(wins).toBe(1);
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it("racing OVERLAPPING (not identical) slots: no two stored rows overlap", async () => {
    // 10:00-10:30, 10:15-10:45, 10:30-11:00, ... each overlaps its neighbours.
    const starts = Array.from({ length: 12 }, (_, i) => Date.UTC(2027, 2, 11, 10, i * 15));
    await Promise.all(
      starts.map((s) =>
        attempt({
          resource: "dr-ana",
          start: new Date(s).toISOString(),
          end: new Date(s + 30 * 60_000).toISOString(),
        })
      )
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
