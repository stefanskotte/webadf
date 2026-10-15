import { getDb, type Db } from './index';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * What db.batch() gave us on neon-http, as a real transaction (P1 D2): the
 * statements run in order, all or nothing, and each result comes back in
 * order. EVERY statement must be built from `tx` -- one built from getDb()
 * runs outside the transaction and survives a rollback.
 */
export async function atomic(build: (tx: Tx) => readonly PromiseLike<unknown>[]): Promise<unknown[]> {
  return getDb().transaction(async (tx) => {
    const out: unknown[] = [];
    for (const stmt of build(tx)) out.push(await stmt);
    return out;
  });
}
