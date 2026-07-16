import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

import { preflightTargetInputHash } from './preflight-identity';
import {
    ANALYSIS_V2_TARGET_PROFILE_REUSE_DATABASE_NAMES,
    createAnalysisV2TargetProfileReuseStore,
    type AnalysisV2TargetProfileReuseSupabaseClient,
} from './v2-target-profile-reuse';

const requestId = '11111111-1111-4111-8111-111111111111';
const claimToken = '22222222-2222-4222-8222-222222222222';
const jobInputHash = 'a'.repeat(64);
const targetUsername = 'target.account';
const env = Object.freeze({
    ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: Buffer.alloc(32, 7).toString('base64'),
});
const inputHash = preflightTargetInputHash(targetUsername, env);

function client(
    data: unknown,
    error: null | { code?: string; message?: string } = null
) {
    const rpc = vi.fn(async () => ({ data, error }));
    return { rpc, value: { rpc } as AnalysisV2TargetProfileReuseSupabaseClient };
}

function descriptor(overrides: Record<string, unknown> = {}) {
    return {
        runId: 'FreshAdmissionRun123',
        inputHash,
        actorId: 'apify/instagram-profile-scraper',
        credentialSlot: 'quinary',
        maxChargeUsd: 0.0026,
        ...overrides,
    };
}

const claim = Object.freeze({
    requestId,
    jobKey: 'track:target-evidence:collect',
    claimToken,
    jobInputHash,
    targetUsername,
});

describe('analysis V2 reusable target profile run store', () => {
    it('loads a strict descriptor with exact claim parameters and target HMAC', async () => {
        const fake = client(descriptor());
        const store = createAnalysisV2TargetProfileReuseStore(fake.value, env);

        await expect(store.load(claim)).resolves.toEqual({
            ...descriptor(),
            logicalProvider: 'apify',
        });
        expect(fake.rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_TARGET_PROFILE_REUSE_DATABASE_NAMES.loadRpc,
            {
                p_request_id: requestId,
                p_job_key: 'track:target-evidence:collect',
                p_claim_token: claimToken,
                p_job_input_hash: jobInputHash,
            }
        );
    });

    it('returns null only after validating the target HMAC configuration', async () => {
        const fake = client(null);
        await expect(createAnalysisV2TargetProfileReuseStore(fake.value, env).load(claim))
            .resolves.toBeNull();

        const missingSecret = client(null);
        await expect(createAnalysisV2TargetProfileReuseStore(
            missingSecret.value,
            {}
        ).load(claim)).rejects.toThrow('PREFLIGHT_TASKS_CONFIG_ERROR');
        expect(missingSecret.rpc).not.toHaveBeenCalled();
    });

    it.each([
        ['input HMAC mismatch', descriptor({ inputHash: 'b'.repeat(64) })],
        ['wrong actor', descriptor({ actorId: 'other/actor' })],
        ['wrong charge', descriptor({ maxChargeUsd: 0.0027 })],
        ['unexpected field', descriptor({ profile: { username: targetUsername } })],
    ])('fails closed for %s', async (_label, value) => {
        await expect(createAnalysisV2TargetProfileReuseStore(
            client(value).value,
            env
        ).load(claim)).rejects.toThrow('ANALYSIS_V2_TARGET_PROFILE_REUSE_PERSISTENCE_ERROR');
    });

    it('fails closed on RPC errors and non-target jobs', async () => {
        await expect(createAnalysisV2TargetProfileReuseStore(
            client(null, { code: 'P0001', message: 'private detail' }).value,
            env
        ).load(claim)).rejects.toThrow(
            'ANALYSIS_V2_TARGET_PROFILE_REUSE_PERSISTENCE_ERROR (P0001)'
        );

        const fake = client(null);
        await expect(createAnalysisV2TargetProfileReuseStore(fake.value, env).load({
            ...claim,
            jobKey: 'track:profiles:batch:0',
        })).rejects.toThrow('ANALYSIS_V2_TARGET_PROFILE_REUSE_VALIDATION_ERROR');
        expect(fake.rpc).not.toHaveBeenCalled();
    });
});
