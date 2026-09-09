import { describe, expect, it, vi } from 'vitest';
import {
    claimAnonymousAnalysisV2Preflight,
    createAnonymousAnalysisV2Preflight,
    markAnonymousAnalysisV2PreflightDispatched,
    readAnonymousAnalysisV2Preflight,
    reserveAnonymousAnalysisV2PreflightDispatch,
    reserveAnonymousPreflightBudget,
    setAnonymousAnalysisV2PreflightExclusion,
} from './anonymous-preflight';
import { createAnonymousPreflightClaim } from './anonymous-preflight-claim';
import { createCaptureToken } from '@/lib/services/landing/landing-lead-journey';
import {
    buildReadyPreflightSnapshot,
    InvalidPreflightExclusionError,
    launchStatusSnapshot,
    planCatalogSnapshot,
    pricingSnapshot,
    PreflightImmutableError,
    type ReadyPreflightSnapshot,
} from './preflight';

const env = {
    ANONYMOUS_PREFLIGHT_CLAIM_SECRET:
        'anonymous-preflight-test-secret-with-at-least-32-bytes',
};
const preflightId = '123e4567-e89b-42d3-a456-426614174000';

describe('anonymous preflight service', () => {
    it('passes only hashed claim state and server snapshots to the create RPC', async () => {
        const claim = createAnonymousPreflightClaim({ env });
        const rpc = vi.fn().mockResolvedValue({
            data: [{
                preflight_id: preflightId,
                expires_at: '2026-08-05T00:30:00.000Z',
                created: true,
                preflight_status: 'pending',
            }],
            error: null,
        });
        const result = await createAnonymousAnalysisV2Preflight({
            targetInstagramId: 'target_user',
            targetInputHash: 'a'.repeat(64),
            idempotencyKey: 'anonymous-preflight-001',
            claimToken: claim.token,
            env,
        }, { client: { rpc } });

        expect(result.preflightId).toBe(preflightId);
        expect(result.claimToken).toBe(claim.token);
        expect(rpc).toHaveBeenCalledWith(
            'create_anonymous_analysis_v2_preflight',
            expect.objectContaining({
                p_target_instagram_id: 'target_user',
                p_claim_token_hash: claim.tokenHash,
                p_target_input_hash: 'a'.repeat(64),
            }),
        );
    });

    it('repairs a missed landing capture at the preflight boundary without forwarding raw identity material', async () => {
        const claim = createAnonymousPreflightClaim({ env });
        const capture = createCaptureToken('device-123', env.ANONYMOUS_PREFLIGHT_CLAIM_SECRET);
        const preflightRpc = vi.fn().mockResolvedValue({
            data: [{
                preflight_id: preflightId,
                expires_at: '2026-08-05T00:30:00.000Z',
                created: true,
                preflight_status: 'pending',
            }],
            error: null,
        });
        const landingRpc = vi.fn()
            .mockResolvedValueOnce({
                data: [{ journey_id: capture.journeyId, created: true }],
                error: null,
            })
            .mockResolvedValueOnce({ data: true, error: null });

        await createAnonymousAnalysisV2Preflight({
            targetInstagramId: 'target_user',
            targetInputHash: 'a'.repeat(64),
            idempotencyKey: 'anonymous-preflight-002',
            claimToken: claim.token,
            landingCaptureToken: capture.token,
            anonymousDeviceId: 'device-123',
            env,
        }, { client: { rpc: preflightRpc }, landingClient: { rpc: landingRpc } });

        expect(landingRpc).toHaveBeenNthCalledWith(1, 'create_or_replay_landing_lead_capture', expect.objectContaining({
            p_journey_id: capture.journeyId,
            p_capture_token_hash: capture.tokenHash,
            p_anonymous_principal_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }));
        expect(landingRpc).toHaveBeenNthCalledWith(2, 'bind_landing_lead_journey_to_preflight', {
            p_journey_id: capture.journeyId,
            p_source_preflight_id: preflightId,
        });
        expect(JSON.stringify(landingRpc.mock.calls)).not.toContain(capture.token);
        expect(JSON.stringify(landingRpc.mock.calls)).not.toContain('device-123');
    });

    it('does not report preflight success when the landing capture cannot be persisted', async () => {
        const claim = createAnonymousPreflightClaim({ env });
        const preflightRpc = vi.fn().mockResolvedValue({
            data: [{
                preflight_id: preflightId,
                expires_at: '2026-08-05T00:30:00.000Z',
                created: true,
                preflight_status: 'pending',
            }],
            error: null,
        });
        const landingRpc = vi.fn().mockResolvedValue({
            data: null,
            error: { message: 'LANDING_LEAD_PERSISTENCE_ERROR' },
        });

        await expect(createAnonymousAnalysisV2Preflight({
            targetInstagramId: 'target_user',
            targetInputHash: 'a'.repeat(64),
            idempotencyKey: 'anonymous-preflight-003',
            claimToken: claim.token,
            landingCaptureToken: createCaptureToken('device-123', env.ANONYMOUS_PREFLIGHT_CLAIM_SECRET).token,
            anonymousDeviceId: 'device-123',
            env,
        }, { client: { rpc: preflightRpc }, landingClient: { rpc: landingRpc } })).rejects.toMatchObject({
            message: 'LANDING_LEAD_PERSISTENCE_ERROR:capture',
            preflightId,
        });
    });

    it('requires the signed token before reading anonymous status', async () => {
        const claim = createAnonymousPreflightClaim({ env });
        const rpc = vi.fn().mockResolvedValue({ data: [], error: null });

        await expect(readAnonymousAnalysisV2Preflight(
            preflightId,
            `${claim.token}tampered`,
            { env, client: { rpc } },
        )).rejects.toThrow('ANONYMOUS_PREFLIGHT_CLAIM_INVALID');
        expect(rpc).not.toHaveBeenCalled();
    });

    it('reads the safe public projection and preserves the stored eligibility prices', async () => {
        const claim = createAnonymousPreflightClaim({ env });
        const snapshot = buildReadyPreflightSnapshot({
            username: 'target_user',
            fullName: 'Target',
            bio: 'bio',
            profilePicUrl: 'https://provider.example/avatar.jpg',
            followersCount: 350,
            followingCount: 300,
            postsCount: 10,
            isPrivate: false,
            isVerified: false,
        }, 'production') as ReadyPreflightSnapshot;
        const rpc = vi.fn().mockResolvedValue({
            data: [{
                id: preflightId,
                status: 'ready',
                expires_at: '2026-08-05T00:30:00.000Z',
                error_code: null,
                target_instagram_id: 'target_user',
                target_full_name: 'Target',
                target_bio: 'bio',
                target_followers_count: 350,
                target_following_count: 300,
                target_is_private: false,
                access_mode: 'production',
                launch_status_snapshot: launchStatusSnapshot(),
                capacity_required_plan_id: snapshot.capacityRequiredPlan,
                required_plan_id: snapshot.requiredPlan,
                plan_cards_snapshot: Object.fromEntries(snapshot.plans.map(plan => [plan.planId, {
                    launchStatus: plan.launchStatus,
                    relationshipCapacity: plan.relationshipCapacity,
                    detailedMutualLimit: plan.detailedMutualLimit,
                    selectionState: plan.selectionState,
                    unavailableReason: plan.unavailableReason,
                }])),
                pricing_version: snapshot.pricingVersion,
                pricing_snapshot: pricingSnapshot(),
                exclusion_decision: 'pending',
            }],
            error: null,
        });

        const result = await readAnonymousAnalysisV2Preflight(
            preflightId,
            claim.token,
            { env, client: { rpc } },
        );

        expect(rpc).toHaveBeenCalledWith(
            'read_anonymous_analysis_v2_preflight_public',
            expect.objectContaining({ p_claim_token_hash: claim.tokenHash }),
        );
        expect(result?.readySnapshot?.plans.find(plan => plan.planId === 'basic')?.price)
            .toEqual({ status: 'quoted', currency: 'KRW', amountKrw: 9_900 });
        expect(result?.readySnapshot?.plans.find(plan => plan.planId === 'standard')?.price)
            .toEqual({ status: 'quoted', currency: 'KRW', amountKrw: 19_900 });
        expect(result?.readySnapshot?.target.profileImageUrl).toBeNull();
        expect(planCatalogSnapshot().standard.relationshipCapacity.followers).toBe(800);
    });

    it('maps a budget denial to a bounded decision', async () => {
        const rpc = vi.fn().mockResolvedValue({
            data: [{ allowed: false, reason: 'daily_cap', daily_count: 300 }],
            error: null,
        });
        await expect(reserveAnonymousPreflightBudget({
            ipHash: 'a'.repeat(64),
            deviceHash: 'b'.repeat(64),
            targetInputHash: 'c'.repeat(64),
            client: { rpc },
        })).resolves.toEqual({ allowed: false, reason: 'daily_cap', dailyCount: 300 });
    });

    it('returns an existing owner preflight id for an authenticated retry', async () => {
        const claim = createAnonymousPreflightClaim({ env });
        const rpc = vi.fn().mockResolvedValue({
            data: [{
                claimed: false,
                preflight_status: 'owner_active',
                owner_preflight_id: preflightId,
            }],
            error: null,
        });

        await expect(claimAnonymousAnalysisV2Preflight(
            preflightId,
            claim.token,
            '223e4567-e89b-42d3-a456-426614174000',
            { env, client: { rpc } },
        )).resolves.toEqual({
            claimed: false,
            ownerPreflightId: preflightId,
        });
    });

    it('claims the anonymous preflight and landing journey through one atomic RPC', async () => {
        const claim = createAnonymousPreflightClaim({ env });
        const preflightRpc = vi.fn().mockResolvedValue({
            data: [{
                claimed: true,
                preflight_status: 'claimed',
                owner_preflight_id: null,
            }],
            error: null,
        });
        const landingRpc = vi.fn();

        await expect(claimAnonymousAnalysisV2Preflight(
            preflightId,
            claim.token,
            '223e4567-e89b-42d3-a456-426614174000',
            { env, client: { rpc: preflightRpc }, landingClient: { rpc: landingRpc } },
        )).resolves.toEqual({ claimed: true, ownerPreflightId: null });

        expect(preflightRpc).toHaveBeenCalledWith(
            'claim_anonymous_analysis_v2_preflight_with_landing',
            expect.objectContaining({ p_preflight_id: preflightId }),
        );
        expect(landingRpc).not.toHaveBeenCalled();
    });

    it('writes anonymous exclusions through the owner-or-claim atomic RPC', async () => {
        const claim = createAnonymousPreflightClaim({ env });
        const rpc = vi.fn().mockResolvedValue({ data: true, error: null });

        await expect(setAnonymousAnalysisV2PreflightExclusion({
            preflightId,
            claimToken: claim.token,
            decision: 'exclude',
            excludedInstagramId: 'excluded.user',
        }, { env, client: { rpc } })).resolves.toBe(true);

        expect(rpc).toHaveBeenCalledWith(
            'set_analysis_v2_preflight_exclusion_with_landing',
            {
                p_preflight_id: preflightId,
                p_user_id: null,
                p_claim_token_hash: claim.tokenHash,
                p_decision: 'exclude',
                p_excluded_instagram_id: 'excluded.user',
            },
        );
    });

    it('preserves atomic exclusion validation errors for the anonymous route', async () => {
        const claim = createAnonymousPreflightClaim({ env });
        const rpc = vi.fn()
            .mockResolvedValueOnce({
                data: null,
                error: { message: 'ANALYSIS_V2_INVALID_EXCLUSION' },
            })
            .mockResolvedValueOnce({
                data: null,
                error: { message: 'ANALYSIS_V2_PREFLIGHT_EXPIRED' },
            });

        await expect(setAnonymousAnalysisV2PreflightExclusion({
            preflightId,
            claimToken: claim.token,
            decision: 'exclude',
            excludedInstagramId: 'target.user',
        }, { env, client: { rpc } })).rejects.toBeInstanceOf(InvalidPreflightExclusionError);
        await expect(setAnonymousAnalysisV2PreflightExclusion({
            preflightId,
            claimToken: claim.token,
            decision: 'exclude',
            excludedInstagramId: 'excluded.user',
        }, { env, client: { rpc } })).rejects.toMatchObject({
            name: 'PreflightImmutableError',
            message: 'ANALYSIS_V2_PREFLIGHT_EXPIRED',
        } satisfies Partial<PreflightImmutableError>);
    });

    it('uses versioned role-aware dispatch RPCs for new anonymous tasks', async () => {
        const claim = createAnonymousPreflightClaim({ env });
        const dispatchToken = '323e4567-e89b-42d3-a456-426614174000';
        const rpc = vi.fn()
            .mockResolvedValueOnce({
                data: [{
                    should_enqueue: true,
                    dispatch_generation: 1,
                    reservation_token: dispatchToken,
                    preflight_status: 'pending',
                }],
                error: null,
            })
            .mockResolvedValueOnce({ data: true, error: null });

        await expect(reserveAnonymousAnalysisV2PreflightDispatch(
            preflightId,
            claim.token,
            { env, client: { rpc } },
        )).resolves.toMatchObject({
            shouldEnqueue: true,
            generation: 1,
            reservationToken: dispatchToken,
        });
        await expect(markAnonymousAnalysisV2PreflightDispatched({
            preflightId,
            claimToken: claim.token,
            generation: 1,
            reservationToken: dispatchToken,
        }, { env, client: { rpc } })).resolves.toBe(true);

        expect(rpc).toHaveBeenNthCalledWith(
            1,
            'reserve_anonymous_analysis_v2_preflight_dispatch_v2',
            expect.objectContaining({ p_workload_role: 'preflight', p_contract_version: 2 }),
        );
        expect(rpc).toHaveBeenNthCalledWith(
            2,
            'mark_anonymous_analysis_v2_preflight_dispatched_v2',
            expect.objectContaining({ p_workload_role: 'preflight', p_contract_version: 2 }),
        );
    });
});
