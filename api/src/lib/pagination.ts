/**
 * Cursor-based pagination helpers using ULID cursors.
 * ULIDs are lexicographically sortable by time, so cursor pagination
 * is simply: WHERE id < cursor ORDER BY id DESC LIMIT n
 */

export interface PaginationParams {
  cursor?: string;
  limit: number;
}

export function parsePagination(url: URL): PaginationParams {
  const cursor = url.searchParams.get('cursor') || undefined;
  const limitStr = url.searchParams.get('limit');
  let limit = limitStr ? parseInt(limitStr, 10) : 20;
  if (isNaN(limit) || limit < 1) limit = 20;
  if (limit > 100) limit = 100;
  return { cursor, limit };
}

/**
 * Build cursor clause and bindings for a query.
 * Returns { clause, binds } to append to WHERE conditions.
 */
export function cursorClause(
  cursor: string | undefined,
  column: string = 'id',
): { clause: string; binds: unknown[] } {
  if (!cursor) return { clause: '', binds: [] };
  return { clause: `AND ${column} < ?`, binds: [cursor] };
}

/**
 * Extract next_cursor from a result set.
 * Returns the id of the last item if the result set is full (has `limit` items),
 * null otherwise (indicating no more pages).
 */
export function nextCursor<T extends { id: string }>(
  results: T[],
  limit: number,
): string | null {
  if (results.length < limit) return null;
  return results[results.length - 1].id;
}

export function scoreCursorClause(
  cursor: string | undefined,
  scoreColumn: string,
  idColumn: string,
): { clause: string; binds: unknown[] } {
  if (!cursor) return { clause: '', binds: [] };
  const parsed = parseScoreCursor(cursor);
  if (!parsed) return cursorClause(cursor, idColumn);
  return {
    clause: `AND (${scoreColumn} < ? OR (${scoreColumn} = ? AND ${idColumn} < ?))`,
    binds: [parsed.score, parsed.score, parsed.id],
  };
}

export function nextScoreCursor<T extends { id: string }>(
  results: T[],
  limit: number,
  scoreOf: (result: T) => number,
): string | null {
  if (results.length < limit) return null;
  const last = results[results.length - 1];
  return `${scoreOf(last)}:${last.id}`;
}

function parseScoreCursor(cursor: string): { score: number; id: string } | null {
  const separator = cursor.indexOf(':');
  if (separator <= 0) return null;
  const score = Number(cursor.slice(0, separator));
  const id = cursor.slice(separator + 1);
  if (!Number.isFinite(score) || !id) return null;
  return { score, id };
}
