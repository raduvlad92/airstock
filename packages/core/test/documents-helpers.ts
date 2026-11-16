import pg from 'pg';
import { inject } from 'vitest';
import { reconcile } from '../../../test/helpers.ts';

/**
 * Every stock invariant (A21) plus the document checks of milestone I2: transfer holds and
 * in-transit quantities match their lines. Runs as the runtime role in the shop, like the job.
 */
export async function reconcileAll(shopId: string): Promise<string[]> {
  const problems = await reconcile(shopId);
  const client = new pg.Client({ connectionString: inject('databases').appUrl });
  await client.connect();
  try {
    await client.query('begin read only');
    await client.query(`select set_config('app.shop_id', $1, true)`, [shopId]);
    for (const fn of ['transfer_reconciliation_problems', 'return_reconciliation_problems']) {
      const { rows } = await client.query<{
        problem: string;
        target_id: string;
        expected: string;
        actual: string;
      }>(`select problem, target_id, expected, actual from ${fn}()`);
      problems.push(
        ...rows.map(
          (r) => `${r.problem} at ${r.target_id}: expected ${r.expected}, got ${r.actual}`,
        ),
      );
    }
    await client.query('commit');
    return problems;
  } finally {
    await client.end();
  }
}
