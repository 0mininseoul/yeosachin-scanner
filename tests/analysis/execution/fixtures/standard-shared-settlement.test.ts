import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createStandardDatabase } from './standard-database';
import { sharedStandardEffects } from './standard-shared-verification';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

it('detects swapped charges with unchanged total, missing orders and duplicate settlements per operation and attempt', async () => {
    const db = await createStandardDatabase();
    const requestId = randomUUID(), orderId = randomUUID(), ownerId = randomUUID();
    const effects = () => sharedStandardEffects(db, requestId, orderId, ownerId);
    try {
        // Preserve the real ledger column types. Temporary tables allow deliberately malformed evidence.
        await db.exec(`
            CREATE TEMP TABLE analysis_v2_ai_attempts AS TABLE public.analysis_v2_ai_attempts WITH NO DATA;
            CREATE TEMP TABLE vertex_ai_budget_reservations AS TABLE public.vertex_ai_budget_reservations WITH NO DATA;
        `);
        await db.query(`INSERT INTO analysis_v2_ai_attempts(request_id,operation_key,attempt,estimated_cost_usd)
            VALUES ($1,'first',1,0.0001),($1,'first',2,0.0003),($1,'other',1,0.0002)`, [requestId]);
        await db.query(`INSERT INTO vertex_ai_budget_reservations(run_id,order_id,operation_key,attempt,state,actual_cost_usd)
            SELECT request_id::text,$1,operation_key,attempt,'settled',estimated_cost_usd FROM analysis_v2_ai_attempts`, [orderId]);
        const baseline = await effects();
        expect(baseline).toMatchObject({
            settlements: 3, wrong_order: 0, unsettled_attempts: 0,
            duplicate_settlements: 0, unmatched_settlements: 0, mismatched_settlement_costs: 0
        });

        await db.exec(`UPDATE vertex_ai_budget_reservations SET actual_cost_usd=0.0004-actual_cost_usd
            WHERE operation_key='first'`);
        expect(await effects()).toMatchObject({ mismatched_settlement_costs: 2, charged_micros: baseline.charged_micros });
        await db.exec(`UPDATE analysis_v2_ai_attempts SET estimated_cost_usd=NULL WHERE operation_key='other'`);
        expect(await effects()).toMatchObject({ mismatched_settlement_costs: 3 });
        await db.exec(`UPDATE vertex_ai_budget_reservations SET order_id=NULL,attempt=1 WHERE attempt=2`);
        expect(await effects()).toMatchObject({ wrong_order: 1, duplicate_settlements: 1, unsettled_attempts: 1, settlements: 3 });
        await db.exec(`UPDATE vertex_ai_budget_reservations SET operation_key='unexpected' WHERE operation_key='other'`);
        expect(await effects()).toMatchObject({ unmatched_settlements: 1, unsettled_attempts: 2 });
    } finally {
        await db.close();
    }
}, 30_000);
