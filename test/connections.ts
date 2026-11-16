import type { ConnectionSource } from '@airstock/db';
import pg from 'pg';

// One PostgreSQL server (100 connections, 3 of them kept for superusers) serves the test and
// end-to-end runs of every worktree on a machine, each in its own database. A single run peaks
// near 60 connections, so two runs at once used to fill the server, and whichever test connected
// next failed with "too many clients" or "remaining connection slots are reserved".
//
// Two things keep a run robust to that. Test pools are small and close idle connections after a
// second, instead of parking up to 60 for ten seconds after a burst. And a connection attempt
// that finds the server full waits for a slot, as a pooler queues a client, instead of failing
// the test. Any other error is thrown at once.

/** SQLSTATE too_many_connections: no free slot on the server (or for this role). */
const TOO_MANY_CONNECTIONS = '53300';
const WAIT_FOR_SLOT_MS = 60_000;

/** Runs `connect`, waiting with backoff while the server has no free connection slot. */
export async function whenSlotFree<T>(connect: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + WAIT_FOR_SLOT_MS;
  for (let wait = 20; ; wait = Math.min(wait * 2, 500)) {
    try {
      return await connect();
    } catch (error) {
      const full = (error as { code?: unknown }).code === TOO_MANY_CONNECTIONS;
      if (!full || Date.now() + wait > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait + Math.random() * wait));
    }
  }
}

/** A small pool whose idle connections go back to the server after a second. */
export function testPool(connectionString: string, max: number): pg.Pool {
  return new pg.Pool({ connectionString, max, idleTimeoutMillis: 1000, allowExitOnIdle: true });
}

/** The tests' stand-in for `poolSource`: a `testPool` that waits for a free server slot. */
export function testConnectionSource(connectionString: string, max: number): ConnectionSource {
  const pool = testPool(connectionString, max);
  return {
    async acquire() {
      const client = await whenSlotFree(() => pool.connect());
      return { client, release: (broken) => client.release(broken) };
    },
    close: () => pool.end(),
  };
}

/** A single connected client (for a session the test controls), waiting for a free slot. */
export function connectClient(connectionString: string): Promise<pg.Client> {
  return whenSlotFree(async () => {
    const client = new pg.Client({ connectionString });
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.end().catch(() => {});
      throw error;
    }
  });
}
