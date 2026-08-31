import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { InstagramProfile } from '@/lib/types/instagram';
import type { ProviderCallContext } from '@/lib/services/instagram/providers/types';
import { APIFY_PROFILE_ACTOR_ID } from '@/lib/services/instagram/providers/apify';
import { selectPreflightApifyCredentialSlot } from '@/lib/services/instagram/providers/apify-relationship';
import { makeWebProfileFetcher } from '@/lib/services/instagram/providers/selfhosted/web-client';
import { RISK_POLICY_VERSION } from '@/lib/domain/analysis/risk-policy';
import { AI_STAGE_POLICY_LATEST_VERSION } from '@/lib/services/ai/stage-policy';
import { AI_SCHEDULER_POLICY_ID } from '@/lib/services/ai/scheduler-policy';

import {
    BetaPreflightAccessUnavailableError,
    PREFLIGHT_DATABASE_NAMES,
    PreflightImmutableError,
    PreflightLeaseBusyError,
    buildReadyPreflightSnapshot,
    boundPrecheckoutBliteSourceExpiry,
    classifyPreflightError,
    createSupabasePreflightStore,
    preflightPolicyVersions,
    processPreflight,
    publicPreflightStatusDto,
    trustedPreflightAccessMode,
    type ClaimedPreflight,
    type PreflightCatalogSnapshot,
    type PreflightStore,
    type ReadyPreflightSnapshot,
} from './preflight';
import type {
    PreflightProviderRunStore,
    StoredPreflightProviderRun,
} from './preflight-provider-run';
import type {
    AnalysisProviderAdmissionStore,
} from './provider-admission-store';
import { preflightTargetInputHash } from './preflight-identity';
import { PREFLIGHT_PROVIDER_DEADLINE_MS } from './preflight-runtime-policy';
import type { BetaApifyPreflightCoordinator } from './beta-apify-preflight-coordinator';
import { projectPrecheckoutBliteSource } from '@/lib/services/precheckout/blite-source';
import { PreflightTaskEnqueueError } from './preflight-tasks';

const preflightId = '123e4567-e89b-42d3-a456-426614174000';
const userId = '223e4567-e89b-42d3-a456-426614174000';
const claimToken = '323e4567-e89b-42d3-a456-426614174000'; // gitleaks:allow -- UUID fixture
const expiresAt = '2030-07-13T13:00:00.000Z';
const entitlementSecret = Buffer.alloc(32, 13).toString('base64url');
const preflightIdentitySecret = Buffer.alloc(32, 14).toString('base64url');
const imageProxySigningSecret = Buffer.alloc(32, 15).toString('base64url');
const preflightInputHash = preflightTargetInputHash('target.name', {
    ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: preflightIdentitySecret,
});
const preflightApifyPoolEnv = {
    APIFY_PRIMARY_API_TOKEN: 'primary-token',
    APIFY_QUINARY_API_TOKEN: 'quinary-token',
    APIFY_SENARY_API_TOKEN: 'senary-token',
    PREFLIGHT_APIFY_API_TOKEN_SLOTS: 'primary,quinary,senary',
} as const;

describe('betatest preflight credit fence', () => {
    it.each(['production', 'test_entitlement'] as const)(
        'never persists the beta capacity code for a %s channel error',
        async accessMode => {
            const claimed = claim({ accessMode, analysisEntryChannel: 'standard' });
            const store = workerStore(claimed);
            await expect(processPreflight(preflightId, {
                store,
                providerRunStore: providerRunStore(),
                getProfile: async () => { throw new Error('ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE'); },
            })).resolves.toBe('blocked');
            expect(store.finalizeBlocked).toHaveBeenCalledWith(claimed, 'ANALYSIS_FAILED');
        }
    );

    it('reuses the already prepared frozen beta hold before Apify-only profile work', async () => {
        const events: string[] = [];
        const coordinator: BetaApifyPreflightCoordinator = {
            reuse: vi.fn(async () => {
                events.push('hold');
                return {
                    allocationId: '423e4567-e89b-42d3-a456-426614174000',
                    credentialSlot: 'septenary' as const,
                };
            }),
            prepare: vi.fn(async () => { throw new Error('unexpected prepare'); }),
        };
        const claimed = claim({ analysisEntryChannel: 'betatest' });
        const store = workerStore(claimed);
        const apifyProfile = vi.fn(async () => {
            events.push('profile');
            return profile();
        });

        const outcome = await processPreflight(preflightId, {
            store,
            betaCreditCoordinator: coordinator,
            getProfile: vi.fn(() => { throw new Error('beta must not use public selfhosted'); }),
            getFallbackProfile: apifyProfile,
            providerRunStore: providerRunStore(),
        });

        expect(events[0]).toBe('hold');
        expect(events).toContain('profile');
        expect(apifyProfile).toHaveBeenCalled();
        expect(store.finalizeReady).toHaveBeenCalled();
        expect(outcome).toBe('ready');
    });

    it('charges a held beta septenary profile to paid admission while staying on the preflight route', async () => {
        const claimed = claim({ analysisEntryChannel: 'betatest' });
        const store = workerStore(claimed);
        const runs = providerRunStore();
        vi.mocked(runs.reserve).mockResolvedValue({
            created: true,
            run: {
                ...storedRun('starting'),
                credentialSlot: 'septenary',
                runId: null,
            },
        });
        vi.mocked(runs.checkpointStarted).mockResolvedValue({
            ...storedRun('running'),
            credentialSlot: 'septenary',
            runId: 'StartedRun1234567',
        });
        vi.mocked(runs.checkpointTerminal).mockResolvedValue({
            ...storedRun('succeeded'),
            credentialSlot: 'septenary',
            runId: 'StartedRun1234567',
        });
        const admission: AnalysisProviderAdmissionStore = {
            acquire: vi.fn(async input => ({
                ...input,
                outcome: 'acquired' as const,
                admissionId: 'a'.repeat(64),
                leaseToken: '423e4567-e89b-42d3-a456-426614174000',
                fence: 1,
                expiresAt: new Date(Date.now() + 120_000).toISOString(),
                activeCount: 1,
                maxActive: 8,
            })),
            renew: vi.fn(),
            release: vi.fn(async () => undefined),
            recoverExpired: vi.fn(),
            resolve: vi.fn(),
            listExpired: vi.fn(),
        };
        const getFallbackProfile = vi.fn(async (
            _username: string,
            context?: ProviderCallContext,
        ) => completeFallbackRun(context));

        await expect(processPreflight(preflightId, {
            store,
            providerRunStore: runs,
            providerAdmissionStore: admission,
            betaCreditCoordinator: {
                reuse: vi.fn(async () => ({
                    allocationId: '423e4567-e89b-42d3-a456-426614174001',
                    credentialSlot: 'septenary' as const,
                })),
                prepare: vi.fn(),
            },
            getFallbackProfile,
            env: {
                ...preflightApifyPoolEnv,
                ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'true',
            },
        })).resolves.toBe('ready');

        expect(admission.acquire).toHaveBeenCalledWith(expect.objectContaining({
            workloadRole: 'paid',
            logicalProvider: 'apify',
            credentialSlot: 'septenary',
            budgetKey: 'paid:apify:septenary',
            jobKey: 'preflight:provider',
            operationKey: 'target-profile-fallback',
        }));
        expect(admission.release).toHaveBeenCalledOnce();
        expect(getFallbackProfile).toHaveBeenCalledOnce();
    });

    it('rejects a septenary beta profile when no durable preflight-held reservation exists', async () => {
        const claimed = claim({ analysisEntryChannel: 'betatest' });
        const store = workerStore(claimed);
        const admission: AnalysisProviderAdmissionStore = {
            acquire: vi.fn(),
            renew: vi.fn(),
            release: vi.fn(),
            recoverExpired: vi.fn(),
            resolve: vi.fn(),
            listExpired: vi.fn(),
        };

        await expect(processPreflight(preflightId, {
            store,
            providerAdmissionStore: admission,
            betaCreditCoordinator: {
                reuse: vi.fn(async () => {
                    throw new Error('ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE');
                }),
                prepare: vi.fn(),
            },
            getFallbackProfile: vi.fn(),
            env: {
                ...preflightApifyPoolEnv,
                ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'true',
            },
        })).resolves.toBe('blocked');

        expect(admission.acquire).not.toHaveBeenCalled();
        expect(store.finalizeBlocked).toHaveBeenCalledWith(
            claimed,
            'BETA_CAPACITY_UNAVAILABLE',
        );
    });

    it('blocks beta capacity before profile collection and releases the claim', async () => {
        const claimed = claim({ analysisEntryChannel: 'betatest' });
        const store = workerStore(claimed);
        const getProfile = vi.fn();
        const settleBetaCredit = vi.fn(async () => true);
        const refreshBetaCredit = vi.fn(async () => undefined);
        await expect(processPreflight(preflightId, {
            store,
            betaCreditCoordinator: {
                reuse: async () => { throw new Error('ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE'); },
                prepare: async () => { throw new Error('ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE'); },
            },
            getProfile,
            settleBetaCredit,
            refreshBetaCredit,
        })).resolves.toBe('blocked');
        expect(getProfile).not.toHaveBeenCalled();
        expect(store.finalizeBlocked).toHaveBeenCalledWith(claimed, 'BETA_CAPACITY_UNAVAILABLE');
        expect(settleBetaCredit).toHaveBeenCalledWith(preflightId);
        expect(refreshBetaCredit).toHaveBeenCalledOnce();
    });
});

describe('B-lite single-collection preflight', () => {
    it('bypasses B-lite immediately for a legacy claim without a persisted target hash', async () => {
        const claimed = claim({ targetInputHash: null });
        const store = workerStore(claimed);
        const activateBliteCohort = vi.fn();
        const getFullProfile = vi.fn();
        const getProfile = vi.fn(async () => profile());
        const bliteObservability = {
            completed: vi.fn(),
            profileCollectionFailed: vi.fn(),
            inferenceFailed: vi.fn(),
            inferenceAttempt: vi.fn(),
            sourceFinalizerFailed: vi.fn(),
            demoCompleted: vi.fn(),
            demoFailed: vi.fn(),
        };
        const env = {
            ...preflightApifyPoolEnv,
            PRECHECKOUT_BLITE_ENABLED: 'true',
            PRECHECKOUT_BLITE_ROLLOUT_PERCENT: '100',
            ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: preflightIdentitySecret,
            ANALYSIS_V2_INSTAGRAM_ROUTE: 'apify_v1',
        };

        await expect(processPreflight(preflightId, {
            store,
            providerRunStore: providerRunStore(),
            getProfile,
            getFullProfile,
            activateBliteCohort,
            bliteObservability,
            env,
        })).resolves.toBe('ready');

        expect(activateBliteCohort).not.toHaveBeenCalled();
        expect(getFullProfile).not.toHaveBeenCalled();
        expect(getProfile).toHaveBeenCalledOnce();
        expect(store.finalizeReady).toHaveBeenCalledOnce();
    });

    it('uses the frozen beta hold before the dedicated selector for a new beta B-lite run', async () => {
        const claimed = claim({ analysisEntryChannel: 'betatest' });
        const store = workerStore(claimed);
        const runs = providerRunStore();
        expect(selectPreflightApifyCredentialSlot(preflightId, preflightApifyPoolEnv))
            .toBe('senary');
        let loadCount = 0;
        vi.mocked(runs.load).mockImplementation(async () => {
            loadCount += 1;
            return loadCount <= 2
                ? null
                : { ...storedRun('succeeded'), credentialSlot: 'septenary' };
        });
        vi.mocked(runs.reserve).mockImplementation(async input => ({
            created: true,
            run: {
                ...storedRun('starting'),
                credentialSlot: input.credentialSlot,
            },
        }));
        const getFullProfile = vi.fn(async (
            _username: string,
            context?: ProviderCallContext,
        ) => {
            expect(context?.credentialSlot).toBe('septenary');
            await context?.onBeforeRunStart?.({
                logicalProvider: 'apify',
                actorId: APIFY_PROFILE_ACTOR_ID,
                credentialSlot: 'septenary',
                maxChargeUsd: 0.0026,
            });
            return profile();
        });

        await expect(processPreflight(preflightId, {
            store,
            providerRunStore: runs,
            betaCreditCoordinator: {
                reuse: vi.fn(async () => ({
                    allocationId: '423e4567-e89b-42d3-a456-426614174000',
                    credentialSlot: 'septenary' as const,
                })),
                prepare: vi.fn(),
            },
            getFullProfile,
            finalizeReadyWithSource: vi.fn(async () => false),
            activateBliteCohort: vi.fn(async () => ({
                submittedAt: new Date(Date.now() - 1_000).toISOString(),
                deadlineAt: new Date(Date.now() + 59_000).toISOString(),
                expiresAt: new Date(Date.now() + 29 * 60_000).toISOString(),
            })),
            env: {
                ...preflightApifyPoolEnv,
                PRECHECKOUT_BLITE_ENABLED: 'true',
                PRECHECKOUT_BLITE_ROLLOUT_PERCENT: '100',
                ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: preflightIdentitySecret,
            },
        })).resolves.toBe('ready');

        expect(getFullProfile).toHaveBeenCalledOnce();
        expect(runs.reserve).toHaveBeenCalledWith(expect.objectContaining({
            credentialSlot: 'septenary',
        }));
    });

    it('blocks an existing beta B-lite run before bind when its hold slot has drifted', async () => {
        const claimed = claim({ analysisEntryChannel: 'betatest' });
        const store = workerStore(claimed);
        const runs = providerRunStore();
        vi.mocked(runs.load).mockResolvedValue({
            ...storedRun('succeeded'),
            credentialSlot: 'senary',
        });
        const getFullProfile = vi.fn(async () => profile());

        await expect(processPreflight(preflightId, {
            store,
            providerRunStore: runs,
            betaCreditCoordinator: {
                reuse: vi.fn(async () => ({
                    allocationId: '423e4567-e89b-42d3-a456-426614174000',
                    credentialSlot: 'septenary' as const,
                })),
                prepare: vi.fn(),
            },
            getFullProfile,
            finalizeReadyWithSource: vi.fn(async () => false),
            activateBliteCohort: vi.fn(async () => ({
                submittedAt: new Date(Date.now() - 1_000).toISOString(),
                deadlineAt: new Date(Date.now() + 59_000).toISOString(),
                expiresAt: new Date(Date.now() + 29 * 60_000).toISOString(),
            })),
            env: {
                ...preflightApifyPoolEnv,
                PRECHECKOUT_BLITE_ENABLED: 'true',
                PRECHECKOUT_BLITE_ROLLOUT_PERCENT: '100',
                ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: preflightIdentitySecret,
            },
        })).resolves.toBe('blocked');

        expect(getFullProfile).not.toHaveBeenCalled();
        expect(runs.reserve).not.toHaveBeenCalled();
        expect(store.finalizeBlocked).toHaveBeenCalledWith(
            claimed,
            'BETA_CAPACITY_UNAVAILABLE',
        );
    });

    it.each(['secondary', 'tenth'] as const)(
        'resumes a persisted B-lite run on its stored %s slot without the new pool',
        async credentialSlot => {
            const claimed = claim();
            const store = workerStore(claimed);
            const persistedRun = {
                ...storedRun('succeeded'),
                credentialSlot,
            };
            const runs = providerRunStore();
            vi.mocked(runs.load).mockResolvedValue(persistedRun);
            const getFullProfile = vi.fn(async (
                _username: string,
                context?: ProviderCallContext,
            ) => {
                expect(context).toMatchObject({
                    resumeRunId: 'StoredRun12345678',
                    credentialSlot,
                });
                return profile();
            });

            await expect(processPreflight(preflightId, {
                store,
                providerRunStore: runs,
                getFullProfile,
                activateBliteCohort: vi.fn(async () => ({
                    submittedAt: new Date(Date.now() - 1_000).toISOString(),
                    deadlineAt: new Date(Date.now() + 59_000).toISOString(),
                    expiresAt: new Date(Date.now() + 29 * 60_000).toISOString(),
                })),
                finalizeReadyWithSource: vi.fn(async () => false),
                env: {
                    PRECHECKOUT_BLITE_ENABLED: 'true',
                    PRECHECKOUT_BLITE_ROLLOUT_PERCENT: '100',
                    ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: preflightIdentitySecret,
                },
            })).resolves.toBe('ready');

            expect(getFullProfile).toHaveBeenCalledOnce();
            expect(runs.reserve).not.toHaveBeenCalled();
        },
    );

    it('preserves the authoritative DB expiry through an exact 44-microsecond reproduction', () => {
        expect(boundPrecheckoutBliteSourceExpiry(
            '2030-07-13T12:00:00.000Z',
            '2030-07-13T12:29:59.919044Z',
        )).toBe('2030-07-13T12:29:59.919044Z');
    });

    it('clamps an expiry that is truly 44 microseconds later than the source bound', () => {
        expect(boundPrecheckoutBliteSourceExpiry(
            '2030-07-13T12:00:00.919Z',
            '2030-07-13T12:30:00.919044Z',
        )).toBe('2030-07-13T12:30:00.919Z');
    });

    it('classifies source finalization persistence failures as retryable persistence', () => {
        expect(classifyPreflightError(
            new Error('PRECHECKOUT_BLITE_SOURCE_PERSISTENCE_ERROR (PGRST202)'),
        )).toEqual({
            category: 'persistence',
            retryable: true,
            httpStatus: null,
            paidFallbackEligible: false,
        });
    });

    it('fails open to ordinary readiness when the source-finalization RPC is absent from PostgREST', async () => {
        const claimed = claim();
        const store = workerStore(claimed);
        const activateBliteCohort = vi.fn(async () => ({
            submittedAt: new Date(Date.now() - 1_000).toISOString(),
            deadlineAt: new Date(Date.now() + 59_000).toISOString(),
            expiresAt: new Date(Date.now() + 29 * 60_000).toISOString(),
        }));
        const finalizeReadyWithSource = vi.fn(async () => {
            throw new Error('PRECHECKOUT_BLITE_SOURCE_PERSISTENCE_ERROR (PGRST202)');
        });
        const run = {
            ...storedRun('succeeded'),
            credentialSlot: selectPreflightApifyCredentialSlot(preflightId, {
                ...preflightApifyPoolEnv,
                PRECHECKOUT_BLITE_ENABLED: 'true',
                PRECHECKOUT_BLITE_ROLLOUT_PERCENT: '100',
                ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: preflightIdentitySecret,
            }),
        };
        const runs: PreflightProviderRunStore = {
            load: vi.fn(async () => run),
            reserve: vi.fn(),
            checkpointStarted: vi.fn(),
            checkpointRejected: vi.fn(),
            checkpointTerminal: vi.fn(),
        };

        await expect(processPreflight(preflightId, {
            store,
            providerRunStore: runs,
            getFullProfile: vi.fn(async () => profile({ followersCount: 476, followingCount: 644 })),
            activateBliteCohort,
            finalizeReadyWithSource,
            env: {
                ...preflightApifyPoolEnv,
                PRECHECKOUT_BLITE_ENABLED: 'true',
                PRECHECKOUT_BLITE_ROLLOUT_PERCENT: '100',
                ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: preflightIdentitySecret,
            },
        })).resolves.toBe('ready');

        expect(finalizeReadyWithSource).toHaveBeenCalledOnce();
        expect(store.finalizeReady).toHaveBeenCalledWith(
            claimed,
            expect.objectContaining({
                target: expect.objectContaining({ followersCount: 476, followingCount: 644 }),
            }),
        );
        expect(store.releaseClaim).not.toHaveBeenCalled();
        expect(store.finalizeBlocked).not.toHaveBeenCalled();
    });

    it('keeps non-schema-cache source finalization failures on the retry fence', async () => {
        const claimed = claim();
        const store = workerStore(claimed);
        const activateBliteCohort = vi.fn(async () => ({
            submittedAt: new Date(Date.now() - 1_000).toISOString(),
            deadlineAt: new Date(Date.now() + 59_000).toISOString(),
            expiresAt: new Date(Date.now() + 29 * 60_000).toISOString(),
        }));
        const finalizeReadyWithSource = vi.fn(async () => {
            throw new Error('PRECHECKOUT_BLITE_SOURCE_PERSISTENCE_ERROR (PGRST42501)');
        });

        await expect(processPreflight(preflightId, {
            store,
            providerRunStore: providerRunStore(),
            getFullProfile: vi.fn(async () => profile({ followersCount: 476, followingCount: 644 })),
            activateBliteCohort,
            finalizeReadyWithSource,
            env: {
                ...preflightApifyPoolEnv,
                PRECHECKOUT_BLITE_ENABLED: 'true',
                PRECHECKOUT_BLITE_ROLLOUT_PERCENT: '100',
                ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: preflightIdentitySecret,
            },
        })).rejects.toMatchObject({
            message: 'PREFLIGHT_WORKER_RETRY',
            classification: { category: 'persistence', retryable: true },
        });

        expect(store.finalizeReady).not.toHaveBeenCalled();
        expect(store.releaseClaim).toHaveBeenCalledOnce();
        expect(store.finalizeBlocked).not.toHaveBeenCalled();
    });

    it('records a bounded profile collection failure when the selected Apify call fails', async () => {
        const claimed = claim();
        const store = workerStore(claimed);
        const bliteObservability = {
            completed: vi.fn(),
            profileCollectionFailed: vi.fn(),
            inferenceFailed: vi.fn(),
            inferenceAttempt: vi.fn(),
            sourceFinalizerFailed: vi.fn(),
            demoCompleted: vi.fn(),
            demoFailed: vi.fn(),
        };
        const activateBliteCohort = vi.fn(async () => ({
            submittedAt: new Date(Date.now() - 1_000).toISOString(),
            deadlineAt: new Date(Date.now() + 59_000).toISOString(),
            expiresAt: new Date(Date.now() + 29 * 60_000).toISOString(),
        }));
        const runs = providerRunStore();
        const fullProfile = vi.fn(async () => {
            throw new Error('SCRAPING_SCHEMA_ERROR: Apify profile payload is invalid.');
        });

        await expect(processPreflight(preflightId, {
            store,
            providerRunStore: runs,
            getFullProfile: fullProfile,
            activateBliteCohort,
            bliteObservability,
            env: {
                ...preflightApifyPoolEnv,
                PRECHECKOUT_BLITE_ENABLED: 'true',
                PRECHECKOUT_BLITE_ROLLOUT_PERCENT: '100',
                ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: preflightIdentitySecret,
            },
        })).resolves.toBe('blocked');

        expect(bliteObservability.profileCollectionFailed).toHaveBeenCalledWith('schema');
        expect(bliteObservability.completed).not.toHaveBeenCalled();
        expect(bliteObservability.inferenceFailed).not.toHaveBeenCalled();
        expect(store.finalizeBlocked).toHaveBeenCalledWith(claimed, 'ANALYSIS_FAILED');
        expect(JSON.stringify(bliteObservability.profileCollectionFailed.mock.calls))
            .not.toContain('Apify profile payload');
    });

    it('does not report a provider failure for checkpoint persistence errors', async () => {
        const claimed = claim();
        const store = workerStore(claimed);
        const bliteObservability = {
            completed: vi.fn(),
            profileCollectionFailed: vi.fn(),
            inferenceFailed: vi.fn(),
            inferenceAttempt: vi.fn(),
            sourceFinalizerFailed: vi.fn(),
            demoCompleted: vi.fn(),
            demoFailed: vi.fn(),
        };
        const activateBliteCohort = vi.fn(async () => ({
            submittedAt: new Date(Date.now() - 1_000).toISOString(),
            deadlineAt: new Date(Date.now() + 59_000).toISOString(),
            expiresAt: new Date(Date.now() + 29 * 60_000).toISOString(),
        }));
        const fullProfile = vi.fn(async () => {
            throw new Error('ANALYSIS_PERSISTENCE_ERROR: provider checkpoint is unavailable.');
        });

        await expect(processPreflight(preflightId, {
            store,
            providerRunStore: providerRunStore(),
            getFullProfile: fullProfile,
            activateBliteCohort,
            bliteObservability,
            env: {
                ...preflightApifyPoolEnv,
                PRECHECKOUT_BLITE_ENABLED: 'true',
                PRECHECKOUT_BLITE_ROLLOUT_PERCENT: '100',
                ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: preflightIdentitySecret,
            },
        })).rejects.toMatchObject({ message: 'PREFLIGHT_WORKER_RETRY' });

        expect(bliteObservability.profileCollectionFailed).not.toHaveBeenCalled();
    });

    it('does not report a provider failure while a checkpointed Apify run is pending', async () => {
        const claimed = claim();
        const store = workerStore(claimed);
        const bliteObservability = {
            completed: vi.fn(),
            profileCollectionFailed: vi.fn(),
            inferenceFailed: vi.fn(),
            inferenceAttempt: vi.fn(),
            sourceFinalizerFailed: vi.fn(),
            demoCompleted: vi.fn(),
            demoFailed: vi.fn(),
        };
        const activateBliteCohort = vi.fn(async () => ({
            submittedAt: new Date(Date.now() - 1_000).toISOString(),
            deadlineAt: new Date(Date.now() + 59_000).toISOString(),
            expiresAt: new Date(Date.now() + 29 * 60_000).toISOString(),
        }));
        const fullProfile = vi.fn(async () => {
            throw new Error('SCRAPING_RUN_PENDING_ERROR: checkpointed run is still active.');
        });

        await expect(processPreflight(preflightId, {
            store,
            providerRunStore: providerRunStore(),
            getFullProfile: fullProfile,
            activateBliteCohort,
            bliteObservability,
            env: {
                ...preflightApifyPoolEnv,
                PRECHECKOUT_BLITE_ENABLED: 'true',
                PRECHECKOUT_BLITE_ROLLOUT_PERCENT: '100',
                ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: preflightIdentitySecret,
            },
        })).rejects.toMatchObject({ message: 'PREFLIGHT_WORKER_RETRY' });

        expect(bliteObservability.profileCollectionFailed).not.toHaveBeenCalled();
    });

    it('fails open to the ordinary ready flow when a retry crosses the immutable B-lite fence', async () => {
        const claimed = claim({
            userId: null,
            workerAttemptCount: 1,
            leaseExpiresAt: new Date(Date.now() + 180_000).toISOString(),
        });
        const store = workerStore(claimed);
        vi.mocked(store.claim).mockResolvedValueOnce(claimed).mockResolvedValueOnce({
            ...claimed,
            workerAttemptCount: 2,
        });
        const runs = providerRunStore();
        const env = {
            ...preflightApifyPoolEnv,
            PRECHECKOUT_BLITE_ENABLED: 'true',
            PRECHECKOUT_BLITE_ROLLOUT_PERCENT: '100',
            ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: preflightIdentitySecret,
        };
        const completedRun = {
            ...storedRun('succeeded'),
            credentialSlot: selectPreflightApifyCredentialSlot(preflightId, env),
        };
        vi.mocked(runs.load)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(completedRun)
            .mockResolvedValueOnce(completedRun);
        const activateBliteCohort = vi.fn()
            .mockResolvedValueOnce({
                submittedAt: new Date(Date.now() - 61_000).toISOString(),
                deadlineAt: new Date(Date.now() - 1_000).toISOString(),
                expiresAt: new Date(Date.now() + 29 * 60_000).toISOString(),
            })
            .mockRejectedValueOnce(new Error('PRECHECKOUT_BLITE_PREFLIGHT_FENCE_LOST'));
        const getFullProfile = vi.fn(async () => {
            throw new Error('SCRAPING_RUN_PENDING_ERROR: checkpointed run is still active.');
        });
        const getFallbackProfile = vi.fn(async () => profile());
        const finalizeReadyWithSource = vi.fn();
        const enqueueBliteInference = vi.fn();
        const anonymousProfileCache = {
            load: vi.fn(async () => null),
            store: vi.fn(async () => true),
        };
        const options = {
            store,
            providerRunStore: runs,
            getFullProfile,
            getFallbackProfile,
            activateBliteCohort,
            finalizeReadyWithSource,
            enqueueBliteInference,
            anonymousProfileCache,
            env,
        };

        await expect(processPreflight(preflightId, options))
            .rejects.toMatchObject({ message: 'PREFLIGHT_WORKER_RETRY' });
        expect(getFullProfile).toHaveBeenCalledOnce();
        expect(store.releaseClaim).toHaveBeenCalledOnce();

        await expect(processPreflight(preflightId, options)).resolves.toBe('ready');
        expect(activateBliteCohort).toHaveBeenCalledTimes(2);
        expect(getFullProfile).toHaveBeenCalledOnce();
        expect(getFallbackProfile).toHaveBeenCalledOnce();
        expect(store.finalizeReady).toHaveBeenCalledOnce();
        expect(store.finalizeBlocked).not.toHaveBeenCalled();
        expect(finalizeReadyWithSource).not.toHaveBeenCalled();
        expect(enqueueBliteInference).not.toHaveBeenCalled();
    });

    it('fails open when source finalization crosses the immutable B-lite fence', async () => {
        const claimed = claim({
            leaseExpiresAt: new Date(Date.now() + 180_000).toISOString(),
        });
        const store = workerStore(claimed);
        const env = {
            ...preflightApifyPoolEnv,
            PRECHECKOUT_BLITE_ENABLED: 'true',
            PRECHECKOUT_BLITE_ROLLOUT_PERCENT: '100',
            ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: preflightIdentitySecret,
        };
        const run = {
            ...storedRun('succeeded'),
            credentialSlot: selectPreflightApifyCredentialSlot(preflightId, env),
        };
        const runs: PreflightProviderRunStore = {
            load: vi.fn(async () => run),
            reserve: vi.fn(),
            checkpointStarted: vi.fn(),
            checkpointRejected: vi.fn(),
            checkpointTerminal: vi.fn(),
        };
        const activateBliteCohort = vi.fn(async () => ({
            submittedAt: new Date(Date.now() - 1_000).toISOString(),
            deadlineAt: new Date(Date.now() + 59_000).toISOString(),
            expiresAt: new Date(Date.now() + 29 * 60_000).toISOString(),
        }));
        const finalizeReadyWithSource = vi.fn(async () => {
            throw new Error('PRECHECKOUT_BLITE_PREFLIGHT_FENCE_LOST');
        });
        const bliteObservability = {
            completed: vi.fn(),
            profileCollectionFailed: vi.fn(),
            inferenceFailed: vi.fn(),
            inferenceAttempt: vi.fn(),
            sourceFinalizerFailed: vi.fn(),
            demoCompleted: vi.fn(),
            demoFailed: vi.fn(),
        };

        await expect(processPreflight(preflightId, {
            store,
            providerRunStore: runs,
            getFullProfile: vi.fn(async () => profile()),
            activateBliteCohort,
            finalizeReadyWithSource,
            bliteObservability,
            env,
        })).resolves.toBe('ready');

        expect(finalizeReadyWithSource).toHaveBeenCalledOnce();
        expect(store.finalizeReady).toHaveBeenCalledOnce();
        expect(bliteObservability.sourceFinalizerFailed).toHaveBeenCalledWith('fence_lost');
        expect(store.finalizeBlocked).not.toHaveBeenCalled();
    });

    it('uses the claimed persisted target hash when the worker HMAC secret has drifted', async () => {
        const persistedTargetHash = 'c'.repeat(64);
        const claimed = claim({ targetInputHash: persistedTargetHash });
        const store = workerStore(claimed);
        const run = {
            ...storedRun('succeeded'),
            inputHash: persistedTargetHash,
            credentialSlot: selectPreflightApifyCredentialSlot(preflightId, {
                ...preflightApifyPoolEnv,
                PRECHECKOUT_BLITE_ENABLED: 'true',
                PRECHECKOUT_BLITE_ROLLOUT_PERCENT: '100',
                ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: preflightIdentitySecret,
            }),
        };
        const runs: PreflightProviderRunStore = {
            load: vi.fn(async () => run),
            reserve: vi.fn(),
            checkpointStarted: vi.fn(),
            checkpointRejected: vi.fn(),
            checkpointTerminal: vi.fn(),
        };
        const finalizeReadyWithSource = vi.fn(async () => true);
        const env = {
            ...preflightApifyPoolEnv,
            PRECHECKOUT_BLITE_ENABLED: 'true',
            PRECHECKOUT_BLITE_ROLLOUT_PERCENT: '100',
            ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: preflightIdentitySecret,
        };

        await expect(processPreflight(preflightId, {
            store,
            providerRunStore: runs,
            getFullProfile: vi.fn(async () => profile()),
            activateBliteCohort: vi.fn(async () => ({
                submittedAt: new Date(Date.now() - 1_000).toISOString(),
                deadlineAt: new Date(Date.now() + 89_000).toISOString(),
                expiresAt: new Date(Date.now() + 29 * 60_000).toISOString(),
            })),
            finalizeReadyWithSource,
            enqueueBliteInference: vi.fn(async () => 'enqueued' as const),
            env,
        })).resolves.toBe('ready');

        expect(runs.load).toHaveBeenCalledWith(expect.objectContaining({
            inputHash: persistedTargetHash,
        }));
        expect(finalizeReadyWithSource).toHaveBeenCalledWith(
            expect.objectContaining({ targetInputHash: persistedTargetHash }),
        );
    });

    it('preserves the claimed target hash when an expired B-lite activation fails open', async () => {
        const persistedTargetHash = 'c'.repeat(64);
        const claimed = claim({
            userId: null,
            targetInputHash: persistedTargetHash,
            leaseExpiresAt: new Date(Date.now() + 180_000).toISOString(),
        });
        const store = workerStore(claimed);
        const env = {
            ...preflightApifyPoolEnv,
            PRECHECKOUT_BLITE_ENABLED: 'true',
            PRECHECKOUT_BLITE_ROLLOUT_PERCENT: '100',
            ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: preflightIdentitySecret,
        };
        const run = {
            ...storedRun('succeeded'),
            inputHash: persistedTargetHash,
            credentialSlot: selectPreflightApifyCredentialSlot(preflightId, env),
        };
        const runs: PreflightProviderRunStore = {
            load: vi.fn(async () => run),
            reserve: vi.fn(),
            checkpointStarted: vi.fn(),
            checkpointRejected: vi.fn(),
            checkpointTerminal: vi.fn(),
        };
        const activateBliteCohort = vi.fn(async () => {
            throw new Error('PRECHECKOUT_BLITE_PREFLIGHT_FENCE_LOST');
        });
        const anonymousProfileCache = {
            load: vi.fn(async () => null),
            store: vi.fn(async () => true),
        };

        await expect(processPreflight(preflightId, {
            store,
            providerRunStore: runs,
            getFallbackProfile: vi.fn(async () => profile()),
            activateBliteCohort,
            anonymousProfileCache,
            env,
        })).resolves.toBe('ready');

        expect(runs.load).toHaveBeenCalledWith(expect.objectContaining({
            inputHash: persistedTargetHash,
        }));
        expect(store.finalizeReady).toHaveBeenCalledOnce();
        expect(store.finalizeBlocked).not.toHaveBeenCalled();
    });

    it('collects one Apify profile, commits its ready snapshot and bounded source, then enqueues', async () => {
        const claimed = claim();
        const store = workerStore(claimed);
        const collectedProfile = profile({
            latestPosts: [{
                id: 'post-1',
                shortCode: 'postone',
                type: 'image',
                likesCount: 10,
                commentsCount: 2,
                taggedUsers: [],
                mentionedUsers: [],
                hashtags: [],
                imageUrl: 'https://scontent.cdninstagram.com/post.jpg',
                timestamp: '2026-08-13T00:00:00.000Z',
            }],
        });
        const fullProfile = vi.fn(async () => collectedProfile);
        const fallback = vi.fn(async () => collectedProfile);
        const projectBliteSource = vi.fn(projectPrecheckoutBliteSource);
        const order: string[] = [];
        const authoritativeExpiresAt = `${new Date(Date.now() + 29 * 60_000)
            .toISOString().slice(0, -1)}044Z`;
        const activateBliteCohort = vi.fn(async () => ({
            submittedAt: new Date(Date.now() - 1_000).toISOString(),
            deadlineAt: new Date(Date.now() + 59_000).toISOString(),
            expiresAt: authoritativeExpiresAt,
        }));
        const finalizeReadyWithSource = vi.fn(async () => { order.push('finalize'); return true; });
        const enqueueBliteInference = vi.fn(async () => { order.push('enqueue'); return 'enqueued' as const; });
        const run = {
            ...storedRun('succeeded'),
            credentialSlot: selectPreflightApifyCredentialSlot(preflightId, {
                ...preflightApifyPoolEnv,
                PRECHECKOUT_BLITE_ENABLED: 'true',
                PRECHECKOUT_BLITE_ROLLOUT_PERCENT: '100',
                ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: preflightIdentitySecret,
            }),
        };
        const runs: PreflightProviderRunStore = {
            load: vi.fn(async () => run),
            reserve: vi.fn(),
            checkpointStarted: vi.fn(),
            checkpointRejected: vi.fn(),
            checkpointTerminal: vi.fn(),
        };

        await expect(processPreflight(preflightId, {
            store,
            providerRunStore: runs,
            getProfile: vi.fn(() => { throw new Error('cohort must not use selfhosted'); }),
            getFullProfile: fullProfile,
            getFallbackProfile: fallback,
            activateBliteCohort,
            projectBliteSource,
            finalizeReadyWithSource,
            enqueueBliteInference,
            env: {
                PRECHECKOUT_BLITE_ENABLED: 'true',
                PRECHECKOUT_BLITE_ROLLOUT_PERCENT: '100',
                ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: preflightIdentitySecret,
            },
        })).resolves.toBe('ready');

        expect(fullProfile).toHaveBeenCalledTimes(1);
        expect(fallback).not.toHaveBeenCalled();
        expect(projectBliteSource).toHaveBeenCalledWith(collectedProfile);
        expect(finalizeReadyWithSource).toHaveBeenCalledWith(expect.objectContaining({
            expiresAt: authoritativeExpiresAt,
            source: expect.objectContaining({
                posts: expect.arrayContaining([
                    expect.objectContaining({ likesCount: 10, commentsCount: 2 }),
                ]),
            }),
            providerOperationKey: 'target-profile-fallback',
            providerRunReference: 'StoredRun12345678',
            targetFollowersCount: collectedProfile.followersCount,
            targetFollowingCount: collectedProfile.followingCount,
        }));
        expect(store.finalizeReady).not.toHaveBeenCalled();
        expect(order).toEqual(['finalize', 'enqueue']);
    });

    it('retains a finalized B-lite fence after a definitive enqueue refusal for maintenance recovery', async () => {
        const dispatchToken = '623e4567-e89b-42d3-a456-426614174000'; // gitleaks:allow -- UUID fixture
        const reserveBliteDispatch = vi.fn(async () => ({
            shouldEnqueue: true,
            dispatchToken,
            dispatchGeneration: 1,
        }));
        const markBliteDispatchFailed = vi.fn(async () => true);
        const markBliteDispatchEnqueued = vi.fn(async () => true);
        const enqueueBliteInference = vi.fn()
            .mockRejectedValueOnce(new PreflightTaskEnqueueError('terminal'))
            .mockResolvedValueOnce('enqueued' as const);
        const store = {
            ...workerStore(null),
            reserveBliteDispatch,
            markBliteDispatchFailed,
            markBliteDispatchEnqueued,
        };
        const env = {
            PRECHECKOUT_BLITE_ENABLED: 'false',
            PRECHECKOUT_BLITE_ROLLOUT_PERCENT: '0',
            ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: preflightIdentitySecret,
        };

        await expect(processPreflight(preflightId, {
            store,
            enqueueBliteInference,
            env,
        })).rejects.toBeInstanceOf(PreflightTaskEnqueueError);
        await expect(processPreflight(preflightId, {
            store,
            enqueueBliteInference,
            env,
        })).resolves.toBe('noop');

        expect(store.claim).toHaveBeenCalledTimes(2);
        expect(reserveBliteDispatch).toHaveBeenCalledTimes(2);
        // A terminal create response is not an ownership proof: Cloud Tasks may have committed
        // before the refusal was observed. The enqueuing fence must remain recoverable.
        expect(markBliteDispatchFailed).not.toHaveBeenCalled();
        expect(markBliteDispatchEnqueued).toHaveBeenCalledWith({
            preflightId,
            dispatchGeneration: 1,
            dispatchToken,
        });
        expect(enqueueBliteInference).toHaveBeenCalledTimes(2);
    });

    it('retains a B-lite reservation after replayable enqueue ambiguity for maintenance recovery', async () => {
        const dispatchToken = '723e4567-e89b-42d3-a456-426614174000'; // gitleaks:allow -- UUID fixture
        const reserveBliteDispatch = vi.fn(async () => ({
            shouldEnqueue: true,
            dispatchToken,
            dispatchGeneration: 2,
        }));
        const markBliteDispatchFailed = vi.fn(async () => true);
        const markBliteDispatchEnqueued = vi.fn(async () => true);
        const enqueueBliteInference = vi.fn()
            .mockRejectedValueOnce(new PreflightTaskEnqueueError('replayable'))
            .mockResolvedValueOnce('enqueued' as const);
        const store = {
            ...workerStore(null),
            reserveBliteDispatch,
            markBliteDispatchFailed,
            markBliteDispatchEnqueued,
        };
        const env = {
            PRECHECKOUT_BLITE_ENABLED: 'false',
            PRECHECKOUT_BLITE_ROLLOUT_PERCENT: '0',
            ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: preflightIdentitySecret,
        };

        await expect(processPreflight(preflightId, {
            store,
            enqueueBliteInference,
            env,
        })).rejects.toBeInstanceOf(PreflightTaskEnqueueError);
        expect(markBliteDispatchFailed).not.toHaveBeenCalled();

        await expect(processPreflight(preflightId, {
            store,
            enqueueBliteInference,
            env,
        })).resolves.toBe('noop');
        expect(markBliteDispatchEnqueued).toHaveBeenCalledWith({
            preflightId,
            dispatchGeneration: 2,
            dispatchToken,
        });
        expect(enqueueBliteInference).toHaveBeenCalledTimes(2);
    });

    it('does not enqueue a legacy/cohort-off claim-null replay', async () => {
        const reserveBliteDispatch = vi.fn(async () => ({
            shouldEnqueue: false,
            dispatchToken: null,
        }));
        const enqueueBliteInference = vi.fn(async () => 'enqueued' as const);
        const store = {
            ...workerStore(null),
            reserveBliteDispatch,
        };

        await expect(processPreflight(preflightId, {
            store,
            enqueueBliteInference,
            env: {
                PRECHECKOUT_BLITE_ENABLED: 'false',
                PRECHECKOUT_BLITE_ROLLOUT_PERCENT: '0',
            },
        })).resolves.toBe('noop');

        expect(reserveBliteDispatch).toHaveBeenCalledWith(preflightId);
        expect(enqueueBliteInference).not.toHaveBeenCalled();
    });
});

beforeAll(() => {
    vi.stubEnv('ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET', preflightIdentitySecret);
    vi.stubEnv('IMAGE_PROXY_SIGNING_SECRET', imageProxySigningSecret);
});

afterAll(() => {
    vi.unstubAllEnvs();
});

it('classifies a definite provider start rejection as non-retryable', () => {
    expect(classifyPreflightError(
        new Error('SCRAPING_PROVIDER_START_REJECTED_ERROR')
    )).toEqual({
        category: 'provider',
        retryable: false,
        httpStatus: null,
        paidFallbackEligible: false,
    });
});

it('classifies an immutable B-lite fence loss as non-retryable persistence', () => {
    expect(classifyPreflightError(
        new Error('PRECHECKOUT_BLITE_PREFLIGHT_FENCE_LOST')
    )).toEqual({
        category: 'persistence',
        retryable: false,
        httpStatus: null,
        paidFallbackEligible: false,
    });
});

it('classifies rejection checkpoint failure as retryable persistence', () => {
    expect(classifyPreflightError(
        new Error('ANALYSIS_V2_PROVIDER_RUN_REJECTION_PERSISTENCE_ERROR')
    )).toEqual({
        category: 'persistence',
        retryable: true,
        httpStatus: null,
        paidFallbackEligible: false,
    });
});

it('classifies provider admission persistence and identity failures without opening fallback', () => {
    expect(classifyPreflightError(
        new Error('ANALYSIS_PROVIDER_ADMISSION_PERSISTENCE_ERROR: acquire failed.'),
    )).toEqual({
        category: 'persistence',
        retryable: true,
        httpStatus: null,
        paidFallbackEligible: false,
    });
    expect(classifyPreflightError(
        new Error('ANALYSIS_PROVIDER_ADMISSION_IDENTITY_CONFLICT'),
    )).toEqual({
        category: 'persistence',
        retryable: false,
        httpStatus: null,
        paidFallbackEligible: false,
    });
});

function profile(overrides: Partial<InstagramProfile> = {}): InstagramProfile {
    return {
        username: 'target.name',
        fullName: 'Target',
        bio: 'bio',
        profilePicUrl: 'https://scontent.cdninstagram.com/avatar.jpg',
        followersCount: 350,
        followingCount: 300,
        postsCount: 10,
        isPrivate: false,
        isVerified: false,
        ...overrides,
    };
}

function claim(overrides: Partial<ClaimedPreflight> = {}): ClaimedPreflight {
    return {
        preflightId,
        claimToken,
        userId,
        targetInstagramId: 'target.name',
        accessMode: 'test_entitlement',
        workerAttemptCount: 1,
        targetInputHash: preflightInputHash,
        catalogSnapshot: {
            plans: {
                basic: {
                    launchStatus: 'test_only',
                    relationshipCapacity: { followers: 400, following: 400 },
                    detailedMutualLimit: 300,
                },
                standard: {
                    launchStatus: 'test_only',
                    relationshipCapacity: { followers: 800, following: 800 },
                    detailedMutualLimit: 600,
                },
                plus: {
                    launchStatus: 'test_only',
                    relationshipCapacity: { followers: 1_200, following: 1_200 },
                    detailedMutualLimit: 900,
                },
            },
            pricingVersion: 'deferred',
            prices: {
                basic: { status: 'deferred', currency: 'KRW', amountKrw: null },
                standard: { status: 'deferred', currency: 'KRW', amountKrw: null },
                plus: { status: 'deferred', currency: 'KRW', amountKrw: null },
            },
        } satisfies PreflightCatalogSnapshot,
        ...overrides,
    };
}

function providerRunStore(): PreflightProviderRunStore {
    return {
        load: vi.fn(async () => null),
        reserve: vi.fn(),
        checkpointStarted: vi.fn(),
        checkpointRejected: vi.fn(),
        checkpointTerminal: vi.fn(),
    };
}

function storedRun(
    status: StoredPreflightProviderRun['status'] = 'running'
): StoredPreflightProviderRun {
    const rejected = status === 'rejected';
    return {
        preflightId,
        operationKey: 'target-profile-fallback',
        inputHash: preflightInputHash,
        logicalProvider: 'apify' as const,
        actorId: APIFY_PROFILE_ACTOR_ID,
        credentialSlot: 'quinary' as const,
        maxChargeUsd: 0.0026 as const,
        status,
        runId: status === 'starting' || rejected ? null : 'StoredRun12345678',
        actualUsageUsd: rejected ? 0 : null,
        reservedAt: '2026-07-14T17:59:00.000Z',
        runStartedAt: status === 'starting' || rejected
            ? null
            : '2026-07-14T17:59:30.000Z',
        terminalizedAt: status === 'succeeded' || rejected
            ? '2026-07-14T18:05:00.000Z'
            : null,
        usageReconciledAt: rejected ? '2026-07-14T18:05:00.000Z' : null,
    };
}

async function completeFallbackRun(
    context: ProviderCallContext | undefined,
    result: InstagramProfile | null = profile()
) {
    const credentialSlot = context?.credentialSlot ?? 'quinary';
    await context?.onBeforeRunStart?.({
        logicalProvider: 'apify',
        actorId: APIFY_PROFILE_ACTOR_ID,
        credentialSlot,
        maxChargeUsd: 0.0026,
    });
    await context?.onRunStarted?.('StartedRun1234567');
    await context?.onCostRunStarted?.({
        logicalProvider: 'apify',
        actorId: APIFY_PROFILE_ACTOR_ID,
        credentialSlot,
        maxChargeUsd: 0.0026,
        runId: 'StartedRun1234567',
    });
    await context?.onCostRunFinished?.({
        logicalProvider: 'apify',
        actorId: APIFY_PROFILE_ACTOR_ID,
        credentialSlot,
        maxChargeUsd: 0.0026,
        runId: 'StartedRun1234567',
        status: 'succeeded',
        usageTotalUsd: null,
    });
    return result;
}

function workerStore(claimed: ClaimedPreflight | null = claim()) {
    return {
        createOrReplay: vi.fn(),
        findForOwner: vi.fn(),
        reserveDispatch: vi.fn(),
        markDispatched: vi.fn(),
        claim: vi.fn(async () => claimed),
        releaseClaim: vi.fn(async () => undefined),
        finalizeReady: vi.fn(async () => undefined),
        finalizeBlocked: vi.fn(async () => undefined),
        blockQueueUnavailable: vi.fn(async () => undefined),
        setExclusion: vi.fn(async () => undefined),
    } satisfies PreflightStore;
}

describe('preflight persistence adapter', () => {
    it.each([
        ['off', 'production', {
            pipeline: 'v2', risk: RISK_POLICY_VERSION, aiStage: AI_STAGE_POLICY_LATEST_VERSION,
        }],
        ['test_entitlement', 'production', {
            pipeline: 'v2', risk: RISK_POLICY_VERSION, aiStage: AI_STAGE_POLICY_LATEST_VERSION,
        }],
        ['test_entitlement', 'test_entitlement', {
            pipeline: 'v2', risk: RISK_POLICY_VERSION, aiStage: AI_STAGE_POLICY_LATEST_VERSION,
            scheduler: AI_SCHEDULER_POLICY_ID,
        }],
        ['production', 'production', {
            pipeline: 'v2', risk: RISK_POLICY_VERSION, aiStage: AI_STAGE_POLICY_LATEST_VERSION,
            scheduler: AI_SCHEDULER_POLICY_ID,
        }],
        ['production', 'test_entitlement', {
            pipeline: 'v2', risk: RISK_POLICY_VERSION, aiStage: AI_STAGE_POLICY_LATEST_VERSION,
            scheduler: AI_SCHEDULER_POLICY_ID,
        }],
        [undefined, 'production', {
            pipeline: 'v2', risk: RISK_POLICY_VERSION, aiStage: AI_STAGE_POLICY_LATEST_VERSION,
        }],
        ['invalid', 'production', {
            pipeline: 'v2', risk: RISK_POLICY_VERSION, aiStage: AI_STAGE_POLICY_LATEST_VERSION,
        }],
    ] as const)('builds the exact scheduler snapshot for %s rollout and %s access', (
        rolloutMode,
        accessMode,
        expected,
    ) => {
        vi.stubEnv('ANALYSIS_V2_GENDER_RESOLUTION_ROLLOUT', 'production');
        vi.stubEnv('ANALYSIS_V2_AI_SCHEDULER_ROLLOUT', rolloutMode ?? '');

        expect(preflightPolicyVersions(accessMode)).toStrictEqual(expected);
    });

    it('keeps RPC names centralized and sends authenticated identity to create/replay', async () => {
        vi.stubEnv('ANALYSIS_V2_GENDER_RESOLUTION_ROLLOUT', 'test_entitlement');
        vi.stubEnv('ANALYSIS_V2_AI_SCHEDULER_ROLLOUT', 'off');
        const rpc = vi.fn(async () => ({
            data: [{
                preflight_id: preflightId,
                expires_at: expiresAt,
                created: true,
                preflight_status: 'pending',
            }],
            error: null,
        }));
        const store = createSupabasePreflightStore({
            rpc,
            from: vi.fn() as never,
        });

        await expect(store.createOrReplay({
            userId,
            email: 'owner@example.com',
            authProvider: 'google',
            targetInstagramId: 'target.name',
            targetInputHash: 'a'.repeat(64),
            idempotencyKey: 'preflight-key-000000000000',
            accessMode: 'test_entitlement',
        })).resolves.toEqual({ preflightId, expiresAt, created: true, status: 'pending' });
        expect(rpc).toHaveBeenCalledWith('create_or_replay_analysis_v2_preflight_with_target_hash', {
            p_user_id: userId,
            p_email: 'owner@example.com',
            p_auth_provider: 'google',
            p_target_instagram_id: 'target.name',
            p_target_input_hash: 'a'.repeat(64),
            p_idempotency_key: 'preflight-key-000000000000',
            p_access_mode: 'test_entitlement',
            p_launch_status_snapshot: {
                basic: 'production',
                standard: 'production',
                plus: 'production',
            },
            p_plan_catalog_snapshot: {
                basic: {
                    launchStatus: 'production',
                    relationshipCapacity: { followers: 400, following: 400 },
                    detailedMutualLimit: 300,
                },
                standard: {
                    launchStatus: 'production',
                    relationshipCapacity: { followers: 800, following: 800 },
                    detailedMutualLimit: 600,
                },
                plus: {
                    launchStatus: 'production',
                    relationshipCapacity: { followers: 1_200, following: 1_200 },
                    detailedMutualLimit: 900,
                },
            },
            p_pricing_version: 'earlybird-2026-08-v5',
            p_pricing_snapshot: {
                basic: { status: 'quoted', currency: 'KRW', amountKrw: 9_900 },
                standard: { status: 'quoted', currency: 'KRW', amountKrw: 19_900 },
                plus: { status: 'deferred', currency: 'KRW', amountKrw: null },
            },
            p_policy_versions_snapshot: {
                pipeline: 'v2',
                risk: RISK_POLICY_VERSION,
                aiStage: AI_STAGE_POLICY_LATEST_VERSION,
            },
        });
        vi.stubEnv('ANALYSIS_V2_GENDER_RESOLUTION_ROLLOUT', 'off');
    });

    it('owner-filters reads and reconstructs ready DTO state from decomposed columns', async () => {
        const snapshot = buildReadyPreflightSnapshot(
            profile(),
            'test_entitlement'
        ) as ReadyPreflightSnapshot;
        const planCards = Object.fromEntries(snapshot.plans.map(plan => [plan.planId, {
            launchStatus: plan.launchStatus,
            relationshipCapacity: plan.relationshipCapacity,
            detailedMutualLimit: plan.detailedMutualLimit,
            selectionState: plan.selectionState,
            unavailableReason: plan.unavailableReason,
        }]));
        const prices = Object.fromEntries(snapshot.plans.map(plan => [plan.planId, plan.price]));
        const launches = Object.fromEntries(
            snapshot.plans.map(plan => [plan.planId, plan.launchStatus])
        );
        const query: Record<string, ReturnType<typeof vi.fn>> = {};
        query.select = vi.fn(() => query);
        query.eq = vi.fn(() => query);
        query.maybeSingle = vi.fn(async () => ({
            data: {
                id: preflightId,
                status: 'ready',
                expires_at: expiresAt,
                error_code: null,
                target_instagram_id: snapshot.target.username,
                target_full_name: snapshot.target.fullName,
                target_bio: snapshot.target.bio,
                target_profile_image_url: snapshot.target.profileImageUrl,
                target_followers_count: snapshot.target.followersCount,
                target_following_count: snapshot.target.followingCount,
                target_is_private: false,
                access_mode: snapshot.accessMode,
                launch_status_snapshot: launches,
                capacity_required_plan_id: snapshot.capacityRequiredPlan,
                required_plan_id: snapshot.requiredPlan,
                plan_cards_snapshot: planCards,
                pricing_version: snapshot.pricingVersion,
                pricing_snapshot: prices,
                exclusion_decision: 'exclude',
            },
            error: null,
        }));
        const store = createSupabasePreflightStore({
            rpc: vi.fn() as never,
            from: vi.fn(() => query as never),
        });

        await expect(store.findForOwner(preflightId, userId)).resolves.toMatchObject({
            preflightId,
            status: 'ready',
            readySnapshot: {
                target: { username: 'target.name' },
                requiredPlan: 'basic',
                plans: [{ planId: 'basic' }, { planId: 'standard' }, { planId: 'plus' }],
            },
        });
        expect(query.eq).toHaveBeenNthCalledWith(1, 'id', preflightId);
        expect(query.eq).toHaveBeenNthCalledWith(2, 'user_id', userId);
        expect(query.select).toHaveBeenCalledWith(expect.stringContaining('exclusion_decision'));
        expect(query.select.mock.calls[0][0]).not.toContain('excluded_instagram_id');
    });

    it('uses fenced completion, blocking, and scalar exclusion RPC contracts', async () => {
        const rpc = vi.fn(async () => ({ data: true, error: null }));
        const store = createSupabasePreflightStore({
            rpc,
            from: vi.fn() as never,
        });
        const snapshot = buildReadyPreflightSnapshot(
            profile(),
            'test_entitlement'
        ) as ReadyPreflightSnapshot;

        await store.finalizeReady(claim(), snapshot);
        await store.finalizeBlocked(claim(), 'TARGET_NOT_FOUND');
        await store.blockQueueUnavailable(preflightId, userId);
        await store.setExclusion({
            preflightId,
            userId,
            decision: 'exclude',
            excludedInstagramId: 'owner.name',
        });

        expect(rpc).toHaveBeenNthCalledWith(1, PREFLIGHT_DATABASE_NAMES.completeRpc, {
            p_preflight_id: preflightId,
            p_user_id: userId,
            p_claim_token: claimToken,
            p_target_full_name: 'Target',
            p_target_bio: 'bio',
            p_target_profile_image_url: 'https://scontent.cdninstagram.com/avatar.jpg',
            p_target_followers_count: 350,
            p_target_following_count: 300,
            p_target_is_private: false,
            p_capacity_required_plan_id: 'basic',
            p_required_plan_id: 'basic',
            p_plan_cards_snapshot: expect.objectContaining({
                basic: expect.objectContaining({
                    selectionState: 'required',
                    detailedMutualLimit: 300,
                }),
            }),
        });
        expect(rpc).toHaveBeenNthCalledWith(2, PREFLIGHT_DATABASE_NAMES.blockRpc, {
            p_preflight_id: preflightId,
            p_user_id: userId,
            p_claim_token: claimToken,
            p_error_code: 'TARGET_NOT_FOUND',
        });
        expect(rpc).toHaveBeenNthCalledWith(3, PREFLIGHT_DATABASE_NAMES.blockRpc, {
            p_preflight_id: preflightId,
            p_user_id: userId,
            p_claim_token: null,
            p_error_code: 'QUEUE_UNAVAILABLE',
        });
        expect(rpc).toHaveBeenNthCalledWith(4, PREFLIGHT_DATABASE_NAMES.exclusionRpc, {
            p_preflight_id: preflightId,
            p_user_id: userId,
            p_decision: 'exclude',
            p_excluded_instagram_id: 'owner.name',
        });
    });

    it('maps a conflicting write-once exclusion decision to an immutable error', async () => {
        const store = createSupabasePreflightStore({
            rpc: vi.fn(async () => ({
                data: null,
                error: { code: 'P0001', message: 'PREFLIGHT_IMMUTABLE' },
            })),
            from: vi.fn() as never,
        });

        const update = store.setExclusion({
            preflightId,
            userId,
            decision: 'skip',
            excludedInstagramId: null,
        });

        await expect(update).rejects.toBeInstanceOf(PreflightImmutableError);
        await expect(update).rejects.toMatchObject({ message: 'PREFLIGHT_IMMUTABLE' });
    });

    it('maps a blocked preflight exclusion RPC result to an immutable error', async () => {
        const store = createSupabasePreflightStore({
            rpc: vi.fn(async () => ({
                data: null,
                error: {
                    code: 'P0001',
                    message: 'ANALYSIS_V2_PREFLIGHT_NOT_READY',
                },
            })),
            from: vi.fn() as never,
        });

        await expect(store.setExclusion({
            preflightId,
            userId,
            decision: 'skip',
            excludedInstagramId: null,
        })).rejects.toMatchObject({
            name: 'PreflightImmutableError',
            message: 'ANALYSIS_V2_PREFLIGHT_NOT_READY',
        });
    });

    it('reserves and marks one durable dispatch generation', async () => {
        const reservationToken = '423e4567-e89b-42d3-a456-426614174000'; // gitleaks:allow -- UUID fixture
        const rpc = vi.fn(async (...args: [string, Record<string, unknown>?]) => (
            args[0] === PREFLIGHT_DATABASE_NAMES.reserveDispatchRpc
            ? {
                data: [{
                    should_enqueue: true,
                    dispatch_generation: 2,
                    reservation_token: reservationToken,
                    preflight_status: 'pending',
                }],
                error: null,
            }
            : { data: true, error: null }
        ));
        const store = createSupabasePreflightStore({ rpc, from: vi.fn() as never });

        const reservation = await store.reserveDispatch(preflightId, userId);
        expect(reservation).toEqual({
            shouldEnqueue: true,
            generation: 2,
            reservationToken,
            status: 'pending',
        });
        expect(rpc.mock.calls[0][1]).toMatchObject({
            p_preflight_id: preflightId,
            p_user_id: userId,
            p_dispatch_token: expect.stringMatching(/^[0-9a-f-]{36}$/),
        });

        await store.markDispatched({
            preflightId,
            userId,
            generation: reservation.generation,
            reservationToken: reservation.reservationToken!,
        });
        expect(rpc).toHaveBeenNthCalledWith(2, PREFLIGHT_DATABASE_NAMES.markDispatchedRpc, {
            p_preflight_id: preflightId,
            p_user_id: userId,
            p_dispatch_generation: 2,
            p_dispatch_token: reservationToken,
            p_workload_role: 'preflight',
            p_contract_version: 2,
        });
    });

    it('reserves, fails, and recovers a finalized B-lite dispatch without duplicating the provider run', async () => {
        const dispatchToken = '523e4567-e89b-42d3-a456-426614174000'; // gitleaks:allow -- UUID fixture
        const rpc = vi.fn(async (...args: [string, Record<string, unknown>?]) => {
            if (args[0] === PREFLIGHT_DATABASE_NAMES.bliteDispatchReserveRpc) {
                return {
                    data: { should_enqueue: true, dispatch_token: dispatchToken },
                    error: null,
                };
            }
            return { data: true, error: null };
        });
        const store = createSupabasePreflightStore({ rpc, from: vi.fn() as never });

        await expect(store.reserveBliteDispatch!(preflightId)).resolves.toEqual({
            shouldEnqueue: true,
            dispatchToken,
        });
        await expect(store.markBliteDispatchFailed!({ preflightId, dispatchToken })).resolves.toBe(true);
        await expect(store.markBliteDispatchEnqueued!({
            preflightId,
            dispatchGeneration: 1,
            dispatchToken,
        })).resolves.toBe(true);
        expect(rpc.mock.calls.map(call => call[0])).toEqual([
            PREFLIGHT_DATABASE_NAMES.bliteDispatchReserveRpc,
            PREFLIGHT_DATABASE_NAMES.bliteDispatchFailedRpc,
            PREFLIGHT_DATABASE_NAMES.bliteDispatchEnqueuedRpc,
        ]);
    });

    it('persists and validates the dedicated beta prepare lifecycle fence', async () => {
        const prepareToken = preflightId.replace(/^1/, '4');
        const rpc = vi.fn(async (...args: [string, Record<string, unknown>?]) => {
            if (args[0] === PREFLIGHT_DATABASE_NAMES.createOrReplayBetaRpc) {
                return { data: [{
                    preflight_id: preflightId,
                    expires_at: expiresAt,
                    created: true,
                    preflight_status: 'pending',
                    prepare_generation: 2,
                    prepare_token: prepareToken,
                    should_enqueue: true,
                }], error: null };
            }
            if (args[0] === PREFLIGHT_DATABASE_NAMES.claimBetaPrepareRpc) {
                return { data: [{
                    claimed: true,
                    prepare_state: 'preparing',
                    claim_disposition: 'claimed',
                }], error: null };
            }
            if (args[0] === PREFLIGHT_DATABASE_NAMES.blockBetaPrepareCapacityRpc) {
                return { data: 'blocked', error: null };
            }
            return { data: true, error: null };
        });
        const store = createSupabasePreflightStore({ rpc, from: vi.fn() as never });
        const created = await store.createOrReplayBeta({
            userId,
            email: 'owner@example.com',
            authProvider: 'google',
            targetInstagramId: 'target.name',
            idempotencyKey: 'betatest-entry-key-000001',
        });
        expect(created).toEqual({
            preflightId, expiresAt, created: true, status: 'pending',
            prepareGeneration: 2, prepareToken, shouldEnqueue: true,
        });
        expect(rpc).toHaveBeenNthCalledWith(
            1,
            PREFLIGHT_DATABASE_NAMES.createOrReplayBetaRpc,
            expect.objectContaining({
                p_user_id: userId,
                p_beta_prepare_token: expect.stringMatching(/^[0-9a-f-]{36}$/),
            })
        );
        await store.markBetaPrepareDispatched({
            preflightId, userId, prepareGeneration: 2, prepareToken,
        });
        const claim = await store.claimBetaPrepare({
            preflightId, userId, prepareGeneration: 2, prepareToken,
        });
        expect(claim).toMatchObject({
            claimed: true, state: 'preparing',
            claimToken: expect.stringMatching(/^[0-9a-f-]{36}$/),
            disposition: 'claimed',
        });
        await expect(store.blockBetaPrepareCapacity({
            preflightId, userId, prepareGeneration: 2, prepareToken,
            claimToken: claim.claimToken,
        })).resolves.toBe('blocked');
        expect(rpc.mock.calls.map(call => call[0])).toEqual([
            PREFLIGHT_DATABASE_NAMES.createOrReplayBetaRpc,
            PREFLIGHT_DATABASE_NAMES.markBetaPrepareDispatchedRpc,
            PREFLIGHT_DATABASE_NAMES.claimBetaPrepareRpc,
            PREFLIGHT_DATABASE_NAMES.blockBetaPrepareCapacityRpc,
        ]);
    });

    it('parses an expired beta prepare claim as a terminal no-claim result', async () => {
        const rpc = vi.fn(async () => ({
            data: [{
                claimed: false,
                prepare_state: 'expired',
                claim_disposition: 'terminal',
            }],
            error: null,
        }));
        const store = createSupabasePreflightStore({
            rpc,
            from: vi.fn() as never,
        });

        await expect(store.claimBetaPrepare({
            preflightId,
            userId,
            prepareGeneration: 1,
            prepareToken: preflightId.replace(/^1/, '4'),
        })).resolves.toEqual({
            claimed: false,
            state: 'expired',
            claimToken: null,
            disposition: 'terminal',
        });
    });

    it('parses retry exhaustion as terminal across claim, block, and release', async () => {
        const rpc = vi.fn(async (name: string) => {
            if (name === PREFLIGHT_DATABASE_NAMES.claimBetaPrepareRpc) {
                return {
                    data: [{
                        claimed: false,
                        prepare_state: 'retry_exhausted',
                        claim_disposition: 'terminal',
                    }],
                    error: null,
                };
            }
            if (name === PREFLIGHT_DATABASE_NAMES.blockBetaPrepareCapacityRpc) {
                return { data: 'retry_exhausted', error: null };
            }
            if (name === PREFLIGHT_DATABASE_NAMES.releaseBetaPrepareClaimRpc) {
                return { data: false, error: null };
            }
            throw new Error(`unexpected rpc: ${name}`);
        });
        const store = createSupabasePreflightStore({
            rpc,
            from: vi.fn() as never,
        });
        const prepareToken = preflightId.replace(/^1/, '4');

        await expect(store.claimBetaPrepare({
            preflightId,
            userId,
            prepareGeneration: 1,
            prepareToken,
        })).resolves.toEqual({
            claimed: false,
            state: 'retry_exhausted',
            claimToken: null,
            disposition: 'terminal',
        });
        await expect(store.blockBetaPrepareCapacity({
            preflightId,
            userId,
            prepareGeneration: 1,
            prepareToken,
            claimToken: null,
        })).resolves.toBe('retry_exhausted');
        await expect(store.releaseBetaPrepareClaim({
            preflightId,
            userId,
            prepareGeneration: 1,
            prepareToken,
            claimToken: userId,
        })).resolves.toBe(false);
    });

    it('maps a database beta access race to one sanitized typed error', async () => {
        const store = createSupabasePreflightStore({
            rpc: vi.fn(async () => ({
                data: null,
                error: {
                    message: 'ANALYSIS_BETA_ACCESS_UNAVAILABLE provider-detail',
                },
            })),
            from: vi.fn() as never,
        });

        await expect(store.createOrReplayBeta({
            userId,
            email: 'owner@example.com',
            authProvider: 'google',
            targetInstagramId: 'target.name',
            idempotencyKey: 'betatest-access-race-000001',
        })).rejects.toEqual(new BetaPreflightAccessUnavailableError());
    });

    it('keeps an active-lease duplicate delivery retryable instead of acknowledging it', async () => {
        const store = createSupabasePreflightStore({
            rpc: vi.fn(async (name: string) => name === PREFLIGHT_DATABASE_NAMES.claimedTargetHashRpc
                ? { data: preflightInputHash, error: null }
                : { data: [{
                    preflight_id: preflightId,
                    user_id: userId,
                    claimed: false,
                    target_instagram_id: null,
                    access_mode: 'test_entitlement',
                    worker_attempt_count: 1,
                    lease_expires_at: expiresAt,
                    preflight_status: 'processing',
                }], error: null }),
            from: vi.fn() as never,
        });

        await expect(store.claim(preflightId)).rejects.toBeInstanceOf(
            PreflightLeaseBusyError
        );
    });

    it('claims the immutable stored catalog even when its pricing version is not current', async () => {
        const storedCatalog = claim().catalogSnapshot;
        const store = createSupabasePreflightStore({
            rpc: vi.fn(async (name: string) => name === PREFLIGHT_DATABASE_NAMES.claimedTargetHashRpc
                ? { data: preflightInputHash, error: null }
                : { data: [{
                    preflight_id: preflightId,
                    user_id: userId,
                    claimed: true,
                    target_instagram_id: 'target.name',
                    access_mode: 'test_entitlement',
                    plan_catalog_snapshot: storedCatalog.plans,
                    pricing_version: 'quoted-v1',
                    pricing_snapshot: {
                        basic: { status: 'quoted', currency: 'KRW', amountKrw: 9_900 },
                        standard: { status: 'quoted', currency: 'KRW', amountKrw: 14_900 },
                        plus: { status: 'quoted', currency: 'KRW', amountKrw: 19_900 },
                    },
                    worker_attempt_count: 1,
                    lease_expires_at: expiresAt,
                    preflight_status: 'processing',
                }], error: null }),
            from: vi.fn() as never,
        });

        await expect(store.claim(preflightId)).resolves.toMatchObject({
            workerAttemptCount: 1,
            catalogSnapshot: {
                pricingVersion: 'quoted-v1',
                prices: {
                    standard: { status: 'quoted', amountKrw: 14_900 },
                },
            },
        });
    });
});

describe('preflight worker domain', () => {
    it('selects the deterministic three-account slot for a new anonymous fallback', async () => {
        const selectedPreflightId = '123e4567-e89b-42d3-a456-000000000001';
        const env = {
            ...preflightApifyPoolEnv,
            ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: preflightIdentitySecret,
        };
        const baseClaim = claim();
        const selectedClaim = claim({
            preflightId: selectedPreflightId,
            userId: null,
            accessMode: 'production',
            catalogSnapshot: {
                ...baseClaim.catalogSnapshot,
                plans: Object.fromEntries(Object.entries(
                    baseClaim.catalogSnapshot.plans,
                ).map(([planId, plan]) => [planId, {
                    ...plan,
                    launchStatus: 'production' as const,
                }])) as PreflightCatalogSnapshot['plans'],
            },
        });
        const selectedSlot = selectPreflightApifyCredentialSlot(selectedPreflightId, env);
        const runs = providerRunStore();
        vi.mocked(runs.reserve).mockImplementation(async input => ({
            created: true,
            run: {
                ...storedRun('starting'),
                preflightId: selectedPreflightId,
                credentialSlot: input.credentialSlot,
            },
        }));
        const apify = vi.fn(async (
            _username: string,
            context?: ProviderCallContext,
        ) => {
            expect(context?.credentialSlot).toBe(selectedSlot);
            await context?.onBeforeRunStart?.({
                logicalProvider: 'apify',
                actorId: APIFY_PROFILE_ACTOR_ID,
                credentialSlot: selectedSlot,
                maxChargeUsd: 0.0026,
            });
            return profile();
        });

        await expect(processPreflight(selectedPreflightId, {
            store: workerStore(selectedClaim),
            getFallbackProfile: apify,
            providerRunStore: runs,
            anonymousProfileCache: {
                load: vi.fn(async () => null),
                store: vi.fn(async () => true),
            },
            env,
        })).resolves.toBe('ready');

        expect(apify).toHaveBeenCalledOnce();
        expect(runs.reserve).toHaveBeenCalledWith(expect.objectContaining({
            preflightId: selectedPreflightId,
            credentialSlot: selectedSlot,
        }));
    });

    it('selects the deterministic three-account slot for a new standard fallback', async () => {
        const selectedPreflightId = '123e4567-e89b-42d3-a456-000000000001';
        const env = {
            ...preflightApifyPoolEnv,
            ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: preflightIdentitySecret,
        };
        const selectedClaim = claim({ preflightId: selectedPreflightId });
        const selectedSlot = selectPreflightApifyCredentialSlot(selectedPreflightId, env);
        const runs = providerRunStore();
        vi.mocked(runs.reserve).mockImplementation(async input => ({
            created: true,
            run: {
                ...storedRun('starting'),
                preflightId: selectedPreflightId,
                credentialSlot: input.credentialSlot,
            },
        }));
        const apify = vi.fn(async (
            _username: string,
            context?: ProviderCallContext,
        ) => {
            expect(context?.credentialSlot).toBe(selectedSlot);
            await context?.onBeforeRunStart?.({
                logicalProvider: 'apify',
                actorId: APIFY_PROFILE_ACTOR_ID,
                credentialSlot: selectedSlot,
                maxChargeUsd: 0.0026,
            });
            return profile();
        });

        await expect(processPreflight(selectedPreflightId, {
            store: workerStore(selectedClaim),
            getProfile: vi.fn(async () => {
                throw new Error('SCRAPING_SCHEMA_ERROR: force paid fallback');
            }),
            getFallbackProfile: apify,
            providerRunStore: runs,
            env,
        })).resolves.toBe('ready');

        expect(apify).toHaveBeenCalledOnce();
        expect(runs.reserve).toHaveBeenCalledWith(expect.objectContaining({
            preflightId: selectedPreflightId,
            credentialSlot: selectedSlot,
        }));
    });

    it('rejects a misconfigured preflight pool before reserving or starting paid work', async () => {
        const store = workerStore();
        const runs = providerRunStore();
        const fallback = vi.fn();

        await expect(processPreflight(preflightId, {
            store,
            getProfile: vi.fn(async () => {
                throw new Error('SCRAPING_SCHEMA_ERROR: trigger paid fallback');
            }),
            getFallbackProfile: fallback,
            providerRunStore: runs,
            env: {
                ...preflightApifyPoolEnv,
                PREFLIGHT_APIFY_API_TOKEN_SLOTS: 'primary,quinary,tenth',
                ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: preflightIdentitySecret,
            },
        })).resolves.toBe('blocked');

        expect(fallback).not.toHaveBeenCalled();
        expect(runs.reserve).not.toHaveBeenCalled();
    });

    it('routes anonymous profile summaries to Apify and reuses the global summary cache', async () => {
        const baseAnonymousClaim = claim();
        const anonymousPlans = Object.fromEntries(
            Object.entries(baseAnonymousClaim.catalogSnapshot.plans).map(([planId, plan]) => [
                planId,
                { ...plan, launchStatus: 'production' as const },
            ])
        ) as PreflightCatalogSnapshot['plans'];
        const anonymousClaim = claim({
            userId: null,
            accessMode: 'production',
            catalogSnapshot: {
                ...baseAnonymousClaim.catalogSnapshot,
                plans: anonymousPlans,
            },
        });
        const firstStore = workerStore(anonymousClaim);
        const secondStore = workerStore(anonymousClaim);
        const cache = {
            load: vi.fn()
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce(profile()),
            store: vi.fn(async () => true),
        };
        const authenticated = vi.fn(async () => profile());
        const apify = vi.fn(async () => profile());

        await expect(processPreflight(preflightId, {
            store: firstStore,
            getProfile: authenticated,
            getFallbackProfile: apify,
            providerRunStore: providerRunStore(),
            anonymousProfileCache: cache,
            env: preflightApifyPoolEnv,
        })).resolves.toBe('ready');
        await expect(processPreflight(preflightId, {
            store: secondStore,
            getProfile: authenticated,
            getFallbackProfile: apify,
            providerRunStore: providerRunStore(),
            anonymousProfileCache: cache,
            env: preflightApifyPoolEnv,
        })).resolves.toBe('ready');

        expect(apify).toHaveBeenCalledOnce();
        expect(authenticated).not.toHaveBeenCalled();
        expect(cache.store).toHaveBeenCalledOnce();
        expect(firstStore.finalizeReady).toHaveBeenCalledWith(
            anonymousClaim,
            expect.objectContaining({ requiredPlan: 'basic' }),
        );
    });

    it('reports safe profile and ready metadata without profile content', async () => {
        const observer = vi.fn();

        await expect(processPreflight(preflightId, {
            store: workerStore(),
            getProfile: vi.fn(async () => profile()),
            providerRunStore: providerRunStore(),
            observer,
        })).resolves.toBe('ready');

        expect(observer.mock.calls).toEqual([
            [{
                type: 'profile_collected',
                preflightId,
                userId,
                targetInstagramId: 'target.name',
                followersCount: 350,
                followingCount: 300,
            }],
            [{
                type: 'completed',
                outcome: 'ready',
                preflightId,
                userId,
                targetInstagramId: 'target.name',
                followersCount: 350,
                followingCount: 300,
                requiredPlan: 'basic',
            }],
        ]);
        expect(JSON.stringify(observer.mock.calls)).not.toMatch(
            /bio|Target|cdninstagram|avatar/
        );
    });

    it('keeps preflight processing fail-open when its optional observer throws', async () => {
        const store = workerStore();
        const observer = vi.fn(() => {
            throw new Error('telemetry unavailable');
        });

        await expect(processPreflight(preflightId, {
            store,
            getProfile: vi.fn(async () => profile()),
            providerRunStore: providerRunStore(),
            observer,
        })).resolves.toBe('ready');

        expect(observer).toHaveBeenCalledTimes(2);
        expect(store.finalizeReady).toHaveBeenCalledOnce();
    });

    it('reports a fetched private profile before its blocked completion', async () => {
        const observer = vi.fn();

        await expect(processPreflight(preflightId, {
            store: workerStore(),
            getProfile: vi.fn(async () => profile({
                isPrivate: true,
                followersCount: 401,
                followingCount: 302,
                bio: 'private profile content',
            })),
            providerRunStore: providerRunStore(),
            observer,
        })).resolves.toBe('blocked');

        expect(observer.mock.calls).toEqual([
            [{
                type: 'profile_collected',
                preflightId,
                userId,
                targetInstagramId: 'target.name',
                followersCount: 401,
                followingCount: 302,
            }],
            [{
                type: 'completed',
                outcome: 'blocked',
                preflightId,
                userId,
                targetInstagramId: 'target.name',
                followersCount: 401,
                followingCount: 302,
                errorCode: 'TARGET_PRIVATE',
            }],
        ]);
        expect(JSON.stringify(observer.mock.calls)).not.toContain('private profile content');
    });

    it('reports retry metadata while preserving the public retry error', async () => {
        const observer = vi.fn();
        const store = workerStore(claim({ workerAttemptCount: 3 }));
        const runs = providerRunStore();
        vi.mocked(runs.load).mockResolvedValue(storedRun('running'));

        await expect(processPreflight(preflightId, {
            store,
            getProfile: vi.fn(),
            getFallbackProfile: vi.fn(async () => {
                throw new Error('SCRAPING_RUN_PENDING_ERROR: private-provider-body');
            }),
            providerRunStore: runs,
            observer,
        })).rejects.toMatchObject({ message: 'PREFLIGHT_WORKER_RETRY' });

        expect(observer).toHaveBeenCalledOnce();
        expect(observer).toHaveBeenCalledWith({
            type: 'failed',
            preflightId,
            userId,
            targetInstagramId: 'target.name',
            category: 'run_pending',
            retryable: true,
            httpStatus: null,
            workerAttemptCount: 3,
        });
        expect(JSON.stringify(observer.mock.calls)).not.toContain('private-provider-body');
    });

    it('uses only the self-hosted profile provider without fallback and stores a ready quote', async () => {
        const store = workerStore();
        const getProfile = vi.fn<(
            username: string,
            options?: { invocationDeadlineAtMs?: number }
        ) => Promise<InstagramProfile>>(async () => profile());
        const workerStartedAt = Date.now();

        await expect(processPreflight(preflightId, {
            store,
            getProfile,
            providerRunStore: providerRunStore(),
        }))
            .resolves.toBe('ready');
        expect(getProfile).toHaveBeenCalledWith('target.name', {
            invocationDeadlineAtMs: expect.any(Number),
        });
        const invocationDeadlineAtMs = getProfile.mock.calls[0][1]?.invocationDeadlineAtMs;
        expect(invocationDeadlineAtMs).toBeGreaterThanOrEqual(
            workerStartedAt + PREFLIGHT_PROVIDER_DEADLINE_MS
        );
        expect(invocationDeadlineAtMs).toBeLessThanOrEqual(
            Date.now() + PREFLIGHT_PROVIDER_DEADLINE_MS
        );
        expect(store.finalizeReady).toHaveBeenCalledWith(
            expect.objectContaining({ preflightId, claimToken }),
            expect.objectContaining({
                accessMode: 'test_entitlement',
                capacityRequiredPlan: 'basic',
                requiredPlan: 'basic',
                plans: expect.arrayContaining([
                    expect.objectContaining({ planId: 'basic', launchStatus: 'test_only' }),
                ]),
            })
        );
        expect(store.finalizeBlocked).not.toHaveBeenCalled();
    });

    it.each([
        ['missing target', null, 'TARGET_NOT_FOUND', 'TARGET_NOT_FOUND'],
        ['private target', profile({ isPrivate: true }), 'TARGET_PRIVATE', 'TARGET_PRIVATE'],
        [
            'over Plus target',
            profile({ followersCount: 1_201, followingCount: 1 }),
            'OVER_PLUS_CAPACITY',
            'PLAN_CAPACITY_EXCEEDED',
        ],
    ] as const)('terminalizes a %s with a bounded code', async (
        _name,
        result,
        code,
        ledgerCode,
    ) => {
        const store = workerStore();
        const recordFailure = vi.fn(async () => true);
        await expect(processPreflight(preflightId, {
            store,
            getProfile: vi.fn(async () => result),
            providerRunStore: providerRunStore(),
            recordPreflightFailure: recordFailure,
        })).resolves.toBe('blocked');
        expect(store.finalizeBlocked).toHaveBeenCalledWith(
            expect.objectContaining({ preflightId }),
            code
        );
        expect(recordFailure).toHaveBeenCalledWith({
            userId,
            preflightId,
            stage: 'profile',
            errorCode: ledgerCode,
        });
        expect(store.finalizeReady).not.toHaveBeenCalled();
    });

    it('blocks a production quote while the static catalog remains test-only', async () => {
        const store = workerStore(claim({ accessMode: 'production' }));
        await expect(processPreflight(preflightId, {
            store,
            getProfile: vi.fn(async () => profile()),
            providerRunStore: providerRunStore(),
        })).resolves.toBe('blocked');
        expect(store.finalizeBlocked).toHaveBeenCalledWith(
            expect.anything(),
            'TARGET_UNSUPPORTED'
        );
    });

    it('does nothing when an idempotent worker delivery cannot claim the row', async () => {
        const store = workerStore(null);
        const getProfile = vi.fn();
        const settleBetaCredit = vi.fn(async () => true);
        const refreshBetaCredit = vi.fn(async () => undefined);
        await expect(processPreflight(preflightId, {
            store,
            getProfile,
            providerRunStore: providerRunStore(),
            settleBetaCredit,
            refreshBetaCredit,
        }))
            .resolves.toBe('noop');
        expect(getProfile).not.toHaveBeenCalled();
        expect(settleBetaCredit).toHaveBeenCalledWith(preflightId);
        expect(refreshBetaCredit).toHaveBeenCalledOnce();
    });

    it('does not refresh a ready/ordinary claim-side no-op', async () => {
        const settleBetaCredit = vi.fn(async () => false);
        const refreshBetaCredit = vi.fn(async () => undefined);
        await expect(processPreflight(preflightId, {
            store: workerStore(null),
            settleBetaCredit,
            refreshBetaCredit,
        })).resolves.toBe('noop');
        expect(settleBetaCredit).toHaveBeenCalledOnce();
        expect(refreshBetaCredit).not.toHaveBeenCalled();
    });

    it('blocks an unclassified primary failure without starting paid work', async () => {
        const store = workerStore();
        const runs = providerRunStore();
        const failure = new Error('transient self-hosted failure');
        const fallback = vi.fn();
        const observer = vi.fn();
        await expect(processPreflight(preflightId, {
            store,
            getProfile: vi.fn(async () => { throw failure; }),
            getFallbackProfile: fallback,
            providerRunStore: runs,
            observer,
        })).resolves.toBe('blocked');
        expect(fallback).not.toHaveBeenCalled();
        expect(runs.reserve).not.toHaveBeenCalled();
        expect(store.releaseClaim).not.toHaveBeenCalled();
        expect(store.finalizeReady).not.toHaveBeenCalled();
        expect(store.finalizeBlocked).toHaveBeenCalledWith(expect.anything(), 'ANALYSIS_FAILED');
        expect(observer).toHaveBeenCalledWith(expect.objectContaining({
            type: 'completed',
            outcome: 'blocked',
            errorCode: 'ANALYSIS_FAILED',
            failureCategory: 'unknown',
        }));
    });

    it('falls back exactly once for a self-hosted 429 and persists the paid run', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        const store = workerStore();
        const runs = providerRunStore();
        vi.mocked(runs.reserve).mockResolvedValue({ created: true, run: storedRun('starting') });
        vi.mocked(runs.checkpointStarted).mockResolvedValue({
            ...storedRun('running'),
            runId: 'StartedRun1234567',
        });
        vi.mocked(runs.checkpointTerminal).mockResolvedValue({
            ...storedRun('succeeded'),
            runId: 'StartedRun1234567',
        });
        const fetchProfile = makeWebProfileFetcher({
            env: {
                SELFHOSTED_PROFILE_TIMEOUT_MS: '1000',
                SELFHOSTED_PROFILE_RETRIES: '0',
                SELFHOSTED_PROFILE_RETRY_BASE_DELAY_MS: '0',
                SELFHOSTED_PROFILE_MIN_INTERVAL_MS: '0',
                SELFHOSTED_PROFILE_CIRCUIT_COOLDOWN_MS: '1000',
                SELFHOSTED_PROFILE_SCHEMA_FAILURE_THRESHOLD: '2',
                SELFHOSTED_PROFILE_TRANSIENT_FAILURE_THRESHOLD: '3',
                SELFHOSTED_PROFILE_MAX_RETRY_AFTER_MS: '60000',
            },
            fetchFn: vi.fn<typeof fetch>(async () => new Response('', {
                status: 429,
                headers: { 'content-type': 'text/plain' },
            })),
        });
        const fallback = vi.fn(async (
            _username: string,
            context?: ProviderCallContext
        ) => {
            expect(context?.invocationWaitLimitSecs).toBeGreaterThan(0);
            expect(context?.invocationWaitLimitSecs).toBeLessThanOrEqual(75);
            expect(context?.invocationDeadlineAtMs).toBeGreaterThan(Date.now());
            return completeFallbackRun(context);
        });

        await expect(processPreflight(preflightId, {
            store,
            getProfile: async username => {
                await fetchProfile(username);
                return null;
            },
            getFallbackProfile: fallback,
            providerRunStore: runs,
            env: {
                ...preflightApifyPoolEnv,
                ANALYSIS_V2_APIFY_API_TOKEN_SLOT: 'quinary',
                ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: preflightIdentitySecret,
            },
        })).resolves.toBe('ready');

        expect(fallback).toHaveBeenCalledOnce();
        expect(runs.reserve).toHaveBeenCalledOnce();
        expect(runs.checkpointStarted).toHaveBeenCalledOnce();
        expect(runs.checkpointTerminal).toHaveBeenCalledOnce();
        expect(JSON.stringify(vi.mocked(runs.reserve).mock.calls[0])).not.toContain('target.name');
        const record = String(info.mock.calls[0]?.[0]);
        expect(JSON.parse(record)).toEqual({
            event: 'preflight_profile_fallback_entered',
            operation: 'profile',
            category: 'rate_limit',
            httpStatus: 429,
            existingRun: false,
        });
        expect(record).not.toContain('target.name');
        expect(record).not.toContain('StartedRun1234567');
        info.mockRestore();
    });

    it('resumes an existing paid run without calling self-hosted or starting another Actor', async () => {
        const store = workerStore(claim({ workerAttemptCount: 2 }));
        const runs = providerRunStore();
        vi.mocked(runs.load).mockResolvedValue(storedRun('running'));
        const primary = vi.fn();
        const fallback = vi.fn(async (
            _username: string,
            context?: ProviderCallContext
        ) => {
            expect(context).toMatchObject({
                resumeRunId: 'StoredRun12345678',
                credentialSlot: 'quinary',
                maxChargeUsd: 0.0026,
            });
            return profile();
        });

        await expect(processPreflight(preflightId, {
            store,
            getProfile: primary,
            getFallbackProfile: fallback,
            providerRunStore: runs,
        })).resolves.toBe('ready');

        expect(primary).not.toHaveBeenCalled();
        expect(fallback).toHaveBeenCalledOnce();
        expect(runs.reserve).not.toHaveBeenCalled();
    });

    it('releases only a checkpointed RUN_PENDING result for same-run task retry', async () => {
        const store = workerStore(claim({ workerAttemptCount: 3 }));
        const runs = providerRunStore();
        vi.mocked(runs.load).mockResolvedValue(storedRun('running'));

        const result = processPreflight(preflightId, {
            store,
            getProfile: vi.fn(),
            getFallbackProfile: vi.fn(async () => {
                throw new Error('SCRAPING_RUN_PENDING_ERROR: still running');
            }),
            providerRunStore: runs,
        });

        await expect(result).rejects.toMatchObject({
            message: 'PREFLIGHT_WORKER_RETRY',
            classification: {
                category: 'run_pending',
                workerAttemptCount: 3,
            },
        });
        expect(store.releaseClaim).toHaveBeenCalledOnce();
        expect(store.finalizeBlocked).not.toHaveBeenCalled();
    });

    it.each([
        'SCRAPING_CONFIG_ERROR: local configuration is invalid.',
        'PREFLIGHT_TASKS_CONFIG_ERROR: runtime budget is invalid.',
        'PREFLIGHT_PROVIDER_RUN_PERSISTENCE_ERROR: invalid stored run.',
    ])('never starts paid work for deterministic local failure: %s', async message => {
        const store = workerStore();
        const runs = providerRunStore();
        const fallback = vi.fn();

        await expect(processPreflight(preflightId, {
            store,
            getProfile: vi.fn(async () => { throw new Error(message); }),
            getFallbackProfile: fallback,
            providerRunStore: runs,
        })).resolves.toBe('blocked');

        expect(fallback).not.toHaveBeenCalled();
        expect(runs.reserve).not.toHaveBeenCalled();
    });

    it.each([
        'PREFLIGHT_PERSISTENCE_ERROR: finalize failed (08006).',
        'PREFLIGHT_PROVIDER_RUN_PERSISTENCE_ERROR: load failed (08006).',
        'ANALYSIS_PERSISTENCE_ERROR: provider checkpoint is temporarily unavailable.',
    ])('releases transient persistence failures without paid fallback: %s', async message => {
        const store = workerStore(claim({ workerAttemptCount: 4 }));
        const runs = providerRunStore();
        const fallback = vi.fn();

        const result = processPreflight(preflightId, {
            store,
            getProfile: vi.fn(async () => { throw new Error(message); }),
            getFallbackProfile: fallback,
            providerRunStore: runs,
        });

        await expect(result).rejects.toMatchObject({
            message: 'PREFLIGHT_WORKER_RETRY',
            classification: {
                category: 'persistence',
                retryable: true,
                workerAttemptCount: 4,
            },
        });
        expect(fallback).not.toHaveBeenCalled();
        expect(runs.reserve).not.toHaveBeenCalled();
        expect(store.releaseClaim).toHaveBeenCalledOnce();
        expect(store.finalizeBlocked).not.toHaveBeenCalled();
    });

    it('releases a transient provider-ledger load failure before self-hosted work', async () => {
        const store = workerStore();
        const runs = providerRunStore();
        vi.mocked(runs.load).mockRejectedValue(
            new Error('PREFLIGHT_PROVIDER_RUN_PERSISTENCE_ERROR: load failed (08006).')
        );
        const primary = vi.fn();

        await expect(processPreflight(preflightId, {
            store,
            getProfile: primary,
            providerRunStore: runs,
        })).rejects.toMatchObject({
            message: 'PREFLIGHT_WORKER_RETRY',
            classification: { category: 'persistence' },
        });

        expect(primary).not.toHaveBeenCalled();
        expect(store.releaseClaim).toHaveBeenCalledOnce();
        expect(store.finalizeBlocked).not.toHaveBeenCalled();
    });

    it('releases a transient finalize-ready failure instead of replacing it with blocked', async () => {
        const store = workerStore();
        vi.mocked(store.finalizeReady).mockRejectedValue(
            new Error('PREFLIGHT_PERSISTENCE_ERROR: finalize ready failed (08006).')
        );

        await expect(processPreflight(preflightId, {
            store,
            getProfile: vi.fn(async () => profile()),
            providerRunStore: providerRunStore(),
        })).rejects.toMatchObject({
            message: 'PREFLIGHT_WORKER_RETRY',
            classification: { category: 'persistence' },
        });

        expect(store.releaseClaim).toHaveBeenCalledOnce();
        expect(store.finalizeBlocked).not.toHaveBeenCalled();
    });

    it('keeps an explicit self-hosted null free and terminal', async () => {
        const store = workerStore();
        const runs = providerRunStore();
        const fallback = vi.fn();

        await expect(processPreflight(preflightId, {
            store,
            getProfile: vi.fn(async () => null),
            getFallbackProfile: fallback,
            providerRunStore: runs,
        })).resolves.toBe('blocked');

        expect(fallback).not.toHaveBeenCalled();
        expect(runs.reserve).not.toHaveBeenCalled();
        expect(store.finalizeBlocked).toHaveBeenCalledWith(expect.anything(), 'TARGET_NOT_FOUND');
    });

    it('acknowledges a preflight that expires while its blocked result is finalized', async () => {
        const store = workerStore();
        vi.mocked(store.finalizeBlocked).mockRejectedValue(
            new PreflightImmutableError('ANONYMOUS_PREFLIGHT_EXPIRED')
        );

        await expect(processPreflight(preflightId, {
            store,
            getProfile: vi.fn(async () => null),
            providerRunStore: providerRunStore(),
        })).resolves.toBe('noop');

        expect(store.releaseClaim).not.toHaveBeenCalled();
    });

    it('does not start provider work when an anonymous lease cannot cover its deadline', async () => {
        const getFallbackProfile = vi.fn();
        const store = workerStore(claim({
            userId: null,
            leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
        }));

        await expect(processPreflight(preflightId, {
            store,
            getFallbackProfile,
            providerRunStore: providerRunStore(),
        })).resolves.toBe('noop');

        expect(getFallbackProfile).not.toHaveBeenCalled();
    });

    it('maps anonymous expiry from a finalize RPC to an immutable error', async () => {
        const store = createSupabasePreflightStore({
            rpc: vi.fn(async () => ({
                data: null,
                error: { code: 'P0001', message: 'ANONYMOUS_PREFLIGHT_EXPIRED' },
            })),
            from: vi.fn() as never,
        });

        await expect(store.finalizeBlocked(
            claim({ userId: null }),
            'TARGET_NOT_FOUND'
        )).rejects.toMatchObject({
            name: 'PreflightImmutableError',
            message: 'ANONYMOUS_PREFLIGHT_EXPIRED',
        });
    });

    it.each([
        ['ANALYSIS_V2_PREFLIGHT_LEASE_LOST', claim()],
        ['ANALYSIS_V2_PREFLIGHT_BLOCK_CONFLICT', claim()],
        ['ANONYMOUS_PREFLIGHT_LEASE_LOST', claim({ userId: null })],
        ['ANONYMOUS_PREFLIGHT_BLOCK_CONFLICT', claim({ userId: null })],
    ] as const)('maps the stale terminal block fence %s to an immutable error', async (
        message,
        claimed,
    ) => {
        const store = createSupabasePreflightStore({
            rpc: vi.fn(async () => ({
                data: null,
                error: { code: 'P0001', message },
            })),
            from: vi.fn() as never,
        });

        await expect(store.finalizeBlocked(claimed, 'ANALYSIS_FAILED')).rejects.toMatchObject({
            name: 'PreflightImmutableError',
            message,
        });
    });

    it('blocks a reserved start without a run id before invoking any paid provider', async () => {
        const store = workerStore(claim({ workerAttemptCount: 2 }));
        const runs = providerRunStore();
        vi.mocked(runs.load).mockResolvedValue(storedRun('starting'));
        const fallback = vi.fn();

        await expect(processPreflight(preflightId, {
            store,
            getProfile: vi.fn(),
            getFallbackProfile: fallback,
            providerRunStore: runs,
        })).resolves.toBe('blocked');

        expect(fallback).not.toHaveBeenCalled();
        expect(runs.reserve).not.toHaveBeenCalled();
        expect(store.finalizeBlocked).toHaveBeenCalledWith(expect.anything(), 'ANALYSIS_FAILED');
    });

    it('blocks a replayed definite start rejection without re-entering the paid provider', async () => {
        const store = workerStore(claim({ workerAttemptCount: 2 }));
        const runs = providerRunStore();
        vi.mocked(runs.load).mockResolvedValue(storedRun('rejected'));
        const fallback = vi.fn();

        await expect(processPreflight(preflightId, {
            store,
            getProfile: vi.fn(),
            getFallbackProfile: fallback,
            providerRunStore: runs,
        })).resolves.toBe('blocked');

        expect(fallback).not.toHaveBeenCalled();
        expect(runs.reserve).not.toHaveBeenCalled();
        expect(store.finalizeBlocked).toHaveBeenCalledWith(expect.anything(), 'ANALYSIS_FAILED');
    });

    it('records a terminal provider run as a temporary provider failure', async () => {
        const runs = providerRunStore();
        vi.mocked(runs.load).mockResolvedValue(storedRun('failed'));
        const recordFailure = vi.fn(async () => true);

        await expect(processPreflight(preflightId, {
            store: workerStore(),
            getProfile: vi.fn(),
            getFallbackProfile: vi.fn(),
            providerRunStore: runs,
            recordPreflightFailure: recordFailure,
        })).resolves.toBe('blocked');

        expect(recordFailure).toHaveBeenCalledWith({
            userId,
            preflightId,
            stage: 'profile',
            errorCode: 'PROVIDER_TEMPORARY_FAILURE',
        });
    });

    it('terminalizes a succeeded provider run with no valid profile at the final attempt', async () => {
        const claimed = claim({ workerAttemptCount: 7 });
        const store = workerStore(claimed);
        const runs = providerRunStore();
        vi.mocked(runs.load).mockResolvedValue(storedRun('succeeded'));
        const observer = vi.fn();
        const providerFailure = new Error(
            'SCRAPING_RUN_PENDING_ERROR: provider returned no valid profile'
        );

        await expect(processPreflight(preflightId, {
            store,
            getProfile: vi.fn(),
            getFallbackProfile: vi.fn(async () => { throw providerFailure; }),
            providerRunStore: runs,
            observer,
        })).resolves.toBe('blocked');

        expect(store.finalizeBlocked).toHaveBeenCalledTimes(1);
        expect(store.finalizeBlocked).toHaveBeenCalledWith(claimed, 'ANALYSIS_FAILED');
        expect(store.releaseClaim).not.toHaveBeenCalled();
        expect(observer).toHaveBeenCalledWith(expect.objectContaining({
            type: 'completed',
            outcome: 'blocked',
            errorCode: 'ANALYSIS_FAILED',
            failureCategory: 'provider',
            failureReason: 'provider_terminal_no_profile',
        }));
    });

    it('keeps a succeeded provider run retryable before the final attempt', async () => {
        const claimed = claim({ workerAttemptCount: 6 });
        const store = workerStore(claimed);
        const runs = providerRunStore();
        vi.mocked(runs.load).mockResolvedValue(storedRun('succeeded'));
        const providerFailure = new Error(
            'SCRAPING_RUN_PENDING_ERROR: provider returned no valid profile'
        );

        await expect(processPreflight(preflightId, {
            store,
            getProfile: vi.fn(),
            getFallbackProfile: vi.fn(async () => { throw providerFailure; }),
            providerRunStore: runs,
        })).rejects.toMatchObject({
            message: 'PREFLIGHT_WORKER_RETRY',
            classification: {
                category: 'run_pending',
                retryable: true,
                workerAttemptCount: 6,
            },
        });

        expect(store.finalizeBlocked).not.toHaveBeenCalled();
        expect(store.releaseClaim).toHaveBeenCalledOnce();
    });

    it('keeps a final-attempt persistence failure retryable and unclassified as no-profile', async () => {
        const claimed = claim({ workerAttemptCount: 7 });
        const store = workerStore(claimed);
        const runs = providerRunStore();
        vi.mocked(runs.load).mockResolvedValue(storedRun('succeeded'));

        await expect(processPreflight(preflightId, {
            store,
            getProfile: vi.fn(),
            getFallbackProfile: vi.fn(async () => {
                throw new Error('PREFLIGHT_PERSISTENCE_ERROR: profile extraction failed (08006).');
            }),
            providerRunStore: runs,
        })).rejects.toMatchObject({
            message: 'PREFLIGHT_WORKER_RETRY',
            classification: {
                category: 'persistence',
                retryable: true,
                workerAttemptCount: 7,
            },
        });

        expect(store.finalizeBlocked).not.toHaveBeenCalled();
        expect(store.releaseClaim).toHaveBeenCalledOnce();
    });

    it('keeps a valid profile ready at the final attempt', async () => {
        const claimed = claim({ workerAttemptCount: 7 });
        const store = workerStore(claimed);
        const runs = providerRunStore();
        vi.mocked(runs.load).mockResolvedValue(storedRun('succeeded'));

        await expect(processPreflight(preflightId, {
            store,
            getProfile: vi.fn(),
            getFallbackProfile: vi.fn(async () => profile()),
            providerRunStore: runs,
        })).resolves.toBe('ready');

        expect(store.finalizeReady).toHaveBeenCalledOnce();
        expect(store.finalizeBlocked).not.toHaveBeenCalled();
    });

    it('acknowledges a stale final-attempt fence without retrying the terminal transition', async () => {
        const claimed = claim({ workerAttemptCount: 7 });
        const store = workerStore(claimed);
        const runs = providerRunStore();
        vi.mocked(runs.load).mockResolvedValue(storedRun('succeeded'));
        vi.mocked(store.finalizeBlocked).mockRejectedValue(
            new PreflightImmutableError('PREFLIGHT_IMMUTABLE')
        );
        const providerFailure = new Error(
            'SCRAPING_RUN_PENDING_ERROR: provider returned no valid profile'
        );

        await expect(processPreflight(preflightId, {
            store,
            getProfile: vi.fn(),
            getFallbackProfile: vi.fn(async () => { throw providerFailure; }),
            providerRunStore: runs,
        })).resolves.toBe('noop');

        expect(store.releaseClaim).not.toHaveBeenCalled();
    });

    it.each([
        ['ANALYSIS_V2_PREFLIGHT_LEASE_LOST', claim({ workerAttemptCount: 7 })],
        ['ANALYSIS_V2_PREFLIGHT_BLOCK_CONFLICT', claim({ workerAttemptCount: 7 })],
        ['ANONYMOUS_PREFLIGHT_LEASE_LOST', claim({ userId: null, workerAttemptCount: 7 })],
        ['ANONYMOUS_PREFLIGHT_BLOCK_CONFLICT', claim({ userId: null, workerAttemptCount: 7 })],
    ] as const)('does not retry or report completion after stale fence %s', async (
        message,
        claimed,
    ) => {
        const rpc = vi.fn(async () => ({
            data: null,
            error: { code: 'P0001', message },
        }));
        const durableStore = createSupabasePreflightStore({
            rpc,
            from: vi.fn() as never,
        });
        const finalizeBlocked = vi.fn(async (
            actualClaim: ClaimedPreflight,
            code: Parameters<PreflightStore['finalizeBlocked']>[1],
        ) => {
            await durableStore.finalizeBlocked(actualClaim, code);
        });
        const store = { ...workerStore(claimed), finalizeBlocked } satisfies PreflightStore;
        const runs = providerRunStore();
        vi.mocked(runs.load).mockResolvedValue(storedRun('succeeded'));
        const observer = vi.fn();
        const anonymousProfileCache = {
            load: vi.fn(async () => null),
            store: vi.fn(async () => true),
        };

        await expect(processPreflight(preflightId, {
            store,
            getProfile: vi.fn(),
            getFallbackProfile: vi.fn(async () => {
                throw new Error('SCRAPING_RUN_PENDING_ERROR: provider returned no valid profile');
            }),
            providerRunStore: runs,
            observer,
            anonymousProfileCache,
        })).resolves.toBe('noop');

        expect(rpc).toHaveBeenCalledWith(
            PREFLIGHT_DATABASE_NAMES[claimed.userId === null ? 'anonymousBlockRpc' : 'blockRpc'],
            expect.objectContaining({
                p_preflight_id: preflightId,
                p_claim_token: claimToken,
                p_error_code: 'ANALYSIS_FAILED',
            }),
        );
        expect(store.releaseClaim).not.toHaveBeenCalled();
        expect(observer).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'completed' }));
    });

    it('does not retry a parent that has already terminalized', async () => {
        const store = workerStore(null);
        const getFallbackProfile = vi.fn();

        await expect(processPreflight(preflightId, {
            store,
            getFallbackProfile,
            providerRunStore: providerRunStore(),
        })).resolves.toBe('noop');

        expect(getFallbackProfile).not.toHaveBeenCalled();
    });

    it.each([
        ['starting', 'provider'],
        ['rejected', 'provider'],
        ['failed', 'provider'],
        ['aborted', 'provider'],
        ['timed_out', 'timeout'],
    ] as const)('reports a replayed %s provider run as a safe %s terminal cause', async (
        status,
        failureCategory,
    ) => {
        const runs = providerRunStore();
        vi.mocked(runs.load).mockResolvedValue(storedRun(status));
        const observer = vi.fn();

        await expect(processPreflight(preflightId, {
            store: workerStore(),
            getProfile: vi.fn(),
            getFallbackProfile: vi.fn(),
            providerRunStore: runs,
            observer,
        })).resolves.toBe('blocked');

        expect(observer).toHaveBeenCalledWith(expect.objectContaining({
            type: 'completed',
            outcome: 'blocked',
            errorCode: 'ANALYSIS_FAILED',
            failureCategory,
        }));
    });
});

describe('preflight public mapping', () => {
    it('exposes a terminal provider failure as blocked status for the existing retry/error UX', () => {
        const result = publicPreflightStatusDto({
            preflightId,
            status: 'blocked',
            expiresAt,
            blockedCode: 'ANALYSIS_FAILED',
            readySnapshot: null,
            exclusionDecision: 'pending',
        });

        expect(result).toMatchObject({
            status: 'blocked',
            code: 'ANALYSIS_FAILED',
        });
        expect(result.status).not.toBe('pending');
    });

    it('returns retry exhaustion immediately as a queue-unavailable block', () => {
        expect(publicPreflightStatusDto({
            preflightId,
            status: 'blocked',
            expiresAt,
            blockedCode: 'QUEUE_UNAVAILABLE',
            readySnapshot: null,
            exclusionDecision: 'pending',
        })).toEqual({
            schemaVersion: 1,
            preflightId,
            expiresAt,
            status: 'blocked',
            exclusionDecision: 'pending',
            code: 'QUEUE_UNAVAILABLE',
        });
    });

    it('uses the terminal expiry boundary if a queue block ages out before GET', () => {
        expect(() => publicPreflightStatusDto({
            preflightId,
            status: 'blocked',
            expiresAt: '2026-07-13T12:00:00.000Z',
            blockedCode: 'QUEUE_UNAVAILABLE',
            readySnapshot: null,
            exclusionDecision: 'pending',
        }, {}, () => undefined, Date.parse('2026-07-13T12:00:00.001Z')))
            .toThrow('PREFLIGHT_EXPIRED');
    });

    it('returns a signed proxy path and never the stored raw CDN URL', () => {
        const snapshot = buildReadyPreflightSnapshot(
            profile(),
            'test_entitlement'
        ) as ReadyPreflightSnapshot;
        const result = publicPreflightStatusDto({
            preflightId,
            status: 'ready',
            expiresAt,
            blockedCode: null,
            readySnapshot: snapshot,
            exclusionDecision: 'exclude',
        }, {}, () => '/api/image-proxy?token=signed');

        expect(result).toMatchObject({
            status: 'ready',
            exclusionDecision: 'exclude',
            target: { profileImage: '/api/image-proxy?token=signed' },
        });
        expect(JSON.stringify(result)).not.toContain('excludedInstagramId');
        expect(JSON.stringify(result)).not.toContain('cdninstagram.com');
    });

    it('rejects a stale ready row even before a database cleanup marks it expired', () => {
        const snapshot = buildReadyPreflightSnapshot(
            profile(),
            'test_entitlement'
        ) as ReadyPreflightSnapshot;

        expect(() => publicPreflightStatusDto({
            preflightId,
            status: 'ready',
            expiresAt: '2026-07-13T12:00:00.000Z',
            blockedCode: null,
            readySnapshot: snapshot,
            exclusionDecision: 'skip',
        }, {}, () => undefined, Date.parse('2026-07-13T12:00:00.001Z'))).toThrow('PREFLIGHT_EXPIRED');
    });

    it('requires the explicit signed-test-entitlement feature gate in every environment', () => {
        expect(trustedPreflightAccessMode({})).toBe('production');
        expect(trustedPreflightAccessMode({
            NODE_ENV: 'production',
            PREFLIGHT_ACCESS_MODE: 'test_entitlement',
            ANALYSIS_TEST_ENTITLEMENTS_ENABLED: 'true',
            ANALYSIS_TEST_ENTITLEMENT_SECRET: entitlementSecret,
        })).toBe('test_entitlement');
        expect(() => trustedPreflightAccessMode({
            NODE_ENV: 'production',
            PREFLIGHT_ACCESS_MODE: 'test_entitlement',
            ANALYSIS_TEST_ENTITLEMENTS_ENABLED: 'false',
        })).toThrow('test entitlement mode is disabled');
    });

    it('applies injected remaining slots to paid plans and omits the key for plus', () => {
        const snapshot = buildReadyPreflightSnapshot(
            profile(),
            'test_entitlement'
        ) as ReadyPreflightSnapshot;

        const result = publicPreflightStatusDto({
            preflightId,
            status: 'ready',
            expiresAt,
            blockedCode: null,
            readySnapshot: snapshot,
            exclusionDecision: 'skip',
        }, { basic: 3, standard: 0 });

        const byPlan = Object.fromEntries(
            result.status === 'ready' ? result.plans.map(plan => [plan.planId, plan]) : []
        );
        expect(byPlan.basic).toHaveProperty('remainingSlots', 3);
        expect(byPlan.standard).toHaveProperty('remainingSlots', 0);
        expect(byPlan.plus).not.toHaveProperty('remainingSlots');
    });

    it('omits remaining slots entirely when the lookup returned nothing', () => {
        const snapshot = buildReadyPreflightSnapshot(
            profile(),
            'test_entitlement'
        ) as ReadyPreflightSnapshot;

        const result = publicPreflightStatusDto({
            preflightId,
            status: 'ready',
            expiresAt,
            blockedCode: null,
            readySnapshot: snapshot,
            exclusionDecision: 'skip',
        });

        if (result.status !== 'ready') throw new Error('expected a ready status');
        for (const plan of result.plans) {
            expect(plan).not.toHaveProperty('remainingSlots');
        }
    });
});
