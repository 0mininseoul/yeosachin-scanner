import { setTimeout as sleep } from 'node:timers/promises';
import type { StandardDatabase } from './standard-database';

// Only constructed by the one-owner signed-webhook fixture in a fresh local cluster.
export class SharedBudgetPressureProbe {
    private installed?: Promise<void>;
    private readonly deniedDeliveries = new Set<object>();
    private readonly deniedReservationKeys = new Set<string>();
    private triageModelCalls = 0;
    private released = false;
    private continuations = 0;

    constructor(private readonly db: StandardDatabase, readonly mode: 'held' | 'spent') {}

    observeModelCall(stage: string) {
        if (stage === 'gender_triage') this.triageModelCalls++;
    }

    async beforeRpc(name: string, args: Record<string, unknown>) {
        if (name !== 'reserve_vertex_ai_budget' || typeof args.p_operation_key !== 'string'
            || !args.p_operation_key.startsWith('gender-triage:')) return;
        this.installed ??= this.install(args);
        await this.installed;
    }

    private async install(args: Record<string, unknown>) {
        // Let the signed fixture's one parallel private-name call settle first. Its
        // estimate can exceed its final cost and reopen capacity during the probe.
        const deadline = performance.now() + 15_000;
        while (true) {
            const { rows } = await this.db.query<{ ready: boolean }>(`
                SELECT EXISTS (SELECT FROM public.analysis_v2_ai_attempts a
                    JOIN public.vertex_ai_budget_reservations r ON r.run_id=a.request_id::text
                        AND r.operation_key=a.operation_key AND r.attempt=a.attempt
                    WHERE r.run_id=$1 AND a.stage='privateAccountName' AND a.status='success'
                        AND r.state='settled' AND NOT r.usage_unknown) AS ready`, [args.p_run_id]);
            if (rows[0]?.ready) break;
            if (performance.now() >= deadline) throw new Error('SHARED_BUDGET_PROBE_PRIVATE_NAME_UNSETTLED');
            await sleep(25);
        }
        // The fixture operation uses the same signed order and run. It exercises
        // reserve and settle without submitting a model call or creating an AI attempt.
        await this.db.transaction(async tx => {
            await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('vertex-ai-budget:all-scopes',0))");
            const { rows } = await tx.query<{ ok: boolean }>(`
                WITH available AS (
                    SELECT $1::numeric - coalesce(sum(coalesce(actual_cost_usd,estimated_cost_usd)),0) AS amount
                    FROM public.vertex_ai_budget_reservations
                    WHERE run_id=$2 AND state IN ('reserved','settled')
                )
                SELECT EXISTS (SELECT FROM available CROSS JOIN LATERAL public.reserve_vertex_ai_budget(
                    'fixture-competing-budget',$2,$3,'fixture-finance-only',
                    1,'default','fixture','global',1,1,available.amount,NULL,$1,$4,$5)) AS ok
            `, [args.p_per_run_limit_usd, args.p_run_id, args.p_order_id ?? null, args.p_per_order_limit_usd, args.p_daily_limit_usd]);
            if (rows[0]?.ok !== true) throw new Error('SHARED_BUDGET_PROBE_INSTALL_FAILED');
            if (this.mode === 'spent') {
                // Use the real finalizer with the known price, exactly up to the cap.
                await tx.query(`SELECT s.reservation_id IS NOT NULL AS ok
                    FROM public.vertex_ai_budget_reservations r CROSS JOIN LATERAL public.settle_vertex_ai_budget(
                        r.reservation_key,r.reservation_id,r.estimated_cost_usd) s
                    WHERE r.reservation_key='fixture-competing-budget'`);
            }
        });
    }

    async afterRpc(name: string, args: Record<string, unknown>, error: { hint?: string; message?: string } | null, delivery?: object) {
        if (name === 'reserve_vertex_ai_budget' && error?.message?.startsWith('VERTEX_AI_BUDGET_EXCEEDED:run:') && delivery
            && typeof args.p_reservation_key === 'string' && typeof args.p_operation_key === 'string'
            && args.p_operation_key.startsWith('gender-triage:')) {
            this.deniedDeliveries.add(delivery);
            this.deniedReservationKeys.add(args.p_reservation_key);
        }
        if (this.mode !== 'held' || this.released || !delivery || !this.deniedDeliveries.has(delivery) || error
            || name !== 'continue_analysis_v2_scheduler_job' || args.p_error_code !== 'ANALYSIS_V2_AI_CAPACITY_PENDING') return;
        this.continuations++;
        // A denial must recur after real queue redelivery, with the financial hold still present.
        if (this.deniedDeliveries.size < 2) return;
        this.released = true;
        await this.db.query(`SELECT public.cancel_vertex_ai_budget(reservation_key,reservation_id)
            FROM public.vertex_ai_budget_reservations WHERE reservation_key='fixture-competing-budget' AND state='reserved'`);
    }

    async receipt() {
        const { rows: [row] } = await this.db.query<{
            cancelled: number; spent: number; signedOrderMatches: number;
            fixtureModelAttempts: number; admittedAfterDenial: number; settledAfterDenial: number;
        }>(`
            WITH fixture AS (
                SELECT * FROM public.vertex_ai_budget_reservations WHERE reservation_key='fixture-competing-budget'
            ), denied AS (
                SELECT * FROM public.vertex_ai_budget_reservations WHERE reservation_key=ANY($1::text[])
            )
            SELECT
                (SELECT count(*)::int FROM fixture WHERE state='cancelled' AND actual_cost_usd IS NULL) AS cancelled,
                (SELECT count(*)::int FROM fixture WHERE state='settled' AND actual_cost_usd=estimated_cost_usd
                    AND NOT usage_unknown) AS spent,
                (SELECT count(*)::int FROM fixture r JOIN public.earlybird_fulfillments f
                    ON f.request_id::text=r.run_id AND f.order_id::text=r.order_id) AS "signedOrderMatches",
                (SELECT count(*)::int FROM fixture r JOIN public.analysis_v2_ai_attempts a
                    ON a.request_id::text=r.run_id AND a.operation_key=r.operation_key) AS "fixtureModelAttempts",
                (SELECT count(*)::int FROM denied) AS "admittedAfterDenial",
                (SELECT count(*)::int FROM denied WHERE state='settled' AND actual_cost_usd>0 AND NOT usage_unknown) AS "settledAfterDenial"
        `, [[...this.deniedReservationKeys]]);
        return { mode: this.mode, deniedDeliveries: this.deniedDeliveries.size, continuations: this.continuations,
            deniedReservationKeys: this.deniedReservationKeys.size, triageModelCalls: this.triageModelCalls, ...row };
    }
}
