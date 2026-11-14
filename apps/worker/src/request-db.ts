import type { ConnectionSource } from '@airstock/db';
import pg from 'pg';

/**
 * One client per request, reused by the request's sequential transactions and closed when
 * the request ends. Hyperdrive pools the real database connections behind it.
 */
export function requestScopedSource(connectionString: string): ConnectionSource {
  let client: pg.Client | null = null;
  return {
    async acquire() {
      if (!client) {
        client = new pg.Client({ connectionString });
        await client.connect();
      }
      const current = client;
      return {
        client: current,
        release: async (broken) => {
          if (broken) {
            client = null;
            await current.end().catch(() => {});
          }
        },
      };
    },
    async close() {
      const current = client;
      client = null;
      await current?.end().catch(() => {});
    },
  };
}
