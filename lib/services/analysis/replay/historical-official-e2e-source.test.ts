import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
    loadHistoricalOfficialE2EReplayCaptureDescriptor,
    type HistoricalOfficialE2EReplaySourceRpcClient,
} from './replay-supabase-repository';

const migration = new URL(
    '../../../../supabase/migrations/20260727110000_add_historical_official_e2e_replay_source.sql',
    import.meta.url,
);
const requestId = '10000000-0000-4000-8000-000000000001';

function source() {
    return {
        requestId,
        preflightId: '20000000-0000-4000-8000-000000000001',
        targetUsername: 'replay_0123456789abcdef0123456',
        selectedPlanId: 'standard',
        policyVersions: {
            pipeline: 'v2',
            risk: 'risk-policy-v2.3',
            aiStage: 'ai-stage-policy-v2.7',
        },
        target: {
            fullName: 'Target', bio: 'bio',
            profileImageUrl: 'https://example.com/profile.jpg',
            followersCount: 10, followingCount: 20,
        },
        preflightRuns: [], providerRuns: [],
    };
}

describe('historical official E2E replay source', () => {
    it('uses a UUID-only service RPC and accepts only a schema-valid opaque target', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: source(), error: null });
        const descriptor = await loadHistoricalOfficialE2EReplayCaptureDescriptor(
            { rpc } satisfies HistoricalOfficialE2EReplaySourceRpcClient, requestId,
        );
        expect(rpc).toHaveBeenCalledWith(
            'read_analysis_v2_historical_official_e2e_replay_source', { p_request_id: requestId },
        );
        expect(descriptor.targetUsername).toBe(source().targetUsername);
        expect(descriptor.targetResolution).toBe('provider_ledger');
        expect(descriptor.sourceLineage).toEqual({
            selectedPlanId: 'standard', policyVersions: source().policyVersions,
        });
        expect(descriptor.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    });

    it('rejects any returned stored or arbitrary target identifier', async () => {
        await expect(loadHistoricalOfficialE2EReplayCaptureDescriptor(
            { rpc: vi.fn().mockResolvedValue({ data: { ...source(), targetUsername: 'stored_identifier' }, error: null }) } satisfies HistoricalOfficialE2EReplaySourceRpcClient,
            requestId,
        )).rejects.toThrow('ANALYSIS_V2_REPLAY_READ_ONLY_SOURCE_INVALID');
    });

    it('keeps the new source migration SELECT/STABLE and UUID-only with closed ACLs', async () => {
        const sql = await readFile(migration, 'utf8');
        expect(sql).toContain('read_analysis_v2_historical_official_e2e_replay_source(\n    p_request_id UUID');
        expect(sql).toContain('STABLE');
        expect(sql).toContain('SECURITY DEFINER');
        expect(sql).toContain("SET search_path = ''");
        expect(sql).toContain("request.plan_access_mode_snapshot = 'test_entitlement'");
        expect(sql).toContain("preflight.access_mode = 'test_entitlement'");
        expect(sql).toContain('analysis_v2_test_entitlement_consumptions AS entitlement_consumption');
        expect(sql).toContain('request.test_entitlement_jti_hash = entitlement_consumption.entitlement_jti_hash');
        expect(sql).toContain('entitlement_consumption.user_id = request.user_id');
        expect(sql).toContain("request.policy_versions_snapshot = '{\"pipeline\":\"v2\",\"risk\":\"risk-policy-v2.3\",\"aiStage\":\"ai-stage-policy-v2.7\"}'::JSONB");
        expect(sql).toContain("'replay_' || pg_catalog.substr(pg_catalog.md5");
        expect(sql).not.toContain('target_instagram_id =');
        expect(sql).toContain('REVOKE ALL ON FUNCTION public.read_analysis_v2_historical_official_e2e_replay_source');
        expect(sql).toContain('TO service_role');
        expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/);
    });
});
