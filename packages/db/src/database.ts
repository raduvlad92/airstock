import pg from 'pg';

/** A connection used inside one transaction. */
export interface Tx {
  query<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<R[]>;
  /** SQL statements sent in this transaction, including BEGIN and COMMIT. */
  readonly statements: number;
}

export interface TenantContext {
  /** Shop whose rows are visible. Null for account-level work (for example listing a user's shops). */
  shopId: string | null;
  /** Signed-in user, used by policies that expose a user's own memberships and shops. */
  userId: string | null;
  readOnly?: boolean;
}

export interface TransactionStats {
  statements: number;
  durationMs: number;
  outcome: 'committed' | 'rolled_back' | 'unknown';
}

export interface Database {
  /**
   * Runs `fn` in one transaction with the tenant context set transaction-locally,
   * so pooled connections never carry one request's tenant into the next.
   */
  transaction<T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * The commit was sent but its acknowledgement was lost. The transaction may or may not
 * have committed; callers must report an unknown outcome and let the client retry with
 * the same idempotency key (PRD 7.3).
 */
export class CommitOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super('The database commit acknowledgement was lost; the outcome is unknown.', { cause });
    this.name = 'CommitOutcomeUnknownError';
  }
}

export interface Connection {
  client: pg.ClientBase;
  release(broken: boolean): Promise<void> | void;
}

export interface ConnectionSource {
  acquire(): Promise<Connection>;
  close(): Promise<void>;
}

export interface DatabaseHooks {
  /** Test-only fault injection: runs after `fn` and before COMMIT. */
  beforeCommit?: (tx: Tx) => Promise<void> | void;
  /** Test-only fault injection: runs after COMMIT succeeds, before returning. */
  afterCommit?: () => Promise<void> | void;
  onTransactionEnd?: (stats: TransactionStats) => void;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function contextLiteral(value: string | null): string {
  if (value === null) return "''";
  if (!UUID_RE.test(value)) throw new Error('Tenant context values must be lowercase UUIDs.');
  return `'${value}'`;
}

/** SQLSTATE codes mean the server answered; anything else at COMMIT is a lost acknowledgement. */
function isServerError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    /^[0-9A-Z]{5}$/.test((error as { code: string }).code)
  );
}

export class PgDatabase implements Database {
  constructor(
    private readonly source: ConnectionSource,
    private readonly hooks: DatabaseHooks = {},
  ) {}

  async transaction<T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const started = performance.now();
    const conn = await this.source.acquire();
    let statements = 0;
    let broken = false;
    let outcome: TransactionStats['outcome'] = 'rolled_back';
    const tx: Tx = {
      async query<R>(sql: string, params?: readonly unknown[]) {
        statements++;
        const res = await conn.client.query(sql, params as unknown[] | undefined);
        return res.rows as R[];
      },
      get statements() {
        return statements;
      },
    };

    // BEGIN and the tenant context travel in one round trip. The values are validated UUIDs,
    // so inlining them in the simple-query string is safe.
    const begin = `begin${ctx.readOnly ? ' read only' : ''}; select set_config('app.shop_id', ${contextLiteral(ctx.shopId)}, true), set_config('app.user_id', ${contextLiteral(ctx.userId)}, true)`;

    try {
      statements++;
      await conn.client.query(begin);
      const result = await fn(tx);
      await this.hooks.beforeCommit?.(tx);
      try {
        statements++;
        await conn.client.query('commit');
      } catch (error) {
        if (isServerError(error)) throw error;
        broken = true;
        outcome = 'unknown';
        throw new CommitOutcomeUnknownError(error);
      }
      outcome = 'committed';
      try {
        await this.hooks.afterCommit?.();
      } catch (error) {
        outcome = 'unknown';
        throw new CommitOutcomeUnknownError(error);
      }
      return result;
    } catch (error) {
      if (outcome === 'rolled_back' && !broken) {
        try {
          await conn.client.query('rollback');
        } catch {
          broken = true;
        }
      }
      throw error;
    } finally {
      await conn.release(broken);
      this.hooks.onTransactionEnd?.({
        statements,
        durationMs: performance.now() - started,
        outcome,
      });
    }
  }

  close(): Promise<void> {
    return this.source.close();
  }
}

/** Pooled connections, for Node (tests, scripts). */
export function poolSource(connectionString: string, max = 20): ConnectionSource {
  const pool = new pg.Pool({ connectionString, max });
  return {
    async acquire() {
      const client = await pool.connect();
      return {
        client,
        release: (broken) => client.release(broken),
      };
    },
    close: () => pool.end(),
  };
}

/**
 * One client per connection, for Workers behind Hyperdrive. Hyperdrive pools the real
 * database connections, so each request opens a cheap client and closes it afterwards.
 */
export function clientSource(connectionString: string): ConnectionSource {
  return {
    async acquire() {
      const client = new pg.Client({ connectionString });
      await client.connect();
      return {
        client,
        release: () => client.end(),
      };
    },
    close: async () => {},
  };
}
