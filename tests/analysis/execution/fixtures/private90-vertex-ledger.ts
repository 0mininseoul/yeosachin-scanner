import type { PGlite } from '@electric-sql/pglite';

// Compare settled holds to the exact reservation attached to each observed SDK send, including a renewed hold after a proven pre-send release.
// No reservation, account, operation or request identifier leaves SQL.
export async function private90VertexLedger(db: PGlite, grantId: string, sentIds: readonly string[]) {
    const result = await db.query<{
        positive: number; unused: number; unresolved: number; duplicate: number; orphan: number; debit: number;
    }>(`
        WITH holds AS (
            SELECT reservation_id, vertex_attempt_key AS key, actual_micros AS cost, unused_before_dispatch AS unused
            FROM dev_live_budget.reservations WHERE grant_id=$1::uuid AND provider='vertex'
        )
        SELECT count(*) FILTER (WHERE cost>0)::int AS positive,
               count(*) FILTER (WHERE cost=0 AND unused)::int AS unused,
               count(*) FILTER (WHERE cost IS NULL OR (cost=0 AND NOT unused) OR (cost>0 AND unused))::int AS unresolved,
               (count(*) FILTER (WHERE cost>0) - count(DISTINCT key) FILTER (WHERE cost>0))::int AS duplicate,
               count(*) FILTER (WHERE cost>0 AND NOT (reservation_id=ANY($2::uuid[])))::int AS orphan,
               coalesce(sum(cost),0)::int AS debit FROM holds
    `, [grantId, [...sentIds]]);
    return result.rows[0]!;
}
