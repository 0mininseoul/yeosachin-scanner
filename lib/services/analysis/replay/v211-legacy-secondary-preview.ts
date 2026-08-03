import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AnalysisV2ReplayBundle } from './replay-bundle';
import type { ReplayAccountAiOutput } from './replay-runner';
import { TEST_ENTITLEMENT_STANDARD_V211_LEGACY_SECONDARY_REPLAY_CAPABILITY } from './replay-source-lineage';

export interface V211LegacySecondaryPreview {
    schemaVersion: 1;
    requestId: string;
    sourceFingerprint: string;
    semanticInputFingerprint: string;
    expectedCurrentRevision: number;
    idempotencyKey: string;
    counts: { male: number; female: number; unknown: number };
    femaleRows: readonly Record<string, unknown>[];
    accounts: readonly ReplayAccountAiOutput[];
    previewHash: string;
}

const accountOutputSchema = z.object({
    ordinal: z.number().int().positive(),
    finalClassification: z.enum(['verified_female', 'verified_non_female', 'unresolved', 'unresolved_stage_conflict', 'fetch_unavailable', 'media_unavailable', 'analysis_unavailable']),
    classificationSource: z.enum(['triage', 'feature', 'gender_resolution', 'unknown', 'unavailable']),
    featureOverview: z.string().min(1).max(180).nullable(),
}).strict();
const femaleRowSchema = z.object({
    candidateId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/), sortOrdinal: z.number().int().min(1).max(900),
    instagramId: z.string().regex(/^[a-z0-9._]{1,30}$/), fullName: z.string().max(200).nullable(),
    profileImageUrl: z.string().max(8192).nullable(), bio: z.string().max(2200).nullable(),
    displayScore: z.number().min(1).max(10), riskBand: z.enum(['normal', 'caution', 'high_risk']),
    featuredRank: z.number().int().min(1).max(15).nullable(), recentMutualRank: z.number().int().min(1).max(10).nullable(),
    analysisDepth: z.enum(['features', 'narrative']), oneLineOverview: z.string().min(1).max(180),
    highRiskNarrative: z.tuple([z.string().min(1).max(180), z.string().min(1).max(180)]).nullable(),
}).strict();
const previewSchema = z.object({
    schemaVersion: z.literal(1), requestId: z.string().uuid(), sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    semanticInputFingerprint: z.string().regex(/^[a-f0-9]{64}$/), expectedCurrentRevision: z.number().int().min(0).max(999),
    idempotencyKey: z.string().regex(/^[a-f0-9]{64}$/), counts: z.object({ male: z.number().int().min(0), female: z.number().int().min(0), unknown: z.number().int().min(0) }).strict(),
    femaleRows: z.array(femaleRowSchema).max(900), accounts: z.array(accountOutputSchema).max(900), previewHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().superRefine((value, context) => {
    if (value.counts.female !== value.femaleRows.length || value.counts.male + value.counts.female + value.counts.unknown !== value.accounts.length) context.addIssue({ code: 'custom', message: 'Preview counts do not match rows.' });
});

function canonical(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => (
        `${JSON.stringify(key)}:${canonical(record[key])}`
    )).join(',')}}`;
}
function hash(value: unknown): string {
    return createHash('sha256').update(canonical(value)).digest('hex');
}

/**
 * Produces the only applyable v2.11 payload. It never invents score metadata:
 * a newly classified female without a previously finalized row fails preview.
 */
export function createV211LegacySecondaryPreview(input: {
    requestId: string;
    bundle: AnalysisV2ReplayBundle;
    accountOutputs: readonly ReplayAccountAiOutput[];
    semanticInputFingerprint: string;
}): V211LegacySecondaryPreview {
    const capture = input.bundle.capture;
    if (
        input.bundle.schemaVersion !== 1
        || capture.evaluationPolicy?.capability
            !== TEST_ENTITLEMENT_STANDARD_V211_LEGACY_SECONDARY_REPLAY_CAPABILITY
        || !capture.legacySecondary
        || input.requestId !== capture.legacySecondary.requestId
        || !/^[0-9a-f-]{36}$/i.test(input.requestId)
        || !/^[a-f0-9]{64}$/.test(input.semanticInputFingerprint)
    ) throw new Error('ANALYSIS_V2_V211_PREVIEW_SCOPE_INVALID');
    const publicProfiles = input.bundle.profiles.filter(profile => !profile.isPrivate);
    const outputByOrdinal = new Map(input.accountOutputs.map(output => [output.ordinal, output]));
    if (
        outputByOrdinal.size !== input.accountOutputs.length
        || outputByOrdinal.size !== publicProfiles.length
        || publicProfiles.some(profile => !outputByOrdinal.has(profile.ordinal))
    ) throw new Error('ANALYSIS_V2_V211_PREVIEW_ACCOUNT_OUTPUT_INCOMPLETE');
    const originalByInstagram = new Map(
        capture.legacySecondary.originalFemaleRows.map(row => [row.instagramId, row]),
    );
    if (originalByInstagram.size !== capture.legacySecondary.originalFemaleRows.length) {
        throw new Error('ANALYSIS_V2_V211_PREVIEW_SOURCE_DRIFT');
    }
    const femaleRows = publicProfiles.flatMap(profile => {
        const output = outputByOrdinal.get(profile.ordinal)!;
        if (output.finalClassification !== 'verified_female') return [];
        const original = originalByInstagram.get(profile.username);
        if (!original) throw new Error('ANALYSIS_V2_V211_PREVIEW_NEW_FEMALE_METADATA_UNAVAILABLE');
        return [{
            candidateId: original.candidateId,
            sortOrdinal: 0,
            instagramId: original.instagramId,
            fullName: original.fullName,
            profileImageUrl: original.profileImageUrl,
            bio: original.bio,
            displayScore: original.displayScore,
            riskBand: original.riskBand,
            featuredRank: original.featuredRank,
            recentMutualRank: original.recentMutualRank,
            analysisDepth: original.analysisDepth,
            oneLineOverview: output.featureOverview ?? original.oneLineOverview,
            highRiskNarrative: original.highRiskNarrative,
        }];
    }).sort((left, right) => (
        right.displayScore - left.displayScore
        || left.candidateId.localeCompare(right.candidateId)
    )).map((row, index) => ({ ...row, sortOrdinal: index + 1 }));
    const counts = input.accountOutputs.reduce((total, output) => {
        if (output.finalClassification === 'verified_female') total.female++;
        else if (output.finalClassification === 'verified_non_female') total.male++;
        else total.unknown++;
        return total;
    }, { male: 0, female: 0, unknown: 0 });
    if (counts.female !== femaleRows.length) {
        throw new Error('ANALYSIS_V2_V211_PREVIEW_GENDER_ROW_DRIFT');
    }
    const unsigned = {
        schemaVersion: 1 as const,
        requestId: input.requestId,
        sourceFingerprint: capture.legacySecondary.sourceFingerprint,
        semanticInputFingerprint: input.semanticInputFingerprint,
        expectedCurrentRevision: capture.legacySecondary.currentRevision,
        counts,
        femaleRows,
        accounts: [...input.accountOutputs].sort((left, right) => left.ordinal - right.ordinal),
    };
    const idempotencyKey = hash(`analysis-v2-v211-legacy-secondary-apply:v1\n${hash(unsigned)}`);
    const signed = { ...unsigned, idempotencyKey };
    return { ...signed, previewHash: hash(signed) };
}

/** Validates a persisted preview before its explicit apply command reaches the RPC. */
export function verifyV211LegacySecondaryPreview(value: unknown): V211LegacySecondaryPreview {
    const parsed = previewSchema.safeParse(value);
    if (!parsed.success) throw new Error('ANALYSIS_V2_V211_PREVIEW_INVALID');
    const preview = parsed.data as V211LegacySecondaryPreview;
    const { previewHash, ...signed } = preview;
    const { idempotencyKey, ...unsigned } = signed;
    const expectedIdempotencyKey = hash(
        `analysis-v2-v211-legacy-secondary-apply:v1\n${hash(unsigned)}`,
    );
    if (
        !/^[a-f0-9]{64}$/.test(previewHash)
        || !/^[a-f0-9]{64}$/.test(idempotencyKey)
        || idempotencyKey !== expectedIdempotencyKey
        || previewHash !== hash(signed)
    ) throw new Error('ANALYSIS_V2_V211_PREVIEW_HASH_INVALID');
    return preview;
}

export interface V211LegacySecondaryRevisionRpcClient {
    rpc(name: 'apply_analysis_v2_v211_result_revision', params: {
        p_request_id: string; p_source_fingerprint: string;
        p_semantic_input_fingerprint: string; p_idempotency_key: string;
        p_expected_current_revision: number; p_male_count: number;
        p_female_count: number; p_unknown_count: number; p_female_rows: readonly Record<string, unknown>[];
    }): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
}

/** The mutating call is deliberately separate from preview generation and validates the seal first. */
export async function applyV211LegacySecondaryPreview(
    client: V211LegacySecondaryRevisionRpcClient,
    previewValue: unknown,
): Promise<unknown> {
    const preview = verifyV211LegacySecondaryPreview(previewValue);
    const result = await client.rpc('apply_analysis_v2_v211_result_revision', {
        p_request_id: preview.requestId,
        p_source_fingerprint: preview.sourceFingerprint,
        p_semantic_input_fingerprint: preview.semanticInputFingerprint,
        p_idempotency_key: preview.idempotencyKey,
        p_expected_current_revision: preview.expectedCurrentRevision,
        p_male_count: preview.counts.male,
        p_female_count: preview.counts.female,
        p_unknown_count: preview.counts.unknown,
        p_female_rows: preview.femaleRows,
    });
    if (result.error) throw new Error('ANALYSIS_V2_V211_REVISION_APPLY_FAILED');
    return result.data;
}
