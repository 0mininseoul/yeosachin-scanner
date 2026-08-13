import { describe, expect, it, vi } from 'vitest';
import {
    createPrecheckoutBliteSourceStore,
    type FinalizePrecheckoutBliteSourceInput,
} from './blite-source-store';

const PREFLIGHT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CLAIM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const HASH = 'a'.repeat(64);
const PROVIDER_RUN = PREFLIGHT;
const PROVIDER_OPERATION_KEY = 'target-profile-fallback';
const COLLECTED_AT = '2026-08-13T00:00:00.000Z';
const EXPIRES_AT = '2026-08-13T00:20:00.000Z';
const SOURCE = {
    schemaVersion: 1 as const,
    fullName: null,
    posts: [],
    media: [],
};

function input(): FinalizePrecheckoutBliteSourceInput {
    return {
        preflightId: PREFLIGHT,
        userId: USER,
        claimToken: CLAIM,
        targetInputHash: HASH,
        providerRunId: PROVIDER_RUN,
        providerOperationKey: PROVIDER_OPERATION_KEY,
        providerRunReference: 'ApifyRun123456',
        targetFullName: 'Target',
        targetBio: null,
        targetProfileImageUrl: 'https://cdninstagram.com/profile.jpg',
        targetFollowersCount: 1,
        targetFollowingCount: 1,
        targetIsPrivate: false,
        capacityRequiredPlanId: 'basic',
        requiredPlanId: 'basic',
        planCardsSnapshot: {},
        source: SOURCE,
        collectedAt: COLLECTED_AT,
        expiresAt: EXPIRES_AT,
    };
}

describe('precheckout B-lite source store', () => {
    it('activates the immutable cohort clock through its claim-fenced RPC before collection', async () => {
        const database = {
            rpc: vi.fn().mockResolvedValue({
                data: {
                    submittedAt: '2026-08-13T00:00:00.000Z',
                    deadlineAt: '2026-08-13T00:01:00.000Z',
                    expiresAt: '2026-08-13T00:30:00.000Z',
                },
                error: null,
            }),
        };
        const store = createPrecheckoutBliteSourceStore(database);

        await expect(store.activateCohort({ preflightId: PREFLIGHT, claimToken: CLAIM }))
            .resolves.toEqual({
                submittedAt: '2026-08-13T00:00:00.000Z',
                deadlineAt: '2026-08-13T00:01:00.000Z',
                expiresAt: '2026-08-13T00:30:00.000Z',
            });
        expect(database.rpc).toHaveBeenCalledWith('activate_precheckout_blite_cohort_v1', {
            p_preflight_id: PREFLIGHT,
            p_claim_token: CLAIM,
        });
    });

    it('finalizes the ready snapshot and bounded source through the exact atomic RPC', async () => {
        const database = { rpc: vi.fn().mockResolvedValue({ data: true, error: null }) };
        const store = createPrecheckoutBliteSourceStore(database);
        const value = input();

        await expect(store.finalizeReadyWithSource(value)).resolves.toBe(true);
        expect(database.rpc).toHaveBeenCalledWith('finalize_preflight_blite_source_v1', {
            p_preflight_id: PREFLIGHT,
            p_user_id: USER,
            p_claim_token: CLAIM,
            p_target_input_hash: HASH,
            p_provider_run_id: PROVIDER_RUN,
            p_provider_operation_key: PROVIDER_OPERATION_KEY,
            p_provider_run_reference: 'ApifyRun123456',
            p_target_full_name: 'Target',
            p_target_bio: null,
            p_target_profile_image_url: 'https://cdninstagram.com/profile.jpg',
            p_target_followers_count: 1,
            p_target_following_count: 1,
            p_target_is_private: false,
            p_capacity_required_plan_id: 'basic',
            p_required_plan_id: 'basic',
            p_plan_cards_snapshot: {},
            p_payload: SOURCE,
            p_payload_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
            p_collected_at: COLLECTED_AT,
            p_expires_at: EXPIRES_AT,
        });
    });

    it('purges with the exact bounded maintenance RPC and fails closed on malformed inputs/results', async () => {
        const database = { rpc: vi.fn().mockResolvedValue({ data: 3, error: null }) };
        const store = createPrecheckoutBliteSourceStore(database);
        await expect(store.purgeExpired({ limit: 3 })).resolves.toBe(3);
        expect(database.rpc).toHaveBeenCalledWith('purge_expired_precheckout_blite_sources_v1', {
            p_limit: 3,
        });
        await expect(store.finalizeReadyWithSource({
            ...input(),
            source: { schemaVersion: 1 } as never,
        }))
            .rejects.toThrow('PRECHECKOUT_BLITE_SOURCE_PERSISTENCE_ERROR');
        const malformed = createPrecheckoutBliteSourceStore({
            rpc: vi.fn().mockResolvedValue({ data: '3', error: null }),
        });
        await expect(malformed.purgeExpired({ limit: 3 }))
            .rejects.toThrow('PRECHECKOUT_BLITE_SOURCE_PERSISTENCE_ERROR');
    });
});
