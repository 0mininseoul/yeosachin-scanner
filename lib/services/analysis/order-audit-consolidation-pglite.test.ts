import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    buildOrderAuditParityReport,
    type OrderAuditParitySnapshot,
} from './order-audit-consolidation';

const migration = readFileSync(new URL(
        '../../../supabase/migrations/20260905110000_add_order_audit_consolidation_readiness.sql',
    import.meta.url,
), 'utf8');

const REQUEST_ID = '93000000-0000-4000-8000-000000000001';
const EMPTY_REQUEST_ID = '93000000-0000-4000-8000-000000000002';
const NO_ATTESTATION_REQUEST_ID = '93000000-0000-4000-8000-000000000003';
const HASH = 'a'.repeat(64);

const bootstrap = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE TABLE supabase_migrations.schema_migrations (version TEXT PRIMARY KEY);
INSERT INTO supabase_migrations.schema_migrations(version) VALUES ('20260904130000');

CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY,
    pipeline_version TEXT NOT NULL,
    status TEXT NOT NULL,
    plan_access_mode_snapshot TEXT NOT NULL
);
CREATE TABLE public.earlybird_orders (
    id UUID PRIMARY KEY,
    result_request_id UUID
);
CREATE TABLE public.analysis_order_audit_bundles (
    request_id UUID NOT NULL,
    version INTEGER NOT NULL,
    stage_status JSONB NOT NULL,
    mutual_total INTEGER NOT NULL,
    target_likes_collected INTEGER,
    target_comments_collected INTEGER,
    candidate_collected INTEGER NOT NULL,
    completeness_status TEXT NOT NULL,
    cost_status TEXT NOT NULL,
    PRIMARY KEY (request_id, version)
);
CREATE TABLE public.analysis_order_audit_assembly_queue (
    request_id UUID PRIMARY KEY,
    status TEXT NOT NULL
);
CREATE TABLE public.analysis_order_audit_candidates (
    request_id UUID NOT NULL,
    version INTEGER NOT NULL,
    candidate_id TEXT NOT NULL,
    username TEXT NOT NULL,
    mutual_ordinal INTEGER,
    following_ordinal INTEGER,
    is_private BOOLEAN NOT NULL,
    is_verified BOOLEAN NOT NULL,
    public_score NUMERIC,
    risk_band TEXT,
    pre_score NUMERIC,
    raw_score NUMERIC,
    featured_rank INTEGER,
    recent_mutual_rank INTEGER,
    risk_components JSONB,
    partner_safety_operation_key TEXT,
    partner_safety_result_hash TEXT
);
CREATE TABLE public.analysis_order_audit_interactions (
    request_id UUID NOT NULL,
    version INTEGER NOT NULL,
    ordinal INTEGER NOT NULL,
    signal TEXT NOT NULL,
    username TEXT,
    source_post_id TEXT,
    evidence_id TEXT NOT NULL,
    occurred_at TEXT,
    comment_text TEXT,
    details JSONB
);
CREATE TABLE public.analysis_v2_relationship_manifests (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    mutual_count INTEGER NOT NULL,
    PRIMARY KEY (request_id, job_key)
);
CREATE TABLE public.analysis_v2_relationship_sides (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    side TEXT NOT NULL,
    declared_count INTEGER NOT NULL,
    collected_count INTEGER NOT NULL
);
CREATE TABLE public.analysis_v2_mutual_rows (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    mutual_ordinal INTEGER NOT NULL,
    following_ordinal INTEGER NOT NULL,
    username TEXT NOT NULL,
    is_private BOOLEAN NOT NULL,
    is_verified BOOLEAN NOT NULL
);
CREATE TABLE public.analysis_v2_target_evidence_manifests (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    interactor_count INTEGER NOT NULL,
    liker_count INTEGER NOT NULL,
    comment_count INTEGER NOT NULL,
    PRIMARY KEY (request_id, job_key)
);
CREATE TABLE public.analysis_target_interactors (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    actor_username TEXT NOT NULL,
    post_id TEXT NOT NULL,
    signal TEXT NOT NULL,
    source_interaction_id TEXT NOT NULL,
    occurred_at TEXT,
    comment_text TEXT,
    details JSONB
);
CREATE TABLE public.analysis_v2_candidate_feature_rows (
    request_id UUID NOT NULL,
    instagram_id TEXT NOT NULL
);
CREATE TABLE public.analysis_v2_private_name_rows (
    request_id UUID NOT NULL,
    instagram_id TEXT NOT NULL
);
CREATE TABLE public.analysis_v2_candidate_score_manifests (
    request_id UUID NOT NULL,
    item_count INTEGER NOT NULL
);
CREATE TABLE public.analysis_v2_candidate_score_rows (
    request_id UUID NOT NULL,
    candidate_id TEXT NOT NULL,
    public_score NUMERIC,
    risk_band TEXT,
    pre_score NUMERIC,
    raw_score NUMERIC,
    featured_rank INTEGER,
    recent_mutual_rank INTEGER,
    components JSONB,
    partner_safety_operation_key TEXT,
    partner_safety_result_hash TEXT
);
CREATE TABLE public.analysis_v2_cost_rollups (
    request_id UUID NOT NULL,
    directly_attributable_cost_complete BOOLEAN,
    usage_unknown BOOLEAN,
    cost_marker TEXT
);

CREATE OR REPLACE FUNCTION public.analysis_order_audit_digest(p_value TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE STRICT SET search_path = '' AS $$
    SELECT encode(extensions.digest(convert_to(p_value, 'UTF8'), 'sha256'), 'hex');
$$;
CREATE OR REPLACE FUNCTION public.analysis_order_audit_cost_source_hash(p_request_id UUID)
RETURNS TEXT LANGUAGE sql STABLE SET search_path = '' AS $$
    SELECT public.analysis_order_audit_digest(COALESCE((
        SELECT to_jsonb(rollup)::TEXT
        FROM public.analysis_v2_cost_rollups AS rollup
        WHERE rollup.request_id = p_request_id
        LIMIT 1
    ), 'missing-cost-source'));
$$;
CREATE OR REPLACE FUNCTION public.analysis_order_audit_redact_json(p_value JSONB)
RETURNS JSONB LANGUAGE sql IMMUTABLE STRICT SET search_path = '' AS $$
    SELECT p_value;
$$;
`;

describe('read-only order-audit parity RPC', () => {
    let db: PGlite;

    beforeAll(async () => {
        db = await PGlite.create({ extensions: { pgcrypto } });
        await db.exec(bootstrap);
        await db.exec(migration);
        await db.exec(`
            INSERT INTO public.analysis_requests
                (id, pipeline_version, status, plan_access_mode_snapshot)
            VALUES
                ('${REQUEST_ID}', 'v2', 'completed', 'production'),
                ('${EMPTY_REQUEST_ID}', 'v2', 'completed', 'production'),
                ('${NO_ATTESTATION_REQUEST_ID}', 'v2', 'completed', 'production');
            INSERT INTO public.earlybird_orders(id, result_request_id)
            VALUES
                ('94000000-0000-4000-8000-000000000001', '${REQUEST_ID}'),
                ('94000000-0000-4000-8000-000000000003', '${NO_ATTESTATION_REQUEST_ID}');
            INSERT INTO public.analysis_order_audit_assembly_queue(request_id, status)
            VALUES
                ('${REQUEST_ID}', 'completed'),
                ('${NO_ATTESTATION_REQUEST_ID}', 'completed');
            INSERT INTO public.analysis_v2_relationship_manifests
                (request_id, job_key, updated_at, mutual_count)
            VALUES ('${REQUEST_ID}', 'relationships:1', '2026-09-05T00:00:00Z', 1);
            INSERT INTO public.analysis_v2_relationship_sides
                (request_id, job_key, side, declared_count, collected_count)
            VALUES
                ('${REQUEST_ID}', 'relationships:1', 'followers', 1, 1),
                ('${REQUEST_ID}', 'relationships:1', 'following', 1, 1);
            INSERT INTO public.analysis_v2_mutual_rows
                (request_id, job_key, mutual_ordinal, following_ordinal, username, is_private, is_verified)
            VALUES ('${REQUEST_ID}', 'relationships:1', 1, 1, 'candidate.one', false, false);
            INSERT INTO public.analysis_v2_target_evidence_manifests
                (request_id, job_key, updated_at, interactor_count, liker_count, comment_count)
            VALUES ('${REQUEST_ID}', 'target:1', '2026-09-05T00:00:00Z', 1, 1, 0);
            INSERT INTO public.analysis_target_interactors
                (request_id, job_key, ordinal, actor_username, post_id, signal, source_interaction_id)
            VALUES ('${REQUEST_ID}', 'target:1', 1, 'candidate.one', 'post-1', 'target_post_like', 'like-1');
            INSERT INTO public.analysis_v2_candidate_feature_rows(request_id, instagram_id)
            VALUES ('${REQUEST_ID}', 'candidate.one');
            INSERT INTO public.analysis_v2_candidate_score_manifests(request_id, item_count)
            VALUES ('${REQUEST_ID}', 1);
            INSERT INTO public.analysis_v2_candidate_score_rows
                (request_id, candidate_id, public_score, risk_band, pre_score, raw_score,
                 featured_rank, recent_mutual_rank, components,
                 partner_safety_operation_key, partner_safety_result_hash)
            VALUES ('${REQUEST_ID}', 'candidate-1', 8.2, 'high_risk', 80, 80, 1, 1,
                '{"recentMutual": 1}'::jsonb, 'partner:1', '${HASH}');
            INSERT INTO public.analysis_v2_cost_rollups
                (request_id, directly_attributable_cost_complete, usage_unknown, cost_marker)
            VALUES ('${REQUEST_ID}', true, false, 'initial');
            INSERT INTO public.analysis_order_audit_bundles
                (request_id, version, stage_status, mutual_total, target_likes_collected,
                 target_comments_collected, candidate_collected, completeness_status, cost_status)
            VALUES ('${REQUEST_ID}', 1,
                jsonb_build_object(
                    'relationships', true,
                    'targetEvidence', true,
                    'candidateFeatures', true,
                    'riskScores', true,
                    'cost', 'complete',
                    'costSourceHash', public.analysis_order_audit_cost_source_hash('${REQUEST_ID}')
                ),
                1, 1, 0, 1, 'complete', 'complete');
            INSERT INTO public.analysis_order_audit_bundles
                (request_id, version, stage_status, mutual_total, target_likes_collected,
                 target_comments_collected, candidate_collected, completeness_status, cost_status)
            VALUES ('${NO_ATTESTATION_REQUEST_ID}', 1,
                jsonb_build_object(
                    'relationships', true,
                    'targetEvidence', true,
                    'candidateFeatures', true,
                    'riskScores', true,
                    'cost', 'complete',
                    'costSourceHash', public.analysis_order_audit_cost_source_hash('${NO_ATTESTATION_REQUEST_ID}')
                ),
                0, 0, 0, 0, 'complete', 'complete');
            INSERT INTO public.analysis_order_audit_candidates
                (request_id, version, candidate_id, username, mutual_ordinal, following_ordinal,
                 is_private, is_verified, public_score, risk_band, pre_score, raw_score,
                 featured_rank, recent_mutual_rank, risk_components,
                 partner_safety_operation_key, partner_safety_result_hash)
            VALUES ('${REQUEST_ID}', 1, 'candidate-1', 'candidate.one', 1, 1, false, false,
                8.2, 'high_risk', 80, 80, 1, 1, '{"recentMutual": 1}'::jsonb,
                'partner:1', '${HASH}');
            INSERT INTO public.analysis_order_audit_interactions
                (request_id, version, ordinal, username, signal, source_post_id, evidence_id)
            VALUES ('${REQUEST_ID}', 1, 1, 'candidate.one', 'target_post_like', 'post-1', 'like-1');
        `);
    });

    afterAll(async () => {
        await db.close();
    });

    async function readSnapshot(requestId: string): Promise<OrderAuditParitySnapshot> {
        const result = await db.query<{ result: unknown }>(
            'SELECT public.read_analysis_order_audit_parity_snapshot($1) AS result',
            [requestId],
        );
        return result.rows[0]?.result as OrderAuditParitySnapshot;
    }

    it('returns only aggregate parity metadata for a completed production order', async () => {
        const payload = await readSnapshot(REQUEST_ID);
        expect(payload).toMatchObject({
            request: {
                completed: true,
                productionOrder: true,
                sourceDataPresent: true,
            },
            bundle: {
                present: true,
                completeness: 'complete',
                costStatus: 'complete',
                version: 1,
            },
        });
        expect(payload).toMatchObject({
            recovery: { present: true, completed: true },
        });
        expect(payload).not.toHaveProperty('requestId');
        expect(JSON.stringify(payload)).not.toContain('candidate.one');
        expect(JSON.stringify(payload)).not.toContain('post-1');
        expect(JSON.stringify(payload)).not.toContain(REQUEST_ID);
        const sections = payload.sections as Record<string, Record<string, unknown>>;
        expect(sections.relationships).toMatchObject({ sourceCount: 1, bundleCount: 1 });
        expect(sections.targetEvidence).toMatchObject({ sourceCount: 1, bundleCount: 1 });
        expect(sections.candidates).toMatchObject({ sourceCount: 1, bundleCount: 1 });
        expect(sections.risk).toMatchObject({ sourceCount: 1, bundleCount: 1 });
        expect(sections.costLedger).toMatchObject({ sourceCount: 1, bundleCount: 1 });
        for (const section of Object.values(sections)) {
            expect(section.sourceChecksum).toBe(section.bundleChecksum);
        }
    });

    it('blocks a completed bundle with no captured attestation after source rows are absent', async () => {
        const payload = await readSnapshot(NO_ATTESTATION_REQUEST_ID);
        const report = buildOrderAuditParityReport(payload);
        const queue = await db.query<{ parity_attestation: unknown }>(
            'SELECT parity_attestation FROM public.analysis_order_audit_assembly_queue WHERE request_id = $1',
            [NO_ATTESTATION_REQUEST_ID],
        );

        expect(queue.rows[0]?.parity_attestation).toBeNull();
        expect(payload).toMatchObject({
            request: {
                completed: true,
                productionOrder: true,
                sourceDataPresent: false,
            },
            bundle: { present: true, version: 1 },
            recovery: { present: true, completed: true },
        });
        expect(report.status).toBe('blocked');
        expect(report.mismatchPaths).toContain('source.no-data');
    });

    it('enforces aggregate-only attestation keys and the bounded JSON size', async () => {
        await db.exec('BEGIN');
        try {
            const unsafe = {
                request: { completed: true, productionOrder: true, sourceDataPresent: true },
                bundle: { present: true, completeness: 'complete', costStatus: 'complete', version: 1 },
                recovery: { present: true, completed: true },
                sections: {
                    relationships: { requestId: 'not-safe' },
                    targetEvidence: null,
                    candidates: null,
                    risk: null,
                    costLedger: null,
                },
            };
            await expect(db.query(
                'UPDATE public.analysis_order_audit_assembly_queue SET parity_attestation = $1 WHERE request_id = $2',
                [JSON.stringify(unsafe), REQUEST_ID],
            )).rejects.toThrow();

            const oversized = {
                request: { completed: true, productionOrder: true, sourceDataPresent: true },
                bundle: { present: true, completeness: 'complete', costStatus: 'complete', version: 1 },
                recovery: { present: true, completed: true },
                sections: {
                    relationships: { padding: 'x'.repeat(65536) },
                    targetEvidence: null,
                    candidates: null,
                    risk: null,
                    costLedger: null,
                },
            };
            await expect(db.query(
                'UPDATE public.analysis_order_audit_assembly_queue SET parity_attestation = $1 WHERE request_id = $2',
                [JSON.stringify(oversized), REQUEST_ID],
            )).rejects.toThrow();
        } finally {
            await db.exec('ROLLBACK');
        }
    });

    it('captures an all-ready snapshot before purge and reuses it after source deletion', async () => {
        await db.exec('BEGIN');
        try {
            await db.query(
                "UPDATE public.analysis_order_audit_assembly_queue SET status = 'processing' WHERE request_id = $1",
                [REQUEST_ID],
            );
            await db.query(
                "UPDATE public.analysis_order_audit_assembly_queue SET status = 'completed' WHERE request_id = $1",
                [REQUEST_ID],
            );
            const before = await readSnapshot(REQUEST_ID);
            const beforeReport = buildOrderAuditParityReport(before);
            const stored = await db.query<{ parity_attestation: unknown }>(
                'SELECT parity_attestation FROM public.analysis_order_audit_assembly_queue WHERE request_id = $1',
                [REQUEST_ID],
            );

            expect(beforeReport.status).toBe('ready');
            expect(stored.rows[0]?.parity_attestation).not.toBeNull();
            expect(JSON.stringify(stored.rows[0]?.parity_attestation)).not.toContain(REQUEST_ID);
            expect(JSON.stringify(stored.rows[0]?.parity_attestation)).not.toContain('candidate.one');

            for (const table of [
                'analysis_v2_relationship_manifests',
                'analysis_v2_relationship_sides',
                'analysis_v2_mutual_rows',
                'analysis_v2_target_evidence_manifests',
                'analysis_target_interactors',
                'analysis_v2_candidate_feature_rows',
                'analysis_v2_private_name_rows',
                'analysis_v2_candidate_score_manifests',
                'analysis_v2_candidate_score_rows',
                'analysis_v2_cost_rollups',
            ]) {
                await db.query(`DELETE FROM public.${table} WHERE request_id = $1`, [REQUEST_ID]);
            }

            const after = await readSnapshot(REQUEST_ID);
            const afterReport = buildOrderAuditParityReport(after);
            expect(afterReport.status).toBe('ready');
            expect(afterReport.mismatchPaths).toEqual(beforeReport.mismatchPaths);
            expect(afterReport.sections).toEqual(beforeReport.sections);
        } finally {
            await db.exec('ROLLBACK');
        }
    });

    it('persists a mismatched source checksum through source purge', async () => {
        await db.exec('BEGIN');
        try {
            await db.query(
                "UPDATE public.analysis_target_interactors SET source_interaction_id = 'drifted-like' WHERE request_id = $1",
                [REQUEST_ID],
            );
            await db.query(
                "UPDATE public.analysis_order_audit_assembly_queue SET status = 'processing' WHERE request_id = $1",
                [REQUEST_ID],
            );
            await db.query(
                "UPDATE public.analysis_order_audit_assembly_queue SET status = 'completed' WHERE request_id = $1",
                [REQUEST_ID],
            );
            const live = await readSnapshot(REQUEST_ID);
            const liveTarget = live.sections.targetEvidence;
            const liveReport = buildOrderAuditParityReport(live);

            expect(liveReport.status).toBe('mismatch');
            expect(liveTarget?.sourceChecksum).not.toBe(liveTarget?.bundleChecksum);

            await db.query(
                'DELETE FROM public.analysis_target_interactors WHERE request_id = $1',
                [REQUEST_ID],
            );
            await db.query(
                'DELETE FROM public.analysis_v2_target_evidence_manifests WHERE request_id = $1',
                [REQUEST_ID],
            );
            const afterPurge = await readSnapshot(REQUEST_ID);
            const afterTarget = afterPurge.sections.targetEvidence;
            const afterReport = buildOrderAuditParityReport(afterPurge);

            expect(afterTarget?.sourceChecksum).toBe(liveTarget?.sourceChecksum);
            expect(afterTarget?.bundleChecksum).toBe(liveTarget?.bundleChecksum);
            expect(afterReport.status).toBe('mismatch');
            expect(afterReport.mismatchPaths).toContain('sections.targetEvidence.checksum');
        } finally {
            await db.exec('ROLLBACK');
        }
    });

    it('carries forward non-cost sections while refreshing late cost evidence', async () => {
        await db.exec('BEGIN');
        try {
            await db.query(
                "UPDATE public.analysis_order_audit_assembly_queue SET status = 'processing' WHERE request_id = $1",
                [REQUEST_ID],
            );
            await db.query(
                "UPDATE public.analysis_order_audit_assembly_queue SET status = 'completed' WHERE request_id = $1",
                [REQUEST_ID],
            );
            const initial = await readSnapshot(REQUEST_ID);
            const initialReport = buildOrderAuditParityReport(initial);
            const initialCostChecksum = initial.sections.costLedger?.sourceChecksum;

            expect(initialReport.status).toBe('ready');

            for (const table of [
                'analysis_v2_relationship_manifests',
                'analysis_v2_relationship_sides',
                'analysis_v2_mutual_rows',
                'analysis_v2_target_evidence_manifests',
                'analysis_target_interactors',
                'analysis_v2_candidate_feature_rows',
                'analysis_v2_private_name_rows',
                'analysis_v2_candidate_score_manifests',
                'analysis_v2_candidate_score_rows',
                'analysis_v2_cost_rollups',
            ]) {
                await db.query(`DELETE FROM public.${table} WHERE request_id = $1`, [REQUEST_ID]);
            }
            await db.query(
                `INSERT INTO public.analysis_v2_cost_rollups
                    (request_id, directly_attributable_cost_complete, usage_unknown, cost_marker)
                 VALUES ($1, true, false, 'late')`,
                [REQUEST_ID],
            );
            const lateCostHashResult = await db.query<{ hash: string }>(
                'SELECT public.analysis_order_audit_cost_source_hash($1) AS hash',
                [REQUEST_ID],
            );
            const lateCostChecksum = lateCostHashResult.rows[0]?.hash;
            expect(lateCostChecksum).toBeTruthy();
            expect(lateCostChecksum).not.toBe(initialCostChecksum);

            await db.query(
                `INSERT INTO public.analysis_order_audit_bundles
                    (request_id, version, stage_status, mutual_total, target_likes_collected,
                     target_comments_collected, candidate_collected, completeness_status, cost_status)
                 VALUES ($1, 2,
                    jsonb_build_object(
                        'relationships', true,
                        'targetEvidence', true,
                        'candidateFeatures', true,
                        'riskScores', true,
                        'cost', 'complete',
                        'costSourceHash', public.analysis_order_audit_cost_source_hash($1)
                    ),
                    1, 1, 0, 1, 'complete', 'complete')`,
                [REQUEST_ID],
            );
            await db.query(
                `INSERT INTO public.analysis_order_audit_candidates
                    (request_id, version, candidate_id, username, mutual_ordinal, following_ordinal,
                     is_private, is_verified, public_score, risk_band, pre_score, raw_score,
                     featured_rank, recent_mutual_rank, risk_components,
                     partner_safety_operation_key, partner_safety_result_hash)
                 VALUES ($1, 2, 'candidate-1', 'candidate.one', 1, 1, false, false,
                    8.2, 'high_risk', 80, 80, 1, 1, '{"recentMutual": 1}'::jsonb,
                    'partner:1', $2)`,
                [REQUEST_ID, HASH],
            );
            await db.query(
                `INSERT INTO public.analysis_order_audit_interactions
                    (request_id, version, ordinal, username, signal, source_post_id, evidence_id)
                 VALUES ($1, 2, 1, 'candidate.one', 'target_post_like', 'post-1', 'like-1')`,
                [REQUEST_ID],
            );
            await db.query(
                "UPDATE public.analysis_order_audit_assembly_queue SET status = 'processing' WHERE request_id = $1",
                [REQUEST_ID],
            );
            await db.query(
                "UPDATE public.analysis_order_audit_assembly_queue SET status = 'completed' WHERE request_id = $1",
                [REQUEST_ID],
            );

            const after = await readSnapshot(REQUEST_ID);
            const afterReport = buildOrderAuditParityReport(after);
            expect(after).toMatchObject({ bundle: { present: true, version: 2 } });
            expect(after.sections.costLedger).toMatchObject({
                sourceCount: 1,
                bundleCount: 1,
                sourceChecksum: lateCostChecksum,
                bundleChecksum: lateCostChecksum,
                sourceComplete: true,
                bundleComplete: true,
            });
            for (const name of ['relationships', 'targetEvidence', 'candidates', 'risk'] as const) {
                expect(after.sections[name]?.sourceChecksum)
                    .toBe(after.sections[name]?.bundleChecksum);
                expect(after.sections[name]?.sourceCount).toBe(1);
                expect(after.sections[name]?.sourceComplete).toBe(true);
            }
            expect(afterReport.status).toBe('ready');
        } finally {
            await db.exec('ROLLBACK');
        }
    });

    it('marks absent source/bundle data as incomplete instead of passing empty parity', async () => {
        const result = await db.query<{ result: unknown }>(
            'SELECT public.read_analysis_order_audit_parity_snapshot($1) AS result',
            [EMPTY_REQUEST_ID],
        );
        expect(result.rows[0]?.result).toMatchObject({
            request: {
                completed: true,
                productionOrder: false,
                sourceDataPresent: false,
            },
            bundle: { present: false, completeness: null, version: null },
            recovery: { present: false, completed: false },
            sections: {
                relationships: null,
                targetEvidence: null,
                candidates: null,
                risk: null,
                costLedger: null,
            },
        });
    });

    it('changes only the source checksum when a legacy source row diverges', async () => {
        await db.query(
            'UPDATE public.analysis_target_interactors SET source_interaction_id = $1 WHERE request_id = $2',
            ['like-drift', REQUEST_ID],
        );
        const result = await db.query<{ result: unknown }>(
            'SELECT public.read_analysis_order_audit_parity_snapshot($1) AS result',
            [REQUEST_ID],
        );
        const payload = result.rows[0]?.result as Record<string, unknown>;
        const target = (payload.sections as Record<string, Record<string, unknown>>).targetEvidence;
        expect(target.sourceCount).toBe(target.bundleCount);
        expect(target.sourceChecksum).not.toBe(target.bundleChecksum);
    });
});
