import { randomUUID } from 'node:crypto';
import type {
    ProviderRunCheckpoint,
    ProviderCostRunFinished,
} from '@/lib/services/instagram/providers/types';
import type { AnalysisWorkloadRole } from './workload-role';
import {
    AnalysisProviderAdmissionFenceError,
    AnalysisProviderAdmissionPersistenceError,
    AnalysisProviderAdmissionResolutionPendingError,
    type AnalysisProviderAdmissionInput,
    type AnalysisProviderAdmissionLease,
    type AnalysisProviderAdmissionStore,
    analysisProviderAdmissionStore,
    isAnalysisProviderAdmissionEnabled,
} from './provider-admission-store';
import { APIFY_FREE_CREDENTIAL_SLOTS } from '@/lib/services/instagram/providers/types';

type ActiveProviderRunStatus = 'starting' | 'running';

export interface AnalysisProviderAdmissionCheckpointOptions {
    checkpoint: ProviderRunCheckpoint;
    /** The status loaded from the durable provider-run ledger, if any. */
    storedStatus: ActiveProviderRunStatus | null;
    workloadRole: AnalysisWorkloadRole;
    /** A service-owned beta hold may run on the preflight route while consuming
     * the paid Apify budget. This value is never caller-controlled; it is set
     * only by the process-owned beta lineage. */
    providerAdmissionWorkloadRole?: AnalysisWorkloadRole;
    providerAdmissionJobKey?: string;
    requestId: string;
    jobKey: string;
    operationKey: string;
    claimToken: string;
    /** Durable analysis_pipeline_jobs claim; Apify defaults to claimToken for legacy callers. */
    jobClaimToken?: string;
    env?: Record<string, string | undefined>;
    store?: AnalysisProviderAdmissionStore;
    leaseSeconds?: number;
}

const DEFAULT_LEASE_SECONDS = 120;

function budgetKey(input: Pick<
    AnalysisProviderAdmissionCheckpointOptions,
    'workloadRole' | 'operationKey'
> & { credentialSlot: string }): string {
    if (input.workloadRole === 'preflight') {
        if (!APIFY_FREE_CREDENTIAL_SLOTS.includes(
            input.credentialSlot as typeof APIFY_FREE_CREDENTIAL_SLOTS[number]
        )) {
            throw new Error('ANALYSIS_PROVIDER_ADMISSION_CREDENTIAL_FORBIDDEN');
        }
        return `preflight:apify:${input.credentialSlot}`;
    }
    if (input.operationKey.startsWith('relationship-')) {
        // Keep the slot in the durable budget identity. Ordinary production
        // relationships still default to secondary, while frozen
        // request/order policies may authorize another slot in the DB.
        return `paid:apify:${input.credentialSlot}:relationship`;
    }
    return `paid:apify:${input.credentialSlot}`;
}

function identityMatches(
    actual: {
        logicalProvider: string;
        actorId: string;
        credentialSlot: string;
        maxChargeUsd: number;
    },
    expected: {
        logicalProvider: string;
        actorId: string;
        credentialSlot: string;
        maxChargeUsd: number;
    },
): boolean {
    return actual.logicalProvider === expected.logicalProvider
        && actual.actorId === expected.actorId
        && actual.credentialSlot === expected.credentialSlot
        && actual.maxChargeUsd === expected.maxChargeUsd;
}

function assertEnabledIdentity(
    input: AnalysisProviderAdmissionCheckpointOptions,
): AnalysisProviderAdmissionInput {
    const checkpoint = input.checkpoint;
    if (
        checkpoint.logicalProvider !== 'apify'
        || typeof checkpoint.actorId !== 'string'
        || typeof checkpoint.credentialSlot !== 'string'
        || typeof checkpoint.maxChargeUsd !== 'number'
    ) {
        throw new Error('ANALYSIS_PROVIDER_ADMISSION_CONFIG_ERROR');
    }
    const admissionWorkloadRole = input.providerAdmissionWorkloadRole ?? input.workloadRole;
    return {
        workloadRole: admissionWorkloadRole,
        logicalProvider: 'apify',
        credentialSlot: checkpoint.credentialSlot,
        budgetKey: budgetKey({
            workloadRole: admissionWorkloadRole,
            operationKey: input.operationKey,
            credentialSlot: checkpoint.credentialSlot,
        }),
        requestId: input.requestId,
        jobKey: input.jobKey,
        operationKey: input.operationKey,
        claimToken: input.claimToken,
        jobClaimToken: input.jobClaimToken ?? input.claimToken,
        leaseSeconds: input.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
    };
}

/**
 * Adds the database-global admission fence around the existing provider-run checkpoint.
 * The wrapper is deliberately opt-in: production deployment scripts must set the explicit
 * gate, while local/test processes remain unable to spend a provider credit by accident.
 */
export function withAnalysisProviderAdmissionCheckpoint(
    input: AnalysisProviderAdmissionCheckpointOptions,
): ProviderRunCheckpoint | Promise<ProviderRunCheckpoint> {
    const env = input.env ?? process.env;
    if (!isAnalysisProviderAdmissionEnabled(env)) return input.checkpoint;

    const admissionInput = assertEnabledIdentity(input);
    const admission = input.store ?? analysisProviderAdmissionStore;
    let heldLease: AnalysisProviderAdmissionLease | null = null;
    let acquisition: Promise<AnalysisProviderAdmissionLease> | null = null;
    let releasePromise: Promise<void> | null = null;
    let renewalTimer: ReturnType<typeof setInterval> | undefined;
    let renewalError: Error | null = null;
    let beforeCompleted = input.storedStatus !== null;

    const stopRenewal = (): void => {
        if (!renewalTimer) return;
        clearInterval(renewalTimer);
        renewalTimer = undefined;
    };

    const startRenewal = (): void => {
        if (renewalTimer) return;
        const intervalMs = Math.max(10_000, Math.floor(admissionInput.leaseSeconds * 1_000 / 3));
        renewalTimer = setInterval(() => {
            if (!heldLease || renewalError) return;
            void admission.renew(heldLease)
                .then(renewed => {
                    heldLease = renewed;
                })
                .catch(() => {
                    renewalError = new Error('ANALYSIS_PROVIDER_ADMISSION_RENEW_REQUIRED');
                });
        }, intervalMs);
        // Timers must not keep a completed local/test process alive.
        const timer = renewalTimer as ReturnType<typeof setInterval> & {
            unref?: () => void;
        };
        timer.unref?.();
    };

    const ensureLease = async (): Promise<AnalysisProviderAdmissionLease> => {
        if (heldLease) return heldLease;
        if (!acquisition) {
            acquisition = (async () => {
                try {
                    return await admission.acquire(admissionInput);
                } catch (error) {
                    // The RPC may have committed the admission before its response
                    // was lost. Replay exactly once with the same durable identity;
                    // typed denials are never replayed and unknown failures retain
                    // the admission if the replay also fails.
                    if (!(error instanceof AnalysisProviderAdmissionPersistenceError)) {
                        throw error;
                    }
                    return admission.acquire(admissionInput);
                }
            })()
                .then(lease => {
                    heldLease = lease;
                    startRenewal();
                    return lease;
                })
                .finally(() => {
                    acquisition = null;
                });
        }
        return acquisition;
    };

    const releaseHeld = async (
        reason: 'terminal' | 'prestart_rejected' = 'terminal',
    ): Promise<void> => {
        if (releasePromise) return releasePromise;
        const lease = heldLease;
        if (!lease) return;
        releasePromise = (async () => {
            stopRenewal();
            try {
                await admission.release(lease, reason);
            } catch (error) {
                // An expired lease is no longer allowed to be released by its stale fence;
                // rotate it into recovery_required, then release only after the durable
                // provider ledger proves terminal/available/quarantined state.
                if (!(error instanceof AnalysisProviderAdmissionFenceError)) throw error;
                const recovered = await admission.recoverExpired({
                    admissionId: lease.admissionId,
                    recoveryToken: randomUUID(),
                });
                if (!recovered) throw new Error('ANALYSIS_PROVIDER_ADMISSION_RELEASE_REQUIRED');
                const resolved = await admission.resolve({
                    admissionId: lease.admissionId,
                    resolutionToken: randomUUID(),
                });
                if (!resolved) throw new AnalysisProviderAdmissionResolutionPendingError();
            } finally {
                heldLease = null;
            }
        })();
        return releasePromise;
    };

    const base = input.checkpoint;
    const wrapped: ProviderRunCheckpoint = {
        ...base,
        onBeforeRunStart: async actual => {
            if (!identityMatches(actual, admissionIdentity(base))) {
                throw new Error('ANALYSIS_PROVIDER_ADMISSION_IDENTITY_CONFLICT');
            }
            if (beforeCompleted) return;
            await ensureLease();
            try {
                await base.onBeforeRunStart?.(actual);
                beforeCompleted = true;
            } catch (error) {
                await releaseHeld('prestart_rejected');
                throw error;
            }
        },
        onRunStartRejected: async event => {
            let callbackError: unknown;
            try {
                await base.onRunStartRejected?.(event);
            } catch (error) {
                callbackError = error;
            }
            try {
                await releaseHeld('prestart_rejected');
            } catch (error) {
                if (!callbackError) callbackError = error;
            }
            if (callbackError) throw callbackError;
        },
        onRunStarted: async runId => {
            try {
                await base.onRunStarted?.(runId);
            } catch (error) {
                // The provider has crossed the start boundary, but the durable
                // running checkpoint is unknown. Stop renewing and retain the
                // admission for TTL/recovery rather than extending it forever.
                stopRenewal();
                throw error;
            }
        },
        onInvocationFinished: async () => {
            // A resumed provider call can return pending/aborted without
            // reaching a terminal or ambiguity callback. Stop only this
            // worker's local renewal; durable ownership remains fenced for
            // TTL recovery/adoption.
            stopRenewal();
        },
        onRunStartAmbiguous: async event => {
            // Keep the lease held: the external POST may have created a charged run even
            // though no trustworthy run id was returned. Recovery must fence it later.
            try {
                await base.onRunStartAmbiguous?.(event);
            } finally {
                // Ambiguous ownership is fail-closed, but a warm worker must not
                // renew indefinitely and prevent the recovery worker from seeing
                // the expired admission.
                stopRenewal();
            }
        },
        onCostRunStarted: async event => {
            try {
                await base.onCostRunStarted?.(event);
                if (renewalError) throw renewalError;
            } catch (error) {
                // Preserve the lease for reconciliation when the durable start
                // checkpoint/telemetry path fails, but stop the local renewal.
                stopRenewal();
                throw error;
            }
        },
        onCostRunFinished: async (event: ProviderCostRunFinished) => {
            // Keep the admission fenced when the durable terminal ledger write
            // fails. Releasing here would let a redelivered task start a second
            // charged provider run while the first outcome is still unknown.
            try {
                await base.onCostRunFinished?.(event);
            } catch (error) {
                stopRenewal();
                throw error;
            }
            stopRenewal();
            try {
                await releaseHeld();
            } catch (error) {
                throw error;
            }
        },
    };

    if (input.storedStatus !== null) {
        return ensureLease().then(() => wrapped);
    }
    return wrapped;
}

function admissionIdentity(checkpoint: ProviderRunCheckpoint): {
    logicalProvider: string;
    actorId: string;
    credentialSlot: string;
    maxChargeUsd: number;
} {
    if (
        typeof checkpoint.logicalProvider !== 'string'
        || typeof checkpoint.actorId !== 'string'
        || typeof checkpoint.credentialSlot !== 'string'
        || typeof checkpoint.maxChargeUsd !== 'number'
    ) {
        throw new Error('ANALYSIS_PROVIDER_ADMISSION_CONFIG_ERROR');
    }
    return {
        logicalProvider: checkpoint.logicalProvider,
        actorId: checkpoint.actorId,
        credentialSlot: checkpoint.credentialSlot,
        maxChargeUsd: checkpoint.maxChargeUsd,
    };
}
