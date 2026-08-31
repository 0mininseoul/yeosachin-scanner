/**
 * Deterministic, provider-free proof harness for the split capacity boundary.
 *
 * This harness uses the production Cloud Tasks payload builders and the
 * production provider-admission checkpoint/Gemini lease wrappers, while all
 * transport, database, Apify, and Gemini calls are local deterministic fakes.
 * It is executable only in an explicit local/test mode and can never select a
 * paid provider client or an external network endpoint.
 */
import { randomUUID } from 'node:crypto';
import {
    enqueuePreflightTask,
    type PreflightTasksConfig,
} from '@/lib/services/analysis/preflight-tasks';
import {
    enqueueAnalysisV2FreshAdmissionTask,
    type AnalysisV2TasksConfig,
} from '@/lib/services/analysis/v2-tasks';
import type {
    ProviderRunCheckpoint,
    ProviderRunStartRejected,
} from '@/lib/services/instagram/providers/types';
import type { ApifyCredentialSlot } from '@/lib/services/instagram/providers/types';
import {
    AnalysisProviderAdmissionCapacityPendingError,
    AnalysisProviderAdmissionFenceError,
    AnalysisProviderAdmissionIdentityConflictError,
    analysisProviderAdmissionId,
    type AnalysisProviderAdmissionInput,
    type AnalysisProviderAdmissionLease,
    type AnalysisProviderAdmissionRecoveryPage,
    type AnalysisProviderAdmissionStore,
} from '@/lib/services/analysis/provider-admission-store';
import { withAnalysisProviderAdmissionCheckpoint } from '@/lib/services/analysis/provider-admission-checkpoint';
import {
    AnalysisV2AiCapacityPendingError,
    createAnalysisV2GeminiLeaseStore,
} from '@/lib/services/analysis/v2-gemini-lease-store';

export interface CapacityExtensionLoadOptions {
    /** Explicitly opts into the provider-free load harness. */
    fakeProviderMode?: 'load';
    preflightRequests?: number;
    paidRequests?: number;
    preflightConcurrency?: number;
    paidConcurrency?: number;
    geminiConcurrency?: number;
    duplicateDeliveryEvery?: number;
    expireEvery?: number;
    capacityStage?: 'initial' | 'expanded';
}

export interface CapacityExtensionLoadReport {
    schemaVersion: 'automatic-analysis-capacity-load-v3';
    capacityStage: 'initial' | 'expanded';
    workerPreflightConcurrency: number;
    workerPaidConcurrency: number;
    accepted: number;
    terminalized: number;
    lost: number;
    duplicateTerminalEffects: number;
    duplicateDeliveries: number;
    capacityPending: number;
    capacityPendingByRole: { preflight: number; paid: number; gemini: number };
    relationshipBudgetMaxActive: number;
    relationshipProviderMaxActive: number;
    relationshipCapacityPendingCount: number;
    relationshipCapacityPending: boolean;
    recoveredLeases: number;
    fenceRotations: number;
    /** Number of successful durable lease renewals observed by the fake DB. */
    renewedLeases: number;
    deliveries: number;
    maxPreflightProviderActive: number;
    maxPaidProviderActive: number;
    maxGeminiActive: number;
    providerStarts: number;
    geminiStarts: number;
    maxDatabaseInFlight: number;
    databaseContentionEvents: number;
    databaseContentionBounded: boolean;
    preflightQueueDrained: boolean;
    paidQueueDrained: boolean;
    eventualDrain: boolean;
    taskWrappers: true;
    providerAdmissionWrappers: true;
    fakeProvider: true;
}

type WorkloadRole = 'preflight' | 'paid';
type QueueItem = {
    role: WorkloadRole;
    id: string;
    requestId: string;
    jobKey: string;
    operationKey: string;
    claimToken: string;
    credentialSlot: ApifyCredentialSlot;
    attempt: number;
    expireMarker?: boolean;
};

const DEFAULTS = Object.freeze({
    preflightRequests: 400,
    paidRequests: 200,
    preflightConcurrency: 32,
    paidConcurrency: 8,
    geminiConcurrency: 8,
    duplicateDeliveryEvery: 17,
    expireEvery: 19,
    capacityStage: 'initial' as const,
});

function boundedInteger(value: number, key: string, minimum: number, maximum: number): number {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(`CAPACITY_LOAD_CONFIG_ERROR:${key}`);
    }
    return value;
}

function validateOptions(options: Required<CapacityExtensionLoadOptions>): void {
    boundedInteger(options.preflightRequests, 'preflightRequests', 1, 10_000);
    boundedInteger(options.paidRequests, 'paidRequests', 1, 10_000);
    const preflightMaximum = options.capacityStage === 'expanded' ? 64 : 32;
    const paidMaximum = options.capacityStage === 'expanded' ? 64 : 8;
    boundedInteger(options.preflightConcurrency, 'preflightConcurrency', 1, preflightMaximum);
    boundedInteger(options.paidConcurrency, 'paidConcurrency', 1, paidMaximum);
    boundedInteger(options.geminiConcurrency, 'geminiConcurrency', 1, 8);
    boundedInteger(options.duplicateDeliveryEvery, 'duplicateDeliveryEvery', 0, 10_000);
    boundedInteger(options.expireEvery, 'expireEvery', 0, 10_000);
    if (options.capacityStage === 'expanded' && options.paidConcurrency < 16) {
        throw new Error('CAPACITY_LOAD_CONFIG_ERROR:paid expansion requires >=16 workers');
    }
}

/**
 * The executable load command is release evidence, so it must reject a report
 * that merely drained without observing every approved boundary.  Keep this
 * assertion in the harness (in addition to the Vitest assertions) so a direct
 * `npm run load:analysis-capacity` invocation cannot print a weak report as a
 * successful proof.
 */
export function assertCapacityExtensionLoadReport(
    report: CapacityExtensionLoadReport,
): void {
    const fail = (field: string): never => {
        throw new Error(`CAPACITY_LOAD_ASSERTION_FAILED:${field}`);
    };
    if (report.accepted !== 600) fail('accepted');
    if (report.terminalized !== 600) fail('terminalized');
    if (report.lost !== 0) fail('lost');
    if (report.duplicateTerminalEffects !== 0) fail('duplicateTerminalEffects');
    if (report.capacityStage === 'initial') {
        if (report.workerPreflightConcurrency !== 32) fail('workerPreflightConcurrency');
        if (report.workerPaidConcurrency !== 8) fail('workerPaidConcurrency');
    } else {
        if (report.workerPreflightConcurrency !== 64) fail('workerPreflightConcurrency');
        if (report.workerPaidConcurrency !== 16) fail('workerPaidConcurrency');
    }
    if (report.maxPreflightProviderActive !== 32) fail('maxPreflightProviderActive');
    if (report.maxPaidProviderActive !== 8) fail('maxPaidProviderActive');
    if (report.maxGeminiActive !== 8) fail('maxGeminiActive');
    if (report.capacityPending <= 0) fail('capacityPending');
    for (const role of ['preflight', 'paid', 'gemini'] as const) {
        if (report.capacityPendingByRole[role] <= 0) {
            fail(`capacityPendingByRole.${role}`);
        }
    }
    if (report.recoveredLeases <= 0) fail('recoveredLeases');
    if (report.fenceRotations <= 0) fail('fenceRotations');
    if (report.relationshipBudgetMaxActive !== 4) fail('relationshipBudgetMaxActive');
    if (report.relationshipProviderMaxActive !== 4) fail('relationshipProviderMaxActive');
    if (report.relationshipCapacityPendingCount <= 0) {
        fail('relationshipCapacityPendingCount');
    }
    if (!report.relationshipCapacityPending) fail('relationshipCapacityPending');
    if (!report.preflightQueueDrained) fail('preflightQueueDrained');
    if (!report.paidQueueDrained) fail('paidQueueDrained');
    if (!report.eventualDrain) fail('eventualDrain');
    if (!report.taskWrappers) fail('taskWrappers');
    if (!report.providerAdmissionWrappers) fail('providerAdmissionWrappers');
    if (!report.fakeProvider) fail('fakeProvider');
}

function deterministicUuid(role: WorkloadRole, index: number): string {
    const prefix = role === 'preflight' ? '1' : '2';
    return `${prefix}${'0'.repeat(7)}-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function deterministicClaim(role: WorkloadRole, index: number): string {
    const prefix = role === 'preflight' ? '3' : '4';
    return `${prefix}${'0'.repeat(7)}-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function deterministicOperation(index: number): string {
    return `target-profile-fresh-admission:g${index}`;
}

function taskConfig(role: WorkloadRole): PreflightTasksConfig | AnalysisV2TasksConfig {
    const paid = role === 'paid';
    const projectId = 'example-project';
    return {
        workloadRole: role,
        project: projectId,
        location: 'asia-northeast3',
        queue: paid ? 'analysis-v2-pipeline' : 'analysis-preflight',
        targetUrl: paid
            ? 'https://paid-worker.example/api/analysis/v2/worker'
            : 'https://preflight-worker.example/api/analysis/preflight/worker',
        oidcAudience: paid
            ? 'https://paid-worker.example'
            : 'https://preflight-worker.example',
        serviceAccountEmail: paid
            ? 'paid-task@example-project.iam.gserviceaccount.com'
            : 'preflight-task@example-project.iam.gserviceaccount.com',
        callerAuth: { mode: 'adc', projectId },
    } as PreflightTasksConfig | AnalysisV2TasksConfig;
}

class DeterministicTaskClient {
    readonly tasks = new Map<string, Record<string, unknown>>();

    queuePath(project: string, location: string, queue: string): string {
        return `projects/${project}/locations/${location}/queues/${queue}`;
    }

    taskPath(project: string, location: string, queue: string, task: string): string {
        return `${this.queuePath(project, location, queue)}/tasks/${task}`;
    }

    async createTask(request: Record<string, unknown>): Promise<void> {
        const task = request.task as { name?: string } | undefined;
        const name = task?.name;
        if (!name) throw new Error('CAPACITY_LOAD_TASK_NAME_MISSING');
        if (this.tasks.has(name)) {
            const error = new Error('ALREADY_EXISTS');
            Object.assign(error, { code: 6 });
            throw error;
        }
        this.tasks.set(name, request);
    }
}

interface LoadDbStats {
    databaseInFlight: number;
    maxDatabaseInFlight: number;
    databaseContentionEvents: number;
}

type StoredAdmission = AnalysisProviderAdmissionLease & {
    state: 'leased' | 'released' | 'recovery_required';
    releaseReason?: 'terminal' | 'prestart_rejected';
};

/** In-memory implementation of the production store contract for fake-only load runs. */
class DeterministicAdmissionStore implements AnalysisProviderAdmissionStore {
    private readonly leases = new Map<string, StoredAdmission>();
    private readonly providerRuns = new Map<string, 'running' | 'succeeded'>();
    private readonly geminiRuns = new Map<string, 'running' | 'succeeded'>();
    private readonly maxActiveByBudget = new Map<string, number>();
    private dbTail: Promise<void> = Promise.resolve();
    private dbQueued = 0;
    recoveryCount = 0;
    fenceRotations = 0;
    renewedLeases = 0;
    capacityPending = 0;
    readonly capacityPendingByRole = { preflight: 0, paid: 0, gemini: 0 };

    constructor(private readonly stats: LoadDbStats) {}

    private async db<T>(operation: () => T): Promise<T> {
        // Model one serializable database transaction queue, rather than using
        // a local permit pool that could masquerade as provider capacity.  The
        // queue tracks real transaction contention while the operation itself
        // remains the same atomic claim/ledger transition used by production.
        const predecessor = this.dbTail;
        let release!: () => void;
        this.dbTail = new Promise<void>(resolve => { release = resolve; });
        const queued = this.dbQueued > 0;
        this.dbQueued += 1;
        if (queued) this.stats.databaseContentionEvents += 1;
        await predecessor;
        this.dbQueued -= 1;
        this.stats.databaseInFlight += 1;
        this.stats.maxDatabaseInFlight = Math.max(
            this.stats.maxDatabaseInFlight,
            this.stats.databaseInFlight,
        );
        try {
            return operation();
        } finally {
            this.stats.databaseInFlight -= 1;
            release();
        }
    }

    private maxActive(input: AnalysisProviderAdmissionInput): number {
        if (input.logicalProvider === 'gemini') return 8;
        if (input.budgetKey.endsWith(':relationship')) return 4;
        return input.workloadRole === 'preflight' ? 32 : 8;
    }

    private activeBudget(input: AnalysisProviderAdmissionInput): number {
        return [...this.leases.values()].filter(lease => (
            lease.state !== 'released'
            && lease.budgetKey === input.budgetKey
        )).length;
    }

    maxObservedBudget(budgetKey: string): number {
        return this.maxActiveByBudget.get(budgetKey) ?? 0;
    }

    private recordBudgetActive(input: AnalysisProviderAdmissionInput): void {
        const active = this.activeBudget(input);
        this.maxActiveByBudget.set(
            input.budgetKey,
            Math.max(this.maxObservedBudget(input.budgetKey), active),
        );
    }

    private activeGlobal(input: AnalysisProviderAdmissionInput): number {
        return [...this.leases.values()].filter(lease => (
            lease.state !== 'released'
            && lease.workloadRole === input.workloadRole
            && lease.logicalProvider === input.logicalProvider
        )).length;
    }

    async acquire(input: AnalysisProviderAdmissionInput): Promise<AnalysisProviderAdmissionLease> {
        return this.db(() => {
            const id = analysisProviderAdmissionId(input);
            const existing = this.leases.get(id);
            if (existing) {
                if (existing.state === 'leased') {
                    if (existing.claimToken !== input.claimToken
                        || existing.jobClaimToken !== input.jobClaimToken) {
                        throw new AnalysisProviderAdmissionIdentityConflictError();
                    }
                    return Object.freeze({ ...existing, outcome: 'already_acquired' as const });
                }
                if (existing.state === 'recovery_required') {
                    throw new AnalysisProviderAdmissionCapacityPendingError();
                }
                if (existing.releaseReason !== 'prestart_rejected') {
                    throw new AnalysisProviderAdmissionIdentityConflictError();
                }
                const reacquired = Object.freeze({
                    ...existing,
                    ...input,
                    outcome: 'acquired' as const,
                    leaseToken: randomUUID(),
                    fence: existing.fence + 1,
                    expiresAt: new Date(Date.now() + input.leaseSeconds * 1_000).toISOString(),
                    activeCount: this.activeGlobal(input) + 1,
                    maxActive: this.maxActive(input),
                    state: 'leased' as const,
                    releaseReason: undefined,
                });
                this.leases.set(id, reacquired);
                this.recordBudgetActive(input);
                this.fenceRotations += 1;
                return reacquired;
            }
            const maxActive = this.maxActive(input);
            const globalMaxActive = input.logicalProvider === 'gemini'
                ? 8
                : input.workloadRole === 'preflight' ? 32 : 8;
            const activeCount = this.activeGlobal(input);
            const budgetActiveCount = this.activeBudget(input);
            if (activeCount >= globalMaxActive || budgetActiveCount >= maxActive) {
                this.capacityPending += 1;
                this.capacityPendingByRole[input.logicalProvider === 'gemini'
                    ? 'gemini'
                    : input.workloadRole] += 1;
                throw new AnalysisProviderAdmissionCapacityPendingError();
            }
            const created = Object.freeze({
                ...input,
                outcome: 'acquired' as const,
                admissionId: id,
                leaseToken: randomUUID(),
                fence: 1,
                expiresAt: new Date(Date.now() + input.leaseSeconds * 1_000).toISOString(),
                activeCount: activeCount + 1,
                maxActive,
                state: 'leased' as const,
            });
            this.leases.set(id, created);
            this.recordBudgetActive(input);
            return created;
        });
    }

    async renew(lease: AnalysisProviderAdmissionLease): Promise<AnalysisProviderAdmissionLease> {
        return this.db(() => {
            const current = this.leases.get(lease.admissionId);
            if (!current || current.state !== 'leased'
                || current.leaseToken !== lease.leaseToken
                || current.fence !== lease.fence) {
                throw new Error('ANALYSIS_PROVIDER_ADMISSION_FENCE_MISMATCH');
            }
            const renewed = Object.freeze({
                ...current,
                expiresAt: new Date(Date.now() + lease.leaseSeconds * 1_000).toISOString(),
            });
            this.leases.set(lease.admissionId, renewed);
            this.renewedLeases += 1;
            return renewed;
        });
    }

    async release(
        lease: AnalysisProviderAdmissionLease,
        reason: 'terminal' | 'prestart_rejected' = 'terminal',
    ): Promise<void> {
        await this.db(() => {
            const current = this.leases.get(lease.admissionId);
            if (!current) {
                throw new Error('ANALYSIS_PROVIDER_ADMISSION_FENCE_MISMATCH');
            }
            // The SQL release RPC is idempotent after a response-loss retry.  The
            // exact old token/fence may observe the already released row; only a
            // changed fence/token is a real ownership conflict.
            if (current.state === 'released'
                && current.leaseToken === lease.leaseToken
                && current.fence === lease.fence) return;
            if (current.state !== 'leased'
                || current.leaseToken !== lease.leaseToken
                || current.fence !== lease.fence) {
                throw new Error('ANALYSIS_PROVIDER_ADMISSION_FENCE_MISMATCH');
            }
            if (Date.parse(current.expiresAt) <= Date.now()) {
                throw new AnalysisProviderAdmissionFenceError();
            }
            this.leases.set(lease.admissionId, Object.freeze({
                ...current,
                state: 'released' as const,
                releaseReason: reason,
            }));
        });
    }

    async recoverExpired(input: {
        admissionId: string;
        recoveryToken: string;
    }): Promise<boolean> {
        return this.db(() => {
            const current = this.leases.get(input.admissionId);
            if (!current || current.state === 'released') return false;
            if (current.state === 'recovery_required') return true;
            if (Date.parse(current.expiresAt) > Date.now()) return false;
            const recovered = Object.freeze({
                ...current,
                state: 'recovery_required' as const,
                leaseToken: input.recoveryToken,
                fence: current.fence + 1,
            });
            this.leases.set(input.admissionId, recovered);
            this.recoveryCount += 1;
            this.fenceRotations += 1;
            return true;
        });
    }

    async resolve(input: { admissionId: string; resolutionToken: string }): Promise<boolean> {
        return this.db(() => {
            const current = this.leases.get(input.admissionId);
            if (!current || current.state !== 'recovery_required') return false;
            this.leases.set(input.admissionId, Object.freeze({
                ...current,
                state: 'released' as const,
                // This harness only resolves intentionally expired pre-start
                // admissions (no provider ledger was started), so the durable
                // identity is safely replayable as prestart_rejected.
                releaseReason: 'prestart_rejected' as const,
            }));
            return true;
        });
    }

    async listExpired(): Promise<AnalysisProviderAdmissionRecoveryPage> {
        return this.db(() => ({
            candidates: [...this.leases.values()]
                .filter(lease => lease.state === 'leased' && Date.parse(lease.expiresAt) <= Date.now())
                .map(lease => ({
                    admissionId: lease.admissionId,
                    fence: lease.fence,
                    expiresAt: lease.expiresAt,
                })),
            hasMore: false,
        }));
    }

    expire(item: Pick<QueueItem, 'requestId' | 'jobKey' | 'operationKey' | 'credentialSlot' | 'role' | 'claimToken'>): void {
        const input = {
            workloadRole: item.role,
            logicalProvider: 'apify' as const,
            credentialSlot: item.credentialSlot,
            budgetKey: item.role === 'preflight'
                ? `preflight:apify:${item.credentialSlot}`
                : `paid:apify:${item.credentialSlot}${item.operationKey.startsWith('relationship-') ? ':relationship' : ''}`,
            requestId: item.requestId,
            jobKey: item.jobKey,
            operationKey: item.operationKey,
            claimToken: item.claimToken ?? '',
            jobClaimToken: item.claimToken ?? '',
            leaseSeconds: 120,
        } as AnalysisProviderAdmissionInput;
        const id = analysisProviderAdmissionId(input);
        const lease = this.leases.get(id);
        if (!lease) throw new Error('CAPACITY_LOAD_EXPIRY_ADMISSION_MISSING');
        this.leases.set(id, Object.freeze({
            ...lease,
            expiresAt: new Date(Date.now() - 1_000).toISOString(),
        }));
    }

    providerStatus(item: Pick<QueueItem, 'id'>): 'running' | 'succeeded' | null {
        return this.providerRuns.get(item.id) ?? null;
    }

    claimProviderStart(item: Pick<QueueItem, 'id'>): boolean {
        const current = this.providerRuns.get(item.id);
        if (current) return false;
        this.providerRuns.set(item.id, 'running');
        return true;
    }

    clearProviderStart(item: Pick<QueueItem, 'id'>): void {
        if (this.providerRuns.get(item.id) === 'running') this.providerRuns.delete(item.id);
    }

    markProviderSucceeded(item: Pick<QueueItem, 'id'>): void {
        this.providerRuns.set(item.id, 'succeeded');
    }

    geminiStatus(item: Pick<QueueItem, 'id'>): 'running' | 'succeeded' | null {
        return this.geminiRuns.get(item.id) ?? null;
    }

    claimGeminiStart(item: Pick<QueueItem, 'id'>): boolean {
        const current = this.geminiRuns.get(item.id);
        if (current) return false;
        this.geminiRuns.set(item.id, 'running');
        return true;
    }

    clearGeminiStart(item: Pick<QueueItem, 'id'>): void {
        if (this.geminiRuns.get(item.id) === 'running') this.geminiRuns.delete(item.id);
    }

    markGeminiSucceeded(item: Pick<QueueItem, 'id'>): void {
        this.geminiRuns.set(item.id, 'succeeded');
    }
}

class DeterministicFakeProviders {
    preflightActive = 0;
    paidActive = 0;
    geminiActive = 0;
    maxPreflightActive = 0;
    maxPaidActive = 0;
    maxGeminiActive = 0;
    providerStarts = 0;
    geminiStarts = 0;
    private readonly barrierReleased = { preflight: false, paid: false, gemini: false };
    private readonly barrierReached = new Map<'preflight' | 'paid' | 'gemini', () => void>();
    private readonly barrierWaiters = new Map<'preflight' | 'paid' | 'gemini', Array<() => void>>();

    constructor(
        private readonly preflightBarrierTarget: number,
        private readonly paidBarrierTarget: number,
        private readonly geminiBarrierTarget: number,
    ) {
        this.barrierWaiters.set('preflight', []);
        this.barrierWaiters.set('paid', []);
        this.barrierWaiters.set('gemini', []);
    }

    private activeFor(role: 'preflight' | 'paid' | 'gemini'): number {
        if (role === 'preflight') return this.preflightActive;
        if (role === 'paid') return this.paidActive;
        return this.geminiActive;
    }

    private targetFor(role: 'preflight' | 'paid' | 'gemini'): number {
        if (role === 'preflight') return this.preflightBarrierTarget;
        if (role === 'paid') return this.paidBarrierTarget;
        return this.geminiBarrierTarget;
    }

    private async firstWaveBarrier(role: 'preflight' | 'paid' | 'gemini'): Promise<void> {
        if (this.barrierReleased[role]) return;
        await new Promise<void>(resolve => {
            this.barrierWaiters.get(role)?.push(resolve);
        });
    }

    waitUntilSaturated(role: 'preflight' | 'paid' | 'gemini'): Promise<void> {
        if (this.activeFor(role) >= this.targetFor(role)) return Promise.resolve();
        return new Promise<void>(resolve => {
            this.barrierReached.set(role, resolve);
        });
    }

    releaseSaturation(role: 'preflight' | 'paid' | 'gemini'): void {
        this.barrierReleased[role] = true;
        for (const resolve of this.barrierWaiters.get(role) ?? []) resolve();
        this.barrierWaiters.set(role, []);
    }

    private signalSaturated(role: 'preflight' | 'paid' | 'gemini'): void {
        if (this.activeFor(role) < this.targetFor(role)) return;
        this.barrierReached.get(role)?.();
        this.barrierReached.delete(role);
    }

    async apify(role: WorkloadRole): Promise<void> {
        this.providerStarts += 1;
        if (role === 'preflight') {
            this.preflightActive += 1;
            this.maxPreflightActive = Math.max(this.maxPreflightActive, this.preflightActive);
        } else {
            this.paidActive += 1;
            this.maxPaidActive = Math.max(this.maxPaidActive, this.paidActive);
        }
        const barrierRole = role;
        this.signalSaturated(barrierRole);
        await this.firstWaveBarrier(barrierRole);
        if (role === 'preflight') this.preflightActive -= 1;
        else this.paidActive -= 1;
    }

    async gemini(): Promise<void> {
        this.geminiStarts += 1;
        this.geminiActive += 1;
        this.maxGeminiActive = Math.max(this.maxGeminiActive, this.geminiActive);
        this.signalSaturated('gemini');
        await this.firstWaveBarrier('gemini');
        this.geminiActive -= 1;
    }
}

function checkpointFor(
    item: QueueItem,
    terminal: Set<string>,
    terminalEffectCalls: Map<string, number>,
): ProviderRunCheckpoint {
    const actorId = 'apify/instagram-profile-scraper';
    return {
        logicalProvider: 'apify',
        actorId,
        credentialSlot: item.credentialSlot,
        maxChargeUsd: 0.25,
        // Admission acquire is the authoritative serialized database fence in
        // this fake.  The provider-run reservation itself is represented by
        // the durable providerRuns map below and does not add an unbounded
        // local counter.
        onBeforeRunStart: async () => undefined,
        onRunStartRejected: async () => undefined,
        onRunStartAmbiguous: async () => undefined,
        onCostRunStarted: async () => undefined,
        onCostRunFinished: async () => {
            if (item.role !== 'preflight') return;
            const calls = (terminalEffectCalls.get(item.id) ?? 0) + 1;
            terminalEffectCalls.set(item.id, calls);
            // A paid analysis is not terminal until its subsequent Gemini
            // stage commits.  Preflight has only the Apify stage.
            if (calls === 1) terminal.add(item.id);
        },
    };
}

async function runWrappedProvider(
    item: QueueItem,
    terminal: Set<string>,
    terminalEffectCalls: Map<string, number>,
    providers: DeterministicFakeProviders,
    store: DeterministicAdmissionStore,
    stats: LoadDbStats,
    env: Record<string, string | undefined>,
): Promise<'completed' | 'adopted' | 'rejected'> {
    const providerStatus = store.providerStatus(item);
    if (providerStatus === 'succeeded') return 'adopted';
    const checkpoint = checkpointFor(item, terminal, terminalEffectCalls);
    const providerIdentity = {
        logicalProvider: 'apify' as const,
        actorId: checkpoint.actorId!,
        credentialSlot: checkpoint.credentialSlot!,
        maxChargeUsd: checkpoint.maxChargeUsd!,
    };
    const wrapped = await Promise.resolve(withAnalysisProviderAdmissionCheckpoint({
        checkpoint,
        storedStatus: providerStatus === 'running' ? 'running' : null,
        workloadRole: item.role,
        requestId: item.requestId,
        jobKey: item.jobKey,
        operationKey: item.operationKey,
        claimToken: item.claimToken,
        env,
        store,
    }));
    await wrapped.onBeforeRunStart?.(providerIdentity);
    if (providerStatus === 'running') return 'adopted';
    if (item.attempt === 0 && item.expireMarker) {
        const rejected: ProviderRunStartRejected = {
            ...providerIdentity,
            statusCode: 503,
            errorType: 'synthetic_expiry',
        };
        // Expire the already acquired durable admission before invoking the
        // normal pre-start rejection path.  The checkpoint must take the
        // production recoverExpired -> resolve route rather than using a
        // synthetic counter.
        store.expire(item);
        store.clearProviderStart(item);
        await wrapped.onRunStartRejected?.(rejected);
        return 'rejected';
    }
    if (!store.claimProviderStart(item)) return 'adopted';
    await providers.apify(item.role);
    await wrapped.onCostRunFinished?.({
        logicalProvider: 'apify',
        actorId: checkpoint.actorId!,
        credentialSlot: checkpoint.credentialSlot!,
        maxChargeUsd: checkpoint.maxChargeUsd!,
        runId: `Run${item.id.replace(/[^A-Za-z0-9]/g, '').slice(-12).padStart(8, 'A')}`,
        status: 'succeeded',
        usageTotalUsd: 0.01,
    });
    store.markProviderSucceeded(item);
    return 'completed';
}

/** Runs the approved synthetic burst with actual task/admission/provider wrappers. */
export async function runCapacityExtensionLoad(
    rawOptions: CapacityExtensionLoadOptions = {},
): Promise<CapacityExtensionLoadReport> {
    const fakeProviderMode = rawOptions.fakeProviderMode
        ?? process.env.ANALYSIS_FAKE_PROVIDER_MODE;
    if (fakeProviderMode !== 'load') {
        throw new Error('CAPACITY_LOAD_FAKE_MODE_REQUIRED');
    }
    if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production') {
        throw new Error('CAPACITY_LOAD_FAKE_MODE_FORBIDDEN');
    }
    const options = {
        ...DEFAULTS,
        ...rawOptions,
    } as Required<CapacityExtensionLoadOptions>;
    validateOptions(options);

    const queues: Record<WorkloadRole, QueueItem[]> = { preflight: [], paid: [] };
    const terminal = new Set<string>();
    const terminalEffectCalls = new Map<string, number>();
    const expiredOnce = new Set<string>();
    const stats: LoadDbStats = {
        databaseInFlight: 0,
        maxDatabaseInFlight: 0,
        databaseContentionEvents: 0,
    };
    let duplicateDeliveries = 0;
    let deliveries = 0;

    const taskClients: Record<WorkloadRole, DeterministicTaskClient> = {
        preflight: new DeterministicTaskClient(),
        paid: new DeterministicTaskClient(),
    };
    const taskConfigs = {
        preflight: taskConfig('preflight') as PreflightTasksConfig,
        paid: taskConfig('paid') as AnalysisV2TasksConfig,
    };
    const enqueueBurst = async (role: WorkloadRole, count: number): Promise<void> => {
        const duplicateItems: QueueItem[] = [];
        for (let index = 1; index <= count; index += 1) {
            const requestId = deterministicUuid(role, index);
            const claimToken = deterministicClaim(role, index);
            const operationKey = role === 'preflight'
                ? 'target-profile-fallback'
                : deterministicOperation(index);
            const jobKey = role === 'preflight'
                ? 'preflight:provider'
                : 'paid:target-profile';
            const credentialSlot = role === 'preflight'
                ? (['primary', 'quinary', 'senary'] as const)[(index - 1) % 3]
                : 'secondary';
            const item: QueueItem = {
                role,
                id: `${role}:${index}`,
                requestId,
                jobKey,
                operationKey,
                claimToken,
                credentialSlot,
                attempt: 0,
            };
            if (role === 'preflight') {
                await enqueuePreflightTask(
                    requestId,
                    1,
                    { config: taskConfigs.preflight, client: taskClients.preflight },
                );
            } else {
                await enqueueAnalysisV2FreshAdmissionTask(
                    {
                        preflightId: requestId,
                        generation: 1,
                        dispatchGeneration: 1,
                        dispatchToken: deterministicClaim('paid', index + 10_000),
                        workloadRole: 'paid',
                    },
                    { config: taskConfigs.paid, client: taskClients.paid },
                );
            }
            queues[role].push(item);
            if (options.duplicateDeliveryEvery > 0
                && index % options.duplicateDeliveryEvery === 0) {
                // The deterministic client above proves Cloud Tasks idempotent
                // naming; this second queue item models a later redelivery.
                if (role === 'preflight') {
                    await enqueuePreflightTask(
                        requestId,
                        1,
                        { config: taskConfigs.preflight, client: taskClients.preflight },
                    );
                } else {
                    await enqueueAnalysisV2FreshAdmissionTask(
                        {
                            preflightId: requestId,
                            generation: 1,
                            dispatchGeneration: 1,
                            dispatchToken: deterministicClaim('paid', index + 10_000),
                            workloadRole: 'paid',
                        },
                        { config: taskConfigs.paid, client: taskClients.paid },
                    );
                }
                // Keep the first unique provider wave contiguous so the fake
                // saturation barrier can prove the exact ceiling; duplicates
                // are appended after the accepted burst below and still race
                // the durable claim/provider ledgers when drained.
                duplicateItems.push({ ...item });
                duplicateDeliveries += 1;
            }
        }
        queues[role].push(...duplicateItems);
    };
    await enqueueBurst('preflight', options.preflightRequests);
    await enqueueBurst('paid', options.paidRequests);

    const providers = new DeterministicFakeProviders(
        Math.min(32, options.preflightConcurrency),
        Math.min(8, options.paidConcurrency),
        Math.min(8, options.geminiConcurrency),
    );
    const admission = new DeterministicAdmissionStore(stats);
    let geminiCapacityPending = 0;
    const providerEnv = {
        NODE_ENV: 'test',
        ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'true',
    };
    const geminiSlots = Array.from({ length: 8 }, (_, index) => ({
        slot: index + 1,
        fence: 0,
        claimToken: null as string | null,
        identity: null as string | null,
    }));
    const geminiStore = createAnalysisV2GeminiLeaseStore({
        rpc: async (name, params) => {
            if (name.includes('release')) {
                const slot = geminiSlots.find(candidate => candidate.slot === params.p_slot);
                if (!slot || slot.claimToken !== params.p_claim_token || slot.fence !== params.p_fence) {
                    return {
                        data: [{ released: false, lease_state: 'available', fence: slot?.fence ?? 0 }],
                        error: null,
                    };
                }
                slot.claimToken = null;
                slot.identity = null;
                return {
                    data: [{ released: true, lease_state: 'available', fence: slot.fence }],
                    error: null,
                };
            }
            const identity = [
                params.p_request_id,
                params.p_job_key,
                params.p_operation_key ?? '',
                params.p_attempt,
            ].join(':');
            const existing = geminiSlots.find(candidate => candidate.identity === identity);
            if (existing) {
                return {
                    data: [{
                        outcome: 'acquired',
                        slot: existing.slot,
                        lease_claim_token: existing.claimToken,
                        fence: existing.fence,
                        expires_at: new Date(Date.now() + 240_000).toISOString(),
                    }],
                    error: null,
                };
            }
            const available = geminiSlots.find(candidate => candidate.claimToken === null);
            if (!available) {
                return {
                    data: [{
                        outcome: 'capacity_pending',
                        slot: null,
                        lease_claim_token: null,
                        fence: null,
                        expires_at: null,
                    }],
                    error: null,
                };
            }
            available.fence += 1;
            available.claimToken = String(params.p_claim_token);
            available.identity = identity;
            return {
                data: [{
                    outcome: 'acquired',
                    slot: available.slot,
                    lease_claim_token: available.claimToken,
                    fence: available.fence,
                    expires_at: new Date(Date.now() + 240_000).toISOString(),
                }],
                error: null,
            };
        },
        nowMs: () => Date.now(),
        randomUuid: randomUUID,
        env: providerEnv,
        providerAdmissionStore: admission,
    });

    const probeApifyCapacity = async (role: WorkloadRole): Promise<void> => {
        const probeIndex = role === 'preflight' ? 900_001 : 900_002;
        const input: AnalysisProviderAdmissionInput = {
            workloadRole: role,
            logicalProvider: 'apify',
            credentialSlot: role === 'preflight' ? 'primary' : 'secondary',
            budgetKey: role === 'preflight'
                ? 'preflight:apify:primary'
                : 'paid:apify:secondary',
            requestId: deterministicUuid(role, probeIndex),
            jobKey: role === 'preflight' ? 'preflight:provider' : 'paid:target-profile',
            operationKey: role === 'preflight'
                ? 'target-profile-fallback'
                : 'target-profile-fresh-admission:g900002',
            claimToken: deterministicClaim(role, probeIndex),
            jobClaimToken: deterministicClaim(role, probeIndex),
            leaseSeconds: 120,
        };
        try {
            const lease = await admission.acquire(input);
            await admission.release(lease, 'prestart_rejected');
        } catch (error) {
            if (error instanceof AnalysisProviderAdmissionCapacityPendingError) return;
            throw error;
        }
    };

    const probeGeminiCapacity = async (): Promise<void> => {
        const probeRequestId = deterministicUuid('paid', 900_003);
        try {
            await geminiStore.acquire({
                requestId: probeRequestId,
                jobKey: 'paid:gemini-probe',
                jobClaimToken: deterministicClaim('paid', 900_003),
                attempt: 1,
                handlerDeadlineAtMs: Date.now() + 300_000,
            });
        } catch (error) {
            if (error instanceof AnalysisV2AiCapacityPendingError) {
                geminiCapacityPending += 1;
                return;
            }
            throw error;
        }
    };

    const processItem = async (item: QueueItem): Promise<void> => {
        deliveries += 1;
        if (terminal.has(item.id)) {
            return;
        }
        const ordinal = Number(item.id.split(':')[1]);
        const shouldExpire = item.attempt === 0
            && options.expireEvery > 0
            && ordinal % options.expireEvery === 0
            // Keep the initial unique saturation wave free of synthetic
            // expiry so its exact provider ceiling can be reached.
            && ordinal > 64
            && !expiredOnce.has(item.id);
        if (shouldExpire) {
            expiredOnce.add(item.id);
            // Exercise the production pre-start rejection release/reacquire path.
            let rejected: 'completed' | 'adopted' | 'rejected';
            try {
                rejected = await runWrappedProvider(
                    { ...item, expireMarker: true },
                    terminal,
                    terminalEffectCalls,
                    providers,
                    admission,
                    stats,
                    providerEnv,
                );
            } catch (error) {
                if (error instanceof AnalysisProviderAdmissionCapacityPendingError) {
                    expiredOnce.delete(item.id);
                    queues[item.role].push({ ...item });
                    return;
                }
                throw error;
            }
            if (rejected !== 'rejected') throw new Error('CAPACITY_LOAD_EXPIRY_MODEL_ERROR');
            // Cloud Tasks does not redeliver until the current attempt has
            // returned. Preserve that ordering in the deterministic queue so
            // a retry cannot steal the still-held admission fence.
            queues[item.role].push({ ...item, attempt: 1 });
            return;
        }
        let result: 'completed' | 'adopted' | 'rejected';
        try {
            result = await runWrappedProvider(
                item,
                terminal,
                terminalEffectCalls,
                providers,
                admission,
                stats,
                providerEnv,
            );
        } catch (error) {
            if (error instanceof AnalysisProviderAdmissionCapacityPendingError) {
                // Capacity wait is attempt-neutral in the durable model. Keep
                // this exact operation in the work-in-flight queue until a
                // global/slot budget becomes available.
                queues[item.role].push({ ...item, attempt: item.attempt + 1 });
                return;
            }
            throw error;
        }
        if (result === 'completed' || result === 'adopted') {
            if (item.role === 'paid') {
                // An adopted/running Apify ledger is still in flight.  Leave
                // this delivery retryable until the durable ledger reaches a
                // completed state; it must not jump into Gemini early.
                if (admission.providerStatus(item) === 'running') {
                    queues[item.role].push({ ...item, attempt: item.attempt + 1 });
                    return;
                }
                let geminiOwner = false;
                const existingGeminiStatus = admission.geminiStatus(item);
                if (existingGeminiStatus === 'succeeded') {
                    // Durable Gemini execution already completed for this
                    // operation; no provider call is repeated.
                } else {
                    let lease: Awaited<ReturnType<typeof geminiStore.acquire>>;
                    if (!admission.claimGeminiStart(item)) {
                        // Another delivery owns the durable Gemini run.  Do not
                        // acquire/replay a second slot with a fresh token.
                        return;
                    }
                    geminiOwner = true;
                    try {
                        // There is intentionally no local semaphore here.  The
                        // deterministic Gemini RPC below owns eight fenced slots;
                        // capacity_pending is a durable retry, not a process-local
                        // permit decision.
                        lease = await geminiStore.acquire({
                            requestId: item.requestId,
                            jobKey: item.jobKey,
                            jobClaimToken: item.claimToken,
                            attempt: 1,
                            // Reserve the full five-minute task contract.  A bare
                            // minimum (+225s) can be consumed by queue/admission
                            // setup before the monotonic deadline check runs.
                            handlerDeadlineAtMs: Date.now() + 300_000,
                        });
                    } catch (error) {
                        if (error instanceof AnalysisV2AiCapacityPendingError) {
                            admission.clearGeminiStart(item);
                            // Keep the same durable operation identity. This is a
                            // retry delivery and does not create a terminal effect.
                            queues[item.role].push({ ...item, attempt: item.attempt + 1 });
                            return;
                        }
                        admission.clearGeminiStart(item);
                        throw error;
                    }
                    await providers.gemini();
                    admission.markGeminiSucceeded(item);
                    await geminiStore.release(lease);
                }
                if (!geminiOwner && admission.geminiStatus(item) !== 'succeeded') {
                    return;
                }
            }
            // Paid terminalization is deliberately after both fake provider
            // stages; a Gemini failure cannot be reported as lost-free work.
            if (item.role === 'paid') {
                const terminalCalls = (terminalEffectCalls.get(item.id) ?? 0) + 1;
                terminalEffectCalls.set(item.id, terminalCalls);
                if (terminalCalls === 1) terminal.add(item.id);
            }
        }
    };

    const drain = async (role: WorkloadRole, concurrency: number): Promise<boolean> => {
        const queue = queues[role];
        let cursor = 0;
        let active = 0;
        const waiters: Array<() => void> = [];
        const wake = (): void => {
            while (waiters.length > 0) waiters.shift()?.();
        };
        const take = async (): Promise<QueueItem | null> => {
            while (cursor >= queue.length) {
                if (active === 0) return null;
                await new Promise<void>(resolve => waiters.push(resolve));
            }
            active += 1;
            return queue[cursor++];
        };
        const workers = Array.from({ length: concurrency }, async () => {
            while (true) {
                const item = await take();
                if (!item) return;
                try {
                    // Duplicate deliveries intentionally race here.  The
                    // durable admission/claim/provider ledgers decide the one
                    // owner; no local operation serializer can hide that race.
                    await processItem(item);
                } finally {
                    active -= 1;
                    wake();
                }
            }
        });
        await Promise.all(workers);
        return cursor >= queue.length && active === 0;
    };

    const preflightDrain = drain('preflight', options.preflightConcurrency);
    const paidDrain = drain('paid', options.paidConcurrency);
    // Hold the first saturated provider waves long enough to run real durable
    // admission probes.  This proves capacity_pending is observed at the
    // approved ceilings rather than merely inferred from worker counts.
    const preflightProbe = (async () => {
        await providers.waitUntilSaturated('preflight');
        try {
            await probeApifyCapacity('preflight');
        } finally {
            providers.releaseSaturation('preflight');
        }
    })();
    const paidProbe = (async () => {
        await providers.waitUntilSaturated('paid');
        try {
            await probeApifyCapacity('paid');
        } finally {
            providers.releaseSaturation('paid');
        }
    })();
    const geminiProbe = (async () => {
        await providers.waitUntilSaturated('gemini');
        try {
            await probeGeminiCapacity();
        } finally {
            providers.releaseSaturation('gemini');
        }
    })();
    await Promise.all([preflightProbe, paidProbe, geminiProbe]);
    const [preflightQueueDrained, paidQueueDrained] = await Promise.all([
        preflightDrain,
        paidDrain,
    ]);
    // Keep the ordinary relationship contract separate from the paid
    // target-profile global-8 burst: relationships use secondary and their
    // dedicated DB budget is four, even while the full-analysis budget is 8.
    const relationshipLeases: AnalysisProviderAdmissionLease[] = [];
    let relationshipCapacityPending = false;
    let relationshipCapacityPendingCount = 0;
    for (let index = 1; index <= 4; index += 1) {
        relationshipLeases.push(await admission.acquire({
            workloadRole: 'paid',
            logicalProvider: 'apify',
            credentialSlot: 'secondary',
            budgetKey: 'paid:apify:secondary:relationship',
            requestId: deterministicUuid('paid', 910_000 + index),
            jobKey: 'track:relationships:collect',
            operationKey: `relationship-followers:g${index}`,
            claimToken: deterministicClaim('paid', 910_000 + index),
            jobClaimToken: deterministicClaim('paid', 910_000 + index),
            leaseSeconds: 120,
        }));
    }
    // Exercise the same durable renew primitive used by the production
    // checkpoint wrapper.  This is deliberately performed while the exact
    // relationship lease/fence is held, before release, so the report proves
    // renewal rather than inferring it from worker lifetime.
    await admission.renew(relationshipLeases[0]);
    try {
        const unexpectedLease = await admission.acquire({
            workloadRole: 'paid',
            logicalProvider: 'apify',
            credentialSlot: 'secondary',
            budgetKey: 'paid:apify:secondary:relationship',
            requestId: deterministicUuid('paid', 910_005),
            jobKey: 'track:relationships:collect',
            operationKey: 'relationship-followers:g5',
            claimToken: deterministicClaim('paid', 910_005),
            jobClaimToken: deterministicClaim('paid', 910_005),
            leaseSeconds: 120,
        });
        await admission.release(unexpectedLease, 'prestart_rejected');
    } catch (error) {
        if (!(error instanceof AnalysisProviderAdmissionCapacityPendingError)) throw error;
        relationshipCapacityPending = true;
        relationshipCapacityPendingCount += 1;
    }
    for (const lease of relationshipLeases) {
        await admission.release(lease, 'prestart_rejected');
    }
    const accepted = options.preflightRequests + options.paidRequests;
    const duplicateTerminalEffects = [...terminalEffectCalls.values()]
        .reduce((total, calls) => total + Math.max(0, calls - 1), 0);
    return Object.freeze({
        schemaVersion: 'automatic-analysis-capacity-load-v3',
        capacityStage: options.capacityStage,
        workerPreflightConcurrency: options.preflightConcurrency,
        workerPaidConcurrency: options.paidConcurrency,
        accepted,
        terminalized: terminal.size,
        lost: accepted - terminal.size,
        duplicateTerminalEffects,
        duplicateDeliveries,
        capacityPending: admission.capacityPending + geminiCapacityPending,
        capacityPendingByRole: {
            ...admission.capacityPendingByRole,
            gemini: admission.capacityPendingByRole.gemini + geminiCapacityPending,
        },
        relationshipBudgetMaxActive: admission.maxObservedBudget(
            'paid:apify:secondary:relationship',
        ),
        relationshipProviderMaxActive: admission.maxObservedBudget(
            'paid:apify:secondary:relationship',
        ),
        relationshipCapacityPendingCount,
        relationshipCapacityPending,
        recoveredLeases: admission.recoveryCount,
        fenceRotations: admission.fenceRotations,
        renewedLeases: admission.renewedLeases,
        deliveries,
        maxPreflightProviderActive: providers.maxPreflightActive,
        maxPaidProviderActive: providers.maxPaidActive,
        maxGeminiActive: providers.maxGeminiActive,
        providerStarts: providers.providerStarts,
        geminiStarts: providers.geminiStarts,
        maxDatabaseInFlight: stats.maxDatabaseInFlight,
        databaseContentionEvents: stats.databaseContentionEvents,
        databaseContentionBounded: stats.maxDatabaseInFlight === 1
            && stats.databaseContentionEvents > 0,
        preflightQueueDrained,
        paidQueueDrained,
        eventualDrain: preflightQueueDrained
            && paidQueueDrained
            && terminal.size === accepted,
        taskWrappers: true,
        providerAdmissionWrappers: true,
        fakeProvider: true,
    });
}

const isDirectExecution = process.argv[1]?.endsWith('capacity-extension-load-harness.ts') === true;
if (isDirectExecution) {
    const requestedStage = process.env.ANALYSIS_CAPACITY_LOAD_STAGE;
    if (requestedStage !== undefined
        && requestedStage !== 'initial'
        && requestedStage !== 'expanded') {
        process.stderr.write('capacity load harness failed\n');
        process.exitCode = 1;
    } else {
        const loadOptions: CapacityExtensionLoadOptions = {
            fakeProviderMode: 'load',
        };
        if (requestedStage) {
            loadOptions.capacityStage = requestedStage;
            if (requestedStage === 'expanded') {
                loadOptions.preflightConcurrency = 64;
                loadOptions.paidConcurrency = 16;
            }
        }
        runCapacityExtensionLoad(loadOptions)
        .then(report => {
            assertCapacityExtensionLoadReport(report);
            process.stdout.write(`${JSON.stringify(report)}\n`);
        })
        .catch(() => {
            process.stderr.write('capacity load harness failed\n');
            process.exitCode = 1;
        });
    }
}
