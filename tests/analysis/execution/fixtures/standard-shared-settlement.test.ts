import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createStandardDatabase, type StandardConnection, type StandardDatabase } from './standard-database';
import { createSharedStandardDatabase } from './standard-shared-database';
import { sharedStandardEffects, sharedStandardLedgerIssues, sharedStandardLedgerStages } from './standard-shared-verification';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

it('detects operation-level cost mismatches and distinguishes cancelled cutoff holds from missing holds', async () => {
    const database: StandardDatabase = process.env.RUN_SHARED_STANDARD_POSTGRES_TEST === '1'
        ? await createSharedStandardDatabase() : await createStandardDatabase();
    try {
        await database.transaction(checkSettlementEvidence);
    } finally {
        await database.close();
    }
}, 30_000);

async function checkSettlementEvidence(db: StandardConnection) {
    const requestId = randomUUID(), orderId = randomUUID(), ownerId = randomUUID();
    const effects = () => sharedStandardEffects(db, requestId, orderId, ownerId);
    // Preserve the real ledger column types. Temporary tables allow deliberately malformed evidence.
    await db.exec(`
        CREATE TEMP TABLE analysis_v2_ai_attempts AS TABLE public.analysis_v2_ai_attempts WITH NO DATA;
        CREATE TEMP TABLE vertex_ai_budget_reservations AS TABLE public.vertex_ai_budget_reservations WITH NO DATA;
        CREATE TEMP TABLE analysis_provider_admission_leases AS TABLE public.analysis_provider_admission_leases WITH NO DATA;
        CREATE TEMP TABLE analysis_v2_gemini_leases AS TABLE public.analysis_v2_gemini_leases WITH NO DATA;
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

    await db.exec(`UPDATE analysis_v2_ai_attempts SET status='success',stage='featureAnalysis';
        UPDATE analysis_v2_ai_attempts SET status='cutoff',stage='genderResolution',estimated_cost_usd=NULL WHERE operation_key='first';
        UPDATE vertex_ai_budget_reservations SET attempt=2,actual_cost_usd=NULL,usage_unknown=true,estimated_cost_usd=0.005
        WHERE order_id IS NULL`);
    const detailed = await sharedStandardLedgerStages(db, requestId, orderId);
    expect(detailed).toEqual(expect.arrayContaining([
        expect.objectContaining({ stage: 'genderResolution', attempts: 2, cutoffs: 2, cutoffs_missing_tokens: 2,
            unknown_cost_cutoffs: 1, priced_cutoffs_missing_attempt_cost: 1, unknown_settlements: 1,
            unknown_reserved_estimate_micros: 5000, wrong_order: 1 }),
        expect.objectContaining({ stage: 'featureAnalysis', attempts: 1, unsettled_attempts: 1 }),
        expect.objectContaining({ stage: 'unattributed', attempts: 0, unmatched_settlements: 1 }),
    ]));
    expect(sharedStandardLedgerIssues(await effects(), 3)).toEqual(expect.arrayContaining([
        'wrong_order', 'unpriced', 'unsettled_attempts', 'unmatched_settlements', 'mismatched_settlement_costs', 'incomplete_model_outcomes',
    ]));

    const claim = randomUUID();
    await db.query(`INSERT INTO analysis_v2_ai_attempts(request_id,job_key,job_claim_token,operation_key,attempt,status,stage)
        VALUES($1,'job',$2,'cutoff',1,'cutoff','genderResolution'),($1,'job',$2,'cutoff',2,'cutoff','genderResolution')`, [requestId, claim]);
    // One operation, two attempts. The first has only cancelled reservations, while the second has none.
    // A cancelled row alongside the earlier settled attempt must not count as cancelled-only.
    await db.query(`INSERT INTO vertex_ai_budget_reservations(run_id,order_id,operation_key,attempt,state)
        VALUES($1,$2,'cutoff',1,'cancelled'),($1,$2,'cutoff',1,'cancelled'),($1,$2,'first',2,'cancelled')`, [requestId, orderId]);
    await db.query(`INSERT INTO analysis_provider_admission_leases(request_id,job_key,job_claim_token,operation_key,workload_role,logical_provider,state,expires_at)
        VALUES($1,'job',$2,'gemini:cutoff:attempt:1','paid','gemini','leased',now()+interval '1 hour'),
              ($1,'job',$2,'gemini:cutoff:attempt:2','paid','gemini','recovery_required',now()-interval '1 hour')`, [requestId, claim]);
    await db.query(`INSERT INTO analysis_v2_gemini_leases(request_id,job_key,operation_key,attempt,stage,state,expires_at)
        VALUES($1,'job','cutoff',1,'genderResolution','quarantined',now()+interval '1 hour'),
              ($1,'job','cutoff',2,'genderResolution','quarantined',now()-interval '1 hour')`, [requestId]);
    const resolver = (await sharedStandardLedgerStages(db, requestId, orderId)).find(row => row.stage === 'genderResolution');
    expect(resolver).toMatchObject({
        cutoffs: 4, unsettled_attempts: 2, cutoffs_cancelled_only: 1, cutoffs_without_budget_row: 1,
        cutoffs_with_unexpired_admission: 1, cutoffs_with_expired_admission: 0, cutoffs_with_recovery_required_admission: 1,
        cutoffs_with_unexpired_slot: 1, cutoffs_with_expired_slot: 1, cutoffs_with_quarantined_slot: 2,
    });
    expect(sharedStandardLedgerIssues(await effects(), 5)).toEqual(expect.arrayContaining(['unsettled_attempts', 'open_provider_leases', 'open_model_slots']));
}
