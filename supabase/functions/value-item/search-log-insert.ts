// Writing the Search AI's log rows (l_search_log). Kept apart from store.ts (which needs the Supabase client) so it can be tested.
import type { SearchLogRow } from "./types.ts";

/** The one thing needed from the database client: insert rows into a table, get back `{ error }`. */
export interface InsertDb {
  from(table: string): { insert(rows: unknown): PromiseLike<{ error: { message: string } | null }> };
}

/**
 * Inserts the rows. Code deployed BEFORE its migration must never break and never lose rows it can keep:
 *  - If the database does not have the column own_sold yet (migration 20261109100000), the column is removed from EVERY
 *    row and the insert is retried. No row is dropped for this: own_sold is an extra, `prices` still carries the rest.
 *  - If it does not have executed_query / connector_modified yet (migration 20261108100000), the rows are written the old
 *    way, but every row whose query the Connector edited is left out: without the marker the Search AI could not tell that
 *    its prices belong to the edit, not to the template.
 * Both can apply at once; at most two attempts follow the first one's failure. Any other error is thrown as before.
 */
export async function insertSearchLog(db: InsertDb, rows: SearchLogRow[]): Promise<void> {
  if (rows.length === 0) return;
  let current: Record<string, unknown>[] = rows as unknown as Record<string, unknown>[];
  let droppedOwnSold = false;
  let droppedExecuted = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { error } = await db.from("l_search_log").insert(current);
    if (!error) return;
    const msg = error.message;
    if (!droppedOwnSold && /own_sold/.test(msg)) {
      droppedOwnSold = true;
      current = current.map((r) => {
        const copy = { ...r };
        delete copy.own_sold;
        return copy;
      });
      continue;
    }
    if (!droppedExecuted && /executed_query|connector_modified/.test(msg)) {
      droppedExecuted = true;
      current = current
        .filter((r) => !r.connector_modified)
        .map((r) => {
          const copy = { ...r };
          delete copy.executed_query;
          delete copy.connector_modified;
          return copy;
        });
      if (current.length === 0) return;
      continue;
    }
    throw new Error(msg);
  }
  throw new Error("l_search_log insert failed after retries"); // unreachable in practice: each retry uses up one of the two fallbacks
}
