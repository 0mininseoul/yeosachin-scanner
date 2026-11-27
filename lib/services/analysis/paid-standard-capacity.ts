import { isPaidWorkerService } from '@/lib/services/analysis/paid-worker-service';
import { AsyncLocalStorage } from 'node:async_hooks';
import { VertexDispatchAuthorizationError } from '@/lib/services/ai/vertex-dispatch-window';

export type PaidStandardCapacityJob = Readonly<{
    requestId: string;
    jobKey: string;
    claimToken: string;
    inputHash?: string;
    handlerDeadlineAtMs?: number;
}>;
type Verify = (job: PaidStandardCapacityJob) => Promise<boolean>;
type Environment = Readonly<Record<string, string | undefined>>;

type Delivery = PaidStandardCapacityJob & { verify: Verify; approval?: Promise<boolean>; featureOptIn: boolean };
const delivery = new AsyncLocalStorage<Delivery>();

function select(active: Delivery): Promise<boolean> {
    active.approval ??= active.verify(active).catch(error => {
        if (error instanceof VertexDispatchAuthorizationError) throw error;
        // Routing is read-only. A missing receipt may be retried, never downgraded.
        throw new VertexDispatchAuthorizationError('db_contention');
    });
    return active.approval;
}

function productionWorkerEnabled(env: Environment) {
    return env.NODE_ENV === 'production' && isPaidWorkerService(env)
        && env.ANALYSIS_WORKLOAD_ROLE === 'paid' && env.PAID_STANDARD_VERTEX_CAPACITY_MODE === 'expanded128'
        && env.ANALYSIS_PROVIDER_ADMISSION_ENABLED === 'true'
        && !env.DEV_LIVE_WORKLOAD && !env.CLOUD_RUN_JOB;
}

export function withPaidStandardCapacityJob<T>(
    job: PaidStandardCapacityJob,
    verify: Verify,
    run: () => T,
    env: Environment = process.env,
): T {
    if (!productionWorkerEnabled(env)) return run();
    return delivery.run({ ...job, verify, featureOptIn: env.PAID_STANDARD_PROCESS_FEATURE_SLOTS === '4' }, run);
}

/** A positive cache lives for one claimed handler. The physical allocator rechecks against PostgreSQL per grant. */
export async function paidStandardExpandedCapacityEnabled(
    policyVersion: string | undefined,
    job: PaidStandardCapacityJob,
): Promise<boolean> {
    if (policyVersion !== 'ai-stage-policy-v2.11') return false;
    const active = delivery.getStore();
    if (!active || active.requestId !== job.requestId || active.jobKey !== job.jobKey
        || active.claimToken !== job.claimToken) return false;
    return select(active);
}

/** Only this worker revision participates in the mixed-version feature limiter. */
export function paidStandardFeaturePoolEnabled(): boolean {
    return process.env.PAID_STANDARD_PROCESS_FEATURE_SLOTS === '4' && productionWorkerEnabled(process.env);
}

/** The DB verifier binds the signed order, owner, profile job, v2.11 snapshot and live claim. */
export async function paidStandardFourthFeatureEnabled(
    policyVersion: string | undefined, requestId: string | undefined, job?: PaidStandardCapacityJob,
): Promise<boolean> {
    const active = delivery.getStore();
    if (!active?.featureOptIn || policyVersion !== 'ai-stage-policy-v2.11' || active.requestId !== requestId
        || !/^track:profile-ai:batch:\d+$/.test(active.jobKey)) return false;
    if (job && (active.jobKey !== job.jobKey || active.claimToken !== job.claimToken)) return false;
    return select(active);
}

export function paidStandardFeatureAdmissionDeadline(): number | undefined {
    return delivery.getStore()?.handlerDeadlineAtMs;
}

export function capturePaidStandardDispatchSelection(): () => Promise<boolean> {
    const active = delivery.getStore();
    return async () => active ? select(active) : false;
}

/** A refused reservation can wait only when this exact request has confirmed paid routing. */
export async function paidStandardBudgetWaitEnabled(runId: string): Promise<boolean> {
    const active = delivery.getStore();
    if (!active || active.requestId !== runId) return false;
    try {
        return await select(active);
    } catch {
        return false;
    }
}

/** The final attempt transaction binds the same worker claim and input that passed the wire fence. */
export async function paidStandardReservationClaim(job: PaidStandardCapacityJob): Promise<{ inputHash: string } | null> {
    const active = delivery.getStore();
    if (!active || !await select(active)) return null;
    if (active.requestId !== job.requestId || active.jobKey !== job.jobKey || active.claimToken !== job.claimToken
        || !active.inputHash || !/^[a-f0-9]{64}$/.test(active.inputHash)) {
        throw new Error('ANALYSIS_V2_DAG_STATE_FENCE_MISMATCH');
    }
    return { inputHash: active.inputHash };
}
