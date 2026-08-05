import { describe, expect, it, vi } from 'vitest';
import {
    createAnonymousAnalysisV2Preflight,
    readAnonymousAnalysisV2Preflight,
    reserveAnonymousPreflightBudget,
} from './anonymous-preflight';
import { createAnonymousPreflightClaim } from './anonymous-preflight-claim';
import {
    buildReadyPreflightSnapshot,
    launchStatusSnapshot,
    planCatalogSnapshot,
    pricingSnapshot,
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
            .toEqual({ status: 'quoted', currency: 'KRW', amountKrw: 990 });
        expect(result?.readySnapshot?.plans.find(plan => plan.planId === 'standard')?.price)
            .toEqual({ status: 'quoted', currency: 'KRW', amountKrw: 1_990 });
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
});
