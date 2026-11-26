import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';

export type ResolverAdmissionReason = 'worker_stage' | 'worker_shared' | 'global_resolver' | 'global_shared';
type ResolverAdmissionOutcome = 'contended' | 'skipped' | 'admitted_after_wait';

const observations = channel('yeosachin.standard.resolver-admission');
const resolverAdmission = new AsyncLocalStorage<{ signal: AbortSignal; waitDeadline?: number }>();
const resolverWaitMs = 5_000;

// Both the executor and physical lease allocator require the same Dev delivery.
export async function devStandardExpandedCapacityEnabled(
    policyVersion: string | undefined,
    env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
    if (policyVersion !== 'ai-stage-policy-v2.11' || env.STANDARD_SHARED_VERTEX_SLOTS !== '128'
        || env.DEV_LIVE_STANDARD_RESOLVER_MODE !== 'admitted' || env.DEV_LIVE_WORKLOAD !== 'paid'
        || env.ANALYSIS_WORKLOAD_ROLE !== 'paid' || env.K_SERVICE !== 'dev-live-paid'
        || env.DEV_LIVE_ANALYSIS_MODE !== 'owner_start' || env.DEV_LIVE_ANALYSIS_ARMED !== 'true') return false;
    const { hasDevStandardOwnerDelivery } = await import('@/lib/services/dev-ui/live-budget');
    return hasDevStandardOwnerDelivery();
}

// The paid Standard executor opens this scope only for its opted-in resolver.
// It ends with that operation. Concurrent required stages keep their original limits.
export function withStandardResolverAdmission<T>(signal: AbortSignal, call: () => Promise<T>): Promise<T> {
    return resolverAdmission.run({ signal }, call);
}

export function currentStandardResolverAdmission() {
    return resolverAdmission.getStore();
}

export function remainingResolverAdmissionWait(): number {
    const active = resolverAdmission.getStore();
    if (!active) return 0;
    active.signal.throwIfAborted();
    const now = performance.now();
    active.waitDeadline ??= now + resolverWaitMs;
    return Math.max(0, Math.ceil(active.waitDeadline - now));
}

export function observeResolverAdmission(reason: ResolverAdmissionReason, outcome: ResolverAdmissionOutcome) {
    if (observations.hasSubscribers) observations.publish({ reason, outcome });
}
