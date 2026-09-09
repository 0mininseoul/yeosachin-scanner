import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createAnalysisCanonicalStore,
    type AnalysisCanonicalSupabaseClient,
} from './canonical-analysis-store';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

function canonicalMigrationPath(): URL {
    const directory = new URL('../../../supabase/migrations/', import.meta.url);
    const files = readdirSync(directory).filter(file => (
        file.endsWith('_add_analysis_canonical_tables.sql')
    ));
    expect(files).toHaveLength(1);
    return new URL(files[0]!, directory);
}

function migrationSql(): string {
    return readFileSync(canonicalMigrationPath(), 'utf8');
}

describe('analysis canonical table migration contract', () => {
    it('defines the six additive canonical tables and their request indexes', () => {
        const sql = migrationSql();
        for (const table of [
            'analysis_jobs',
            'analysis_events',
            'analysis_artifacts',
            'analysis_costs',
            'analysis_cache',
            'analysis_audit_bundles',
        ]) {
            expect(sql).toContain(`CREATE TABLE public.${table}`);
            expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
            expect(sql).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
            expect(sql).toMatch(new RegExp(
                `REVOKE ALL ON TABLE public\\.${table}\\s+FROM PUBLIC, anon, authenticated, service_role`
            ));
        }
        for (const index of [
            'analysis_jobs_dispatch_idx',
            'analysis_events_request_created_idx',
            'analysis_artifacts_request_kind_idx',
            'analysis_costs_request_recorded_idx',
            'analysis_cache_expiry_idx',
            'analysis_audit_request_version_idx',
        ]) {
            expect(sql).toContain(`CREATE INDEX ${index}`);
        }
    });

    it('keeps canonical domains, ownership, and unknown cost semantics explicit', () => {
        const sql = migrationSql();
        expect(sql).toContain("kind IN ('coordinator', 'collection', 'ai', 'finalize', 'recovery')");
        expect(sql).toContain("state IN ('queued', 'leased', 'running', 'succeeded', 'failed', 'blocked')");
        expect(sql).toContain('request_id UUID NOT NULL REFERENCES public.analysis_requests(id)');
        expect(sql).toContain('usage_unknown BOOLEAN NOT NULL');
        expect(sql).toContain('CHECK (amount_known IS NULL OR amount_known >= 0)');
        expect(sql).toContain('CHECK (NOT usage_unknown OR amount_known IS NULL)');
        expect(sql).toContain('UNIQUE (request_id, version, kind, content_hash)');
        expect(sql).toContain("candidate_key TEXT");
        expect(sql).toContain("ordinal INTEGER");
    });

    it('exposes only service-role RPCs and rejects raw provider secrets', () => {
        const sql = migrationSql();
        for (const rpc of [
            'record_analysis_canonical_job',
            'append_analysis_canonical_event',
            'append_analysis_canonical_artifact',
            'append_analysis_canonical_cost',
            'upsert_analysis_canonical_cache',
            'append_analysis_canonical_audit',
            'enqueue_analysis_canonical_retry',
            'load_analysis_canonical_family',
        ]) {
            expect(sql).toContain(`CREATE OR REPLACE FUNCTION public.${rpc}`);
            expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${rpc}`);
            expect(sql).toMatch(new RegExp(
                `REVOKE ALL ON FUNCTION public\\.${rpc}\\([\\s\\S]*?FROM PUBLIC, anon, authenticated, service_role`
            ));
        }
        expect(sql).toMatch(/SECURITY DEFINER[\s\S]*SET search_path = ''/);
        expect(sql).not.toMatch(/provider_token|access_token|cookie|raw_provider_payload/i);
        expect(sql).toContain('CREATE TRIGGER analysis_events_append_only');
        expect(sql).toContain('CREATE TRIGGER analysis_audit_bundles_append_only');
    });
});

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const hash = 'a'.repeat(64);

function rpcClient(
    rpc: AnalysisCanonicalSupabaseClient['rpc'] = vi.fn(async () => ({
        data: {},
        error: null,
    }))
): AnalysisCanonicalSupabaseClient {
    return { rpc };
}

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('analysis canonical server adapter', () => {
    it('keeps all canonical writes disabled unless the family flag is explicit', async () => {
        const rpc = vi.fn();
        const store = createAnalysisCanonicalStore(rpcClient(rpc));

        await expect(store.appendCost({
            requestId,
            provider: 'vertex',
            operationKey: 'score:001',
            stage: 'score',
            amountKnown: null,
            amountConservative: 0.014,
            usageUnknown: true,
            sourceHash: hash,
        })).resolves.toEqual({ status: 'disabled', usageUnknown: true });
        expect(rpc).not.toHaveBeenCalled();
    });

    it('appends an unknown-usage cost without inventing a known amount', async () => {
        vi.stubEnv('ANALYSIS_CANONICAL_COST_WRITE', 'true');
        const rpc = vi.fn(async () => ({ data: {}, error: null }));
        const store = createAnalysisCanonicalStore(rpcClient(rpc));

        await expect(store.appendCost({
            requestId,
            provider: 'vertex',
            operationKey: 'score:001',
            stage: 'score',
            amountKnown: null,
            amountConservative: 0.014,
            usageUnknown: true,
            sourceHash: hash,
        })).resolves.toEqual({ status: 'appended', usageUnknown: true });
        expect(rpc).toHaveBeenCalledWith('append_analysis_canonical_cost', expect.objectContaining({
            p_request_id: requestId,
            p_amount_known: null,
            p_amount_conservative: 0.014,
            p_usage_unknown: true,
            p_source_hash: hash,
        }));
    });

    it('rejects forbidden payload keys before crossing the RPC boundary', async () => {
        vi.stubEnv('ANALYSIS_CANONICAL_EVIDENCE_WRITE', 'true');
        const rpc = vi.fn();
        const store = createAnalysisCanonicalStore(rpcClient(rpc));

        await expect(store.appendArtifact({
            requestId,
            kind: 'evidence',
            artifactKey: 'evidence:1',
            state: 'retained',
            contentHash: hash,
            retentionClass: 'standard',
            payload: { providerToken: 'must-not-cross-boundary' },
        })).rejects.toThrow('forbidden payload key');
        expect(rpc).not.toHaveBeenCalled();
    });

    it('queues one bounded retry marker after a one-sided canonical write', async () => {
        vi.stubEnv('ANALYSIS_CANONICAL_AUDIT_WRITE', 'true');
        const rpc = vi.fn()
            .mockResolvedValueOnce({ data: null, error: { message: 'temporary write failure' } })
            .mockResolvedValueOnce({ data: { status: 'queued' }, error: null });
        const store = createAnalysisCanonicalStore(rpcClient(rpc));

        await expect(store.appendAuditRow({
            requestId,
            version: 1,
            kind: 'bundle',
            state: 'complete',
            contentHash: hash,
            retentionClass: 'permanent',
            payload: { resultStatus: 'completed' },
        })).resolves.toEqual({ status: 'retry_queued', family: 'audit' });
        expect(rpc).toHaveBeenNthCalledWith(2, 'enqueue_analysis_canonical_retry', {
            p_request_id: requestId,
            p_family: 'audit',
        });
    });
});
