import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type {
    GenderRoutingBucket,
    GenderRoutingEvidence,
    GenderRoutingManifestRow,
    GenderRoutingPlan,
} from './gender-routing';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const JOB_KEY = 'track:relationships:collect';

const manifestHeaderBaseSchema = z.object({
    attemptCount: z.number().int().min(1).max(32_767),
    requestId: z.string().regex(UUID_PATTERN),
    relationshipCheckpointId: z.string().regex(HASH_PATTERN),
    policyVersion: z.literal('gender-routing-v1'),
    planId: z.enum(['basic', 'standard']),
    canonicalInputHmac: z.string().regex(HASH_PATTERN),
    populationCount: z.number().int().min(0).max(800),
    detailedCap: z.union([z.literal(100), z.literal(200)]),
    relationshipJobInputHash: z.string().regex(HASH_PATTERN),
});

const completeManifestHeaderSchema = manifestHeaderBaseSchema.extend({
    status: z.literal('complete'),
    selectedCount: z.number().int().min(0).max(200),
    modelAttemptedCount: z.number().int().min(0).max(800),
    modelValidCount: z.number().int().min(0).max(800),
    modelFailedCount: z.number().int().min(0).max(800),
    modelRetriedCount: z.number().int().min(0).max(800),
    quotaFemaleShortfall: z.number().int().min(0).max(160),
    quotaUncertaintyShortfall: z.number().int().min(0).max(40),
    femalePriorityCount: z.number().int().min(0).max(800),
    uncertaintyCount: z.number().int().min(0).max(800),
    maleDeprioritizedCount: z.number().int().min(0).max(800),
    selectedFemalePriorityCount: z.number().int().min(0).max(200),
    selectedUncertaintyCount: z.number().int().min(0).max(200),
    selectedMaleDeprioritizedCount: z.number().int().min(0).max(200),
}).strict().superRefine((value, context) => {
    if (
        value.modelValidCount + value.modelFailedCount !== value.modelAttemptedCount
        || value.selectedCount !== Math.min(value.populationCount, value.detailedCap)
        || value.femalePriorityCount + value.uncertaintyCount + value.maleDeprioritizedCount
            !== value.populationCount
        || value.selectedFemalePriorityCount + value.selectedUncertaintyCount
            + value.selectedMaleDeprioritizedCount !== value.selectedCount
    ) context.addIssue({ code: 'custom', message: 'Complete aggregate counts are inconsistent.' });
});

const manifestHeaderSchema = z.discriminatedUnion('status', [
    manifestHeaderBaseSchema.extend({ status: z.literal('building') }).strict(),
    completeManifestHeaderSchema,
    manifestHeaderBaseSchema.extend({ status: z.literal('invalidated') }).strict(),
]);

export type AnalysisV2GenderRoutingManifestHeader = z.infer<typeof manifestHeaderSchema>;

export interface AnalysisV2GenderRoutingManifestBeginInput {
    readonly requestId: string;
    readonly jobKey: typeof JOB_KEY;
    readonly claimToken: string;
    readonly jobInputHash: string;
    readonly relationshipCheckpointId: string;
    readonly policyVersion: 'gender-routing-v1';
    readonly planId: GenderRoutingPlan;
    readonly canonicalInputHmac: string;
    readonly populationCount: number;
    readonly detailedCap: 100 | 200;
}

/** Claim-fenced identity for the only retry-safe complete-manifest reader. */
export interface AnalysisV2GenderRoutingManifestCurrentCompleteInput {
    readonly requestId: string;
    readonly jobKey: typeof JOB_KEY;
    readonly claimToken: string;
    readonly jobInputHash: string;
    readonly relationshipCheckpointId: string;
    readonly policyVersion: 'gender-routing-v1';
    readonly planId: GenderRoutingPlan;
}

export interface AnalysisV2GenderRoutingManifestCandidateRow extends GenderRoutingManifestRow {
    /** The only link back to the relationship PII staging row. */
    readonly mutualOrdinal: number;
}

export interface AnalysisV2GenderRoutingManifestPublishInput
    extends AnalysisV2GenderRoutingManifestBeginInput {
    readonly selectedCount: number;
    readonly modelAttemptedCount: number;
    readonly modelValidCount: number;
    readonly modelFailedCount: number;
    readonly modelRetriedCount: number;
    readonly quotaShortfalls: Readonly<{ female: number; uncertainty: number }>;
    readonly bucketCounts: Readonly<Record<GenderRoutingBucket, number>>;
    readonly selectedBucketCounts: Readonly<Record<GenderRoutingBucket, number>>;
    readonly rows: readonly AnalysisV2GenderRoutingManifestCandidateRow[];
}

export interface AnalysisV2GenderRoutingSelectedIdentity {
    readonly requestId: string;
    readonly relationshipCheckpointId: string;
    readonly policyVersion: 'gender-routing-v1';
    readonly planId: GenderRoutingPlan;
}

export interface AnalysisV2GenderRoutingSelectedRow {
    readonly mutualOrdinal: number;
    readonly candidateKey: string;
    readonly selectionSlot: 'female' | 'uncertainty' | 'fill';
    readonly ordinal: number;
}

export interface AnalysisV2GenderRoutingSelectedUsernameRow
    extends AnalysisV2GenderRoutingSelectedRow {
    /** Returned only by the service-only worker loader after a complete manifest is verified. */
    readonly username: string;
}

interface RpcError {
    code?: string;
    message?: string;
}

interface RpcResult {
    data: unknown;
    error: RpcError | null;
}

export interface AnalysisV2GenderRoutingManifestSupabaseClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<RpcResult>;
}

export interface AnalysisV2GenderRoutingManifestStore {
    loadCurrentComplete(input: AnalysisV2GenderRoutingManifestCurrentCompleteInput): Promise<{
        readonly header: Extract<AnalysisV2GenderRoutingManifestHeader, { status: 'complete' }>;
        readonly selected: readonly AnalysisV2GenderRoutingSelectedRow[];
    } | null>;
    begin(input: AnalysisV2GenderRoutingManifestBeginInput): Promise<AnalysisV2GenderRoutingManifestHeader>;
    publish(input: AnalysisV2GenderRoutingManifestPublishInput): Promise<AnalysisV2GenderRoutingManifestHeader>;
    loadSelected(input: AnalysisV2GenderRoutingSelectedIdentity): Promise<readonly AnalysisV2GenderRoutingSelectedRow[]>;
    loadSelectedUsernames(input: AnalysisV2GenderRoutingSelectedIdentity): Promise<readonly AnalysisV2GenderRoutingSelectedUsernameRow[]>;
}

export const ANALYSIS_V2_GENDER_ROUTING_MANIFEST_DATABASE_NAMES = Object.freeze({
    manifestTable: 'analysis_v2_gender_routing_manifests',
    rowTable: 'analysis_v2_gender_routing_candidates',
    beginRpc: 'begin_analysis_v2_gender_routing_manifest',
    publishRpc: 'publish_analysis_v2_gender_routing_manifest',
    loadSelectedRpc: 'load_analysis_v2_gender_routing_selected',
    loadSelectedUsernamesRpc: 'load_analysis_v2_gender_routing_selected_usernames',
    loadCurrentCompleteRpc: 'load_current_analysis_v2_gender_routing_manifest',
});

function validateBegin(input: AnalysisV2GenderRoutingManifestBeginInput): void {
    if (
        !UUID_PATTERN.test(input.requestId)
        || input.jobKey !== JOB_KEY
        || !UUID_PATTERN.test(input.claimToken)
        || !HASH_PATTERN.test(input.jobInputHash)
        || !HASH_PATTERN.test(input.relationshipCheckpointId)
        || !HASH_PATTERN.test(input.canonicalInputHmac)
        || input.policyVersion !== 'gender-routing-v1'
        || !Number.isSafeInteger(input.populationCount)
        || input.populationCount < 0
        || input.populationCount > 800
        || (input.planId === 'basic' && (input.detailedCap !== 100 || input.populationCount > 400))
        || (input.planId === 'standard' && (input.detailedCap !== 200 || input.populationCount > 800))
    ) {
        throw new Error('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_VALIDATION_ERROR');
    }
}

function validateCurrentComplete(input: AnalysisV2GenderRoutingManifestCurrentCompleteInput): void {
    if (
        !UUID_PATTERN.test(input.requestId)
        || input.jobKey !== JOB_KEY
        || !UUID_PATTERN.test(input.claimToken)
        || !HASH_PATTERN.test(input.jobInputHash)
        || !HASH_PATTERN.test(input.relationshipCheckpointId)
        || input.policyVersion !== 'gender-routing-v1'
        || (input.planId !== 'basic' && input.planId !== 'standard')
    ) throw new Error('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_VALIDATION_ERROR');
}

function nonNegativeInteger(value: number, maximum: number): boolean {
    return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function validateSelectedIdentity(input: AnalysisV2GenderRoutingSelectedIdentity): void {
    if (
        !UUID_PATTERN.test(input.requestId)
        || !HASH_PATTERN.test(input.relationshipCheckpointId)
        || input.policyVersion !== 'gender-routing-v1'
        || (input.planId !== 'basic' && input.planId !== 'standard')
    ) throw new Error('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_VALIDATION_ERROR');
}

function expectedCaps(planId: GenderRoutingPlan): Readonly<{ population: number; detailed: number }> {
    return planId === 'basic'
        ? { population: 400, detailed: 100 }
        : { population: 800, detailed: 200 };
}

function validatePublish(input: AnalysisV2GenderRoutingManifestPublishInput): void {
    validateBegin(input);
    const cap = expectedCaps(input.planId);
    const values = [
        input.selectedCount,
        input.modelAttemptedCount,
        input.modelValidCount,
        input.modelFailedCount,
        input.modelRetriedCount,
        input.quotaShortfalls.female,
        input.quotaShortfalls.uncertainty,
        input.bucketCounts.female_priority,
        input.bucketCounts.uncertainty,
        input.bucketCounts.male_deprioritized,
        input.selectedBucketCounts.female_priority,
        input.selectedBucketCounts.uncertainty,
        input.selectedBucketCounts.male_deprioritized,
    ];
    if (
        values.some(value => !nonNegativeInteger(value, cap.population))
        || input.rows.length !== input.populationCount
        || input.rows.length > cap.population
        || input.selectedCount !== Math.min(input.populationCount, cap.detailed)
        || input.modelValidCount + input.modelFailedCount !== input.modelAttemptedCount
        || (input.populationCount > cap.detailed && (
            input.modelAttemptedCount === 0
            || input.modelValidCount === 0
            || input.modelFailedCount / input.modelAttemptedCount > 0.1
        ))
        || input.rows.filter(row => row.selected).length !== input.selectedCount
        || input.rows.filter(row => row.bucket === 'female_priority').length
            !== input.bucketCounts.female_priority
        || input.rows.filter(row => row.bucket === 'uncertainty').length
            !== input.bucketCounts.uncertainty
        || input.rows.filter(row => row.bucket === 'male_deprioritized').length
            !== input.bucketCounts.male_deprioritized
        || input.rows.filter(row => row.selected && row.bucket === 'female_priority').length
            !== input.selectedBucketCounts.female_priority
        || input.rows.filter(row => row.selected && row.bucket === 'uncertainty').length
            !== input.selectedBucketCounts.uncertainty
        || input.rows.filter(row => row.selected && row.bucket === 'male_deprioritized').length
            !== input.selectedBucketCounts.male_deprioritized
    ) throw new Error('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_VALIDATION_ERROR');

    const mutualOrdinals = new Set<number>();
    const candidateKeys = new Set<string>();
    const selectedOrdinals = new Set<number>();
    for (const row of input.rows) {
        const scores = [row.femaleScore, row.maleScore, row.uncertaintyScore];
        const populatedScores = scores.every(score => typeof score === 'number');
        const expectedEvidence: GenderRoutingEvidence = row.hasImage
            ? row.hasName ? 'image_and_name' : 'image_only'
            : row.hasName ? 'name_only' : 'none';
        const expectedReason = row.selected
            ? row.selectionSlot === 'female'
                ? 'female_quota'
                : row.selectionSlot === 'uncertainty'
                    ? 'uncertainty_quota'
                    : input.populationCount <= cap.detailed ? 'population_within_cap' : 'fill'
            : 'not_selected';
        if (
            !Number.isSafeInteger(row.mutualOrdinal)
            || row.mutualOrdinal < 1
            || row.mutualOrdinal > 1_200
            || row.candidateKey !== `mutual:${row.mutualOrdinal}`
            || !/^mutual:[1-9][0-9]{0,3}$/.test(row.candidateKey)
            || row.hasImage !== (row.imageContentHmac !== null)
            || row.hasName !== (row.fullnameHmac !== null)
            || (row.imageContentHmac !== null && !HASH_PATTERN.test(row.imageContentHmac))
            || (row.fullnameHmac !== null && !HASH_PATTERN.test(row.fullnameHmac))
            || scores.some(score => score !== null && (!Number.isFinite(score) || score < 0 || score > 1))
            || (populatedScores && Math.abs((row.femaleScore! + row.maleScore! + row.uncertaintyScore!) - 1) > 0.000_001)
            || (!populatedScores && scores.some(score => score !== null))
            || (populatedScores && row.evidence !== expectedEvidence)
            || (!populatedScores && row.evidence !== null)
            || (input.populationCount <= cap.detailed && (
                populatedScores || row.evidence !== null || row.routingUnavailable
            ))
            || (input.populationCount > cap.detailed && (
                !populatedScores
                || row.evidence !== expectedEvidence
                || (row.routingUnavailable && (
                    row.bucket !== 'uncertainty'
                    || row.femaleScore !== 0
                    || row.maleScore !== 0
                    || row.uncertaintyScore !== 1
                ))
            ))
            || (row.selected && (row.selectionSlot === null || row.ordinal === null))
            || (!row.selected && (row.selectionSlot !== null || row.ordinal !== null))
            || (row.selected && !Number.isSafeInteger(row.ordinal))
            || (row.selected && row.selectionSlot === 'female' && row.bucket !== 'female_priority')
            || (row.selected && row.selectionSlot === 'uncertainty' && row.bucket !== 'uncertainty')
            || row.selectionReason !== expectedReason
            || !mutualOrdinals.add(row.mutualOrdinal)
            || !candidateKeys.add(row.candidateKey)
            || (row.selected && !selectedOrdinals.add(row.ordinal!))
        ) throw new Error('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_VALIDATION_ERROR');
    }
    if (
        [...selectedOrdinals].sort((a, b) => a - b).some((ordinal, index) => ordinal !== index + 1)
        || (input.populationCount <= cap.detailed && (
            input.selectedCount !== input.populationCount
            || input.modelAttemptedCount !== 0
            || input.modelValidCount !== 0
            || input.modelFailedCount !== 0
            || input.modelRetriedCount !== 0
        ))
        || (input.populationCount > cap.detailed && input.selectedCount !== cap.detailed)
    ) throw new Error('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_VALIDATION_ERROR');
}

function rowsForDatabase(rows: readonly AnalysisV2GenderRoutingManifestCandidateRow[]): object[] {
    return rows.map(row => ({
        mutualOrdinal: row.mutualOrdinal,
        candidateKey: row.candidateKey,
        hasImage: row.hasImage,
        hasName: row.hasName,
        imageContentHmac: row.imageContentHmac,
        fullnameHmac: row.fullnameHmac,
        femaleScore: row.femaleScore,
        maleScore: row.maleScore,
        uncertaintyScore: row.uncertaintyScore,
        evidence: row.evidence,
        bucket: row.bucket,
        routingUnavailable: row.routingUnavailable,
        selected: row.selected,
        selectionReason: row.selectionReason,
        selectionSlot: row.selectionSlot,
        ordinal: row.ordinal,
    }));
}

const selectedRowSchema = z.object({
    mutualOrdinal: z.number().int().min(1).max(1_200),
    candidateKey: z.string().regex(/^mutual:[1-9][0-9]{0,3}$/),
    selectionSlot: z.enum(['female', 'uncertainty', 'fill']),
    ordinal: z.number().int().min(1).max(200),
}).strict().superRefine((value, context) => {
    if (value.candidateKey !== `mutual:${value.mutualOrdinal}`) {
        context.addIssue({ code: 'custom', message: 'Candidate identity must match mutual ordinal.' });
    }
});

const selectedResultSchema = z.object({
    selectedCount: z.number().int().min(0).max(200),
    rows: z.array(selectedRowSchema).max(200),
}).strict();

const selectedUsernameResultSchema = z.object({
    selectedCount: z.number().int().min(0).max(200),
    rows: z.array(selectedRowSchema.extend({
        username: z.string().regex(/^[a-z0-9._]{1,30}$/),
    }).strict()).max(200),
}).strict();

const currentCompleteResultSchema = z.object({
    header: completeManifestHeaderSchema,
    selected: selectedResultSchema,
}).strict();

function parsedSelectedRows<T extends AnalysisV2GenderRoutingSelectedRow>(
    parsed: { selectedCount: number; rows: readonly T[] },
): readonly T[] {
    const rows = [...parsed.rows].sort((left, right) => left.ordinal - right.ordinal);
    if (
        rows.length !== parsed.selectedCount
        || rows.some((row, index) => row.ordinal !== index + 1)
    ) throw new Error('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID_RESULT');
    return Object.freeze(rows.map(row => Object.freeze(row)));
}

function parseHeader(data: unknown): AnalysisV2GenderRoutingManifestHeader {
    const parsed = manifestHeaderSchema.safeParse(
        Array.isArray(data) && data.length === 1 ? data[0] : data
    );
    if (!parsed.success) {
        throw new Error('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID_RESULT');
    }
    return Object.freeze(parsed.data);
}

function assertHeaderMatchesBegin(
    header: AnalysisV2GenderRoutingManifestHeader,
    input: AnalysisV2GenderRoutingManifestBeginInput,
): void {
    if (
        header.requestId.toLowerCase() !== input.requestId.toLowerCase()
        || header.relationshipCheckpointId !== input.relationshipCheckpointId
        || header.policyVersion !== input.policyVersion
        || header.planId !== input.planId
        || header.canonicalInputHmac !== input.canonicalInputHmac
        || header.populationCount !== input.populationCount
        || header.detailedCap !== input.detailedCap
        || header.relationshipJobInputHash !== input.jobInputHash
    ) throw new Error('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID_RESULT');
}

function assertHeaderMatchesPublish(
    header: Extract<AnalysisV2GenderRoutingManifestHeader, { status: 'complete' }>,
    input: AnalysisV2GenderRoutingManifestPublishInput,
): void {
    if (
        header.selectedCount !== input.selectedCount
        || header.modelAttemptedCount !== input.modelAttemptedCount
        || header.modelValidCount !== input.modelValidCount
        || header.modelFailedCount !== input.modelFailedCount
        || header.modelRetriedCount !== input.modelRetriedCount
        || header.quotaFemaleShortfall !== input.quotaShortfalls.female
        || header.quotaUncertaintyShortfall !== input.quotaShortfalls.uncertainty
        || header.femalePriorityCount !== input.bucketCounts.female_priority
        || header.uncertaintyCount !== input.bucketCounts.uncertainty
        || header.maleDeprioritizedCount !== input.bucketCounts.male_deprioritized
        || header.selectedFemalePriorityCount !== input.selectedBucketCounts.female_priority
        || header.selectedUncertaintyCount !== input.selectedBucketCounts.uncertainty
        || header.selectedMaleDeprioritizedCount !== input.selectedBucketCounts.male_deprioritized
    ) throw new Error('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID_RESULT');
}

function assertHeaderMatchesCurrent(
    header: Extract<AnalysisV2GenderRoutingManifestHeader, { status: 'complete' }>,
    input: AnalysisV2GenderRoutingManifestCurrentCompleteInput,
): void {
    if (
        header.requestId.toLowerCase() !== input.requestId.toLowerCase()
        || header.relationshipCheckpointId !== input.relationshipCheckpointId
        || header.policyVersion !== input.policyVersion
        || header.planId !== input.planId
        || header.relationshipJobInputHash !== input.jobInputHash
    ) throw new Error('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID_RESULT');
}

export function createAnalysisV2GenderRoutingManifestStore(
    client: AnalysisV2GenderRoutingManifestSupabaseClient = supabaseAdmin,
): AnalysisV2GenderRoutingManifestStore {
    return {
        async loadCurrentComplete(input) {
            validateCurrentComplete(input);
            const { data, error } = await client.rpc(
                ANALYSIS_V2_GENDER_ROUTING_MANIFEST_DATABASE_NAMES.loadCurrentCompleteRpc,
                {
                    p_request_id: input.requestId.toLowerCase(),
                    p_job_key: input.jobKey,
                    p_claim_token: input.claimToken.toLowerCase(),
                    p_job_input_hash: input.jobInputHash,
                    p_relationship_checkpoint_id: input.relationshipCheckpointId,
                    p_policy_version: input.policyVersion,
                    p_plan_id: input.planId,
                }
            );
            if (error) throw new Error('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_PERSISTENCE_ERROR');
            if (data === null) return null;
            const parsed = currentCompleteResultSchema.safeParse(data);
            if (!parsed.success) throw new Error('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID_RESULT');
            assertHeaderMatchesCurrent(parsed.data.header, input);
            return Object.freeze({
                header: Object.freeze(parsed.data.header),
                selected: parsedSelectedRows(parsed.data.selected),
            });
        },
        async begin(input) {
            validateBegin(input);
            const { data, error } = await client.rpc(
                ANALYSIS_V2_GENDER_ROUTING_MANIFEST_DATABASE_NAMES.beginRpc,
                {
                    p_request_id: input.requestId.toLowerCase(),
                    p_job_key: input.jobKey,
                    p_claim_token: input.claimToken.toLowerCase(),
                    p_job_input_hash: input.jobInputHash,
                    p_relationship_checkpoint_id: input.relationshipCheckpointId,
                    p_policy_version: input.policyVersion,
                    p_plan_id: input.planId,
                    p_canonical_input_hmac: input.canonicalInputHmac,
                    p_population_count: input.populationCount,
                    p_detailed_cap: input.detailedCap,
                }
            );
            if (error) throw new Error('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_PERSISTENCE_ERROR');
            const header = parseHeader(data);
            assertHeaderMatchesBegin(header, input);
            return header;
        },
        async publish(input) {
            validatePublish(input);
            const { data, error } = await client.rpc(
                ANALYSIS_V2_GENDER_ROUTING_MANIFEST_DATABASE_NAMES.publishRpc,
                {
                    p_request_id: input.requestId.toLowerCase(),
                    p_job_key: input.jobKey,
                    p_claim_token: input.claimToken.toLowerCase(),
                    p_job_input_hash: input.jobInputHash,
                    p_relationship_checkpoint_id: input.relationshipCheckpointId,
                    p_policy_version: input.policyVersion,
                    p_plan_id: input.planId,
                    p_canonical_input_hmac: input.canonicalInputHmac,
                    p_population_count: input.populationCount,
                    p_detailed_cap: input.detailedCap,
                    p_selected_count: input.selectedCount,
                    p_model_attempted_count: input.modelAttemptedCount,
                    p_model_valid_count: input.modelValidCount,
                    p_model_failed_count: input.modelFailedCount,
                    p_model_retried_count: input.modelRetriedCount,
                    p_quota_female_shortfall: input.quotaShortfalls.female,
                    p_quota_uncertainty_shortfall: input.quotaShortfalls.uncertainty,
                    p_female_priority_count: input.bucketCounts.female_priority,
                    p_uncertainty_count: input.bucketCounts.uncertainty,
                    p_male_deprioritized_count: input.bucketCounts.male_deprioritized,
                    p_selected_female_priority_count: input.selectedBucketCounts.female_priority,
                    p_selected_uncertainty_count: input.selectedBucketCounts.uncertainty,
                    p_selected_male_deprioritized_count: input.selectedBucketCounts.male_deprioritized,
                    p_rows: rowsForDatabase(input.rows),
                }
            );
            if (error) throw new Error('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_PERSISTENCE_ERROR');
            const header = parseHeader(data);
            if (header.status !== 'complete') {
                throw new Error('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID_RESULT');
            }
            assertHeaderMatchesBegin(header, input);
            assertHeaderMatchesPublish(header, input);
            return header;
        },
        async loadSelected(input) {
            validateSelectedIdentity(input);
            const { data, error } = await client.rpc(
                ANALYSIS_V2_GENDER_ROUTING_MANIFEST_DATABASE_NAMES.loadSelectedRpc,
                {
                    p_request_id: input.requestId.toLowerCase(),
                    p_relationship_checkpoint_id: input.relationshipCheckpointId,
                    p_policy_version: input.policyVersion,
                    p_plan_id: input.planId,
                }
            );
            if (error) throw new Error('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_PERSISTENCE_ERROR');
            const parsed = selectedResultSchema.safeParse(data);
            if (!parsed.success) throw new Error('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID_RESULT');
            return parsedSelectedRows(parsed.data);
        },
        async loadSelectedUsernames(input) {
            validateSelectedIdentity(input);
            const { data, error } = await client.rpc(
                ANALYSIS_V2_GENDER_ROUTING_MANIFEST_DATABASE_NAMES.loadSelectedUsernamesRpc,
                {
                    p_request_id: input.requestId.toLowerCase(),
                    p_relationship_checkpoint_id: input.relationshipCheckpointId,
                    p_policy_version: input.policyVersion,
                    p_plan_id: input.planId,
                }
            );
            if (error) throw new Error('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_PERSISTENCE_ERROR');
            const parsed = selectedUsernameResultSchema.safeParse(data);
            if (!parsed.success) throw new Error('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID_RESULT');
            return parsedSelectedRows(parsed.data);
        },
    };
}

export const analysisV2GenderRoutingManifestStore =
    createAnalysisV2GenderRoutingManifestStore();
