import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calculateRiskPolicy, type RiskPolicyInput } from '@/lib/domain/analysis/risk-policy';
import {
    assignRelativeRiskTiers,
    assignRelativeRiskTiersV25,
} from '@/lib/domain/analysis/relative-risk-policy';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260727032000_add_analysis_v2_score_audit.sql',
    import.meta.url,
), 'utf8');
const cleanupMigration = readFileSync(new URL(
    '../../../supabase/migrations/20260901192353_fix_analysis_v2_score_audit_expiry_orphans.sql',
    import.meta.url,
), 'utf8');
const riskPolicyV24Migration = readFileSync(new URL(
    '../../../supabase/migrations/20260726090000_add_risk_policy_v24.sql',
    import.meta.url,
), 'utf8');
const riskPolicyV25Migration = readFileSync(new URL(
    '../../../supabase/migrations/20260728180000_add_risk_policy_v25.sql',
    import.meta.url,
), 'utf8');
const requestId = '123e4567-e89b-42d3-a456-426614174000';
const resultHash = 'a'.repeat(64);
const preMigrationRequestId = 'aa000000-e89b-42d3-a456-426614174000';
let db: PGlite;

function functionDefinition(
    source: string,
    name: string,
    occurrence = 0,
): string {
    const marker = `CREATE OR REPLACE FUNCTION public.${name}(`;
    let start = -1;
    for (let index = 0; index <= occurrence; index += 1) {
        start = source.indexOf(marker, start + 1);
        if (start < 0) throw new Error(`Missing function ${name} occurrence ${occurrence}`);
    }
    const end = source.indexOf('\n$$;', start);
    if (end < 0) throw new Error(`Unbounded function ${name} occurrence ${occurrence}`);
    return source.slice(start, end + 4);
}

function migrationBlock(source: string, marker: string): string {
    const start = source.indexOf(marker);
    if (start < 0) throw new Error(`Missing migration block ${marker}`);
    const blockStart = source.indexOf('DO $migration$', start);
    const end = source.indexOf('\n$migration$;', blockStart);
    if (blockStart < 0 || end < 0) throw new Error(`Unbounded migration block ${marker}`);
    return source.slice(blockStart, end + '\n$migration$;'.length);
}

beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
        CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
        CREATE SCHEMA extensions;
        CREATE FUNCTION extensions.gen_random_uuid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${requestId}'::uuid $$;
        CREATE TABLE public.analysis_requests (id uuid PRIMARY KEY, status text NOT NULL, pipeline_version text NOT NULL, policy_versions_snapshot jsonb NOT NULL);
        CREATE TABLE public.analysis_v2_result_summaries (request_id uuid PRIMARY KEY, score_policy_version text NOT NULL, female_count smallint NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
        CREATE TABLE public.analysis_v2_female_results (request_id uuid NOT NULL, candidate_id text NOT NULL, sort_ordinal smallint NOT NULL, instagram_id text NOT NULL, display_score numeric NOT NULL, risk_band text NOT NULL, featured_rank smallint, PRIMARY KEY (request_id, candidate_id));
        CREATE TABLE public.analysis_v2_ai_scoring_stage_checkpoints (
            request_id uuid NOT NULL, stage_kind text NOT NULL,
            batch_key int NOT NULL, result_hash text NOT NULL,
            payload jsonb NOT NULL,
            item_count int GENERATED ALWAYS AS (
                CASE WHEN jsonb_typeof(payload->'candidates') = 'array'
                    THEN jsonb_array_length(payload->'candidates') ELSE 0 END
            ) STORED,
            PRIMARY KEY (request_id, stage_kind, batch_key)
        );
        CREATE TABLE public.analysis_v2_candidate_feature_rows (request_id uuid NOT NULL, candidate_id text NOT NULL, full_name text, bio text, classification_source text NOT NULL, terminal_classification text NOT NULL, PRIMARY KEY (request_id, candidate_id));
        CREATE TABLE public.analysis_pipeline_jobs (
            request_id uuid NOT NULL, job_key text NOT NULL, status text NOT NULL,
            input_hash text NOT NULL, completion_token uuid
        );
        CREATE TABLE public.analysis_v2_narrative_manifests (request_id uuid);
        CREATE TABLE public.analysis_v2_candidate_score_manifests (request_id uuid);
        CREATE TABLE public.analysis_v2_partner_safety_manifests (request_id uuid);
        CREATE TABLE public.analysis_v2_reverse_like_manifests (request_id uuid);
        CREATE TABLE public.analysis_v2_preliminary_score_manifests (request_id uuid);
        CREATE TABLE public.analysis_v2_private_name_manifests (request_id uuid);
        CREATE TABLE public.analysis_v2_candidate_feature_manifests (request_id uuid);
        CREATE TABLE public.analysis_v2_ai_result_checkpoints (request_id uuid);
        CREATE TABLE public.analysis_v2_profile_fetch_batches (request_id uuid);
        CREATE TABLE public.analysis_v2_target_evidence_manifests (request_id uuid);
        CREATE TABLE public.analysis_v2_relationship_manifests (request_id uuid);
        CREATE TABLE public.analysis_v2_relationship_sides (request_id uuid);
    `);
    await db.exec(functionDefinition(
        riskPolicyV24Migration,
        'analysis_v2_expected_relative_risk_rows',
        0,
    ));
    await db.exec(functionDefinition(
        riskPolicyV24Migration,
        'analysis_v2_expected_relative_risk_rows_v23',
    ));
    await db.exec(functionDefinition(
        riskPolicyV24Migration,
        'analysis_v2_expected_relative_risk_rows',
        1,
    ));
    await db.query(
        'INSERT INTO public.analysis_requests VALUES ($1, $2, $3, $4::jsonb)',
        [preMigrationRequestId, 'completed', 'v2', JSON.stringify({
            risk: 'risk-policy-v2.4', aiStage: 'ai-stage-policy-v2.7',
        })],
    );
    await db.query(
        `INSERT INTO public.analysis_v2_result_summaries
            (request_id, score_policy_version, female_count, created_at)
         VALUES ($1, 'risk-policy-v2.4', 0,
            clock_timestamp() - INTERVAL '10 minutes')`,
        [preMigrationRequestId],
    );
    await db.exec(migration);
    await db.exec(cleanupMigration);
    await db.exec(functionDefinition(
        riskPolicyV25Migration,
        'analysis_v2_expected_relative_risk_rows_v25',
    ));
    await db.exec(functionDefinition(
        riskPolicyV25Migration,
        'analysis_v2_expected_relative_risk_rows',
    ));
    await db.exec(functionDefinition(
        riskPolicyV25Migration,
        'analysis_v2_score_audit_expected_v25_components',
    ));
    await db.exec(migrationBlock(
        riskPolicyV25Migration,
        '-- Extend the audit capture/materialization gates',
    ));
}, 60_000);

afterAll(async () => { await db.close(); }, 30_000);

function naturalBand(publicScore: number): 'normal' | 'caution' | 'high_risk' {
    if (publicScore < 4.2) return 'normal';
    if (publicScore < 6.8) return 'caution';
    return 'high_risk';
}

function roundedDisplay(publicScore: number): number {
    return Math.round((publicScore + Number.EPSILON) * 10) / 10;
}

async function expectedRelativeFromSql(
    rows: readonly Record<string, unknown>[],
    strongIds: readonly string[] = [],
) {
    return (await db.query<{
        candidate_id: string;
        display_score: number;
        risk_band: 'normal' | 'caution' | 'high_risk';
        relative_tier_applied: boolean;
    }>(
        `SELECT candidate_id, display_score::float8 AS display_score,
                risk_band, relative_tier_applied
         FROM public.analysis_v2_expected_relative_risk_rows(
            $1::jsonb, $2::text[], 'risk-policy-v2.4'
         )
         ORDER BY candidate_id`,
        [JSON.stringify(rows), strongIds],
    )).rows;
}

interface AuditFixtureCandidate extends Record<string, unknown> {
    candidateId: string;
    username: string;
    displayScore: number;
    riskBand: 'normal' | 'caution' | 'high_risk';
    featuredRank: number | null;
}

function canonicalFixtureCandidate(
    candidateId: string,
    username: string,
    input: RiskPolicyInput,
    policyVersion: 'risk-policy-v2.4' | 'risk-policy-v2.5' = 'risk-policy-v2.4',
): AuditFixtureCandidate {
    const risk = calculateRiskPolicy(input, policyVersion);
    const relativeInput = [{
        candidateId,
        naturalPublicScore: risk.publicScore,
        naturalDisplayScore: risk.displayScore,
        naturalRiskBand: risk.riskBand,
        partnerCapApplied: risk.partnerCapApplied,
        isInbound: input.uniqueTargetPostsLikedByCandidate > 0
            || input.boundedCandidateCommentsOnTarget > 0
            || input.hasCandidateToTargetTagOrCaptionMention,
        personalRiskEligible: input.accountContext !== 'official_group_or_brand',
    }];
    const relative = (
        policyVersion === 'risk-policy-v2.5'
            ? assignRelativeRiskTiersV25(relativeInput)
            : assignRelativeRiskTiers(relativeInput)
    )[0]!;
    return {
        candidateId,
        username,
        ...input,
        risk,
        displayScore: relative.displayScore,
        riskBand: relative.riskBand,
        relativeTierApplied: relative.relativeTierApplied,
        featuredRank: null,
    };
}

function normalizeFixtureCandidates(
    candidates: readonly AuditFixtureCandidate[],
    policyVersion: 'risk-policy-v2.4' | 'risk-policy-v2.5' = 'risk-policy-v2.4',
): {
    normalizedCandidates: AuditFixtureCandidate[];
    sortedCandidates: AuditFixtureCandidate[];
} {
    const relativeInput = candidates.map(candidate => ({
        candidateId: candidate.candidateId,
        naturalPublicScore: Number(
            (candidate.risk as { publicScore: number }).publicScore
        ),
        naturalDisplayScore: Number(
            (candidate.risk as { displayScore: number }).displayScore
        ),
        naturalRiskBand: (candidate.risk as {
            riskBand: 'normal' | 'caution' | 'high_risk';
        }).riskBand,
        partnerCapApplied: Boolean(
            (candidate.risk as { partnerCapApplied: boolean }).partnerCapApplied
        ),
        isInbound: Number(candidate.uniqueTargetPostsLikedByCandidate) > 0
            || Number(candidate.boundedCandidateCommentsOnTarget) > 0
            || candidate.hasCandidateToTargetTagOrCaptionMention === true,
        personalRiskEligible:
            candidate.accountContext !== 'official_group_or_brand',
    }));
    const relativeById = new Map((
        policyVersion === 'risk-policy-v2.5'
            ? assignRelativeRiskTiersV25(relativeInput)
            : assignRelativeRiskTiers(relativeInput)
    ).map(relative => [relative.candidateId, relative]));
    const relativeCandidates = candidates.map(candidate => {
        const relative = relativeById.get(candidate.candidateId);
        if (!relative) throw new Error('Missing relative fixture result.');
        return {
            ...candidate,
            displayScore: relative.displayScore,
            riskBand: relative.riskBand,
            relativeTierApplied: relative.relativeTierApplied,
        };
    });
    const featured = new Map<string, number | null>();
    for (const band of ['high_risk', 'caution'] as const) {
        const limit = band === 'high_risk' ? 3 : 10;
        relativeCandidates
            .filter(candidate => candidate.riskBand === band)
            .slice()
            .sort((left, right) => (
                right.displayScore - left.displayScore
                || left.candidateId.localeCompare(right.candidateId)
            ))
            .forEach((candidate, index) => {
                featured.set(candidate.candidateId, index < limit ? index + 1 : null);
            });
    }
    const normalizedCandidates = relativeCandidates.map(candidate => ({
        ...candidate,
        featuredRank: featured.get(candidate.candidateId) ?? null,
    }));
    const sortedCandidates = normalizedCandidates.slice().sort((left, right) => (
        right.displayScore - left.displayScore
        || left.candidateId.localeCompare(right.candidateId)
    ));
    return { normalizedCandidates, sortedCandidates };
}

async function materializeCapturedFixture(
    fixtureRequestId: string,
    fixtureResultHash: string,
    candidates: readonly AuditFixtureCandidate[],
    policyVersion: 'risk-policy-v2.4' | 'risk-policy-v2.5' = 'risk-policy-v2.4',
): Promise<string> {
    const { normalizedCandidates, sortedCandidates } =
        normalizeFixtureCandidates(candidates, policyVersion);
    await db.query(
        'INSERT INTO public.analysis_requests VALUES ($1, $2, $3, $4::jsonb)',
        [fixtureRequestId, 'completed', 'v2', JSON.stringify({
            risk: policyVersion, aiStage: 'ai-stage-policy-v2.7',
        })],
    );
    for (const candidate of normalizedCandidates) {
        await db.query(
            'INSERT INTO public.analysis_v2_candidate_feature_rows VALUES ($1, $2, NULL, NULL, $3, $4)',
            [fixtureRequestId, candidate.candidateId, 'feature', 'verified_female'],
        );
    }
    await db.query(
        'INSERT INTO public.analysis_v2_ai_scoring_stage_checkpoints VALUES ($1, $2, -1, $3, $4::jsonb, DEFAULT)',
        [fixtureRequestId, 'final_score', fixtureResultHash, JSON.stringify({
            riskPolicyVersion: policyVersion, candidates: normalizedCandidates,
        })],
    );
    await db.query(
        `INSERT INTO public.analysis_v2_result_summaries
            (request_id, score_policy_version, female_count)
         VALUES ($1, $2, $3)`,
        [fixtureRequestId, policyVersion, normalizedCandidates.length],
    );
    for (const [index, candidate] of sortedCandidates.entries()) {
        await db.query(
            `INSERT INTO public.analysis_v2_female_results
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                fixtureRequestId, candidate.candidateId, index + 1,
                candidate.username, candidate.displayScore,
                candidate.riskBand, candidate.featuredRank,
            ],
        );
    }
    await db.query('SELECT public.claim_analysis_v2_score_audit($1)', [fixtureRequestId]);
    const materialized = await db.query<{ result: { status: string } }>(
        'SELECT public.materialize_analysis_v2_score_audit($1, $2::uuid) AS result',
        [fixtureRequestId, requestId],
    );
    return materialized.rows[0]?.result.status ?? 'missing';
}

async function cloneCapturedFixture(
    sourceRequestId: string,
    targetRequestId: string,
    targetResultHash: string,
): Promise<void> {
    await db.query(
        `INSERT INTO public.analysis_requests
         SELECT $1, status, pipeline_version, policy_versions_snapshot
         FROM public.analysis_requests WHERE id = $2`,
        [targetRequestId, sourceRequestId],
    );
    await db.query(
        `INSERT INTO public.analysis_v2_result_summaries
         SELECT $1, score_policy_version, female_count, created_at
         FROM public.analysis_v2_result_summaries WHERE request_id = $2`,
        [targetRequestId, sourceRequestId],
    );
    await db.query(
        `INSERT INTO public.analysis_v2_score_audit_intents (
            request_id, source_result_hash, source_generation,
            checkpoint_item_count
         )
         SELECT $1, $2, 1, female_count
         FROM public.analysis_v2_result_summaries WHERE request_id = $1`,
        [targetRequestId, targetResultHash],
    );
    await db.query(
        `INSERT INTO public.analysis_v2_female_results
         SELECT $1, candidate_id, sort_ordinal, instagram_id, display_score,
                risk_band, featured_rank
         FROM public.analysis_v2_female_results WHERE request_id = $2`,
        [targetRequestId, sourceRequestId],
    );
    await db.query(
        `INSERT INTO public.analysis_v2_score_audit_sources (
            request_id, source_result_hash, risk_policy_version, ai_policy_version,
            source_status, reason, captured_count
         )
         SELECT $1, $2, risk_policy_version, ai_policy_version,
                source_status, reason, captured_count
         FROM public.analysis_v2_score_audit_sources
         WHERE request_id = $3`,
        [targetRequestId, targetResultHash, sourceRequestId],
    );
    await db.query(
        `INSERT INTO public.analysis_v2_score_audit_source_rows
         SELECT $1, $2, candidate_id, instagram_id, gender_provenance,
                account_context, components, signals, weak_partner_adjustment,
                pre_score, raw_score, public_score, natural_display_score,
                natural_risk_band, final_display_score, final_risk_band,
                featured_rank, relative_tier_applied, partner_cap_applied,
                strong_partner_evidence
         FROM public.analysis_v2_score_audit_source_rows
         WHERE request_id = $3`,
        [targetRequestId, targetResultHash, sourceRequestId],
    );
}

describe('analysis score audit database materializer', () => {
    it('backfills pre-migration eligible summaries into the bounded locator queue', async () => {
        const scanned = await db.query<{ request_id: string }>(
            `SELECT request_id::text
             FROM public.list_analysis_v2_score_audit_candidates(20)
             WHERE request_id = $1`,
            [preMigrationRequestId],
        );
        expect(scanned.rows).toHaveLength(1);
        await db.query(
            'SELECT public.claim_analysis_v2_score_audit($1)',
            [preMigrationRequestId],
        );
    });

    it('keeps terminal request state authoritative in both refresh commit orders', async () => {
        const raceRequestId = 'ab000000-e89b-42d3-a456-426614174000';
        await db.query(
            'INSERT INTO public.analysis_requests VALUES ($1, $2, $3, $4::jsonb)',
            [raceRequestId, 'completed', 'v2', JSON.stringify({
                risk: 'risk-policy-v2.4', aiStage: 'ai-stage-policy-v2.7',
            })],
        );
        await db.query(
            `INSERT INTO public.analysis_v2_result_summaries
                (request_id, score_policy_version, female_count)
             VALUES ($1, 'risk-policy-v2.4', 0)`,
            [raceRequestId],
        );
        await db.query(
            `INSERT INTO public.analysis_v2_score_audit_intents
                (request_id, source_result_hash, checkpoint_item_count)
             VALUES ($1, $2, 0)`,
            [raceRequestId, 'b'.repeat(64)],
        );
        await db.query(
            `INSERT INTO public.analysis_v2_score_audit_runs
                (request_id, source_result_hash, source_generation,
                 risk_policy_version, status)
             VALUES ($1, $2, 1, 'risk-policy-v2.4', 'queued')`,
            [raceRequestId, 'b'.repeat(64)],
        );

        await db.query(
            `UPDATE public.analysis_v2_score_audit_runs
             SET updated_at = clock_timestamp() WHERE request_id = $1`,
            [raceRequestId],
        );
        await db.query(
            `UPDATE public.analysis_requests SET status = 'failed' WHERE id = $1`,
            [raceRequestId],
        );
        let locator = await db.query<{ active: boolean }>(
            `SELECT active FROM public.analysis_v2_score_audit_scan_locators
             WHERE request_id = $1`,
            [raceRequestId],
        );
        expect(locator.rows[0]?.active).toBe(false);

        await db.query(
            `UPDATE public.analysis_requests SET status = 'completed' WHERE id = $1`,
            [raceRequestId],
        );
        await db.query(
            `UPDATE public.analysis_requests SET status = 'failed' WHERE id = $1`,
            [raceRequestId],
        );
        await db.query(
            `UPDATE public.analysis_v2_score_audit_runs
             SET updated_at = clock_timestamp() WHERE request_id = $1`,
            [raceRequestId],
        );
        locator = await db.query<{ active: boolean }>(
            `SELECT active FROM public.analysis_v2_score_audit_scan_locators
             WHERE request_id = $1`,
            [raceRequestId],
        );
        expect(locator.rows[0]?.active).toBe(false);
    });

    it('keeps the versioned SQL component policy identical to canonical TypeScript v2.4', async () => {
        const inputs: RiskPolicyInput[] = [
            {
                uniqueTargetPostsLikedByCandidate: 4,
                boundedCandidateCommentsOnTarget: 12,
                reverseLikeStatus: 'observed',
                hasCandidateToTargetTagOrCaptionMention: true,
                hasTargetToCandidateTagOrCaptionMention: true,
                recentFemaleMutualRank: 1,
                appearanceGrade: 5,
                exposureScore: 5,
                accountContext: 'personal',
                hasWeakPartnerEvidence: false,
                hasStrongPartnerEvidence: false,
            },
            {
                uniqueTargetPostsLikedByCandidate: 2,
                boundedCandidateCommentsOnTarget: 6,
                reverseLikeStatus: 'not_collected',
                hasCandidateToTargetTagOrCaptionMention: false,
                hasTargetToCandidateTagOrCaptionMention: true,
                recentFemaleMutualRank: 6,
                appearanceGrade: 4,
                exposureScore: 2,
                accountContext: 'individual_creator',
                hasWeakPartnerEvidence: true,
                hasStrongPartnerEvidence: false,
            },
            {
                uniqueTargetPostsLikedByCandidate: 0,
                boundedCandidateCommentsOnTarget: 0,
                reverseLikeStatus: 'not_observed',
                hasCandidateToTargetTagOrCaptionMention: true,
                hasTargetToCandidateTagOrCaptionMention: false,
                recentFemaleMutualRank: 10,
                appearanceGrade: 3,
                exposureScore: 1,
                accountContext: 'official_group_or_brand',
                hasWeakPartnerEvidence: false,
                hasStrongPartnerEvidence: true,
            },
        ];
        for (const input of inputs) {
            const canonical = calculateRiskPolicy(input, 'risk-policy-v2.4');
            const signals = {
                candidateLikes: input.uniqueTargetPostsLikedByCandidate,
                candidateComments: input.boundedCandidateCommentsOnTarget,
                candidateTagsTarget: input.hasCandidateToTargetTagOrCaptionMention,
                targetTagsCandidate: input.hasTargetToCandidateTagOrCaptionMention,
                targetLikedCandidate: input.reverseLikeStatus,
                recentMutualRank: input.recentFemaleMutualRank,
                appearanceGrade: input.appearanceGrade,
                exposureScore: input.exposureScore,
                hasWeakPartnerEvidence: input.hasWeakPartnerEvidence,
                hasStrongPartnerEvidence: input.hasStrongPartnerEvidence,
            };
            const sql = await db.query<{ components: Record<string, number> }>(
                `SELECT public.analysis_v2_score_audit_expected_v24_components(
                    $1::jsonb, $2
                ) AS components`,
                [JSON.stringify(signals), input.accountContext],
            );
            for (const [key, value] of Object.entries(canonical.components)) {
                expect(Number(sql.rows[0]?.components[key])).toBeCloseTo(value, 9);
            }
        }
    });

    it('matches canonical TypeScript relative tiers at boundaries, quotas, inbound fallback, and exclusions', async () => {
        const scenarios = [
            {
                rows: [
                    { candidateId: 'boundary-caution', publicScore: 4.2, components: {} },
                    { candidateId: 'boundary-high', publicScore: 6.8, components: {} },
                ],
                strongIds: [] as string[],
            },
            {
                rows: [
                    { candidateId: 'top-no-inbound', publicScore: 4.0, components: {} },
                    {
                        candidateId: 'lower-inbound',
                        publicScore: 1.6,
                        components: { candidateToTargetLikes: 6 },
                    },
                    { candidateId: 'third', publicScore: 1, components: {} },
                    {
                        candidateId: 'official',
                        publicScore: 9,
                        accountContext: 'official_group_or_brand',
                        components: { candidateToTargetTagOrCaptionMention: 12 },
                    },
                    {
                        candidateId: 'strong',
                        publicScore: 3.4,
                        components: { candidateToTargetComments: 30 },
                    },
                ],
                strongIds: ['strong'],
            },
            {
                rows: Array.from({ length: 16 }, (_, index) => ({
                    candidateId: `zero-${String(index).padStart(2, '0')}`,
                    publicScore: 10 - index * 0.2,
                    components: {},
                })),
                strongIds: [] as string[],
            },
        ];

        for (const scenario of scenarios) {
            const expected = assignRelativeRiskTiers(scenario.rows.map(row => ({
                candidateId: row.candidateId,
                naturalPublicScore: row.publicScore,
                naturalDisplayScore: roundedDisplay(row.publicScore),
                naturalRiskBand: naturalBand(row.publicScore),
                partnerCapApplied: scenario.strongIds.includes(row.candidateId),
                isInbound: [
                    'candidateToTargetLikes',
                    'candidateToTargetComments',
                    'candidateToTargetTagOrCaptionMention',
                ].some(key => Number(
                    (row.components as Record<string, number>)[key] ?? 0
                ) > 0),
                personalRiskEligible: row.accountContext !== 'official_group_or_brand',
            }))).sort((left, right) => left.candidateId.localeCompare(right.candidateId));
            const actual = await expectedRelativeFromSql(scenario.rows, scenario.strongIds);
            expect(actual).toEqual(expected.map(row => ({
                candidate_id: row.candidateId,
                display_score: row.displayScore,
                risk_band: row.riskBand,
                relative_tier_applied: row.relativeTierApplied,
            })));
        }

        const allZero = await expectedRelativeFromSql(scenarios[2]!.rows);
        expect(allZero.filter(row => row.risk_band === 'high_risk')).toHaveLength(3);
        expect(allZero.filter(row => row.risk_band === 'caution')).toHaveLength(10);
        const directional = await expectedRelativeFromSql(
            scenarios[1]!.rows,
            scenarios[1]!.strongIds,
        );
        expect(directional.find(row => row.candidate_id === 'lower-inbound')?.risk_band)
            .toBe('high_risk');
        expect(directional.find(row => row.candidate_id === 'official')).toMatchObject({
            display_score: 4.1,
            risk_band: 'normal',
            relative_tier_applied: false,
        });
    });

    it('materializes an exact v2.5 two-high/two-caution audit without rewriting v2.4', async () => {
        const policyInput: RiskPolicyInput = {
            uniqueTargetPostsLikedByCandidate: 0,
            boundedCandidateCommentsOnTarget: 0,
            reverseLikeStatus: 'not_collected',
            hasCandidateToTargetTagOrCaptionMention: false,
            hasTargetToCandidateTagOrCaptionMention: false,
            recentFemaleMutualRank: null,
            appearanceGrade: 1,
            exposureScore: 0,
            accountContext: 'personal',
            hasWeakPartnerEvidence: false,
            hasStrongPartnerEvidence: false,
        };
        const fixtureRequestId = '25100000-e89b-42d3-a456-426614174000';
        const fixtureHash = '2'.repeat(64);
        const candidates = Array.from({ length: 4 }, (_, index) =>
            canonicalFixtureCandidate(
                `v25-${index}`,
                `v25.woman.${index}`,
                policyInput,
                'risk-policy-v2.5',
            ));

        await expect(materializeCapturedFixture(
            fixtureRequestId,
            fixtureHash,
            candidates,
            'risk-policy-v2.5',
        )).resolves.toBe('ready');
        const rows = await db.query<{ risk_band: string }>(
            `SELECT risk_band FROM public.analysis_v2_score_audit_rows
             WHERE request_id = $1`,
            [fixtureRequestId],
        );
        expect(rows.rows.filter(row => row.risk_band === 'high_risk')).toHaveLength(2);
        expect(rows.rows.filter(row => row.risk_band === 'caution')).toHaveLength(2);
    });

    it('keeps the v2.5 version when hard-TTL terminalizes retained audit evidence', async () => {
        const ttlRequestId = '25200000-e89b-42d3-a456-426614174000';
        const ttlHash = '3'.repeat(64);
        await db.query(
            'INSERT INTO public.analysis_requests VALUES ($1, $2, $3, $4::jsonb)',
            [ttlRequestId, 'completed', 'v2', JSON.stringify({
                risk: 'risk-policy-v2.5', aiStage: 'ai-stage-policy-v2.10',
            })],
        );
        await db.query(
            `INSERT INTO public.analysis_v2_ai_scoring_stage_checkpoints
             VALUES ($1, 'final_score', -1, $2, $3::jsonb, DEFAULT)`,
            [ttlRequestId, ttlHash, JSON.stringify({
                riskPolicyVersion: 'risk-policy-v2.5', candidates: [],
            })],
        );
        await db.query(
            `INSERT INTO public.analysis_v2_result_summaries
                (request_id, score_policy_version, female_count)
             VALUES ($1, 'risk-policy-v2.5', 0)`,
            [ttlRequestId],
        );
        await db.query(
            `UPDATE public.analysis_v2_score_audit_intents
             SET retain_until = clock_timestamp() - INTERVAL '1 second'
             WHERE request_id = $1`,
            [ttlRequestId],
        );

        await db.query(
            'SELECT public.purge_expired_analysis_v2_score_audit_evidence(100)',
        );
        const run = await db.query<{ risk_policy_version: string; status: string }>(
            `SELECT risk_policy_version, status
             FROM public.analysis_v2_score_audit_runs WHERE request_id = $1`,
            [ttlRequestId],
        );
        expect(run.rows[0]).toEqual({
            risk_policy_version: 'risk-policy-v2.5',
            status: 'partial',
        });
    });

    it('certifies clamp, adjustment, transform, partner-cap, band, and official transitions from TS oracles', async () => {
        const definitions: Array<{
            key: string;
            requestId: string;
            hash: string;
            input: RiskPolicyInput;
        }> = [
            {
                key: 'clamps',
                requestId: 'a0000000-e89b-42d3-a456-426614174000',
                hash: '1'.repeat(64),
                input: {
                    uniqueTargetPostsLikedByCandidate: 4,
                    boundedCandidateCommentsOnTarget: 12,
                    reverseLikeStatus: 'observed',
                    hasCandidateToTargetTagOrCaptionMention: true,
                    hasTargetToCandidateTagOrCaptionMention: true,
                    recentFemaleMutualRank: 1,
                    appearanceGrade: 5,
                    exposureScore: 5,
                    accountContext: 'personal',
                    hasWeakPartnerEvidence: false,
                    hasStrongPartnerEvidence: false,
                },
            },
            {
                key: 'weak',
                requestId: 'a1000000-e89b-42d3-a456-426614174000',
                hash: '2'.repeat(64),
                input: {
                    uniqueTargetPostsLikedByCandidate: 0,
                    boundedCandidateCommentsOnTarget: 0,
                    reverseLikeStatus: 'not_observed',
                    hasCandidateToTargetTagOrCaptionMention: false,
                    hasTargetToCandidateTagOrCaptionMention: false,
                    recentFemaleMutualRank: null,
                    appearanceGrade: 1,
                    exposureScore: 0,
                    accountContext: 'personal',
                    hasWeakPartnerEvidence: true,
                    hasStrongPartnerEvidence: false,
                },
            },
            {
                key: 'strong',
                requestId: 'a2000000-e89b-42d3-a456-426614174000',
                hash: '3'.repeat(64),
                input: {
                    uniqueTargetPostsLikedByCandidate: 4,
                    boundedCandidateCommentsOnTarget: 12,
                    reverseLikeStatus: 'observed',
                    hasCandidateToTargetTagOrCaptionMention: true,
                    hasTargetToCandidateTagOrCaptionMention: true,
                    recentFemaleMutualRank: 1,
                    appearanceGrade: 5,
                    exposureScore: 5,
                    accountContext: 'personal',
                    hasWeakPartnerEvidence: false,
                    hasStrongPartnerEvidence: true,
                },
            },
            {
                key: 'official',
                requestId: 'a3000000-e89b-42d3-a456-426614174000',
                hash: '4'.repeat(64),
                input: {
                    uniqueTargetPostsLikedByCandidate: 4,
                    boundedCandidateCommentsOnTarget: 12,
                    reverseLikeStatus: 'observed',
                    hasCandidateToTargetTagOrCaptionMention: true,
                    hasTargetToCandidateTagOrCaptionMention: true,
                    recentFemaleMutualRank: 1,
                    appearanceGrade: 5,
                    exposureScore: 5,
                    accountContext: 'official_group_or_brand',
                    hasWeakPartnerEvidence: false,
                    hasStrongPartnerEvidence: false,
                },
            },
        ];
        const fixtures = new Map<string, {
            requestId: string;
            hash: string;
            candidateId: string;
        }>();

        for (const definition of definitions) {
            const risk = calculateRiskPolicy(definition.input, 'risk-policy-v2.4');
            const candidateId = `transition-${definition.key}`;
            const username = `transition_${definition.key}`;
            const relative = assignRelativeRiskTiers([{
                candidateId,
                naturalPublicScore: risk.publicScore,
                naturalDisplayScore: risk.displayScore,
                naturalRiskBand: risk.riskBand,
                partnerCapApplied: risk.partnerCapApplied,
                isInbound: definition.input.uniqueTargetPostsLikedByCandidate > 0
                    || definition.input.boundedCandidateCommentsOnTarget > 0
                    || definition.input.hasCandidateToTargetTagOrCaptionMention,
                personalRiskEligible:
                    definition.input.accountContext !== 'official_group_or_brand',
            }])[0]!;
            const candidate: AuditFixtureCandidate = {
                candidateId,
                username,
                ...definition.input,
                risk,
                displayScore: relative.displayScore,
                riskBand: relative.riskBand,
                relativeTierApplied: relative.relativeTierApplied,
                featuredRank: null,
            };
            await expect(materializeCapturedFixture(
                definition.requestId,
                definition.hash,
                [candidate],
            ), definition.key).resolves.toBe('ready');
            fixtures.set(definition.key, {
                requestId: definition.requestId,
                hash: definition.hash,
                candidateId,
            });
        }

        const clampRow = await db.query<{
            pre_score: number;
            raw_score: number;
        }>(
            `SELECT pre_score::float8, raw_score::float8
             FROM public.analysis_v2_score_audit_source_rows WHERE request_id = $1`,
            [fixtures.get('clamps')!.requestId],
        );
        expect(clampRow.rows[0]).toEqual({ pre_score: 95, raw_score: 100 });
        const weakRow = await db.query<{ adjustment: number; pre_score: number }>(
            `SELECT weak_partner_adjustment::float8 AS adjustment, pre_score::float8
             FROM public.analysis_v2_score_audit_source_rows WHERE request_id = $1`,
            [fixtures.get('weak')!.requestId],
        );
        expect(weakRow.rows[0]).toEqual({ adjustment: -5, pre_score: 0 });
        const strongRow = await db.query<{
            public_score: number;
            partner_cap_applied: boolean;
        }>(
            `SELECT public_score::float8, partner_cap_applied
             FROM public.analysis_v2_score_audit_source_rows WHERE request_id = $1`,
            [fixtures.get('strong')!.requestId],
        );
        expect(strongRow.rows[0]).toEqual({
            public_score: 3.4,
            partner_cap_applied: true,
        });
        const officialResult = await db.query<{
            display_score: number;
            risk_band: string;
        }>(
            `SELECT display_score::float8, risk_band
             FROM public.analysis_v2_score_audit_rows WHERE request_id = $1`,
            [fixtures.get('official')!.requestId],
        );
        expect(officialResult.rows[0]).toMatchObject({
            display_score: 4.1,
            risk_band: 'normal',
        });

        const drifts: Array<{
            source: string;
            mutation: string;
        }> = [
            {
                source: 'clamps',
                mutation: 'UPDATE public.analysis_v2_score_audit_source_rows SET pre_score = 94 WHERE request_id = $1',
            },
            {
                source: 'clamps',
                mutation: 'UPDATE public.analysis_v2_score_audit_source_rows SET raw_score = 99 WHERE request_id = $1',
            },
            {
                source: 'weak',
                mutation: 'UPDATE public.analysis_v2_score_audit_source_rows SET weak_partner_adjustment = 0 WHERE request_id = $1',
            },
            {
                source: 'clamps',
                mutation: 'UPDATE public.analysis_v2_score_audit_source_rows SET public_score = 9.9 WHERE request_id = $1',
            },
            {
                source: 'strong',
                mutation: 'UPDATE public.analysis_v2_score_audit_source_rows SET partner_cap_applied = FALSE WHERE request_id = $1',
            },
            {
                source: 'strong',
                mutation: 'UPDATE public.analysis_v2_score_audit_source_rows SET public_score = 3.5 WHERE request_id = $1',
            },
            {
                source: 'strong',
                mutation: 'UPDATE public.analysis_v2_score_audit_source_rows SET natural_display_score = 3.5 WHERE request_id = $1',
            },
            {
                source: 'strong',
                mutation: "UPDATE public.analysis_v2_score_audit_source_rows SET natural_risk_band = 'caution' WHERE request_id = $1",
            },
            {
                source: 'official',
                mutation: "UPDATE public.analysis_v2_score_audit_source_rows SET account_context = 'personal' WHERE request_id = $1",
            },
        ];

        for (const [index, drift] of drifts.entries()) {
            const source = fixtures.get(drift.source)!;
            const driftRequestId = `b${String(index).padStart(7, '0')}-e89b-42d3-a456-426614174000`;
            const driftHash = (index + 5).toString(16).padStart(64, '0');
            await cloneCapturedFixture(
                source.requestId,
                driftRequestId,
                driftHash,
            );
            await db.query(drift.mutation, [driftRequestId]);
            await db.query(
                'SELECT public.claim_analysis_v2_score_audit($1)',
                [driftRequestId],
            );
            const materialized = await db.query<{ result: { status: string } }>(
                `SELECT public.materialize_analysis_v2_score_audit(
                    $1, $2::uuid
                 ) AS result`,
                [driftRequestId, requestId],
            );
            expect(materialized.rows[0]?.result.status, drift.mutation)
                .toBe('inconsistent');
        }
    });

    it('materializes canonical forced relative quotas and rejects a tier transition drift', async () => {
        const definitions: Array<{ key: string; input: RiskPolicyInput }> = [
            {
                key: 'top_no_inbound',
                input: {
                    uniqueTargetPostsLikedByCandidate: 0,
                    boundedCandidateCommentsOnTarget: 0,
                    reverseLikeStatus: 'observed',
                    hasCandidateToTargetTagOrCaptionMention: false,
                    hasTargetToCandidateTagOrCaptionMention: true,
                    recentFemaleMutualRank: 1,
                    appearanceGrade: 5,
                    exposureScore: 5,
                    accountContext: 'personal',
                    hasWeakPartnerEvidence: false,
                    hasStrongPartnerEvidence: false,
                },
            },
            {
                key: 'lower_inbound',
                input: {
                    uniqueTargetPostsLikedByCandidate: 1,
                    boundedCandidateCommentsOnTarget: 0,
                    reverseLikeStatus: 'not_observed',
                    hasCandidateToTargetTagOrCaptionMention: false,
                    hasTargetToCandidateTagOrCaptionMention: false,
                    recentFemaleMutualRank: null,
                    appearanceGrade: 1,
                    exposureScore: 0,
                    accountContext: 'personal',
                    hasWeakPartnerEvidence: false,
                    hasStrongPartnerEvidence: false,
                },
            },
            {
                key: 'zero',
                input: {
                    uniqueTargetPostsLikedByCandidate: 0,
                    boundedCandidateCommentsOnTarget: 0,
                    reverseLikeStatus: 'not_observed',
                    hasCandidateToTargetTagOrCaptionMention: false,
                    hasTargetToCandidateTagOrCaptionMention: false,
                    recentFemaleMutualRank: null,
                    appearanceGrade: 1,
                    exposureScore: 0,
                    accountContext: 'personal',
                    hasWeakPartnerEvidence: false,
                    hasStrongPartnerEvidence: false,
                },
            },
            {
                key: 'official',
                input: {
                    uniqueTargetPostsLikedByCandidate: 4,
                    boundedCandidateCommentsOnTarget: 12,
                    reverseLikeStatus: 'observed',
                    hasCandidateToTargetTagOrCaptionMention: true,
                    hasTargetToCandidateTagOrCaptionMention: true,
                    recentFemaleMutualRank: 1,
                    appearanceGrade: 5,
                    exposureScore: 5,
                    accountContext: 'official_group_or_brand',
                    hasWeakPartnerEvidence: false,
                    hasStrongPartnerEvidence: false,
                },
            },
        ];
        const natural = definitions.map(definition => ({
            definition,
            candidateId: `relative-${definition.key}`,
            risk: calculateRiskPolicy(definition.input, 'risk-policy-v2.4'),
        }));
        const relative = new Map(assignRelativeRiskTiers(natural.map(row => ({
            candidateId: row.candidateId,
            naturalPublicScore: row.risk.publicScore,
            naturalDisplayScore: row.risk.displayScore,
            naturalRiskBand: row.risk.riskBand,
            partnerCapApplied: row.risk.partnerCapApplied,
            isInbound:
                row.definition.input.uniqueTargetPostsLikedByCandidate > 0
                || row.definition.input.boundedCandidateCommentsOnTarget > 0
                || row.definition.input.hasCandidateToTargetTagOrCaptionMention,
            personalRiskEligible:
                row.definition.input.accountContext !== 'official_group_or_brand',
        }))).map(row => [row.candidateId, row]));
        const candidates: AuditFixtureCandidate[] = natural.map(row => {
            const assigned = relative.get(row.candidateId)!;
            return {
                candidateId: row.candidateId,
                username: row.candidateId.replaceAll('-', '_'),
                ...row.definition.input,
                risk: row.risk,
                displayScore: assigned.displayScore,
                riskBand: assigned.riskBand,
                relativeTierApplied: assigned.relativeTierApplied,
                featuredRank: null,
            };
        });
        const relativeRequestId = 'c0000000-e89b-42d3-a456-426614174000';
        await expect(materializeCapturedFixture(
            relativeRequestId,
            'c'.repeat(64),
            candidates,
        )).resolves.toBe('ready');
        const rows = await db.query<{
            instagram_id: string;
            risk_band: string;
            display_score: number;
            relative_tier_applied: boolean;
        }>(
            `SELECT instagram_id, risk_band, display_score::float8 AS display_score,
                    relative_tier_applied
             FROM public.analysis_v2_score_audit_rows
             WHERE request_id = $1 ORDER BY actual_rank`,
            [relativeRequestId],
        );
        expect(rows.rows.find(row => row.instagram_id === 'relative_lower_inbound'))
            .toMatchObject({
                risk_band: 'high_risk',
                display_score: 6.8,
                relative_tier_applied: true,
            });
        expect(rows.rows.filter(row => row.risk_band === 'caution')).toHaveLength(2);
        expect(rows.rows.find(row => row.instagram_id === 'relative_official'))
            .toMatchObject({
                risk_band: 'normal',
                display_score: 4.1,
                relative_tier_applied: false,
            });

        const driftRequestId = 'c1000000-e89b-42d3-a456-426614174000';
        await cloneCapturedFixture(
            relativeRequestId,
            driftRequestId,
            'd'.repeat(64),
        );
        await db.query(
            `UPDATE public.analysis_v2_female_results
             SET risk_band = 'caution', display_score = 6.7
             WHERE request_id = $1 AND candidate_id = 'relative-lower_inbound'`,
            [driftRequestId],
        );
        await db.query('SELECT public.claim_analysis_v2_score_audit($1)', [driftRequestId]);
        const drifted = await db.query<{ result: { status: string } }>(
            'SELECT public.materialize_analysis_v2_score_audit($1, $2::uuid) AS result',
            [driftRequestId, requestId],
        );
        expect(drifted.rows[0]?.result.status).toBe('inconsistent');

        const featuredDriftRequestId = 'c2000000-e89b-42d3-a456-426614174000';
        await cloneCapturedFixture(
            relativeRequestId,
            featuredDriftRequestId,
            'e'.repeat(64),
        );
        await db.query(
            `UPDATE public.analysis_v2_score_audit_source_rows SET featured_rank = NULL
             WHERE request_id = $1 AND candidate_id = 'relative-lower_inbound'`,
            [featuredDriftRequestId],
        );
        await db.query(
            `UPDATE public.analysis_v2_female_results SET featured_rank = NULL
             WHERE request_id = $1 AND candidate_id = 'relative-lower_inbound'`,
            [featuredDriftRequestId],
        );
        await db.query(
            'SELECT public.claim_analysis_v2_score_audit($1)',
            [featuredDriftRequestId],
        );
        const featuredDrifted = await db.query<{ result: { status: string } }>(
            'SELECT public.materialize_analysis_v2_score_audit($1, $2::uuid) AS result',
            [featuredDriftRequestId, requestId],
        );
        expect(featuredDrifted.rows[0]?.result.status).toBe('inconsistent');

        const sortDriftRequestId = 'c3000000-e89b-42d3-a456-426614174000';
        await cloneCapturedFixture(
            relativeRequestId,
            sortDriftRequestId,
            'f'.repeat(64),
        );
        await db.query(
            `UPDATE public.analysis_v2_female_results
             SET sort_ordinal = CASE sort_ordinal WHEN 1 THEN 2 WHEN 2 THEN 1
                                ELSE sort_ordinal END
             WHERE request_id = $1`,
            [sortDriftRequestId],
        );
        await db.query(
            'SELECT public.claim_analysis_v2_score_audit($1)',
            [sortDriftRequestId],
        );
        const sortDrifted = await db.query<{ result: { status: string } }>(
            'SELECT public.materialize_analysis_v2_score_audit($1, $2::uuid) AS result',
            [sortDriftRequestId, requestId],
        );
        expect(sortDrifted.rows[0]?.result.status).toBe('inconsistent');
    });

    it('keeps capture and claim race-safe in both orderings and upgrades expired missing-source partials', async () => {
        const zeroInput: RiskPolicyInput = {
            uniqueTargetPostsLikedByCandidate: 0,
            boundedCandidateCommentsOnTarget: 0,
            reverseLikeStatus: 'not_observed',
            hasCandidateToTargetTagOrCaptionMention: false,
            hasTargetToCandidateTagOrCaptionMention: false,
            recentFemaleMutualRank: null,
            appearanceGrade: 1,
            exposureScore: 0,
            accountContext: 'personal',
            hasWeakPartnerEvidence: false,
            hasStrongPartnerEvidence: false,
        };
        const cases = [
            {
                requestId: 'f0000000-e89b-42d3-a456-426614174000',
                hash: '6'.repeat(64),
                sourceFirst: true,
                expired: false,
            },
            {
                requestId: 'f1000000-e89b-42d3-a456-426614174000',
                hash: '7'.repeat(64),
                sourceFirst: false,
                expired: false,
            },
            {
                requestId: 'f2000000-e89b-42d3-a456-426614174000',
                hash: '8'.repeat(64),
                sourceFirst: false,
                expired: true,
            },
        ];

        for (const [index, raceCase] of cases.entries()) {
            const candidate = canonicalFixtureCandidate(
                `race-${index}`,
                `race_${index}`,
                zeroInput,
            );
            await db.query(
                'INSERT INTO public.analysis_requests VALUES ($1, $2, $3, $4::jsonb)',
                [raceCase.requestId, 'completed', 'v2', JSON.stringify({
                    risk: 'risk-policy-v2.4', aiStage: 'ai-stage-policy-v2.7',
                })],
            );
            await db.query(
                'INSERT INTO public.analysis_v2_candidate_feature_rows VALUES ($1, $2, NULL, NULL, $3, $4)',
                [raceCase.requestId, candidate.candidateId, 'feature', 'verified_female'],
            );
            if (raceCase.sourceFirst) {
                await db.query(
                    `INSERT INTO public.analysis_v2_ai_scoring_stage_checkpoints
                     VALUES ($1, 'final_score', -1, $2, $3::jsonb, DEFAULT)`,
                    [raceCase.requestId, raceCase.hash, JSON.stringify({
                        riskPolicyVersion: 'risk-policy-v2.4', candidates: [candidate],
                    })],
                );
                const durable = await db.query<{
                    source_generation: number;
                    checkpoint_item_count: number;
                    source_rows: number;
                    expanded_rows: number;
                }>(
                    `SELECT intent.source_generation,
                            intent.checkpoint_item_count,
                            (SELECT count(*)::int
                             FROM public.analysis_v2_score_audit_sources AS source
                             WHERE source.request_id = intent.request_id) AS source_rows,
                            (SELECT count(*)::int
                             FROM public.analysis_v2_score_audit_source_rows AS row
                             WHERE row.request_id = intent.request_id) AS expanded_rows
                     FROM public.analysis_v2_score_audit_intents AS intent
                     WHERE intent.request_id = $1`,
                    [raceCase.requestId],
                );
                expect(durable.rows[0]).toEqual({
                    source_generation: 1,
                    checkpoint_item_count: 1,
                    source_rows: 0,
                    expanded_rows: 0,
                });
            }
            await db.query(
                `INSERT INTO public.analysis_v2_result_summaries
                    (request_id, score_policy_version, female_count, created_at)
                 VALUES ($1, 'risk-policy-v2.4', 1,
                    pg_catalog.clock_timestamp() - $2::interval)`,
                [raceCase.requestId, raceCase.expired ? '10 minutes' : '0 minutes'],
            );
            const scannedBeforeLateSource = await db.query<{ request_id: string }>(
                `SELECT request_id::text
                 FROM public.list_analysis_v2_score_audit_candidates(20)
                 WHERE request_id = $1`,
                [raceCase.requestId],
            );
            expect(scannedBeforeLateSource.rows).toHaveLength(
                raceCase.sourceFirst || raceCase.expired ? 1 : 0
            );
            if (!raceCase.sourceFirst) {
                const earlyClaim = await db.query<{ claim: unknown }>(
                    'SELECT public.claim_analysis_v2_score_audit($1) AS claim',
                    [raceCase.requestId],
                );
                expect(earlyClaim.rows[0]?.claim).toBeNull();
                const earlyRun = await db.query<{ status: string; reason: string }>(
                    `SELECT status, reason FROM public.analysis_v2_score_audit_runs
                     WHERE request_id = $1`,
                    [raceCase.requestId],
                );
                if (raceCase.expired) {
                    expect(earlyRun.rows[0]).toEqual({
                        status: 'partial',
                        reason: 'SOURCE_EVIDENCE_EXPIRED',
                    });
                } else {
                    expect(earlyRun.rows).toHaveLength(0);
                }
                await db.query(
                    `INSERT INTO public.analysis_v2_ai_scoring_stage_checkpoints
                     VALUES ($1, 'final_score', -1, $2, $3::jsonb, DEFAULT)`,
                    [raceCase.requestId, raceCase.hash, JSON.stringify({
                        riskPolicyVersion: 'risk-policy-v2.4', candidates: [candidate],
                    })],
                );
                const scannedAfterLateSource = await db.query<{ request_id: string }>(
                    `SELECT request_id::text
                     FROM public.list_analysis_v2_score_audit_candidates(20)
                     WHERE request_id = $1`,
                    [raceCase.requestId],
                );
                expect(scannedAfterLateSource.rows).toHaveLength(1);
            }
            await db.query(
                `INSERT INTO public.analysis_v2_female_results
                 VALUES ($1, $2, 1, $3, 1, 'normal', NULL)`,
                [raceCase.requestId, candidate.candidateId, candidate.username],
            );
            const claim = await db.query<{ claim: { sourceResultHash: string } }>(
                'SELECT public.claim_analysis_v2_score_audit($1) AS claim',
                [raceCase.requestId],
            );
            expect(claim.rows[0]?.claim.sourceResultHash).toBe(raceCase.hash);
            const materialized = await db.query<{ result: { status: string } }>(
                'SELECT public.materialize_analysis_v2_score_audit($1, $2::uuid) AS result',
                [raceCase.requestId, requestId],
            );
            expect(materialized.rows[0]?.result.status).toBe('ready');
        }
    });

    it('scanner terminalizes a missing intent after grace exactly once', async () => {
        const missingRequestId = 'f4000000-e89b-42d3-a456-426614174000';
        await db.query(
            'INSERT INTO public.analysis_requests VALUES ($1, $2, $3, $4::jsonb)',
            [missingRequestId, 'completed', 'v2', JSON.stringify({
                risk: 'risk-policy-v2.4', aiStage: 'ai-stage-policy-v2.7',
            })],
        );
        await db.query(
            `INSERT INTO public.analysis_v2_result_summaries
                (request_id, score_policy_version, female_count, created_at)
             VALUES ($1, 'risk-policy-v2.4', 0,
                pg_catalog.clock_timestamp() - INTERVAL '10 minutes')`,
            [missingRequestId],
        );
        const firstScan = await db.query<{ request_id: string }>(
            `SELECT request_id::text
             FROM public.list_analysis_v2_score_audit_candidates(20)
             WHERE request_id = $1`,
            [missingRequestId],
        );
        expect(firstScan.rows).toHaveLength(1);
        await db.query(
            'SELECT public.claim_analysis_v2_score_audit($1)',
            [missingRequestId],
        );
        const run = await db.query<{ status: string; reason: string }>(
            `SELECT status, reason FROM public.analysis_v2_score_audit_runs
             WHERE request_id = $1`,
            [missingRequestId],
        );
        expect(run.rows[0]).toEqual({
            status: 'partial',
            reason: 'SOURCE_EVIDENCE_EXPIRED',
        });
        const secondScan = await db.query<{ request_id: string }>(
            `SELECT request_id::text
             FROM public.list_analysis_v2_score_audit_candidates(20)
             WHERE request_id = $1`,
            [missingRequestId],
        );
        expect(secondScan.rows).toHaveLength(0);
        const loaded = await db.query<{
            result: { request: { status: string; reason: string } };
        }>(
            'SELECT public.load_analysis_v2_score_audit($1, 0, 25) AS result',
            [missingRequestId],
        );
        expect(loaded.rows[0]?.result.request).toMatchObject({
            status: 'partial',
            reason: 'SOURCE_EVIDENCE_EXPIRED',
        });
    });

    it('keeps scanner output bounded as completed historical summaries grow', async () => {
        const insertHistorical = async (start: number, count: number) => {
            await db.query(
                `WITH fixtures AS (
                    SELECT (
                        '00000000-0000-4000-8000-'
                        || pg_catalog.lpad(value::text, 12, '0')
                    )::uuid AS request_id
                    FROM pg_catalog.generate_series($1::int, $2::int) AS value
                 ),
                 requests AS (
                    INSERT INTO public.analysis_requests
                        (id, status, pipeline_version, policy_versions_snapshot)
                    SELECT request_id, 'completed', 'v2',
                           '{"risk":"risk-policy-v2.4","aiStage":"ai-stage-policy-v2.7"}'::jsonb
                    FROM fixtures
                    RETURNING id
                 )
                 INSERT INTO public.analysis_v2_result_summaries
                    (request_id, score_policy_version, female_count, created_at)
                 SELECT id, 'risk-policy-v2.4', 0,
                        pg_catalog.clock_timestamp() - INTERVAL '1 day'
                 FROM requests`,
                [start, start + count - 1],
            );
        };

        await insertHistorical(1, 1_000);
        const first = await db.query<{ request_id: string }>(
            `SELECT request_id::text
             FROM public.list_analysis_v2_score_audit_candidates(20)`,
        );
        expect(first.rows).toHaveLength(20);

        await insertHistorical(1_001, 1_000);
        await db.query(
            `UPDATE public.analysis_v2_score_audit_scan_locators
             SET retain_until = clock_timestamp() + INTERVAL '30 minutes',
                 retention_deadline_epoch = floor(extract(
                     epoch FROM clock_timestamp() + INTERVAL '30 minutes'
                 ))::bigint,
                 locator_class = 'unbound_intent'
             WHERE request_id IN (
                 SELECT request_id
                 FROM public.analysis_v2_score_audit_scan_locators
                 WHERE request_id::text LIKE '00000000-0000-4000-8000-%'
                 ORDER BY request_id
                 LIMIT 20
             )`,
        );
        const second = await db.query<{ request_id: string }>(
            `SELECT request_id::text
             FROM public.list_analysis_v2_score_audit_candidates(20)`,
        );
        expect(second.rows).toHaveLength(20);
        expect(second.rows).toEqual(first.rows);

        const explained = await db.query<Record<string, unknown>>(
            `EXPLAIN (ANALYZE, FORMAT JSON)
             SELECT request_id
             FROM public.list_analysis_v2_score_audit_candidates(20)`,
        );
        const planText = JSON.stringify(Object.values(explained.rows[0] ?? {})[0]);
        expect(planText).toContain(
            '"Function Name":"list_analysis_v2_score_audit_candidates"'
        );
        expect(planText).toContain('"Actual Rows":20');

        const indexes = await db.query<{ indexname: string }>(
            `SELECT indexname
             FROM pg_catalog.pg_indexes
             WHERE schemaname = 'public'
               AND indexname IN (
                   'analysis_v2_score_audit_scan_locators_ready_unretained_idx',
                   'analysis_v2_score_audit_scan_locators_ready_retained_idx',
                   'analysis_v2_score_audit_scan_locators_expiry_idx'
               )`,
        );
        expect(indexes.rows).toHaveLength(3);
        const branchPlans = [
            {
                index: 'analysis_v2_score_audit_scan_locators_expiry_idx',
                sql: `SELECT request_id
                      FROM public.analysis_v2_score_audit_scan_locators
                      WHERE active
                        AND retain_until <= clock_timestamp()
                      ORDER BY retain_until, request_id LIMIT 20`,
            },
            {
                index: 'analysis_v2_score_audit_scan_locators_ready_unretained_idx',
                sql: `SELECT request_id
                      FROM public.analysis_v2_score_audit_scan_locators
                      WHERE active AND retain_until IS NULL
                        AND eligible_at <= clock_timestamp()
                      ORDER BY eligible_at, sort_at, request_id LIMIT 20`,
            },
            {
                index: 'analysis_v2_score_audit_scan_locators_ready_retained_idx',
                sql: `SELECT request_id
                      FROM public.analysis_v2_score_audit_scan_locators
                      WHERE active AND retain_until > clock_timestamp()
                        AND retention_deadline_epoch >= floor(
                            extract(epoch FROM clock_timestamp())
                        )::bigint
                        AND eligible_at <= clock_timestamp()
                      ORDER BY retention_deadline_epoch, eligible_at,
                               sort_at, request_id LIMIT 20`,
            },
        ];
        for (const branch of branchPlans) {
            const branchExplain = await db.query<Record<string, unknown>>(
                `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${branch.sql}`,
            );
            const branchPlanText = JSON.stringify(
                Object.values(branchExplain.rows[0] ?? {})[0],
            );
            expect(branchPlanText).toContain(branch.index);
            expect(branchPlanText).not.toContain('"Node Type":"Seq Scan"');
            expect(branchPlanText).toContain('"Node Type":"Limit"');
            expect(branchPlanText).toMatch(/"Actual Rows":(?:[0-9]|1[0-9]|20)(?:,|})/);
            expect(branchPlanText).toContain('"Shared Hit Blocks":');
        }
        await db.query(
            `DELETE FROM public.analysis_v2_result_summaries
             WHERE request_id::text LIKE '00000000-0000-4000-8000-%'`,
        );
        await db.query(
            `DELETE FROM public.analysis_requests
             WHERE id::text LIKE '00000000-0000-4000-8000-%'`,
        );
    });

    it('advances every continuously eligible scanner class under replenishment', async () => {
        const classIds = Array.from(
            { length: 6 },
            (_, index) => `e10${index}0000-e89b-42d3-a456-426614174000`,
        );
        for (const id of classIds) {
            await db.query(
                'INSERT INTO public.analysis_requests VALUES ($1, $2, $3, $4::jsonb)',
                [id, 'completed', 'v2', JSON.stringify({
                    risk: 'risk-policy-v2.4', aiStage: 'ai-stage-policy-v2.7',
                })],
            );
            await db.query(
                `INSERT INTO public.analysis_v2_result_summaries
                    (request_id, score_policy_version, female_count, created_at)
                 VALUES ($1, 'risk-policy-v2.4', 0,
                    clock_timestamp() - INTERVAL '55 minutes')`,
                [id],
            );
        }
        for (let index = 0; index < 5; index += 1) {
            await db.query(
                `INSERT INTO public.analysis_v2_score_audit_intents
                    (request_id, source_result_hash, source_generation,
                     checkpoint_item_count, retain_until, updated_at)
                 VALUES ($1, $2, 1, 0,
                    clock_timestamp() + INTERVAL '1 hour',
                    clock_timestamp() - ($3::text || ' minutes')::interval)`,
                [classIds[index], String(index + 1).repeat(64), 60 - index],
            );
        }
        await db.query(
            `UPDATE public.analysis_v2_score_audit_intents
             SET retain_until = clock_timestamp() - INTERVAL '60 minutes'
             WHERE request_id = $1`,
            [classIds[0]],
        );
        const runFixtures = [
            { index: 1, status: 'queued', reason: null, lease: false },
            {
                index: 2,
                status: 'partial',
                reason: 'SOURCE_CAPTURE_FAILED',
                lease: false,
            },
            { index: 3, status: 'processing', reason: null, lease: true },
        ];
        for (const fixture of runFixtures) {
            await db.query(
                `INSERT INTO public.analysis_v2_score_audit_runs
                    (request_id, source_result_hash, source_generation,
                     risk_policy_version, status, reason,
                     lease_token, lease_expires_at, updated_at)
                 VALUES ($1, $2, 1, 'risk-policy-v2.4', $3, $4,
                    CASE WHEN $5 THEN $6::uuid ELSE NULL END,
                    CASE WHEN $5 THEN clock_timestamp() - INTERVAL '1 minute'
                         ELSE NULL END,
                    clock_timestamp() - ($7::text || ' minutes')::interval)`,
                [
                    classIds[fixture.index],
                    String(fixture.index + 1).repeat(64),
                    fixture.status,
                    fixture.reason,
                    fixture.lease,
                    requestId,
                    60 - fixture.index,
                ],
            );
        }

        const observed = new Set<string>();
        for (let iteration = 0; iteration < 6; iteration += 1) {
            const scanned = await db.query<{ request_id: string }>(
                `SELECT request_id::text
                 FROM public.list_analysis_v2_score_audit_candidates(3)`,
            );
            expect(scanned.rows.length).toBeGreaterThanOrEqual(1);
            for (const row of scanned.rows) {
                observed.add(row.request_id);
                await db.query(
                    `UPDATE public.analysis_requests SET status = 'failed'
                     WHERE id = $1`,
                    [row.request_id],
                );
            }

            const replenishedId =
                `e20${iteration}0000-e89b-42d3-a456-426614174000`;
            await db.query(
                'INSERT INTO public.analysis_requests VALUES ($1, $2, $3, $4::jsonb)',
                [replenishedId, 'completed', 'v2', JSON.stringify({
                    risk: 'risk-policy-v2.4', aiStage: 'ai-stage-policy-v2.7',
                })],
            );
            await db.query(
                `INSERT INTO public.analysis_v2_result_summaries
                    (request_id, score_policy_version, female_count)
                 VALUES ($1, 'risk-policy-v2.4', 0)`,
                [replenishedId],
            );
            await db.query(
                `INSERT INTO public.analysis_v2_score_audit_intents
                    (request_id, source_result_hash, checkpoint_item_count,
                     retain_until)
                 VALUES ($1, $2, 0, clock_timestamp() - INTERVAL '1 second')`,
                [replenishedId, 'abcdef'[iteration]!.repeat(64)],
            );
        }
        for (const classId of classIds) {
            expect(observed.has(classId)).toBe(true);
        }
        await db.query(
            `DELETE FROM public.analysis_v2_result_summaries
             WHERE request_id::text LIKE 'e10%'
                OR request_id::text LIKE 'e20%'`,
        );
        await db.query(
            `DELETE FROM public.analysis_requests
             WHERE id::text LIKE 'e10%' OR id::text LIKE 'e20%'`,
        );
    });

    it('expires retained evidence at its absolute deadline on the next bounded scan', async () => {
        const ttlRequestId = 'f5000000-e89b-42d3-a456-426614174000';
        const ttlHash = '5'.repeat(64);
        await db.query(
            'INSERT INTO public.analysis_requests VALUES ($1, $2, $3, $4::jsonb)',
            [ttlRequestId, 'completed', 'v2', JSON.stringify({
                risk: 'risk-policy-v2.4', aiStage: 'ai-stage-policy-v2.7',
            })],
        );
        await db.query(
            `INSERT INTO public.analysis_v2_ai_scoring_stage_checkpoints
             VALUES ($1, 'final_score', -1, $2, $3::jsonb, DEFAULT)`,
            [ttlRequestId, ttlHash, JSON.stringify({
                riskPolicyVersion: 'risk-policy-v2.4', candidates: [],
            })],
        );
        await db.query(
            `INSERT INTO public.analysis_v2_result_summaries
                (request_id, score_policy_version, female_count)
             VALUES ($1, 'risk-policy-v2.4', 0)`,
            [ttlRequestId],
        );
        await db.query(
            'SELECT public.claim_analysis_v2_score_audit($1)',
            [ttlRequestId],
        );
        await db.query(
            `UPDATE public.analysis_v2_score_audit_intents
             SET retain_until = pg_catalog.clock_timestamp() - INTERVAL '1 second'
             WHERE request_id = $1`,
            [ttlRequestId],
        );
        await db.query(
            `WITH fixtures AS (
                SELECT (
                    '90000000-0000-4000-8000-'
                    || pg_catalog.lpad(value::text, 12, '0')
                )::uuid AS request_id
                FROM pg_catalog.generate_series(1, 520) AS value
             ),
             requests AS (
                INSERT INTO public.analysis_requests
                    (id, status, pipeline_version, policy_versions_snapshot)
                SELECT request_id, 'completed', 'v2',
                       '{"risk":"risk-policy-v2.4","aiStage":"ai-stage-policy-v2.7"}'::jsonb
                FROM fixtures
                RETURNING id
             )
             INSERT INTO public.analysis_v2_score_audit_scan_locators
                (request_id, locator_class, active, eligible_at, sort_at,
                 retain_until, retention_deadline_epoch)
             SELECT id, 'missing_intent', TRUE,
                    clock_timestamp() - INTERVAL '2 hours',
                    clock_timestamp() - INTERVAL '2 hours',
                    NULL, NULL
             FROM requests`,
        );
        await db.query(
            'SELECT public.analysis_v2_purge_result_working_set($1, TRUE)',
            [ttlRequestId],
        );
        const purgedAtDeadline = await db.query<{ count: number }>(
            `SELECT count(*)::int AS count
             FROM public.analysis_v2_ai_scoring_stage_checkpoints
             WHERE request_id = $1`,
            [ttlRequestId],
        );
        expect(purgedAtDeadline.rows[0]?.count).toBe(0);
        const scanned = await db.query<{ request_id: string }>(
            `SELECT request_id::text
             FROM public.list_analysis_v2_score_audit_candidates(1)
             WHERE request_id = $1`,
            [ttlRequestId],
        );
        expect(scanned.rows).toHaveLength(1);
        await db.query(
            'SELECT public.claim_analysis_v2_score_audit($1)',
            [ttlRequestId],
        );
        const terminal = await db.query<{
            status: string;
            reason: string;
            intent_status: string;
        }>(
            `SELECT run.status, run.reason, intent.intent_status
             FROM public.analysis_v2_score_audit_runs AS run
             JOIN public.analysis_v2_score_audit_intents AS intent
               ON intent.request_id = run.request_id
             WHERE run.request_id = $1`,
            [ttlRequestId],
        );
        expect(terminal.rows[0]).toEqual({
            status: 'partial',
            reason: 'SOURCE_EVIDENCE_EXPIRED',
            intent_status: 'released',
        });
        const rescanned = await db.query<{ request_id: string }>(
            `SELECT request_id::text
             FROM public.list_analysis_v2_score_audit_candidates(20)
             WHERE request_id = $1`,
            [ttlRequestId],
        );
        expect(rescanned.rows).toHaveLength(0);
        await db.query(
            `UPDATE public.analysis_v2_score_audit_scan_locators
             SET locator_class = 'unbound_intent',
                 retain_until = clock_timestamp() - INTERVAL '1 hour',
                 retention_deadline_epoch = floor(extract(
                     epoch FROM clock_timestamp() - INTERVAL '1 hour'
                 ))::bigint
             WHERE request_id IN (
                 SELECT request_id
                 FROM public.analysis_v2_score_audit_scan_locators
                 WHERE request_id::text LIKE '90000000-0000-4000-8000-%'
                 ORDER BY request_id
                 LIMIT 500
             )`,
        );
        const backlogPlan = await db.query<Record<string, unknown>>(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
             SELECT request_id
             FROM public.list_analysis_v2_score_audit_candidates(20)`,
        );
        const backlogPlanText = JSON.stringify(
            Object.values(backlogPlan.rows[0] ?? {})[0],
        );
        expect(backlogPlanText).toContain('"Actual Rows":20');
        expect(backlogPlanText).toContain('"Shared Hit Blocks":');
        await db.query(
            `DELETE FROM public.analysis_requests
             WHERE id::text LIKE '90000000-0000-4000-8000-%'`,
        );
    });

    it('releases expired intents whose summaries were purged and leaves fresh intents queued', async () => {
        const orphanRequestId = 'f6000000-e89b-42d3-a456-426614174000';
        const expiredRequestId = 'f6100000-e89b-42d3-a456-426614174000';
        const pendingRequestId = 'f6200000-e89b-42d3-a456-426614174000';
        const requestIds = [orphanRequestId, expiredRequestId, pendingRequestId];
        const hashes = [
            '6'.repeat(64),
            '7'.repeat(64),
            '8'.repeat(64),
        ];

        for (const [index, fixtureRequestId] of requestIds.entries()) {
            await db.query(
                'INSERT INTO public.analysis_requests VALUES ($1, $2, $3, $4::jsonb)',
                [fixtureRequestId, 'completed', 'v2', JSON.stringify({
                    risk: 'risk-policy-v2.4', aiStage: 'ai-stage-policy-v2.7',
                })],
            );
            await db.query(
                `INSERT INTO public.analysis_v2_ai_scoring_stage_checkpoints
                 VALUES ($1, 'final_score', -1, $2, $3::jsonb, DEFAULT)`,
                [fixtureRequestId, hashes[index], JSON.stringify({
                    riskPolicyVersion: 'risk-policy-v2.4', candidates: [],
                })],
            );
            await db.query(
                `INSERT INTO public.analysis_v2_result_summaries
                    (request_id, score_policy_version, female_count)
                 VALUES ($1, 'risk-policy-v2.4', 0)`,
                [fixtureRequestId],
            );
        }

        // This is the production failure boundary: the result summary is
        // removed first while its audit intent survives for the TTL drain.
        await db.query(
            'SELECT public.analysis_v2_purge_result_working_set($1, FALSE)',
            [orphanRequestId],
        );
        await db.query(
            `UPDATE public.analysis_v2_score_audit_intents
             SET retain_until = CASE request_id
                 WHEN $1::uuid THEN clock_timestamp() - INTERVAL '2 minutes'
                 WHEN $2::uuid THEN clock_timestamp() - INTERVAL '1 minute'
                 ELSE retain_until
             END
             WHERE request_id = ANY($3::uuid[])`,
            [orphanRequestId, expiredRequestId, requestIds],
        );

        const firstPurge = await db.query<{ count: number }>(
            'SELECT public.purge_expired_analysis_v2_score_audit_evidence(100) AS count',
        );
        expect(firstPurge.rows[0]?.count).toBe(2);

        const outcomes = await db.query<{
            request_id: string;
            intent_status: string;
            run_status: string | null;
            summary_present: boolean;
            checkpoint_count: number;
        }>(
            `SELECT intent.request_id::text,
                    intent.intent_status,
                    run.status AS run_status,
                    summary.request_id IS NOT NULL AS summary_present,
                    (SELECT count(*)::int
                     FROM public.analysis_v2_ai_scoring_stage_checkpoints AS stage
                     WHERE stage.request_id = intent.request_id) AS checkpoint_count
             FROM public.analysis_v2_score_audit_intents AS intent
             LEFT JOIN public.analysis_v2_score_audit_runs AS run
               ON run.request_id = intent.request_id
             LEFT JOIN public.analysis_v2_result_summaries AS summary
               ON summary.request_id = intent.request_id
             WHERE intent.request_id = ANY($1::uuid[])
             ORDER BY intent.request_id`,
            [requestIds],
        );
        expect(outcomes.rows).toEqual([
            {
                request_id: orphanRequestId,
                intent_status: 'released',
                run_status: null,
                summary_present: false,
                checkpoint_count: 0,
            },
            {
                request_id: expiredRequestId,
                intent_status: 'released',
                run_status: 'partial',
                summary_present: true,
                checkpoint_count: 0,
            },
            {
                request_id: pendingRequestId,
                intent_status: 'queued',
                run_status: null,
                summary_present: true,
                checkpoint_count: 1,
            },
        ]);

        const secondPurge = await db.query<{ count: number }>(
            'SELECT public.purge_expired_analysis_v2_score_audit_evidence(100) AS count',
        );
        expect(secondPurge.rows[0]?.count).toBe(0);

        await db.query(
            `DELETE FROM public.analysis_v2_ai_scoring_stage_checkpoints
             WHERE request_id = ANY($1::uuid[])`,
            [requestIds],
        );
        await db.query(
            `DELETE FROM public.analysis_v2_score_audit_runs
             WHERE request_id = ANY($1::uuid[])`,
            [requestIds],
        );
        await db.query(
            `DELETE FROM public.analysis_v2_score_audit_intents
             WHERE request_id = ANY($1::uuid[])`,
            [requestIds],
        );
        await db.query(
            `DELETE FROM public.analysis_v2_result_summaries
             WHERE request_id = ANY($1::uuid[])`,
            [requestIds],
        );
        await db.query(
            `DELETE FROM public.analysis_requests
             WHERE id = ANY($1::uuid[])`,
            [requestIds],
        );
    });

    it('purges 500 expired rich checkpoints ahead of a target within six batches', async () => {
        await db.query(
            `WITH fixtures AS (
                SELECT value, (
                    '91000000-0000-4000-8000-'
                    || pg_catalog.lpad(value::text, 12, '0')
                )::uuid AS request_id
                FROM pg_catalog.generate_series(1, 501) AS value
             )
             INSERT INTO public.analysis_requests
                (id, status, pipeline_version, policy_versions_snapshot)
             SELECT request_id, 'completed', 'v2',
                    jsonb_build_object(
                        'risk', 'risk-policy-v2.4',
                        'aiStage', 'ai-stage-policy-v2.7'
                    )
             FROM fixtures`,
        );
        await db.query(
            `INSERT INTO public.analysis_v2_result_summaries
                (request_id, score_policy_version, female_count, created_at)
             SELECT id, 'risk-policy-v2.4', 0,
                    clock_timestamp() - INTERVAL '1 hour'
             FROM public.analysis_requests
             WHERE id::text LIKE '91000000-0000-4000-8000-%'`,
        );
        await db.query(
            `INSERT INTO public.analysis_v2_ai_scoring_stage_checkpoints
                (request_id, stage_kind, batch_key, result_hash, payload)
             SELECT id, 'final_score', -1,
                    md5(id::text) || md5(id::text),
                    jsonb_build_object(
                        'riskPolicyVersion', 'risk-policy-v2.4',
                        'candidates', jsonb_build_array()
                    )
             FROM public.analysis_requests
             WHERE id::text LIKE '91000000-0000-4000-8000-%'
             ORDER BY id`,
        );
        await db.query(
            `UPDATE public.analysis_v2_score_audit_intents
             SET retain_until = clock_timestamp() - INTERVAL '2 hours'
                 + (
                     right(request_id::text, 12)::bigint
                     * INTERVAL '1 millisecond'
                 )
             WHERE request_id::text LIKE '91000000-0000-4000-8000-%'`,
        );

        const selectorPlan = await db.query<Record<string, unknown>>(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
             SELECT intent.request_id, intent.source_result_hash,
                    intent.source_generation
             FROM public.analysis_v2_score_audit_intents AS intent
             WHERE intent.intent_status = 'queued'
               AND intent.retain_until <= clock_timestamp()
             ORDER BY intent.retain_until, intent.request_id
             LIMIT 100
             FOR UPDATE SKIP LOCKED`,
        );
        const selectorPlanValue = Object.values(
            selectorPlan.rows[0] ?? {},
        )[0] as unknown;
        const selectorPlanText = JSON.stringify(selectorPlanValue);
        expect(selectorPlanText).toContain(
            'analysis_v2_score_audit_intents_expiry_idx'
        );
        expect(selectorPlanText).not.toContain('"Node Type":"Seq Scan"');
        expect(selectorPlanText).toContain('"Actual Rows":100');
        const numericPlanValues = (
            value: unknown,
            key: string,
        ): number[] => {
            if (Array.isArray(value)) {
                return value.flatMap(item => numericPlanValues(item, key));
            }
            if (!value || typeof value !== 'object') return [];
            return Object.entries(value).flatMap(([entryKey, entryValue]) =>
                entryKey === key && typeof entryValue === 'number'
                    ? [entryValue]
                    : numericPlanValues(entryValue, key)
            );
        };
        const removedRows = [
            ...numericPlanValues(selectorPlanValue, 'Rows Removed by Filter'),
            ...numericPlanValues(selectorPlanValue, 'Rows Removed by Index Recheck'),
        ].reduce((sum, value) => sum + value, 0);
        const touchedBuffers = [
            ...numericPlanValues(selectorPlanValue, 'Shared Hit Blocks'),
            ...numericPlanValues(selectorPlanValue, 'Shared Read Blocks'),
        ].reduce((sum, value) => sum + value, 0);
        expect(removedRows).toBeLessThanOrEqual(1);
        expect(touchedBuffers).toBeLessThanOrEqual(1_000);

        const purgedPerPass: number[] = [];
        for (let pass = 0; pass < 6; pass += 1) {
            const purged = await db.query<{ count: number }>(
                `SELECT public.purge_expired_analysis_v2_score_audit_evidence(100)
                        AS count`,
            );
            purgedPerPass.push(purged.rows[0]!.count);
        }
        expect(purgedPerPass).toEqual([100, 100, 100, 100, 100, 1]);

        const remaining = await db.query<{
            checkpoints: number;
            queued_intents: number;
            partial_runs: number;
        }>(
            `SELECT
                (SELECT count(*)::int
                 FROM public.analysis_v2_ai_scoring_stage_checkpoints
                 WHERE request_id::text LIKE '91000000-0000-4000-8000-%')
                    AS checkpoints,
                (SELECT count(*)::int
                 FROM public.analysis_v2_score_audit_intents
                 WHERE request_id::text LIKE '91000000-0000-4000-8000-%'
                   AND intent_status = 'queued') AS queued_intents,
                (SELECT count(*)::int
                 FROM public.analysis_v2_score_audit_runs
                 WHERE request_id::text LIKE '91000000-0000-4000-8000-%'
                   AND status = 'partial'
                   AND reason = 'SOURCE_EVIDENCE_EXPIRED') AS partial_runs`,
        );
        expect(remaining.rows[0]).toEqual({
            checkpoints: 0,
            queued_intents: 0,
            partial_runs: 501,
        });
    }, 15_000);

    it('keeps claim and hard-TTL purge outcomes idempotent in both call orders', async () => {
        for (const [index, purgeFirst] of [false, true].entries()) {
            const raceId = `9200000${index}-e89b-42d3-a456-426614174000`;
            await db.query(
                'INSERT INTO public.analysis_requests VALUES ($1, $2, $3, $4::jsonb)',
                [raceId, 'completed', 'v2', JSON.stringify({
                    risk: 'risk-policy-v2.4', aiStage: 'ai-stage-policy-v2.7',
                })],
            );
            await db.query(
                `INSERT INTO public.analysis_v2_result_summaries
                    (request_id, score_policy_version, female_count)
                 VALUES ($1, 'risk-policy-v2.4', 0)`,
                [raceId],
            );
            await db.query(
                `INSERT INTO public.analysis_v2_ai_scoring_stage_checkpoints
                 VALUES ($1, 'final_score', -1, $2, $3::jsonb, DEFAULT)`,
                [raceId, 'c'.repeat(63) + index, JSON.stringify({
                    riskPolicyVersion: 'risk-policy-v2.4', candidates: [],
                })],
            );
            await db.query(
                `UPDATE public.analysis_v2_score_audit_intents
                 SET retain_until = clock_timestamp() - INTERVAL '1 second'
                 WHERE request_id = $1`,
                [raceId],
            );
            const claim = () => db.query(
                'SELECT public.claim_analysis_v2_score_audit($1)',
                [raceId],
            );
            const purge = () => db.query(
                'SELECT public.purge_expired_analysis_v2_score_audit_evidence(100)',
            );
            if (purgeFirst) {
                await Promise.all([purge(), claim()]);
            } else {
                await Promise.all([claim(), purge()]);
            }
            await purge();
            const finalState = await db.query<{
                status: string;
                reason: string;
                intent_status: string;
                checkpoints: number;
            }>(
                `SELECT run.status, run.reason, intent.intent_status,
                        (SELECT count(*)::int
                         FROM public.analysis_v2_ai_scoring_stage_checkpoints
                         WHERE request_id = $1) AS checkpoints
                 FROM public.analysis_v2_score_audit_runs AS run
                 JOIN public.analysis_v2_score_audit_intents AS intent
                   ON intent.request_id = run.request_id
                 WHERE run.request_id = $1`,
                [raceId],
            );
            expect(finalState.rows[0]).toEqual({
                status: 'partial',
                reason: 'SOURCE_EVIDENCE_EXPIRED',
                intent_status: 'released',
                checkpoints: 0,
            });
        }
    });

    it('preserves same-generation retries but resets exhaustion for fresh evidence', async () => {
        const generationRequestId = 'f6000000-e89b-42d3-a456-426614174000';
        const firstHash = '3'.repeat(64);
        const secondHash = '4'.repeat(64);
        await db.query(
            'INSERT INTO public.analysis_requests VALUES ($1, $2, $3, $4::jsonb)',
            [generationRequestId, 'completed', 'v2', JSON.stringify({
                risk: 'risk-policy-v2.4', aiStage: 'ai-stage-policy-v2.7',
            })],
        );
        await db.query(
            `INSERT INTO public.analysis_v2_ai_scoring_stage_checkpoints
             VALUES ($1, 'final_score', -1, $2, $3::jsonb, DEFAULT)`,
            [generationRequestId, firstHash, JSON.stringify({
                riskPolicyVersion: 'risk-policy-v2.4', candidates: [],
            })],
        );
        await db.query(
            `INSERT INTO public.analysis_v2_result_summaries
                (request_id, score_policy_version, female_count)
             VALUES ($1, 'risk-policy-v2.4', 0)`,
            [generationRequestId],
        );
        await db.query(
            'SELECT public.claim_analysis_v2_score_audit($1)',
            [generationRequestId],
        );
        await db.query(
            `UPDATE public.analysis_v2_score_audit_runs
             SET status = 'partial', reason = 'SOURCE_CAPTURE_FAILED',
                 attempt_count = 19, lease_token = NULL, lease_expires_at = NULL
             WHERE request_id = $1`,
            [generationRequestId],
        );
        await db.query(
            'SELECT public.capture_analysis_v2_score_audit_source($1)',
            [generationRequestId],
        );
        await db.query(
            'SELECT public.claim_analysis_v2_score_audit($1)',
            [generationRequestId],
        );
        const sameGeneration = await db.query<{
            source_generation: number;
            attempt_count: number;
            status: string;
        }>(
            `SELECT source_generation, attempt_count, status
             FROM public.analysis_v2_score_audit_runs WHERE request_id = $1`,
            [generationRequestId],
        );
        expect(sameGeneration.rows[0]).toEqual({
            source_generation: 1,
            attempt_count: 20,
            status: 'processing',
        });
        await db.query(
            `UPDATE public.analysis_v2_score_audit_runs
             SET status = 'partial', reason = 'SOURCE_CAPTURE_FAILED',
                 lease_token = NULL, lease_expires_at = NULL
             WHERE request_id = $1`,
            [generationRequestId],
        );
        await db.query(
            `UPDATE public.analysis_v2_ai_scoring_stage_checkpoints
             SET result_hash = $2 WHERE request_id = $1
               AND stage_kind = 'final_score' AND batch_key = -1`,
            [generationRequestId, secondHash],
        );
        const freshScan = await db.query<{ request_id: string }>(
            `SELECT request_id::text
             FROM public.list_analysis_v2_score_audit_candidates(20)
             WHERE request_id = $1`,
            [generationRequestId],
        );
        expect(freshScan.rows).toHaveLength(1);
        await db.query(
            'SELECT public.claim_analysis_v2_score_audit($1)',
            [generationRequestId],
        );
        const freshGeneration = await db.query<{
            source_result_hash: string;
            source_generation: number;
            attempt_count: number;
            status: string;
        }>(
            `SELECT source_result_hash, source_generation, attempt_count, status
             FROM public.analysis_v2_score_audit_runs WHERE request_id = $1`,
            [generationRequestId],
        );
        expect(freshGeneration.rows[0]).toEqual({
            source_result_hash: secondHash,
            source_generation: 2,
            attempt_count: 1,
            status: 'processing',
        });
    });

    it('never aborts the durable final-score checkpoint when the audit insert fails', async () => {
        const failureRequestId = 'f3000000-e89b-42d3-a456-426614174000';
        await db.query(
            'INSERT INTO public.analysis_requests VALUES ($1, $2, $3, $4::jsonb)',
            [failureRequestId, 'completed', 'v2', JSON.stringify({
                risk: 'risk-policy-v2.4', aiStage: 'ai-stage-policy-v2.7',
            })],
        );
        await db.exec(`
            ALTER TABLE public.analysis_v2_score_audit_intents
            ADD CONSTRAINT force_audit_insert_failure
            CHECK (request_id <> '${failureRequestId}'::uuid)
        `);
        try {
            await expect(db.query(
                `INSERT INTO public.analysis_v2_ai_scoring_stage_checkpoints
                 VALUES ($1, 'final_score', -1, $2, $3::jsonb, DEFAULT)`,
                [failureRequestId, '9'.repeat(64), JSON.stringify({
                    riskPolicyVersion: 'risk-policy-v2.4', candidates: [],
                })],
            )).resolves.toBeDefined();
            const checkpoint = await db.query<{ count: number }>(
                `SELECT count(*)::int AS count
                 FROM public.analysis_v2_ai_scoring_stage_checkpoints
                 WHERE request_id = $1 AND stage_kind = 'final_score'`,
                [failureRequestId],
            );
            expect(checkpoint.rows[0]?.count).toBe(1);
        } finally {
            await db.exec(`
                ALTER TABLE public.analysis_v2_score_audit_intents
                DROP CONSTRAINT force_audit_insert_failure
            `);
        }
    });

    it('keeps final-score trigger work constant from zero through 900 candidates', async () => {
        const cases = [
            { requestId: 'fa000000-e89b-42d3-a456-426614174000', count: 0 },
            { requestId: 'fa100000-e89b-42d3-a456-426614174000', count: 1 },
            { requestId: 'fa200000-e89b-42d3-a456-426614174000', count: 900 },
        ];
        const triggerTimes: number[] = [];
        for (const [index, triggerCase] of cases.entries()) {
            await db.query(
                'INSERT INTO public.analysis_requests VALUES ($1, $2, $3, $4::jsonb)',
                [triggerCase.requestId, 'completed', 'v2', JSON.stringify({
                    risk: 'risk-policy-v2.4', aiStage: 'ai-stage-policy-v2.7',
                })],
            );
            const payload = JSON.stringify({
                riskPolicyVersion: 'risk-policy-v2.4',
                candidates: Array.from(
                    { length: triggerCase.count },
                    () => ({ opaque: 'trigger-does-not-read-this' }),
                ),
            });
            const explained = await db.query<Record<string, unknown>>(
                `EXPLAIN (ANALYZE, FORMAT JSON)
                 INSERT INTO public.analysis_v2_ai_scoring_stage_checkpoints
                 VALUES ($1, 'final_score', -1, $2, $3::jsonb, DEFAULT)`,
                [triggerCase.requestId, String(index + 1).repeat(64), payload],
            );
            const plan = Object.values(explained.rows[0] ?? {})[0] as
                | Array<{ Triggers?: Array<{ Time?: number }> }>
                | undefined;
            const triggerTime = plan?.[0]?.Triggers?.[0]?.Time;
            expect(Number.isFinite(triggerTime)).toBe(true);
            triggerTimes.push(triggerTime!);
        }
        const smallBaseline = Math.max(triggerTimes[0]!, triggerTimes[1]!, 0.01);
        expect(triggerTimes[2]!).toBeLessThan(smallBaseline * 10 + 1);
        const intents = await db.query<{ count: number }>(
            `SELECT count(*)::int AS count
             FROM public.analysis_v2_score_audit_intents
             WHERE request_id = ANY($1::uuid[])`,
            [cases.map(triggerCase => triggerCase.requestId)],
        );
        expect(intents.rows[0]?.count).toBe(3);
    });

    it('turns malformed signal types into a partial source instead of aborting capture', async () => {
        const malformedRequestId = 'd23e4567-e89b-42d3-a456-426614174000';
        const malformed = {
            candidateId: 'malformed-1',
            username: 'malformed_one',
            accountContext: 'personal',
            uniqueTargetPostsLikedByCandidate: 1,
            boundedCandidateCommentsOnTarget: 0,
            hasCandidateToTargetTagOrCaptionMention: false,
            hasTargetToCandidateTagOrCaptionMention: false,
            reverseLikeStatus: 'not_observed',
            recentFemaleMutualRank: null,
            appearanceGrade: 1,
            exposureScore: 'not-a-number',
            hasWeakPartnerEvidence: false,
            hasStrongPartnerEvidence: false,
            relativeTierApplied: false,
            displayScore: 1,
            riskBand: 'normal',
            featuredRank: null,
            risk: {
                policyVersion: 'risk-policy-v2.4',
                components: {
                    candidateToTargetLikes: 6,
                    candidateToTargetComments: 0,
                    candidateToTargetTagOrCaptionMention: 0,
                    targetToCandidateTagOrCaptionMention: 0,
                    targetToCandidateLike: 0,
                    recentMutual: 0,
                    appearanceExposure: 0,
                },
                weakPartnerAdjustment: 0,
                preScore: 6,
                rawScore: 6,
                publicScore: 1.54,
                displayScore: 1.5,
                riskBand: 'normal',
                partnerCapApplied: false,
            },
        };
        await db.query(
            'INSERT INTO public.analysis_requests VALUES ($1, $2, $3, $4::jsonb)',
            [malformedRequestId, 'completed', 'v2', JSON.stringify({
                risk: 'risk-policy-v2.4', aiStage: 'ai-stage-policy-v2.7',
            })],
        );
        await db.query(
            'INSERT INTO public.analysis_v2_ai_scoring_stage_checkpoints VALUES ($1, $2, -1, $3, $4::jsonb, DEFAULT)',
            [malformedRequestId, 'final_score', 'b'.repeat(64), JSON.stringify({
                riskPolicyVersion: 'risk-policy-v2.4', candidates: [malformed],
            })],
        );
        await expect(db.query(
            'SELECT public.capture_analysis_v2_score_audit_source($1)',
            [malformedRequestId],
        )).resolves.toBeDefined();
        await db.query(
            `SELECT public.prepare_analysis_v2_score_audit_source(
                $1, $2, 1
            )`,
            [malformedRequestId, 'b'.repeat(64)],
        );
        const source = await db.query<{ source_status: string; captured_count: number }>(
            `SELECT source_status, captured_count
             FROM public.analysis_v2_score_audit_sources WHERE request_id = $1`,
            [malformedRequestId],
        );
        expect(source.rows[0]).toEqual({ source_status: 'partial', captured_count: 0 });
        await db.query(
            `INSERT INTO public.analysis_v2_result_summaries
                (request_id, score_policy_version, female_count)
             VALUES ($1, 'risk-policy-v2.4', 1)`,
            [malformedRequestId],
        );
        const scanned = await db.query<{ request_id: string }>(
            `SELECT request_id::text
             FROM public.list_analysis_v2_score_audit_candidates(20)
             WHERE request_id = $1`,
            [malformedRequestId],
        );
        expect(scanned.rows).toHaveLength(1);
        await db.query(
            'SELECT public.claim_analysis_v2_score_audit($1)',
            [malformedRequestId],
        );
        const partialRun = await db.query<{ status: string; reason: string }>(
            `SELECT status, reason FROM public.analysis_v2_score_audit_runs
             WHERE request_id = $1`,
            [malformedRequestId],
        );
        expect(partialRun.rows[0]).toEqual({
            status: 'partial',
            reason: 'MALFORMED_OR_DUPLICATE_SCORE_SOURCE',
        });
    });

    it('captures public v2.4 final-score inputs, leases once, and marks an exact sum ready', async () => {
        const candidate = {
            candidateId: 'candidate-1', username: 'safe_handle', accountContext: 'personal',
            uniqueTargetPostsLikedByCandidate: 4, boundedCandidateCommentsOnTarget: 1,
            hasCandidateToTargetTagOrCaptionMention: false, hasTargetToCandidateTagOrCaptionMention: false,
            reverseLikeStatus: 'observed', recentFemaleMutualRank: 2,
            appearanceGrade: 1, exposureScore: 0,
            hasWeakPartnerEvidence: false, hasStrongPartnerEvidence: false,
            displayScore: 4.2,
            riskBand: 'caution', featuredRank: 1, relativeTierApplied: false,
            risk: {
                policyVersion: 'risk-policy-v2.4', riskBand: 'caution', displayScore: 4.2,
                components: {
                    candidateToTargetLikes: 24, candidateToTargetComments: 2.5,
                    candidateToTargetTagOrCaptionMention: 0, targetToCandidateTagOrCaptionMention: 0,
                    targetToCandidateLike: 5, recentMutual: 4.5, appearanceExposure: 0,
                }, weakPartnerAdjustment: 0, preScore: 31, rawScore: 36,
                publicScore: 4.24, partnerCapApplied: false,
            },
        };
        await db.query('INSERT INTO public.analysis_requests VALUES ($1, $2, $3, $4::jsonb)', [requestId, 'completed', 'v2', JSON.stringify({ risk: 'risk-policy-v2.4', aiStage: 'ai-stage-policy-v2.7' })]);
        await db.query('INSERT INTO public.analysis_v2_candidate_feature_rows VALUES ($1, $2, $3, $4, $5, $6)', [requestId, 'candidate-1', 'Safe Name', 'public bio', 'feature', 'verified_female']);
        await db.query('INSERT INTO public.analysis_v2_ai_scoring_stage_checkpoints VALUES ($1, $2, -1, $3, $4::jsonb, DEFAULT)', [requestId, 'final_score', resultHash, JSON.stringify({ riskPolicyVersion: 'risk-policy-v2.4', candidates: [candidate] })]);
        await db.query('SELECT public.capture_analysis_v2_score_audit_source($1)', [requestId]);
        await db.query('INSERT INTO public.analysis_v2_result_summaries (request_id, score_policy_version, female_count) VALUES ($1, $2, 1)', [requestId, 'risk-policy-v2.4']);
        await db.query('INSERT INTO public.analysis_v2_female_results VALUES ($1, $2, 1, $3, 4.2, $4, 1)', [requestId, 'candidate-1', 'safe_handle', 'caution']);
        const claimed = await db.query<{ claim: { leaseToken: string } }>('SELECT public.claim_analysis_v2_score_audit($1) AS claim', [requestId]);
        const token = claimed.rows[0]?.claim.leaseToken;
        expect(token).toBe(requestId);
        await db.query('SELECT public.materialize_analysis_v2_score_audit($1, $2::uuid)', [requestId, token]);
        const result = await db.query<{ result: { request: { status: string }; rows: Array<{ scoreConsistent: boolean; displayScore: number }> } }>('SELECT public.load_analysis_v2_score_audit($1, 0, 25) AS result', [requestId]);
        expect(result.rows[0]?.result.request.status).toBe('ready');
        expect(result.rows[0]?.result.rows).toEqual([expect.objectContaining({ scoreConsistent: true, displayScore: 4.2 })]);
    });

    it('rejects signal-to-component drift for every v2.4 component and normalized cap', async () => {
        const input: RiskPolicyInput = {
            uniqueTargetPostsLikedByCandidate: 4,
            boundedCandidateCommentsOnTarget: 12,
            reverseLikeStatus: 'observed',
            hasCandidateToTargetTagOrCaptionMention: true,
            hasTargetToCandidateTagOrCaptionMention: true,
            recentFemaleMutualRank: 1,
            appearanceGrade: 5,
            exposureScore: 5,
            accountContext: 'personal',
            hasWeakPartnerEvidence: false,
            hasStrongPartnerEvidence: false,
        };
        const canonical = calculateRiskPolicy(input, 'risk-policy-v2.4');
        const componentKeys = Object.keys(canonical.components) as Array<
            keyof typeof canonical.components
        >;
        const requestPrefixes = ['6', '7', '8', '9', 'a', 'b', 'c'];
        const hashPrefixes = ['0', '1', '2', '3', '4', '5', 'a'];

        for (const [index, componentKey] of componentKeys.entries()) {
            const driftRequestId = `${requestPrefixes[index]}23e4567-e89b-42d3-a456-426614174000`;
            const driftHash = hashPrefixes[index]!.repeat(64);
            const candidateId = `drift-${index}`;
            const username = `drift_${index}`;
            const candidate = {
                candidateId,
                username,
                ...input,
                displayScore: canonical.displayScore,
                riskBand: canonical.riskBand,
                featuredRank: null,
                relativeTierApplied: false,
                risk: {
                    ...canonical,
                    components: {
                        ...canonical.components,
                        [componentKey]: canonical.components[componentKey] - 1,
                    },
                },
            };
            await db.query(
                'INSERT INTO public.analysis_requests VALUES ($1, $2, $3, $4::jsonb)',
                [driftRequestId, 'completed', 'v2', JSON.stringify({
                    risk: 'risk-policy-v2.4', aiStage: 'ai-stage-policy-v2.7',
                })],
            );
            await db.query(
                'INSERT INTO public.analysis_v2_candidate_feature_rows VALUES ($1, $2, NULL, NULL, $3, $4)',
                [driftRequestId, candidateId, 'feature', 'verified_female'],
            );
            await db.query(
                'INSERT INTO public.analysis_v2_ai_scoring_stage_checkpoints VALUES ($1, $2, -1, $3, $4::jsonb, DEFAULT)',
                [driftRequestId, 'final_score', driftHash, JSON.stringify({
                    riskPolicyVersion: 'risk-policy-v2.4', candidates: [candidate],
                })],
            );
            await db.query(
                'SELECT public.capture_analysis_v2_score_audit_source($1)',
                [driftRequestId],
            );
            await db.query(
                `INSERT INTO public.analysis_v2_result_summaries
                    (request_id, score_policy_version, female_count)
                 VALUES ($1, 'risk-policy-v2.4', 1)`,
                [driftRequestId],
            );
            await db.query(
                `INSERT INTO public.analysis_v2_female_results
                 VALUES ($1, $2, 1, $3, $4, $5, NULL)`,
                [
                    driftRequestId, candidateId, username,
                    canonical.displayScore, canonical.riskBand,
                ],
            );
            await db.query(
                'SELECT public.claim_analysis_v2_score_audit($1)',
                [driftRequestId],
            );
            const materialized = await db.query<{ result: { status: string } }>(
                `SELECT public.materialize_analysis_v2_score_audit(
                    $1, $2::uuid
                ) AS result`,
                [driftRequestId, requestId],
            );
            expect(
                materialized.rows[0]?.result.status,
                componentKey,
            ).toBe('inconsistent');
        }
    });

    it('does not capture official-group rows as personal ranking candidates', async () => {
        const officialRequestId = '223e4567-e89b-42d3-a456-426614174000';
        const candidate = {
            candidateId: 'official-1', username: 'band_official', accountContext: 'official_group_or_brand',
            uniqueTargetPostsLikedByCandidate: 0, boundedCandidateCommentsOnTarget: 0,
            hasCandidateToTargetTagOrCaptionMention: false, hasTargetToCandidateTagOrCaptionMention: false,
            reverseLikeStatus: 'not_observed', recentFemaleMutualRank: null,
            appearanceGrade: 1, exposureScore: 0,
            hasWeakPartnerEvidence: false, hasStrongPartnerEvidence: false, displayScore: 1,
            riskBand: 'normal', featuredRank: null, relativeTierApplied: false,
            risk: { policyVersion: 'risk-policy-v2.4', riskBand: 'normal', displayScore: 1, components: { candidateToTargetLikes: 0, candidateToTargetComments: 0, candidateToTargetTagOrCaptionMention: 0, targetToCandidateTagOrCaptionMention: 0, targetToCandidateLike: 0, recentMutual: 0, appearanceExposure: 0 }, weakPartnerAdjustment: 0, preScore: 0, rawScore: 0, publicScore: 1, partnerCapApplied: false },
        };
        await db.query('INSERT INTO public.analysis_requests VALUES ($1, $2, $3, $4::jsonb)', [officialRequestId, 'completed', 'v2', JSON.stringify({ risk: 'risk-policy-v2.4', aiStage: 'ai-stage-policy-v2.7' })]);
        await db.query('INSERT INTO public.analysis_v2_candidate_feature_rows VALUES ($1, $2, NULL, NULL, $3, $4)', [officialRequestId, 'official-1', 'feature', 'verified_female']);
        await db.query('INSERT INTO public.analysis_v2_ai_scoring_stage_checkpoints VALUES ($1, $2, -1, $3, $4::jsonb, DEFAULT)', [officialRequestId, 'final_score', 'b'.repeat(64), JSON.stringify({ riskPolicyVersion: 'risk-policy-v2.4', candidates: [candidate] })]);
        await db.query('SELECT public.capture_analysis_v2_score_audit_source($1)', [officialRequestId]);
        await db.query('INSERT INTO public.analysis_v2_result_summaries (request_id, score_policy_version, female_count) VALUES ($1, $2, 1)', [officialRequestId, 'risk-policy-v2.4']);
        await db.query('INSERT INTO public.analysis_v2_female_results VALUES ($1, $2, 1, $3, 1, $4, NULL)', [officialRequestId, 'official-1', 'band_official', 'normal']);
        await db.query('SELECT public.claim_analysis_v2_score_audit($1)', [officialRequestId]);
        await db.query('SELECT public.materialize_analysis_v2_score_audit($1, $2::uuid)', [officialRequestId, requestId]);
        const row = await db.query<{ excluded: boolean; reason: string }>('SELECT official_group_excluded AS excluded, official_group_reason AS reason FROM public.analysis_v2_score_audit_rows WHERE request_id = $1', [officialRequestId]);
        expect(row.rows[0]).toEqual({ excluded: true, reason: 'OFFICIAL_GROUP_OR_BRAND' });
    });

    it('marks a valid zero-candidate completion ready with an empty page', async () => {
        const zeroRequestId = '323e4567-e89b-42d3-a456-426614174000';
        await db.query('INSERT INTO public.analysis_requests VALUES ($1, $2, $3, $4::jsonb)', [zeroRequestId, 'completed', 'v2', JSON.stringify({ risk: 'risk-policy-v2.4', aiStage: 'ai-stage-policy-v2.7' })]);
        await db.query('INSERT INTO public.analysis_v2_ai_scoring_stage_checkpoints VALUES ($1, $2, -1, $3, $4::jsonb, DEFAULT)', [zeroRequestId, 'final_score', 'c'.repeat(64), JSON.stringify({ riskPolicyVersion: 'risk-policy-v2.4', candidates: [] })]);
        await db.query('SELECT public.capture_analysis_v2_score_audit_source($1)', [zeroRequestId]);
        await db.query('INSERT INTO public.analysis_v2_result_summaries (request_id, score_policy_version, female_count) VALUES ($1, $2, 0)', [zeroRequestId, 'risk-policy-v2.4']);
        await db.query('SELECT public.claim_analysis_v2_score_audit($1)', [zeroRequestId]);
        await db.query('SELECT public.materialize_analysis_v2_score_audit($1, $2::uuid)', [zeroRequestId, requestId]);
        const result = await db.query<{ result: { request: { status: string }; rows: unknown[] } }>('SELECT public.load_analysis_v2_score_audit($1, 0, 25) AS result', [zeroRequestId]);
        expect(result.rows[0]?.result).toMatchObject({ request: { status: 'ready' }, rows: [] });
    });

    it('marks dropped public candidates partial without guessing rows', async () => {
        const incompleteRequestId = '423e4567-e89b-42d3-a456-426614174000';
        const sourceCandidate = {
            candidateId: 'one-only', username: 'one_only', accountContext: 'personal',
            uniqueTargetPostsLikedByCandidate: 0, boundedCandidateCommentsOnTarget: 0,
            hasCandidateToTargetTagOrCaptionMention: false, hasTargetToCandidateTagOrCaptionMention: false,
            reverseLikeStatus: 'not_observed', recentFemaleMutualRank: null,
            appearanceGrade: 1, exposureScore: 0,
            hasWeakPartnerEvidence: false, hasStrongPartnerEvidence: false, displayScore: 1,
            riskBand: 'normal', featuredRank: null, relativeTierApplied: false,
            risk: { policyVersion: 'risk-policy-v2.4', riskBand: 'normal', displayScore: 1, components: { candidateToTargetLikes: 0, candidateToTargetComments: 0, candidateToTargetTagOrCaptionMention: 0, targetToCandidateTagOrCaptionMention: 0, targetToCandidateLike: 0, recentMutual: 0, appearanceExposure: 0 }, weakPartnerAdjustment: 0, preScore: 0, rawScore: 0, publicScore: 1, partnerCapApplied: false },
        };
        await db.query('INSERT INTO public.analysis_requests VALUES ($1, $2, $3, $4::jsonb)', [incompleteRequestId, 'completed', 'v2', JSON.stringify({ risk: 'risk-policy-v2.4', aiStage: 'ai-stage-policy-v2.7' })]);
        await db.query('INSERT INTO public.analysis_v2_candidate_feature_rows VALUES ($1, $2, NULL, NULL, $3, $4)', [incompleteRequestId, 'one-only', 'feature', 'verified_female']);
        await db.query('INSERT INTO public.analysis_v2_ai_scoring_stage_checkpoints VALUES ($1, $2, -1, $3, $4::jsonb, DEFAULT)', [incompleteRequestId, 'final_score', 'd'.repeat(64), JSON.stringify({ riskPolicyVersion: 'risk-policy-v2.4', candidates: [sourceCandidate] })]);
        await db.query('SELECT public.capture_analysis_v2_score_audit_source($1)', [incompleteRequestId]);
        await db.query('INSERT INTO public.analysis_v2_result_summaries (request_id, score_policy_version, female_count) VALUES ($1, $2, 2)', [incompleteRequestId, 'risk-policy-v2.4']);
        await db.query('INSERT INTO public.analysis_v2_female_results VALUES ($1, $2, 1, $3, 1, $4, NULL)', [incompleteRequestId, 'one-only', 'one_only', 'normal']);
        await db.query('SELECT public.claim_analysis_v2_score_audit($1)', [incompleteRequestId]);
        const materialized = await db.query<{ result: { status: string } }>('SELECT public.materialize_analysis_v2_score_audit($1, $2::uuid) AS result', [incompleteRequestId, requestId]);
        expect(materialized.rows[0]?.result.status).toBe('partial');
        const row = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM public.analysis_v2_score_audit_rows WHERE request_id = $1', [incompleteRequestId]);
        expect(row.rows[0]?.count).toBe(0);
    });

    it('marks exact risk-policy drift inconsistent without changing the final result', async () => {
        const driftRequestId = '523e4567-e89b-42d3-a456-426614174000';
        const driftHash = 'e'.repeat(64);
        await db.query('INSERT INTO public.analysis_requests VALUES ($1, $2, $3, $4::jsonb)', [driftRequestId, 'completed', 'v2', JSON.stringify({ risk: 'risk-policy-v2.4', aiStage: 'ai-stage-policy-v2.7' })]);
        await db.query('INSERT INTO public.analysis_v2_result_summaries (request_id, score_policy_version, female_count) VALUES ($1, $2, 1)', [driftRequestId, 'risk-policy-v2.4']);
        await db.query('INSERT INTO public.analysis_v2_female_results VALUES ($1, $2, 1, $3, 4.2, $4, 1)', [driftRequestId, 'candidate-1', 'safe_handle', 'caution']);
        await db.query(`INSERT INTO public.analysis_v2_score_audit_sources
            (request_id, source_result_hash, risk_policy_version, ai_policy_version, source_status, reason, captured_count)
            VALUES ($1, $2, 'risk-policy-v2.4', 'ai-stage-policy-v2.7', 'ready', NULL, 1)`, [driftRequestId, driftHash]);
        await db.query(
            `INSERT INTO public.analysis_v2_score_audit_intents
                (request_id, source_result_hash, source_generation,
                 checkpoint_item_count)
             VALUES ($1, $2, 1, 1)`,
            [driftRequestId, driftHash],
        );
        await db.query(`INSERT INTO public.analysis_v2_score_audit_source_rows
            SELECT $1, $2, candidate_id, instagram_id, gender_provenance, account_context,
                components, signals, weak_partner_adjustment, pre_score, raw_score + 1,
                public_score, natural_display_score, natural_risk_band, final_display_score,
                final_risk_band, featured_rank, relative_tier_applied, partner_cap_applied,
                strong_partner_evidence
            FROM public.analysis_v2_score_audit_source_rows
            WHERE request_id = $3`, [driftRequestId, driftHash, requestId]);
        await db.query('SELECT public.claim_analysis_v2_score_audit($1)', [driftRequestId]);
        const materialized = await db.query<{ result: { status: string } }>('SELECT public.materialize_analysis_v2_score_audit($1, $2::uuid) AS result', [driftRequestId, requestId]);
        expect(materialized.rows[0]?.result.status).toBe('inconsistent');
        const result = await db.query<{ display_score: number; score_consistent: boolean }>('SELECT display_score::float8, score_consistent FROM public.analysis_v2_score_audit_rows WHERE request_id = $1', [driftRequestId]);
        expect(result.rows[0]).toEqual({ display_score: 4.2, score_consistent: false });
    });

    it('fails closed when source, summary, or claimed run is not exactly risk-policy-v2.4', async () => {
        const cases = [
            {
                requestId: 'e0000000-e89b-42d3-a456-426614174000',
                hash: 'e'.repeat(64),
                mutate: `UPDATE public.analysis_v2_score_audit_sources
                         SET risk_policy_version = 'risk-policy-v2.3'
                         WHERE request_id = $1`,
                afterClaim: false,
            },
            {
                requestId: 'e1000000-e89b-42d3-a456-426614174000',
                hash: 'f'.repeat(64),
                mutate: `UPDATE public.analysis_v2_result_summaries
                         SET score_policy_version = 'risk-policy-v2.3'
                         WHERE request_id = $1`,
                afterClaim: false,
            },
            {
                requestId: 'e2000000-e89b-42d3-a456-426614174000',
                hash: '0'.repeat(64),
                mutate: `UPDATE public.analysis_v2_score_audit_runs
                         SET risk_policy_version = 'risk-policy-v2.3'
                         WHERE request_id = $1`,
                afterClaim: true,
            },
        ];

        for (const policyCase of cases) {
            await cloneCapturedFixture(
                requestId,
                policyCase.requestId,
                policyCase.hash,
            );
            if (!policyCase.afterClaim) {
                await db.query(policyCase.mutate, [policyCase.requestId]);
            }
            await db.query(
                'SELECT public.claim_analysis_v2_score_audit($1)',
                [policyCase.requestId],
            );
            if (policyCase.afterClaim) {
                await db.query(policyCase.mutate, [policyCase.requestId]);
                const materialized = await db.query<{ result: { status: string } }>(
                    `SELECT public.materialize_analysis_v2_score_audit(
                        $1, $2::uuid
                     ) AS result`,
                    [policyCase.requestId, requestId],
                );
                expect(materialized.rows[0]?.result.status).toBe('partial');
            }
            const run = await db.query<{ status: string; reason: string }>(
                `SELECT status, reason FROM public.analysis_v2_score_audit_runs
                 WHERE request_id = $1`,
                [policyCase.requestId],
            );
            expect(run.rows[0]).toEqual({
                status: 'partial',
                reason: 'UNSUPPORTED_SCORE_POLICY_VERSION',
            });
        }
    });

    it('retains only the located final checkpoint until scanner materialization is terminal', async () => {
        const retainedRequestId = 'fe000000-e89b-42d3-a456-426614174000';
        const retainedHash = '8'.repeat(64);
        const zeroInput: RiskPolicyInput = {
            uniqueTargetPostsLikedByCandidate: 0,
            boundedCandidateCommentsOnTarget: 0,
            reverseLikeStatus: 'not_observed',
            hasCandidateToTargetTagOrCaptionMention: false,
            hasTargetToCandidateTagOrCaptionMention: false,
            recentFemaleMutualRank: null,
            appearanceGrade: 1,
            exposureScore: 0,
            accountContext: 'personal',
            hasWeakPartnerEvidence: false,
            hasStrongPartnerEvidence: false,
        };
        const candidate = canonicalFixtureCandidate(
            'retained-1', 'retained_one', zeroInput
        );
        await db.query(
            'INSERT INTO public.analysis_requests VALUES ($1, $2, $3, $4::jsonb)',
            [retainedRequestId, 'completed', 'v2', JSON.stringify({
                risk: 'risk-policy-v2.4', aiStage: 'ai-stage-policy-v2.7',
            })],
        );
        await db.query(
            `INSERT INTO public.analysis_v2_ai_scoring_stage_checkpoints
             VALUES ($1, 'final_score', -1, $2, $3::jsonb, DEFAULT)`,
            [retainedRequestId, retainedHash, JSON.stringify({
                riskPolicyVersion: 'risk-policy-v2.4', candidates: [candidate],
            })],
        );
        await db.query(
            `INSERT INTO public.analysis_v2_ai_scoring_stage_checkpoints
             VALUES ($1, 'narrative', -1, $2, '{}'::jsonb, DEFAULT)`,
            [retainedRequestId, '7'.repeat(64)],
        );
        await db.query(
            'SELECT public.analysis_v2_purge_result_working_set($1, TRUE)',
            [retainedRequestId],
        );
        let stages = await db.query<{ stage_kind: string }>(
            `SELECT stage_kind
             FROM public.analysis_v2_ai_scoring_stage_checkpoints
             WHERE request_id = $1 ORDER BY stage_kind`,
            [retainedRequestId],
        );
        expect(stages.rows).toEqual([{ stage_kind: 'final_score' }]);
        await db.query(
            `INSERT INTO public.analysis_pipeline_jobs
             VALUES ($1, 'coordinator:finalize', 'completed', $2, $3)`,
            [retainedRequestId, 'input-hash', requestId],
        );
        await db.query(
            `SELECT public.purge_analysis_v2_ai_scoring_stage(
                $1, 'coordinator:finalize', $2::uuid, 'input-hash'
             )`,
            [retainedRequestId, requestId],
        );
        stages = await db.query<{ stage_kind: string }>(
            `SELECT stage_kind
             FROM public.analysis_v2_ai_scoring_stage_checkpoints
             WHERE request_id = $1`,
            [retainedRequestId],
        );
        expect(stages.rows).toEqual([{ stage_kind: 'final_score' }]);
        await db.query(
            `INSERT INTO public.analysis_v2_result_summaries
                (request_id, score_policy_version, female_count)
             VALUES ($1, 'risk-policy-v2.4', 1)`,
            [retainedRequestId],
        );
        await db.query(
            `INSERT INTO public.analysis_v2_female_results
             VALUES ($1, 'retained-1', 1, 'retained_one', 1, 'normal', NULL)`,
            [retainedRequestId],
        );
        const scanned = await db.query<{ request_id: string }>(
            `SELECT request_id::text
             FROM public.list_analysis_v2_score_audit_candidates(20)
             WHERE request_id = $1`,
            [retainedRequestId],
        );
        expect(scanned.rows).toHaveLength(1);
        await db.query(
            'SELECT public.claim_analysis_v2_score_audit($1)',
            [retainedRequestId],
        );
        await db.query(
            `SELECT public.materialize_analysis_v2_score_audit(
                $1, $2::uuid
             )`,
            [retainedRequestId, requestId],
        );
        const released = await db.query<{ count: number }>(
            `SELECT count(*)::int AS count
             FROM public.analysis_v2_ai_scoring_stage_checkpoints
             WHERE request_id = $1`,
            [retainedRequestId],
        );
        expect(released.rows[0]?.count).toBe(0);
    });

    it('surfaces an oversized safe source as terminal partial through scanner recovery', async () => {
        const oversizedRequestId = 'fd000000-e89b-42d3-a456-426614174000';
        const oversizedHash = '6'.repeat(64);
        const zeroInput: RiskPolicyInput = {
            uniqueTargetPostsLikedByCandidate: 0,
            boundedCandidateCommentsOnTarget: 0,
            reverseLikeStatus: 'not_observed',
            hasCandidateToTargetTagOrCaptionMention: false,
            hasTargetToCandidateTagOrCaptionMention: false,
            recentFemaleMutualRank: null,
            appearanceGrade: 1,
            exposureScore: 0,
            accountContext: 'personal',
            hasWeakPartnerEvidence: false,
            hasStrongPartnerEvidence: false,
        };
        const candidate = canonicalFixtureCandidate(
            'oversized-1', 'oversized_one', zeroInput
        );
        const oversizedCandidate = {
            ...candidate,
            risk: {
                ...(candidate.risk as Record<string, unknown>),
                components: {
                    ...(candidate.risk as {
                        components: Record<string, unknown>;
                    }).components,
                    ignoredPadding: 'x'.repeat(7_500_000),
                },
            },
        };
        await db.query(
            'INSERT INTO public.analysis_requests VALUES ($1, $2, $3, $4::jsonb)',
            [oversizedRequestId, 'completed', 'v2', JSON.stringify({
                risk: 'risk-policy-v2.4', aiStage: 'ai-stage-policy-v2.7',
            })],
        );
        await db.query(
            `INSERT INTO public.analysis_v2_ai_scoring_stage_checkpoints
             VALUES ($1, 'final_score', -1, $2, $3::jsonb, DEFAULT)`,
            [oversizedRequestId, oversizedHash, JSON.stringify({
                riskPolicyVersion: 'risk-policy-v2.4',
                candidates: [oversizedCandidate],
            })],
        );
        await db.query(
            `INSERT INTO public.analysis_v2_result_summaries
                (request_id, score_policy_version, female_count)
             VALUES ($1, 'risk-policy-v2.4', 1)`,
            [oversizedRequestId],
        );
        const scanned = await db.query<{ request_id: string }>(
            `SELECT request_id::text
             FROM public.list_analysis_v2_score_audit_candidates(20)
             WHERE request_id = $1`,
            [oversizedRequestId],
        );
        expect(scanned.rows).toHaveLength(1);
        const claim = await db.query<{ claim: { leaseToken: string } }>(
            'SELECT public.claim_analysis_v2_score_audit($1) AS claim',
            [oversizedRequestId],
        );
        expect(claim.rows[0]?.claim.leaseToken).toBe(requestId);
        const materialized = await db.query<{ result: { status: string } }>(
            `SELECT public.materialize_analysis_v2_score_audit(
                $1, $2::uuid
             ) AS result`,
            [oversizedRequestId, requestId],
        );
        expect(materialized.rows[0]?.result.status).toBe('partial');
        const run = await db.query<{ status: string; reason: string }>(
            `SELECT status, reason FROM public.analysis_v2_score_audit_runs
             WHERE request_id = $1`,
            [oversizedRequestId],
        );
        expect(run.rows[0]).toEqual({
            status: 'partial',
            reason: 'SAFE_SOURCE_PAYLOAD_TOO_LARGE',
        });
        const released = await db.query<{ count: number }>(
            `SELECT count(*)::int AS count
             FROM public.analysis_v2_ai_scoring_stage_checkpoints
             WHERE request_id = $1`,
            [oversizedRequestId],
        );
        expect(released.rows[0]?.count).toBe(0);
    });

    it('materializes the 900-candidate Standard ceiling with durable leases and bounded pages', async () => {
        const bulkRequestId = 'ff000000-e89b-42d3-a456-426614174000';
        const bulkHash = '9'.repeat(64);
        const zeroInput: RiskPolicyInput = {
            uniqueTargetPostsLikedByCandidate: 0,
            boundedCandidateCommentsOnTarget: 0,
            reverseLikeStatus: 'not_observed',
            hasCandidateToTargetTagOrCaptionMention: false,
            hasTargetToCandidateTagOrCaptionMention: false,
            recentFemaleMutualRank: null,
            appearanceGrade: 1,
            exposureScore: 0,
            accountContext: 'personal',
            hasWeakPartnerEvidence: false,
            hasStrongPartnerEvidence: false,
        };
        const candidates = Array.from({ length: 900 }, (_, index) =>
            canonicalFixtureCandidate(
                `bulk-${String(index).padStart(3, '0')}`,
                `bulk_${String(index).padStart(3, '0')}`,
                zeroInput,
            )
        );
        const { normalizedCandidates, sortedCandidates } =
            normalizeFixtureCandidates(candidates);
        const results = sortedCandidates.map((candidate, index) => ({
            candidateId: candidate.candidateId,
            sortOrdinal: index + 1,
            instagramId: candidate.username,
            displayScore: candidate.displayScore,
            riskBand: candidate.riskBand,
            featuredRank: candidate.featuredRank,
        }));

        await db.query(
            'INSERT INTO public.analysis_requests VALUES ($1, $2, $3, $4::jsonb)',
            [bulkRequestId, 'completed', 'v2', JSON.stringify({
                risk: 'risk-policy-v2.4', aiStage: 'ai-stage-policy-v2.7',
            })],
        );
        await db.query(
            `INSERT INTO public.analysis_v2_candidate_feature_rows
                (request_id, candidate_id, full_name, bio,
                 classification_source, terminal_classification)
             SELECT $1, item->>'candidateId', NULL, NULL,
                    'feature', 'verified_female'
             FROM pg_catalog.jsonb_array_elements($2::jsonb) AS item`,
            [bulkRequestId, JSON.stringify(normalizedCandidates)],
        );
        await db.query(
            `INSERT INTO public.analysis_v2_ai_scoring_stage_checkpoints
             VALUES ($1, 'final_score', -1, $2, $3::jsonb, DEFAULT)`,
            [bulkRequestId, bulkHash, JSON.stringify({
                riskPolicyVersion: 'risk-policy-v2.4',
                candidates: normalizedCandidates,
            })],
        );
        const durableSource = await db.query<{
            intents: number;
            checkpoint_item_count: number;
            sources: number;
            expanded: number;
        }>(
            `SELECT count(*)::int AS intents,
                    max(checkpoint_item_count)::int AS checkpoint_item_count,
                    (SELECT count(*)::int
                     FROM public.analysis_v2_score_audit_sources
                     WHERE request_id = $1) AS sources,
                    (SELECT count(*)::int
                     FROM public.analysis_v2_score_audit_source_rows
                     WHERE request_id = $1) AS expanded
             FROM public.analysis_v2_score_audit_intents
             WHERE request_id = $1`,
            [bulkRequestId],
        );
        expect(durableSource.rows[0]).toEqual({
            intents: 1,
            checkpoint_item_count: 900,
            sources: 0,
            expanded: 0,
        });
        await db.query(
            `INSERT INTO public.analysis_v2_result_summaries
                (request_id, score_policy_version, female_count)
             VALUES ($1, 'risk-policy-v2.4', 900)`,
            [bulkRequestId],
        );
        await db.query(
            `INSERT INTO public.analysis_v2_female_results
                (request_id, candidate_id, sort_ordinal, instagram_id,
                 display_score, risk_band, featured_rank)
             SELECT $1, item->>'candidateId',
                    (item->>'sortOrdinal')::smallint,
                    item->>'instagramId',
                    (item->>'displayScore')::numeric,
                    item->>'riskBand',
                    NULLIF(item->>'featuredRank', '')::smallint
             FROM pg_catalog.jsonb_array_elements($2::jsonb) AS item`,
            [bulkRequestId, JSON.stringify(results)],
        );

        const firstClaim = await db.query<{
            claim: { leaseToken: string; sourceGeneration: number };
        }>(
            'SELECT public.claim_analysis_v2_score_audit($1) AS claim',
            [bulkRequestId],
        );
        expect(firstClaim.rows[0]?.claim).toMatchObject({
            leaseToken: requestId,
            sourceGeneration: 1,
        });
        const concurrentClaim = await db.query<{ claim: unknown }>(
            'SELECT public.claim_analysis_v2_score_audit($1) AS claim',
            [bulkRequestId],
        );
        expect(concurrentClaim.rows[0]?.claim).toBeNull();
        await db.query(
            `UPDATE public.analysis_v2_score_audit_runs
             SET lease_expires_at = pg_catalog.clock_timestamp() - INTERVAL '1 second'
             WHERE request_id = $1`,
            [bulkRequestId],
        );
        const queuedAfterExpiry = await db.query<{ request_id: string }>(
            `SELECT request_id::text
             FROM public.list_analysis_v2_score_audit_candidates(20)
             WHERE request_id = $1`,
            [bulkRequestId],
        );
        expect(queuedAfterExpiry.rows).toHaveLength(1);
        const reclaimed = await db.query<{ claim: { leaseToken: string } }>(
            'SELECT public.claim_analysis_v2_score_audit($1) AS claim',
            [bulkRequestId],
        );
        expect(reclaimed.rows[0]?.claim.leaseToken).toBe(requestId);
        const run = await db.query<{ attempt_count: number }>(
            `SELECT attempt_count
             FROM public.analysis_v2_score_audit_runs WHERE request_id = $1`,
            [bulkRequestId],
        );
        expect(run.rows[0]?.attempt_count).toBe(2);

        const startedAt = performance.now();
        const materialized = await db.query<{ result: { status: string } }>(
            `SELECT public.materialize_analysis_v2_score_audit(
                $1, $2::uuid
             ) AS result`,
            [bulkRequestId, requestId],
        );
        const elapsedMs = performance.now() - startedAt;
        expect(materialized.rows[0]?.result.status).toBe('ready');
        expect(elapsedMs).toBeLessThan(10_000);
        const expanded = await db.query<{
            source_rows: number;
            audit_rows: number;
            consistent_rows: number;
        }>(
            `SELECT
                (SELECT count(*)::int
                 FROM public.analysis_v2_score_audit_source_rows
                 WHERE request_id = $1) AS source_rows,
                count(*)::int AS audit_rows,
                count(*) FILTER (WHERE score_consistent)::int AS consistent_rows
             FROM public.analysis_v2_score_audit_rows
             WHERE request_id = $1`,
            [bulkRequestId],
        );
        expect(expanded.rows[0]).toEqual({
            source_rows: 900,
            audit_rows: 900,
            consistent_rows: 900,
        });
        const pageOne = await db.query<{
            result: { rows: Array<{ candidateId: string }>; nextCursor: number };
        }>(
            'SELECT public.load_analysis_v2_score_audit($1, 0, 50) AS result',
            [bulkRequestId],
        );
        const pageTwo = await db.query<{
            result: { rows: Array<{ candidateId: string }>; nextCursor: number };
        }>(
            'SELECT public.load_analysis_v2_score_audit($1, 50, 50) AS result',
            [bulkRequestId],
        );
        expect(pageOne.rows[0]?.result.rows).toHaveLength(50);
        expect(pageOne.rows[0]?.result.nextCursor).toBe(50);
        expect(pageTwo.rows[0]?.result.rows).toHaveLength(50);
        expect(pageTwo.rows[0]?.result.nextCursor).toBe(100);
        expect(new Set([
            ...pageOne.rows[0]!.result.rows,
            ...pageTwo.rows[0]!.result.rows,
        ].map(row => row.candidateId)).size).toBe(100);

        const postCompletionClaim = await db.query<{ claim: unknown }>(
            'SELECT public.claim_analysis_v2_score_audit($1) AS claim',
            [bulkRequestId],
        );
        expect(postCompletionClaim.rows[0]?.claim).toBeNull();
        const repeatedPreparation = await db.query<{
            result: { status: string };
        }>(
            `SELECT public.prepare_analysis_v2_score_audit_source(
                $1, $2, 1
             ) AS result`,
            [bulkRequestId, bulkHash],
        );
        expect(repeatedPreparation.rows[0]?.result).toEqual({ status: 'ready' });
    }, 15_000);
});
