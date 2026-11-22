import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    getApifyClient,
    startOrResumeApifyActor,
    type ApifyClientLike,
} from '@/lib/services/instagram/providers/apify-relationship';
import type { ApifyCredentialSlot, ProviderCallContext } from '@/lib/services/instagram/providers/types';
import { CherryDeferError } from './errors';
import { assertNoDatabaseError, cherryRpc } from './rpc';

export interface CherryRunRequest {
    ownerKey: string;
    operation: string;
    subscriptionId: string | null;
    slot: ApifyCredentialSlot;
    actorId: string;
    actorBuild?: string;
    input: unknown;
    /** Largest dataset this run may return. */
    items: number;
    maxChargeUsd: number;
    /** Runtime cap; a little above the billing ceiling so the last charge does not abort the run. */
    executionMaxChargeUsd?: number;
    estimatedUsdPerItem: number;
    timeoutSecs: number;
    deadlineAtMs: number;
    /** A finished run younger than this is read again instead of being bought again. */
    reuseSeconds: number;
}

interface Reservation {
    outcome: 'reserved' | 'resume' | 'busy' | 'capacity' | 'budget' | 'ambiguous' | 'exhausted';
    id: string;
    runId?: string;
    slot: ApifyCredentialSlot;
    maxChargeUsd: number;
    attempt: number;
    status?: string;
}

export interface CherryRunResult {
    ledgerId: string;
    /** One more than the number of runs that failed or could not be used. */
    attempt: number;
    rows: unknown[];
}

export interface CherryRunDeps {
    reserve(request: CherryRunRequest): Promise<Reservation>;
    update(id: string, patch: Record<string, unknown>): Promise<void>;
    client(slot: ApifyCredentialSlot): ApifyClientLike;
    sleep(ms: number): Promise<void>;
}

const DEFERRED: Record<string, { delaySeconds: number; terminal?: boolean; countAttempt?: boolean }> = {
    busy: { delaySeconds: 120, countAttempt: false },
    capacity: { delaySeconds: 60, countAttempt: false },
    budget: { delaySeconds: 1800, countAttempt: false },
    ambiguous: { delaySeconds: 0, terminal: true },
    exhausted: { delaySeconds: 0, terminal: true },
};

const defaultDeps: CherryRunDeps = {
    reserve: request => cherryRpc<Reservation>('cherry_reserve_run', {
        p_owner_key: request.ownerKey, p_operation: request.operation, p_subscription: request.subscriptionId,
        p_slot: request.slot, p_actor: request.actorId, p_items: request.items, p_max_charge: request.maxChargeUsd, p_reuse_seconds: request.reuseSeconds,
    }),
    async update(id, patch) {
        const { error } = await supabaseAdmin.from('cherry_provider_runs').update(patch).eq('id', id);
        assertNoDatabaseError('provider_run_update', error);
    },
    client: slot => getApifyClient(process.env, slot),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

async function readDataset(client: ApifyClientLike, datasetId: string, limit: number, deps: CherryRunDeps): Promise<unknown[]> {
    const rows: unknown[] = [];
    let retries = 0;
    for (;;) {
        let page;
        try {
            page = await client.dataset(datasetId).listItems({ offset: rows.length, limit: Math.min(1000, limit - rows.length + 1) });
        } catch {
            page = null;
        }
        // A finished run can briefly report an unsettled dataset.
        const settled = page && Array.isArray(page.items) && rows.length + page.items.length <= page.total
            && (page.items.length > 0 || rows.length >= page.total) && (page.total > 0 || retries > 0);
        if (!page || !settled) {
            retries += 1;
            if (retries > 4) throw new CherryDeferError('dataset_unsettled', { delaySeconds: 120 });
            await deps.sleep(500 * 2 ** retries);
            continue;
        }
        rows.push(...page.items);
        if (rows.length > limit) throw new CherryDeferError('dataset_limit_exceeded', { delaySeconds: 0, terminal: true });
        if (rows.length >= page.total) return rows;
    }
}

/** Starts one paid run at most once per ledger row and resumes it after an interruption. */
export async function runCherryActor(request: CherryRunRequest, deps: CherryRunDeps = defaultDeps): Promise<CherryRunResult> {
    const waitSecs = Math.floor((request.deadlineAtMs - Date.now()) / 1000) - 20;
    if (waitSecs < 20) throw new CherryDeferError('deadline', { delaySeconds: 5, countAttempt: false });
    const reservation = await deps.reserve(request);
    const deferred = DEFERRED[reservation.outcome];
    if (deferred) throw new CherryDeferError(`provider_${reservation.outcome}`, deferred);

    const client = deps.client(reservation.slot);
    const context = {
        resumeRunId: reservation.outcome === 'resume' ? reservation.runId : undefined,
        logicalProvider: 'apify', actorId: request.actorId,
        credentialSlot: reservation.slot, maxChargeUsd: Number(reservation.maxChargeUsd),
        invocationDeadlineAtMs: request.deadlineAtMs,
        recordUsage: () => undefined,
        onRunStarted: (runId: string) => deps.update(reservation.id, { status: 'started', run_id: runId }),
        onRunStartRejected: ({ statusCode }: { statusCode: number }) => deps.update(reservation.id, {
            status: 'rejected', error_code: `http_${statusCode}`, finished_at: new Date().toISOString(),
        }),
        onRunStartAmbiguous: () => deps.update(reservation.id, {
            status: 'ambiguous', error_code: 'start_unconfirmed', finished_at: new Date().toISOString(),
        }),
    } as unknown as ProviderCallContext;

    let run;
    try {
        run = await startOrResumeApifyActor(client, request.actorId, request.input, {
            logicalProvider: 'apify', credentialSlot: reservation.slot,
            ...(request.actorBuild ? { actorBuild: request.actorBuild } : {}),
            timeoutSecs: request.timeoutSecs, maxItems: request.items,
            maxTotalChargeUsd: Number(reservation.maxChargeUsd),
            executionMaxTotalChargeUsd: Math.max(request.executionMaxChargeUsd ?? 0, Number(reservation.maxChargeUsd)),
            invocationWaitLimitSecs: Math.min(240, waitSecs),
        }, context);
    } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (message.startsWith('SCRAPING_RUN_PENDING_ERROR') || message.startsWith('SCRAPING_INVOCATION_DEADLINE_ERROR')) {
            throw new CherryDeferError('provider_pending', { delaySeconds: 30, countAttempt: false });
        }
        if (message.startsWith('SCRAPING_PROVIDER_START_REJECTED_ERROR')) {
            throw new CherryDeferError('provider_rejected', { delaySeconds: 600 });
        }
        throw new CherryDeferError('provider_start_failed', { delaySeconds: 300 });
    }
    const resumable = run.status === 'READY' || run.status === 'RUNNING' || run.status === 'TIMING-OUT' || run.status === 'ABORTING';
    if (resumable) throw new CherryDeferError('provider_pending', { delaySeconds: 30, countAttempt: false });
    if (run.status !== 'SUCCEEDED' || !run.defaultDatasetId) {
        await deps.update(reservation.id, {
            status: 'failed', error_code: `run_${String(run.status).toLowerCase().slice(0, 24)}`, finished_at: new Date().toISOString(),
        });
        throw new CherryDeferError('provider_run_failed', { delaySeconds: 300 });
    }
    const rows = await readDataset(client, run.defaultDatasetId, request.items, deps);
    // Reading a finished run again must not make it look newly finished.
    if (reservation.status !== 'succeeded') await deps.update(reservation.id, {
        status: 'succeeded', items_returned: rows.length, finished_at: new Date().toISOString(),
        estimated_cost_usd: Number((rows.length * request.estimatedUsdPerItem).toFixed(6)),
    });
    return { ledgerId: reservation.id, attempt: reservation.attempt, rows };
}

/** A finished run whose data cannot be used; the next try starts a new run. */
export async function rejectCherryRun(ledgerId: string, code: string, deps: CherryRunDeps = defaultDeps): Promise<void> {
    await deps.update(ledgerId, { status: 'failed', error_code: code });
}
