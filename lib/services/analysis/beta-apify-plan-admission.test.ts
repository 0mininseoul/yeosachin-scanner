import { describe, expect, it, vi } from 'vitest';
import {
    BETA_APIFY_PLAN_ACCESS_UNAVAILABLE,
    BETA_APIFY_PLAN_ADMISSION_ERROR,
    BETA_APIFY_PLAN_ADMISSION_INVALID_INPUT,
    BETA_APIFY_PLAN_ADMISSION_INVALID_RESULT,
    BETA_APIFY_PLAN_ADMISSION_PERSISTENCE_ERROR,
    BETA_APIFY_PLAN_REPLAY_IDENTITY_CONFLICT,
    admitBetaApifyPlan,
    createBetaApifyPlanAdmissionStore,
} from './beta-apify-plan-admission';
import { BETA_APIFY_TARGET_PROFILE_BUDGET_USD } from './beta-apify-credit-runtime';
import { BETA_APIFY_RUNTIME_CONFIG_ERROR } from './beta-apify-credit-runtime';
import { BETA_APIFY_FREE_CREDENTIAL_SLOTS } from './beta-apify-credit-pool';
import { ANALYSIS_BETA_POOL_BUDGET_DRIFT } from './authorized-test-provider-policy';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PREFLIGHT_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const ADMISSION_TOKEN = '66666666-6666-4666-8666-666666666666';
const timestamps = {
    billingCycleStartAt: '2026-08-01T00:00:00.000Z',
    billingCycleEndAt: '2026-09-01T00:00:00.000Z',
    observedAt: '2026-08-02T00:00:00.000Z',
} as const;

function snapshots(headroom = 10) {
    return BETA_APIFY_FREE_CREDENTIAL_SLOTS.map(credentialSlot => ({
        credentialSlot, monthlyLimitUsd: 10, monthlyUsageUsd: 0,
        effectiveHeadroomUsd: headroom, healthState: 'healthy' as const, ...timestamps,
    }));
}

describe('beta Apify plan admission', () => {
    it('preserves the frozen target-profile hold and derives all eight budgets from the reviewed catalog', async () => {
        const hold = { allocationId: '55555555-5555-4555-8555-555555555555', preflightId: PREFLIGHT_ID, credentialSlot: 'septenary' as const, targetProfileBudgetUsd: BETA_APIFY_TARGET_PROFILE_BUDGET_USD };
        const activate = vi.fn().mockResolvedValue({ requestId: REQUEST_ID, initialJobKey: 'coordinator:bootstrap', allocationId: hold.allocationId, replayed: false });
        const result = await admitBetaApifyPlan({
            preflightId: PREFLIGHT_ID, userId: USER_ID, admissionToken: ADMISSION_TOKEN, admissionGeneration: 1, selectedPlanId: 'basic',
            maxSnapshotAgeSeconds: 300,
            env: { BETATEST_FREE_POOL_ENABLED: 'true' },
            store: { replay: vi.fn().mockResolvedValue(null), loadPreflightHold: vi.fn().mockResolvedValue(hold), loadSnapshots: vi.fn().mockResolvedValue(snapshots()), activate },
        });

        expect(result).toMatchObject({ requestId: REQUEST_ID, initialJobKey: 'coordinator:bootstrap', replayed: false });
        expect(activate).toHaveBeenCalledOnce();
        const input = activate.mock.calls[0]?.[0];
        expect(input.operationSlotMap['target-profile']).toBe('septenary');
        expect(input.operationBudgetMap['target-profile']).toBe(BETA_APIFY_TARGET_PROFILE_BUDGET_USD);
        expect(Object.keys(input.operationBudgetMap).sort()).toEqual([
            'candidate-likers', 'profile-fallback', 'profile-repair', 'relationship-followers',
            'relationship-following', 'target-comments', 'target-likers', 'target-profile',
        ]);
        expect(Object.values(input.operationSlotMap)).not.toContain('secondary');
    });

    it('emits only an aggregate allocation success without user or preflight identity', async () => {
        const emit = vi.fn();
        const hold = { allocationId: '55555555-5555-4555-8555-555555555555', preflightId: PREFLIGHT_ID, credentialSlot: 'primary' as const, targetProfileBudgetUsd: BETA_APIFY_TARGET_PROFILE_BUDGET_USD };
        await admitBetaApifyPlan({
            preflightId: PREFLIGHT_ID, userId: USER_ID, admissionToken: ADMISSION_TOKEN, admissionGeneration: 1, selectedPlanId: 'basic', maxSnapshotAgeSeconds: 300,
            env: { BETATEST_FREE_POOL_ENABLED: 'true' }, telemetry: { emit },
            store: { replay: vi.fn().mockResolvedValue(null), loadPreflightHold: vi.fn().mockResolvedValue(hold), loadSnapshots: vi.fn().mockResolvedValue(snapshots()), activate: vi.fn().mockResolvedValue({ requestId: REQUEST_ID, initialJobKey: 'coordinator:bootstrap', allocationId: hold.allocationId, replayed: false }) },
        });
        expect(emit).toHaveBeenCalledWith(expect.objectContaining({
            event: 'betatest_apify_credit.allocation_accepted',
            fields: expect.objectContaining({ reservation_usd: expect.any(Number) }),
        }));
        expect(JSON.stringify(emit.mock.calls)).not.toMatch(new RegExp(`${USER_ID}|${PREFLIGHT_ID}`));
    });

    it('does not double-count an authoritative activate replay as allocation success', async () => {
        const emit = vi.fn();
        const hold = { allocationId: '55555555-5555-4555-8555-555555555555', preflightId: PREFLIGHT_ID, credentialSlot: 'primary' as const, targetProfileBudgetUsd: BETA_APIFY_TARGET_PROFILE_BUDGET_USD };
        await expect(admitBetaApifyPlan({
            preflightId: PREFLIGHT_ID, userId: USER_ID, admissionToken: ADMISSION_TOKEN,
            admissionGeneration: 1, selectedPlanId: 'basic', maxSnapshotAgeSeconds: 300,
            env: { BETATEST_FREE_POOL_ENABLED: 'true' }, telemetry: { emit },
            store: {
                replay: vi.fn().mockResolvedValue(null),
                loadPreflightHold: vi.fn().mockResolvedValue(hold),
                loadSnapshots: vi.fn().mockResolvedValue(snapshots()),
                activate: vi.fn().mockResolvedValue({
                    requestId: REQUEST_ID, initialJobKey: 'coordinator:bootstrap',
                    allocationId: hold.allocationId, replayed: true,
                }),
            },
        })).resolves.toMatchObject({ replayed: true });
        expect(emit).not.toHaveBeenCalled();
    });

    it('keeps provider/store outages sanitized but distinct from capacity', async () => {
        const secret = 'apify-token-account-raw-payload';
        const error = await admitBetaApifyPlan({
            preflightId: PREFLIGHT_ID, userId: USER_ID, admissionToken: ADMISSION_TOKEN, admissionGeneration: 1, selectedPlanId: 'basic', maxSnapshotAgeSeconds: 300,
            store: { replay: vi.fn().mockRejectedValue(new Error(secret)), loadPreflightHold: vi.fn(), loadSnapshots: vi.fn(), activate: vi.fn() },
        }).catch((caught: unknown) => caught);
        expect(error).toEqual(new Error(BETA_APIFY_PLAN_ADMISSION_PERSISTENCE_ERROR));
        expect(String(error)).not.toContain(secret);
    });

    it('rejects runtime cost drift above the frozen catalog before any request activation', async () => {
        const allocationId = '55555555-5555-4555-8555-555555555555';
        const loadPreflightHold = vi.fn().mockResolvedValue({
            allocationId,
            preflightId: PREFLIGHT_ID,
            credentialSlot: 'primary',
            targetProfileBudgetUsd: BETA_APIFY_TARGET_PROFILE_BUDGET_USD,
        });
        const loadSnapshots = vi.fn().mockResolvedValue(snapshots());
        const activate = vi.fn().mockResolvedValue({
            requestId: REQUEST_ID,
            initialJobKey: 'coordinator:bootstrap',
            allocationId,
            replayed: false,
        });
        await expect(admitBetaApifyPlan({
            preflightId: PREFLIGHT_ID,
            userId: USER_ID,
            admissionToken: ADMISSION_TOKEN,
            admissionGeneration: 1,
            selectedPlanId: 'basic',
            maxSnapshotAgeSeconds: 300,
            env: {
                BETATEST_FREE_POOL_ENABLED: 'true',
                APIFY_PROFILE_ESTIMATED_COST_PER_RESULT_USD: '0.005',
                APIFY_RELATIONSHIP_ESTIMATED_COST_PER_RESULT_USD: '0.002',
                APIFY_RELATIONSHIP_MAX_ESTIMATED_COST_USD_PER_OPERATION: '10',
            },
            store: {
                replay: vi.fn().mockResolvedValue(null),
                loadPreflightHold,
                loadSnapshots,
                activate,
            },
        })).rejects.toThrow(ANALYSIS_BETA_POOL_BUDGET_DRIFT);
        expect(loadPreflightHold).not.toHaveBeenCalled();
        expect(loadSnapshots).not.toHaveBeenCalled();
        expect(activate).not.toHaveBeenCalled();
    });

    it.each([
        'ANALYSIS_BETA_ALLOCATION_CONFLICT',
        'ANALYSIS_BETA_PROVIDER_POLICY_CONFLICT',
        'ANALYSIS_BETA_ALLOCATION_INVALID',
    ])('classifies stored integrity failure %s as persistence without leaking details', async code => {
        const raw = `${code} apify-account-secret`;
        const store = createBetaApifyPlanAdmissionStore({
            rpc: vi.fn().mockResolvedValue({ data: null, error: { message: raw } }),
        });
        const error = await store.replay({
            preflightId: PREFLIGHT_ID,
            userId: USER_ID,
            admissionToken: ADMISSION_TOKEN,
            admissionGeneration: 1,
            selectedPlanId: 'basic',
        }).catch((caught: unknown) => caught);
        expect(error).toEqual(new Error(BETA_APIFY_PLAN_ADMISSION_PERSISTENCE_ERROR));
        expect(String(error)).not.toContain(raw);
        expect(String(error)).not.toContain('apify-account-secret');
    });

    it.each([
        'ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE',
        'ANALYSIS_BETA_POOL_SNAPSHOT_STALE',
        'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE',
        'ANALYSIS_BETA_PREFLIGHT_NOT_ELIGIBLE',
    ])('keeps true domain failure %s in the sanitized capacity category', async code => {
        const store = createBetaApifyPlanAdmissionStore({
            rpc: vi.fn().mockResolvedValue({
                data: null,
                error: { message: `${code} provider-secret` },
            }),
        });
        const error = await store.replay({
            preflightId: PREFLIGHT_ID,
            userId: USER_ID,
            admissionToken: ADMISSION_TOKEN,
            admissionGeneration: 1,
            selectedPlanId: 'basic',
        }).catch((caught: unknown) => caught);
        expect(error).toEqual(new Error(BETA_APIFY_PLAN_ADMISSION_ERROR));
        expect(String(error)).not.toContain('provider-secret');
    });

    it('maps the atomic admission access race without leaking database detail', async () => {
        const store = createBetaApifyPlanAdmissionStore({
            rpc: vi.fn().mockResolvedValue({
                data: null,
                error: {
                    message: 'ANALYSIS_BETA_ACCESS_UNAVAILABLE provider-secret',
                },
            }),
        });

        const error = await store.activate({
            preflightId: PREFLIGHT_ID,
            userId: USER_ID,
            admissionToken: ADMISSION_TOKEN,
            admissionGeneration: 1,
            selectedPlanId: 'basic',
            maxSnapshotAgeSeconds: 300,
            operationSlotMap: Object.fromEntries([
                'target-profile', 'relationship-followers',
                'relationship-following', 'profile-fallback', 'profile-repair',
                'target-likers', 'target-comments', 'candidate-likers',
            ].map(key => [key, 'primary'])) as never,
            operationBudgetMap: Object.fromEntries([
                'target-profile', 'relationship-followers',
                'relationship-following', 'profile-fallback', 'profile-repair',
                'target-likers', 'target-comments', 'candidate-likers',
            ].map(key => [key, BETA_APIFY_TARGET_PROFILE_BUDGET_USD])) as never,
        }).catch((caught: unknown) => caught);

        expect(error).toEqual(new Error(BETA_APIFY_PLAN_ACCESS_UNAVAILABLE));
        expect(String(error)).not.toContain('provider-secret');
    });

    it('serializes a narrow sanitized RPC input and rejects malformed/replayed output', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: {
            requestId: REQUEST_ID, initialJobKey: 'coordinator:bootstrap',
            allocationId: '55555555-5555-4555-8555-555555555555', replayed: true,
        }, error: null });
        const store = createBetaApifyPlanAdmissionStore({ rpc });
        await expect(store.activate({
            preflightId: PREFLIGHT_ID, userId: USER_ID, admissionToken: ADMISSION_TOKEN, admissionGeneration: 1, selectedPlanId: 'basic', maxSnapshotAgeSeconds: 300,
            operationSlotMap: Object.fromEntries([
                'target-profile', 'relationship-followers', 'relationship-following', 'profile-fallback',
                'profile-repair', 'target-likers', 'target-comments', 'candidate-likers',
            ].map(key => [key, 'primary'])) as Record<
                'target-profile' | 'relationship-followers' | 'relationship-following' | 'profile-fallback' | 'profile-repair' | 'target-likers' | 'target-comments' | 'candidate-likers',
                'primary'
            >,
            operationBudgetMap: Object.fromEntries([
                'target-profile', 'relationship-followers', 'relationship-following', 'profile-fallback',
                'profile-repair', 'target-likers', 'target-comments', 'candidate-likers',
            ].map(key => [key, BETA_APIFY_TARGET_PROFILE_BUDGET_USD])) as Record<
                'target-profile' | 'relationship-followers' | 'relationship-following' | 'profile-fallback' | 'profile-repair' | 'target-likers' | 'target-comments' | 'candidate-likers',
                number
            >,
        })).resolves.toMatchObject({ requestId: REQUEST_ID, replayed: true });
        expect(rpc).toHaveBeenCalledWith('admit_analysis_v2_betatest_plan', expect.objectContaining({
            p_preflight_id: PREFLIGHT_ID, p_user_id: USER_ID, p_admission_token: ADMISSION_TOKEN, p_admission_generation: 1, p_selected_plan_id: 'basic',
        }));
        const serialized = JSON.stringify(rpc.mock.calls[0]?.[1]);
        expect(serialized).not.toMatch(/account|raw|secret/i);
        expect(serialized).not.toMatch(/apify|https?:\/\//i);
    });

    it('loads a consumed replay from only owner, preflight, and selected-plan identity', async () => {
        const stored = {
            requestId: REQUEST_ID,
            initialJobKey: 'coordinator:bootstrap',
            allocationId: '55555555-5555-4555-8555-555555555555',
            replayed: true,
        };
        const rpc = vi.fn().mockResolvedValue({ data: stored, error: null });
        const store = createBetaApifyPlanAdmissionStore({ rpc });

        await expect(store.replayConsumed({
            preflightId: PREFLIGHT_ID,
            userId: USER_ID,
            selectedPlanId: 'basic',
        })).resolves.toEqual(stored);
        expect(rpc).toHaveBeenCalledWith(
            'load_analysis_v2_betatest_consumed_replay',
            {
                p_preflight_id: PREFLIGHT_ID,
                p_user_id: USER_ID,
                p_selected_plan_id: 'basic',
            }
        );
    });

    it('preserves only the stable consumed replay plan identity conflict', async () => {
        const rpc = vi.fn().mockResolvedValue({
            data: null,
            error: {
                message: 'ANALYSIS_BETA_PLAN_REPLAY_IDENTITY_CONFLICT provider-secret',
            },
        });
        const store = createBetaApifyPlanAdmissionStore({ rpc });

        const error = await store.replayConsumed({
            preflightId: PREFLIGHT_ID,
            userId: USER_ID,
            selectedPlanId: 'plus',
        }).catch((caught: unknown) => caught);

        expect(error).toEqual(new Error(BETA_APIFY_PLAN_REPLAY_IDENTITY_CONFLICT));
        expect(String(error)).not.toContain('provider-secret');
    });

    it('returns an immutable replay before feature config, hold, snapshot, and planning', async () => {
        const replay = vi.fn().mockResolvedValue({
            requestId: REQUEST_ID, initialJobKey: 'coordinator:bootstrap',
            allocationId: '55555555-5555-4555-8555-555555555555', replayed: true,
        });
        const hold = vi.fn();
        const loadSnapshots = vi.fn();
        await expect(admitBetaApifyPlan({
            preflightId: PREFLIGHT_ID, userId: USER_ID, admissionToken: ADMISSION_TOKEN,
            admissionGeneration: 1, selectedPlanId: 'basic', maxSnapshotAgeSeconds: 300,
            env: {}, store: { replay, loadPreflightHold: hold, loadSnapshots, activate: vi.fn() },
        })).resolves.toMatchObject({ requestId: REQUEST_ID, replayed: true });
        expect(replay).toHaveBeenCalledOnce();
        expect(hold).not.toHaveBeenCalled();
        expect(loadSnapshots).not.toHaveBeenCalled();
    });

    it('re-probes immutable replay when another call wins the activation race', async () => {
        const stored = {
            requestId: REQUEST_ID, initialJobKey: 'coordinator:bootstrap' as const,
            allocationId: '55555555-5555-4555-8555-555555555555', replayed: true,
        };
        const replay = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(stored);
        const emit = vi.fn();
        await expect(admitBetaApifyPlan({
            preflightId: PREFLIGHT_ID, userId: USER_ID, admissionToken: ADMISSION_TOKEN,
            admissionGeneration: 1, selectedPlanId: 'basic', maxSnapshotAgeSeconds: 300,
            env: { BETATEST_FREE_POOL_ENABLED: 'true' },
            telemetry: { emit },
            store: {
                replay,
                loadPreflightHold: vi.fn().mockResolvedValue({
                    allocationId: stored.allocationId, preflightId: PREFLIGHT_ID,
                    credentialSlot: 'primary', targetProfileBudgetUsd: BETA_APIFY_TARGET_PROFILE_BUDGET_USD,
                }),
                loadSnapshots: vi.fn().mockResolvedValue(snapshots()),
                activate: vi.fn().mockRejectedValue(new Error(BETA_APIFY_PLAN_ADMISSION_ERROR)),
            },
        })).resolves.toEqual(stored);
        expect(replay).toHaveBeenCalledTimes(2);
        expect(emit).not.toHaveBeenCalled();
    });

    it.each(['snapshot', 'activation'] as const)(
        'emits exactly one final allocation rejection for a %s capacity failure',
        async boundary => {
            const emit = vi.fn();
            const hold = {
                allocationId: '55555555-5555-4555-8555-555555555555',
                preflightId: PREFLIGHT_ID, credentialSlot: 'primary' as const,
                targetProfileBudgetUsd: BETA_APIFY_TARGET_PROFILE_BUDGET_USD,
            };
            const loadSnapshots = boundary === 'snapshot'
                ? vi.fn().mockRejectedValue(new Error(BETA_APIFY_PLAN_ADMISSION_ERROR))
                : vi.fn().mockResolvedValue(snapshots());
            const activate = boundary === 'activation'
                ? vi.fn().mockRejectedValue(new Error(BETA_APIFY_PLAN_ADMISSION_ERROR))
                : vi.fn();
            await expect(admitBetaApifyPlan({
                preflightId: PREFLIGHT_ID, userId: USER_ID,
                admissionToken: ADMISSION_TOKEN, admissionGeneration: 1,
                selectedPlanId: 'basic', maxSnapshotAgeSeconds: 300,
                env: { BETATEST_FREE_POOL_ENABLED: 'true' }, telemetry: { emit },
                store: {
                    replay: vi.fn().mockResolvedValue(null),
                    loadPreflightHold: vi.fn().mockResolvedValue(hold),
                    loadSnapshots, activate,
                },
            })).rejects.toThrow(BETA_APIFY_PLAN_ADMISSION_ERROR);
            expect(emit).toHaveBeenCalledTimes(1);
            expect(emit).toHaveBeenCalledWith(expect.objectContaining({
                event: 'betatest_apify_credit.allocation_rejected',
            }));
        }
    );

    it('preserves invalid-input, runtime-config, persistence, and malformed-result categories', async () => {
        const noCalls = { replay: vi.fn(), loadPreflightHold: vi.fn(), loadSnapshots: vi.fn(), activate: vi.fn() };
        await expect(admitBetaApifyPlan({
            preflightId: 'bad', userId: USER_ID, admissionToken: ADMISSION_TOKEN,
            admissionGeneration: 1, selectedPlanId: 'basic', maxSnapshotAgeSeconds: 300,
            store: noCalls,
        })).rejects.toThrow(BETA_APIFY_PLAN_ADMISSION_INVALID_INPUT);
        await expect(admitBetaApifyPlan({
            preflightId: PREFLIGHT_ID, userId: USER_ID, admissionToken: ADMISSION_TOKEN,
            admissionGeneration: 1, selectedPlanId: 'basic', maxSnapshotAgeSeconds: 300,
            store: { ...noCalls, replay: vi.fn().mockResolvedValue(null) }, env: {},
        })).rejects.toThrow(BETA_APIFY_RUNTIME_CONFIG_ERROR);

        const malformed = createBetaApifyPlanAdmissionStore({
            rpc: vi.fn().mockResolvedValue({ data: { requestId: REQUEST_ID }, error: null }),
        });
        await expect(malformed.replay({
            preflightId: PREFLIGHT_ID, userId: USER_ID, admissionToken: ADMISSION_TOKEN,
            admissionGeneration: 1, selectedPlanId: 'basic',
        })).rejects.toThrow(BETA_APIFY_PLAN_ADMISSION_INVALID_RESULT);

        const outage = createBetaApifyPlanAdmissionStore({
            rpc: vi.fn().mockRejectedValue(new Error('postgres://secret-host')),
        });
        await expect(outage.replay({
            preflightId: PREFLIGHT_ID, userId: USER_ID, admissionToken: ADMISSION_TOKEN,
            admissionGeneration: 1, selectedPlanId: 'basic',
        })).rejects.toThrow(BETA_APIFY_PLAN_ADMISSION_PERSISTENCE_ERROR);
    });

    it('fails closed when the admission token is stale or the feature switch is disabled', async () => {
        const store = createBetaApifyPlanAdmissionStore({
            rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE stale-token' } }),
        });
        const map = Object.fromEntries([
            'target-profile', 'relationship-followers', 'relationship-following', 'profile-fallback',
            'profile-repair', 'target-likers', 'target-comments', 'candidate-likers',
        ].map(key => [key, 'primary'])) as Record<
            'target-profile' | 'relationship-followers' | 'relationship-following' | 'profile-fallback' | 'profile-repair' | 'target-likers' | 'target-comments' | 'candidate-likers',
            'primary'
        >;
        await expect(store.activate({
            preflightId: PREFLIGHT_ID, userId: USER_ID, admissionToken: '77777777-7777-4777-8777-777777777777', admissionGeneration: 2,
            selectedPlanId: 'basic', maxSnapshotAgeSeconds: 300, operationSlotMap: map,
            operationBudgetMap: Object.fromEntries(Object.keys(map).map(key => [key, BETA_APIFY_TARGET_PROFILE_BUDGET_USD])) as Record<keyof typeof map, number>,
        })).rejects.toThrow(BETA_APIFY_PLAN_ADMISSION_ERROR);

        await expect(admitBetaApifyPlan({
            preflightId: PREFLIGHT_ID, userId: USER_ID, admissionToken: ADMISSION_TOKEN, admissionGeneration: 1, selectedPlanId: 'basic', maxSnapshotAgeSeconds: 300,
            store: { replay: vi.fn().mockResolvedValue(null), loadPreflightHold: vi.fn(), loadSnapshots: vi.fn(), activate: vi.fn() }, env: {},
        })).rejects.toThrow(BETA_APIFY_RUNTIME_CONFIG_ERROR);
    });
});
