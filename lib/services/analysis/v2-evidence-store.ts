import { createHash } from 'node:crypto';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    ANALYSIS_V2_RELATIONSHIPS_JOB_KEY,
    ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY,
} from './v2-coordinator';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,159}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PROVIDER_RUN_ID_PATTERN = /^[A-Za-z0-9]{8,64}$/;
const BOUNDED_SOURCE_ID_PATTERN = /^[^\u0000-\u001f\u007f]{1,255}$/u;
const MAX_COMMENT_TEXT_LENGTH = 1_000;

export const ANALYSIS_V2_RELATIONSHIP_SIDE_LIMIT = 1_200;
export const ANALYSIS_V2_RELATIONSHIP_COVERAGE_BPS = 9_900;
export const ANALYSIS_V2_TARGET_EVIDENCE_LIMIT = 690;
export const ANALYSIS_V2_TARGET_LIKER_POST_LIMIT = 4;
export const ANALYSIS_V2_TARGET_LIKER_PER_POST_LIMIT = 150;
export const ANALYSIS_V2_TARGET_COMMENT_POST_LIMIT = 6;
export const ANALYSIS_V2_TARGET_COMMENT_PER_POST_LIMIT = 15;

export const ANALYSIS_V2_DETAILED_MUTUAL_LIMITS = [300, 600, 900] as const;
export type AnalysisV2DetailedMutualLimit =
    typeof ANALYSIS_V2_DETAILED_MUTUAL_LIMITS[number];
export type AnalysisV2RelationshipSide = 'followers' | 'following';
export type AnalysisV2RelationshipProvider =
    | 'apify'
    | 'coderx';
export type AnalysisV2TargetEvidenceSignal =
    | 'target_post_like'
    | 'target_post_comment';

const usernameSchema = z.string()
    .trim()
    .transform(value => value.replace(/^@/, '').toLowerCase())
    .pipe(z.string().regex(/^[a-z0-9._]{1,30}$/));

const relationshipFullNameSchema = z.string()
    .transform(value => value
        .normalize('NFKC')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim())
    .pipe(z.string().max(200))
    .transform(value => value || null);

const relationshipProfilePicUrlSchema = z.string()
    .trim()
    .max(8_192)
    .url()
    .refine(value => value.startsWith('https://'));

const relationshipRowInputSchema = z.object({
    username: usernameSchema,
    isPrivate: z.boolean(),
    isVerified: z.boolean(),
    fullName: relationshipFullNameSchema.nullable().optional()
        .transform(value => value ?? null),
    profilePicUrl: relationshipProfilePicUrlSchema.nullable().optional()
        .transform(value => value ?? null),
}).strict();

export interface AnalysisV2RelationshipRowInput {
    username: string;
    isPrivate: boolean;
    isVerified: boolean;
    fullName?: string | null;
    profilePicUrl?: string | null;
}

export interface AnalysisV2CanonicalRelationshipRow {
    username: string;
    isPrivate: boolean;
    isVerified: boolean;
    fullName: string | null;
    profilePicUrl: string | null;
}

export interface AnalysisV2MutualStagingRow
    extends AnalysisV2CanonicalRelationshipRow {
    mutualOrdinal: number;
    followingOrdinal: number;
    detailedOrdinal: number | null;
}

export interface AnalysisV2RelationshipSideManifest {
    side: AnalysisV2RelationshipSide;
    sourceStatus: 'collected' | 'not_applicable';
    revision: number;
    declaredCount: number;
    collectedCount: number;
    coverageBps: number;
    inputHash: string;
    resultHash: string;
}

export interface AnalysisV2RelationshipDagManifest {
    revision: number;
    resultHash: string;
    exclusionDecisionHash: string;
    followersResultHash: string;
    followingResultHash: string;
    mutualCount: number;
    publicCount: number;
    privateCount: number;
    detailedPublicCount: number;
    unscreenedPublicCount: number;
}

export interface AnalysisV2RelationshipStagingSnapshot {
    requestId: string;
    jobKey: string;
    excludedUsername: string | null;
    detailedMutualLimit: AnalysisV2DetailedMutualLimit;
    manifest: AnalysisV2RelationshipDagManifest;
    followers: AnalysisV2RelationshipSideManifest & {
        provider: 'apify' | null;
        providerRunId: string | null;
        providerOperationKey: string | null;
        providerCredentialSlot: 'primary' | 'secondary' | null;
        rows: AnalysisV2CanonicalRelationshipRow[];
    };
    following: AnalysisV2RelationshipSideManifest & {
        provider: 'apify' | null;
        providerRunId: string | null;
        providerOperationKey: string | null;
        providerCredentialSlot: 'primary' | 'secondary' | null;
        rows: AnalysisV2CanonicalRelationshipRow[];
    };
    mutualRows: AnalysisV2MutualStagingRow[];
    detailedPublicUsernames: string[];
    privateMutualUsernames: string[];
    privateMutualRows: AnalysisV2MutualStagingRow[];
}

export interface AnalysisV2TargetEvidenceRowInput {
    actorUsername: string;
    postId: string;
    signal: AnalysisV2TargetEvidenceSignal;
    sourceInteractionId: string;
    occurredAt?: string;
    content?: string;
}

export interface AnalysisV2CanonicalTargetEvidenceRow {
    actorUsername: string;
    postId: string;
    signal: AnalysisV2TargetEvidenceSignal;
    sourceInteractionId: string;
    occurredAt: string | null;
    content: string | null;
}

export interface AnalysisV2TargetEvidenceCoverageInput {
    postId: string;
    declaredCount: number;
    returnedCount: number;
    requestedLimit: number;
}

export type AnalysisV2TargetEvidenceSourceInput =
    | {
        status: 'collected';
        inputHash: string;
        provider: AnalysisV2RelationshipProvider;
        providerRunId: string;
        providerOperationKey: string;
        providerCredentialSlot: 'primary' | 'secondary';
        coverage: readonly AnalysisV2TargetEvidenceCoverageInput[];
    }
    | {
        status: 'not_applicable';
        inputHash: string;
    };

export interface AnalysisV2CanonicalTargetEvidenceSource {
    status: 'collected' | 'not_applicable';
    inputHash: string;
    provider: AnalysisV2RelationshipProvider | null;
    providerRunId: string | null;
    providerOperationKey: string | null;
    providerCredentialSlot: 'primary' | 'secondary' | null;
    coverage: AnalysisV2TargetEvidenceCoverageInput[];
}

export interface AnalysisV2TargetEvidenceDagManifest {
    revision: number;
    resultHash: string;
    inputHash: string;
    interactorCount: number;
    likerCount: number;
    commentCount: number;
}

export interface AnalysisV2TargetEvidenceStagingSnapshot {
    requestId: string;
    jobKey: string;
    targetUsername: string;
    excludedUsername: string | null;
    manifest: AnalysisV2TargetEvidenceDagManifest;
    likerSource: AnalysisV2CanonicalTargetEvidenceSource;
    commentSource: AnalysisV2CanonicalTargetEvidenceSource;
    rows: AnalysisV2CanonicalTargetEvidenceRow[];
}

export interface AnalysisV2EvidenceJobClaim {
    requestId: string;
    jobKey: string;
    claimToken: string;
    jobInputHash: string;
}

export type AnalysisV2RelationshipSideSourceInput =
    | {
        status: 'collected';
        inputHash: string;
        provider: 'apify';
        providerRunId: string;
        providerOperationKey: string;
    }
    | {
        status: 'not_applicable';
        inputHash: string;
    };

export interface AnalysisV2RelationshipSideCheckpointInput
    extends AnalysisV2EvidenceJobClaim {
    side: AnalysisV2RelationshipSide;
    declaredCount: number;
    source: AnalysisV2RelationshipSideSourceInput;
    rows: readonly AnalysisV2RelationshipRowInput[];
}

export interface AnalysisV2TargetEvidenceCheckpointInput
    extends AnalysisV2EvidenceJobClaim {
    targetUsername: string;
    excludedUsername: string | null;
    inputHash: string;
    likerSource: AnalysisV2TargetEvidenceSourceInput;
    commentSource: AnalysisV2TargetEvidenceSourceInput;
    rows: readonly AnalysisV2TargetEvidenceRowInput[];
}

export interface AnalysisV2EvidenceStore {
    checkpointRelationshipSide(input: AnalysisV2RelationshipSideCheckpointInput):
        Promise<AnalysisV2RelationshipSideManifest>;
    freezeRelationships(input: AnalysisV2EvidenceJobClaim & {
        detailedMutualLimit: AnalysisV2DetailedMutualLimit;
    }): Promise<AnalysisV2RelationshipDagManifest>;
    loadRelationshipStaging(input: Pick<AnalysisV2EvidenceJobClaim, 'requestId' | 'jobKey'>):
        Promise<AnalysisV2RelationshipStagingSnapshot | null>;
    checkpointTargetEvidence(input: AnalysisV2TargetEvidenceCheckpointInput):
        Promise<AnalysisV2TargetEvidenceDagManifest>;
    loadTargetEvidence(input: Pick<AnalysisV2EvidenceJobClaim, 'requestId' | 'jobKey'>):
        Promise<AnalysisV2TargetEvidenceStagingSnapshot | null>;
}

interface RpcError {
    code?: string;
    message?: string;
}

interface RpcResult {
    data: unknown;
    error: RpcError | null;
}

export interface AnalysisV2EvidenceSupabaseClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<RpcResult>;
}

export const ANALYSIS_V2_EVIDENCE_DATABASE_NAMES = Object.freeze({
    relationshipSideTable: 'analysis_v2_relationship_sides',
    relationshipRowTable: 'analysis_v2_relationship_rows',
    relationshipManifestTable: 'analysis_v2_relationship_manifests',
    mutualRowTable: 'analysis_v2_mutual_rows',
    targetManifestTable: 'analysis_v2_target_evidence_manifests',
    targetInteractorTable: 'analysis_target_interactors',
    checkpointRelationshipSideRpc: 'checkpoint_analysis_v2_relationship_side',
    checkpointRelationshipNotApplicableRpc:
        'checkpoint_analysis_v2_relationship_side_not_applicable',
    freezeRelationshipsRpc: 'freeze_analysis_v2_relationships',
    loadRelationshipStagingRpc: 'load_analysis_v2_relationship_staging',
    checkpointTargetEvidenceRpc: 'checkpoint_analysis_v2_target_evidence',
    loadTargetEvidenceRpc: 'load_analysis_v2_target_evidence',
});

/**
 * Phase G's finalizer must add one transaction-scoped, service-role-only purge RPC that deletes
 * the four relationship PII tables and the two target-evidence PII tables for a terminal request.
 * It must not delete analysis_v2_provider_runs, analysis_v2_ai_attempts, or any PII-free cost and
 * latency telemetry. This Phase F store deliberately exposes no ad-hoc purge method.
 */
export const ANALYSIS_V2_EVIDENCE_PURGE_DESIGN = Object.freeze({
    trigger: 'atomic terminal finalizer or terminal failure handler',
    piiTables: Object.freeze([
        ANALYSIS_V2_EVIDENCE_DATABASE_NAMES.mutualRowTable,
        ANALYSIS_V2_EVIDENCE_DATABASE_NAMES.relationshipRowTable,
        ANALYSIS_V2_EVIDENCE_DATABASE_NAMES.relationshipManifestTable,
        ANALYSIS_V2_EVIDENCE_DATABASE_NAMES.relationshipSideTable,
        ANALYSIS_V2_EVIDENCE_DATABASE_NAMES.targetInteractorTable,
        ANALYSIS_V2_EVIDENCE_DATABASE_NAMES.targetManifestTable,
    ]),
    retainedLedgers: Object.freeze([
        'analysis_v2_provider_runs',
        'analysis_v2_ai_attempts',
    ]),
});

export class AnalysisV2EvidenceFenceError extends Error {
    constructor() {
        super('ANALYSIS_V2_EVIDENCE_FENCE_MISMATCH');
        this.name = 'AnalysisV2EvidenceFenceError';
    }
}

export class AnalysisV2EvidenceConflictError extends Error {
    constructor(message = 'ANALYSIS_V2_EVIDENCE_CONFLICT') {
        super(message);
        this.name = 'AnalysisV2EvidenceConflictError';
    }
}

export class AnalysisV2RelationshipIncompleteError extends Error {
    constructor() {
        super('ANALYSIS_V2_RELATIONSHIP_INCOMPLETE');
        this.name = 'AnalysisV2RelationshipIncompleteError';
    }
}

const relationshipSideManifestSchema = z.object({
    side: z.enum(['followers', 'following']),
    sourceStatus: z.enum(['collected', 'not_applicable']),
    revision: z.number().int().min(1).max(32_767),
    declaredCount: z.number().int().min(0).max(ANALYSIS_V2_RELATIONSHIP_SIDE_LIMIT),
    collectedCount: z.number().int().min(0).max(ANALYSIS_V2_RELATIONSHIP_SIDE_LIMIT),
    coverageBps: z.number().int().min(ANALYSIS_V2_RELATIONSHIP_COVERAGE_BPS).max(10_000),
    inputHash: z.string().regex(SHA256_PATTERN),
    resultHash: z.string().regex(SHA256_PATTERN),
}).strict();

const relationshipDagManifestSchema = z.object({
    revision: z.number().int().min(1).max(32_767),
    resultHash: z.string().regex(SHA256_PATTERN),
    exclusionDecisionHash: z.string().regex(SHA256_PATTERN),
    followersResultHash: z.string().regex(SHA256_PATTERN),
    followingResultHash: z.string().regex(SHA256_PATTERN),
    mutualCount: z.number().int().min(0).max(ANALYSIS_V2_RELATIONSHIP_SIDE_LIMIT),
    publicCount: z.number().int().min(0).max(ANALYSIS_V2_RELATIONSHIP_SIDE_LIMIT),
    privateCount: z.number().int().min(0).max(ANALYSIS_V2_RELATIONSHIP_SIDE_LIMIT),
    detailedPublicCount: z.number().int().min(0).max(900),
    unscreenedPublicCount: z.number().int().min(0).max(ANALYSIS_V2_RELATIONSHIP_SIDE_LIMIT),
}).strict().superRefine((value, context) => {
    if (
        value.publicCount + value.privateCount !== value.mutualCount
        || value.detailedPublicCount + value.unscreenedPublicCount !== value.publicCount
    ) {
        context.addIssue({
            code: 'custom',
            message: 'Relationship manifest counts are inconsistent.',
        });
    }
});

const canonicalRelationshipRowSchema = z.object({
    username: usernameSchema,
    isPrivate: z.boolean(),
    isVerified: z.boolean(),
    fullName: relationshipFullNameSchema.nullable(),
    profilePicUrl: relationshipProfilePicUrlSchema.nullable(),
}).strict();
const mutualRowSchema = canonicalRelationshipRowSchema.extend({
    mutualOrdinal: z.number().int().min(1).max(ANALYSIS_V2_RELATIONSHIP_SIDE_LIMIT),
    followingOrdinal: z.number().int().min(1).max(ANALYSIS_V2_RELATIONSHIP_SIDE_LIMIT),
    detailedOrdinal: z.number().int().min(1).max(900).nullable(),
}).strict();

const relationshipStagingSideSchema = relationshipSideManifestSchema.extend({
    provider: z.literal('apify').nullable(),
    providerRunId: z.string().regex(PROVIDER_RUN_ID_PATTERN).nullable(),
    providerOperationKey: z.string().max(128).nullable(),
    providerCredentialSlot: z.enum(['primary', 'secondary']).nullable(),
    rows: z.array(canonicalRelationshipRowSchema).max(ANALYSIS_V2_RELATIONSHIP_SIDE_LIMIT),
}).strict();

const relationshipSideSourceInputSchema = z.discriminatedUnion('status', [
    z.object({
        status: z.literal('collected'),
        inputHash: z.string().regex(SHA256_PATTERN),
        provider: z.literal('apify'),
        providerRunId: z.string().regex(PROVIDER_RUN_ID_PATTERN),
        providerOperationKey: z.string().max(128),
    }).strict(),
    z.object({
        status: z.literal('not_applicable'),
        inputHash: z.string().regex(SHA256_PATTERN),
    }).strict(),
]);

const detailedLimitSchema = z.union([
    z.literal(300),
    z.literal(600),
    z.literal(900),
]);

const relationshipStagingSnapshotSchema = z.object({
    requestId: z.string().regex(UUID_PATTERN),
    jobKey: z.string().regex(JOB_KEY_PATTERN),
    excludedUsername: usernameSchema.nullable(),
    detailedMutualLimit: detailedLimitSchema,
    manifest: relationshipDagManifestSchema,
    followers: relationshipStagingSideSchema,
    following: relationshipStagingSideSchema,
    mutualRows: z.array(mutualRowSchema).max(ANALYSIS_V2_RELATIONSHIP_SIDE_LIMIT),
    detailedPublicUsernames: z.array(usernameSchema).max(900),
    privateMutualUsernames: z.array(usernameSchema).max(ANALYSIS_V2_RELATIONSHIP_SIDE_LIMIT),
    privateMutualRows: z.array(mutualRowSchema).max(ANALYSIS_V2_RELATIONSHIP_SIDE_LIMIT),
}).strict();

const targetEvidenceRowInputSchema = z.object({
    actorUsername: usernameSchema,
    postId: z.string().regex(BOUNDED_SOURCE_ID_PATTERN),
    signal: z.enum(['target_post_like', 'target_post_comment']),
    sourceInteractionId: z.string().regex(BOUNDED_SOURCE_ID_PATTERN),
    occurredAt: z.string().datetime({ offset: true }).optional(),
    content: z.string().optional(),
}).strict();

const canonicalTargetEvidenceRowSchema = z.object({
    actorUsername: usernameSchema,
    postId: z.string().regex(BOUNDED_SOURCE_ID_PATTERN),
    signal: z.enum(['target_post_like', 'target_post_comment']),
    sourceInteractionId: z.string().regex(BOUNDED_SOURCE_ID_PATTERN),
    occurredAt: z.string().datetime({ offset: true }).nullable(),
    content: z.string().max(MAX_COMMENT_TEXT_LENGTH).nullable(),
}).strict();

const targetEvidenceCoverageSchema = z.object({
    postId: z.string().regex(BOUNDED_SOURCE_ID_PATTERN),
    declaredCount: z.number().int().min(0).max(10_000_000),
    returnedCount: z.number().int().min(0).max(150),
    requestedLimit: z.number().int().positive().max(150),
}).strict();

const canonicalTargetEvidenceSourceSchema = z.object({
    status: z.enum(['collected', 'not_applicable']),
    inputHash: z.string().regex(SHA256_PATTERN),
    provider: z.enum(['apify', 'coderx']).nullable(),
    providerRunId: z.string().regex(PROVIDER_RUN_ID_PATTERN).nullable(),
    providerOperationKey: z.string().max(87).nullable(),
    providerCredentialSlot: z.enum(['primary', 'secondary']).nullable(),
    coverage: z.array(targetEvidenceCoverageSchema).max(6),
}).strict();

const targetEvidenceDagManifestSchema = z.object({
    revision: z.number().int().min(1).max(32_767),
    resultHash: z.string().regex(SHA256_PATTERN),
    inputHash: z.string().regex(SHA256_PATTERN),
    interactorCount: z.number().int().min(0).max(ANALYSIS_V2_TARGET_EVIDENCE_LIMIT),
    likerCount: z.number().int().min(0).max(600),
    commentCount: z.number().int().min(0).max(90),
}).strict().superRefine((value, context) => {
    if (value.likerCount + value.commentCount !== value.interactorCount) {
        context.addIssue({
            code: 'custom',
            message: 'Target evidence manifest counts are inconsistent.',
        });
    }
});

const targetEvidenceStagingSnapshotSchema = z.object({
    requestId: z.string().regex(UUID_PATTERN),
    jobKey: z.string().regex(JOB_KEY_PATTERN),
    targetUsername: usernameSchema,
    excludedUsername: usernameSchema.nullable(),
    manifest: targetEvidenceDagManifestSchema,
    likerSource: canonicalTargetEvidenceSourceSchema,
    commentSource: canonicalTargetEvidenceSourceSchema,
    rows: z.array(canonicalTargetEvidenceRowSchema).max(ANALYSIS_V2_TARGET_EVIDENCE_LIMIT),
}).strict();

function sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function requiredHash(value: string, label: string): string {
    if (!SHA256_PATTERN.test(value)) {
        throw new Error(`ANALYSIS_V2_EVIDENCE_VALIDATION_ERROR: invalid ${label} hash.`);
    }
    return value;
}

function validateIdentity(input: Pick<AnalysisV2EvidenceJobClaim, 'requestId' | 'jobKey'>): void {
    if (!UUID_PATTERN.test(input.requestId) || !JOB_KEY_PATTERN.test(input.jobKey)) {
        throw new Error('ANALYSIS_V2_EVIDENCE_VALIDATION_ERROR: invalid job identity.');
    }
}

function validateClaim(input: AnalysisV2EvidenceJobClaim): void {
    validateIdentity(input);
    if (
        !UUID_PATTERN.test(input.claimToken)
        || !SHA256_PATTERN.test(input.jobInputHash)
    ) {
        throw new Error('ANALYSIS_V2_EVIDENCE_VALIDATION_ERROR: invalid job claim.');
    }
}

function validateFixedJob(
    input: AnalysisV2EvidenceJobClaim,
    expectedJobKey: typeof ANALYSIS_V2_RELATIONSHIPS_JOB_KEY
        | typeof ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY
): void {
    validateClaim(input);
    if (input.jobKey !== expectedJobKey) {
        throw new AnalysisV2EvidenceFenceError();
    }
}

function requiredSafeInteger(
    value: number,
    label: string,
    minimum: number,
    maximum: number
): number {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(`ANALYSIS_V2_EVIDENCE_VALIDATION_ERROR: invalid ${label}.`);
    }
    return value;
}

function canonicalRelationshipRows(
    input: readonly AnalysisV2RelationshipRowInput[]
): AnalysisV2CanonicalRelationshipRow[] {
    const parsed = z.array(relationshipRowInputSchema)
        .max(ANALYSIS_V2_RELATIONSHIP_SIDE_LIMIT)
        .parse(input);
    if (new Set(parsed.map(row => row.username)).size !== parsed.length) {
        throw new Error('ANALYSIS_V2_EVIDENCE_VALIDATION_ERROR: duplicate relationship username.');
    }
    return parsed;
}

function relationshipRowHashMaterial(
    rows: readonly AnalysisV2CanonicalRelationshipRow[]
): string {
    return rows.map((row, index) => [
        index + 1,
        lengthPrefixed(row.username),
        row.isPrivate ? 1 : 0,
        row.isVerified ? 1 : 0,
        lengthPrefixed(row.fullName ?? ''),
        lengthPrefixed(row.profilePicUrl ?? ''),
    ].join('|')).join('\n');
}

export function createAnalysisV2RelationshipResultHash(
    side: AnalysisV2RelationshipSide,
    inputRows: readonly AnalysisV2RelationshipRowInput[]
): string {
    const rows = canonicalRelationshipRows(inputRows);
    return sha256(
        `analysis-v2-relationship-result-v2\n${side}\n${relationshipRowHashMaterial(rows)}`
    );
}

export function createAnalysisV2RelationshipNotApplicableInputHash(
    side: AnalysisV2RelationshipSide
): string {
    const parsedSide = z.enum(['followers', 'following']).parse(side);
    return sha256(`analysis-v2-relationship-not-applicable-v1\n${parsedSide}\n0`);
}

export function deriveAnalysisV2MutualRows(input: {
    followers: readonly AnalysisV2RelationshipRowInput[];
    following: readonly AnalysisV2RelationshipRowInput[];
    excludedUsername: string | null;
    detailedMutualLimit: AnalysisV2DetailedMutualLimit;
}): AnalysisV2MutualStagingRow[] {
    const followers = canonicalRelationshipRows(input.followers);
    const following = canonicalRelationshipRows(input.following);
    const excluded = input.excludedUsername === null
        ? null
        : usernameSchema.parse(input.excludedUsername);
    const detailedLimit = detailedLimitSchema.parse(input.detailedMutualLimit);
    const followerByUsername = new Map(followers.map(row => [row.username, row]));
    let detailedOrdinal = 0;

    return following.flatMap((row, followingIndex): AnalysisV2MutualStagingRow[] => {
        const follower = followerByUsername.get(row.username);
        if (!follower || row.username === excluded) return [];
        const isDetailed = !row.isPrivate && detailedOrdinal < detailedLimit;
        if (isDetailed) detailedOrdinal += 1;
        return [{
            ...row,
            fullName: row.fullName ?? follower.fullName,
            profilePicUrl: row.profilePicUrl ?? follower.profilePicUrl,
            mutualOrdinal: 0,
            followingOrdinal: followingIndex + 1,
            detailedOrdinal: isDetailed ? detailedOrdinal : null,
        }];
    }).map((row, index) => ({ ...row, mutualOrdinal: index + 1 }));
}

function createAnalysisV2ExclusionDecisionHash(excludedUsername: string | null): string {
    return sha256(
        `analysis-v2-girlfriend-exclusion-v1\n${excludedUsername === null
            ? 'skip'
            : `exclude:${excludedUsername}`}`
    );
}

function relationshipFreezeRowHashMaterial(
    rows: readonly AnalysisV2MutualStagingRow[]
): string {
    return rows.map(row => [
        row.mutualOrdinal,
        row.followingOrdinal,
        lengthPrefixed(row.username),
        row.isPrivate ? 1 : 0,
        row.isVerified ? 1 : 0,
        lengthPrefixed(row.fullName ?? ''),
        lengthPrefixed(row.profilePicUrl ?? ''),
        row.detailedOrdinal ?? '',
    ].join('|')).join('\n');
}

function createAnalysisV2RelationshipFreezeHash(input: {
    followersResultHash: string;
    followingResultHash: string;
    exclusionDecisionHash: string;
    detailedMutualLimit: AnalysisV2DetailedMutualLimit;
    mutualRows: readonly AnalysisV2MutualStagingRow[];
}): string {
    return sha256([
        'analysis-v2-relationship-freeze-v2',
        input.followersResultHash,
        input.followingResultHash,
        input.exclusionDecisionHash,
        input.detailedMutualLimit,
        relationshipFreezeRowHashMaterial(input.mutualRows),
    ].join('\n'));
}

function sanitizeCommentText(value: string): string | null {
    const normalized = value
        .normalize('NFKC')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/<[^>]*>/g, '')
        .replace(/[<>]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!normalized) return null;

    let result = '';
    for (const character of normalized) {
        if (result.length + character.length > MAX_COMMENT_TEXT_LENGTH) break;
        result += character;
    }
    return result || null;
}

export function canonicalizeAnalysisV2TargetEvidenceRows(input: {
    rows: readonly AnalysisV2TargetEvidenceRowInput[];
    targetUsername: string;
    excludedUsername: string | null;
}): AnalysisV2CanonicalTargetEvidenceRow[] {
    const targetUsername = usernameSchema.parse(input.targetUsername);
    const excludedUsername = input.excludedUsername === null
        ? null
        : usernameSchema.parse(input.excludedUsername);
    if (targetUsername === excludedUsername) {
        throw new Error('ANALYSIS_V2_EVIDENCE_VALIDATION_ERROR: invalid exclusion username.');
    }

    const excluded = new Set([
        targetUsername,
        ...(excludedUsername ? [excludedUsername] : []),
    ]);
    const parsed = z.array(targetEvidenceRowInputSchema)
        .max(ANALYSIS_V2_TARGET_EVIDENCE_LIMIT)
        .parse(input.rows)
        .filter(row => !excluded.has(row.actorUsername))
        .map((row): AnalysisV2CanonicalTargetEvidenceRow => {
            if (row.signal === 'target_post_like' && row.content !== undefined) {
                throw new Error(
                    'ANALYSIS_V2_EVIDENCE_VALIDATION_ERROR: liker evidence cannot contain text.'
                );
            }
            return {
                actorUsername: row.actorUsername,
                postId: row.postId,
                signal: row.signal,
                sourceInteractionId: row.sourceInteractionId,
                occurredAt: row.occurredAt ?? null,
                content: row.signal === 'target_post_comment'
                    ? sanitizeCommentText(row.content ?? '')
                    : null,
            };
        });

    if (parsed.length > ANALYSIS_V2_TARGET_EVIDENCE_LIMIT) {
        throw new Error('ANALYSIS_V2_EVIDENCE_VALIDATION_ERROR: target evidence overflow.');
    }

    const sourceKeys = parsed.map(row => `${row.signal}\u0000${row.sourceInteractionId}`);
    if (new Set(sourceKeys).size !== sourceKeys.length) {
        throw new Error('ANALYSIS_V2_EVIDENCE_VALIDATION_ERROR: duplicate source interaction.');
    }

    for (const [signal, postLimit, rowLimit] of [
        [
            'target_post_like',
            ANALYSIS_V2_TARGET_LIKER_POST_LIMIT,
            ANALYSIS_V2_TARGET_LIKER_PER_POST_LIMIT,
        ],
        [
            'target_post_comment',
            ANALYSIS_V2_TARGET_COMMENT_POST_LIMIT,
            ANALYSIS_V2_TARGET_COMMENT_PER_POST_LIMIT,
        ],
    ] as const) {
        const rows = parsed.filter(row => row.signal === signal);
        const postCounts = new Map<string, number>();
        rows.forEach((row) => {
            postCounts.set(row.postId, (postCounts.get(row.postId) ?? 0) + 1);
        });
        if (
            postCounts.size > postLimit
            || [...postCounts.values()].some(count => count > rowLimit)
        ) {
            throw new Error(
                `ANALYSIS_V2_EVIDENCE_VALIDATION_ERROR: ${signal} scope overflow.`
            );
        }
    }

    return parsed;
}

const collectedTargetEvidenceSourceInputSchema = z.object({
    status: z.literal('collected'),
    inputHash: z.string().regex(SHA256_PATTERN),
    provider: z.enum(['apify', 'coderx']),
    providerRunId: z.string().regex(PROVIDER_RUN_ID_PATTERN),
    providerOperationKey: z.string().max(87),
    providerCredentialSlot: z.enum(['primary', 'secondary']),
    coverage: z.array(targetEvidenceCoverageSchema).max(6),
}).strict();

const targetEvidenceSourceInputSchema = z.discriminatedUnion('status', [
    collectedTargetEvidenceSourceInputSchema,
    z.object({
        status: z.literal('not_applicable'),
        inputHash: z.string().regex(SHA256_PATTERN),
    }).strict(),
]);

export function canonicalizeAnalysisV2TargetEvidenceSource(
    signal: AnalysisV2TargetEvidenceSignal,
    input: AnalysisV2TargetEvidenceSourceInput
): AnalysisV2CanonicalTargetEvidenceSource {
    const parsed = targetEvidenceSourceInputSchema.parse(input);
    if (parsed.status === 'not_applicable') {
        return {
            status: parsed.status,
            inputHash: parsed.inputHash,
            provider: null,
            providerRunId: null,
            providerOperationKey: null,
            providerCredentialSlot: null,
            coverage: [],
        };
    }

    const kind = signal === 'target_post_like' ? 'target-likers' : 'target-comments';
    const postLimit = signal === 'target_post_like'
        ? ANALYSIS_V2_TARGET_LIKER_POST_LIMIT
        : ANALYSIS_V2_TARGET_COMMENT_POST_LIMIT;
    const requestedLimit = signal === 'target_post_like'
        ? ANALYSIS_V2_TARGET_LIKER_PER_POST_LIMIT
        : ANALYSIS_V2_TARGET_COMMENT_PER_POST_LIMIT;
    if (
        !new RegExp(`^${kind}:[0-9a-f]{64}$`).test(parsed.providerOperationKey)
        || parsed.coverage.length < 1
        || parsed.coverage.length > postLimit
        || new Set(parsed.coverage.map(row => row.postId)).size !== parsed.coverage.length
        || parsed.coverage.some(row => (
            row.requestedLimit !== requestedLimit
            || row.returnedCount > row.requestedLimit
        ))
    ) {
        throw new Error('ANALYSIS_V2_EVIDENCE_VALIDATION_ERROR: invalid target provider coverage.');
    }

    return {
        ...parsed,
        coverage: parsed.coverage.map(row => ({ ...row })),
    };
}

function validateEvidenceAgainstSource(
    signal: AnalysisV2TargetEvidenceSignal,
    rows: readonly AnalysisV2CanonicalTargetEvidenceRow[],
    source: AnalysisV2CanonicalTargetEvidenceSource
): void {
    const signalRows = rows.filter(row => row.signal === signal);
    if (source.status === 'not_applicable') {
        if (signalRows.length !== 0) {
            throw new Error(
                'ANALYSIS_V2_EVIDENCE_VALIDATION_ERROR: evidence has no collected provider source.'
            );
        }
        return;
    }

    const coverageByPost = new Map(source.coverage.map(row => [row.postId, row]));
    if (
        signalRows.some(row => !coverageByPost.has(row.postId))
        || signalRows.length > source.coverage.reduce(
            (total, coverage) => total + coverage.returnedCount,
            0
        )
    ) {
        throw new Error(
            'ANALYSIS_V2_EVIDENCE_VALIDATION_ERROR: target evidence exceeds provider coverage.'
        );
    }
}

function lengthPrefixed(value: string): string {
    return `${Buffer.byteLength(value, 'utf8')}:${value}`;
}

function targetEvidenceHashMaterial(
    rows: readonly AnalysisV2CanonicalTargetEvidenceRow[]
): string {
    return rows.map((row, index) => [
        index + 1,
        row.signal,
        lengthPrefixed(row.postId),
        lengthPrefixed(row.sourceInteractionId),
        lengthPrefixed(row.actorUsername),
        lengthPrefixed(row.occurredAt ?? ''),
        lengthPrefixed(row.content ?? ''),
    ].join('|')).join('\n');
}

function targetEvidenceSourceHashMaterial(
    signal: AnalysisV2TargetEvidenceSignal,
    source: AnalysisV2CanonicalTargetEvidenceSource
): string {
    return [
        signal,
        source.status,
        source.inputHash,
        lengthPrefixed(source.provider ?? ''),
        lengthPrefixed(source.providerRunId ?? ''),
        lengthPrefixed(source.providerOperationKey ?? ''),
        lengthPrefixed(source.providerCredentialSlot ?? ''),
        ...source.coverage.map((row, index) => [
            index + 1,
            lengthPrefixed(row.postId),
            row.declaredCount,
            row.returnedCount,
            row.requestedLimit,
        ].join('|')),
    ].join('\n');
}

export function createAnalysisV2TargetEvidenceSourceHash(
    signal: AnalysisV2TargetEvidenceSignal,
    source: AnalysisV2CanonicalTargetEvidenceSource
): string {
    const parsed = canonicalTargetEvidenceSourceSchema.parse(source);
    return sha256(
        `analysis-v2-target-evidence-source-v1\n${targetEvidenceSourceHashMaterial(signal, parsed)}`
    );
}

export function createAnalysisV2TargetEvidenceResultHash(
    rows: readonly AnalysisV2CanonicalTargetEvidenceRow[],
    sources: Readonly<{
        likerSource: AnalysisV2CanonicalTargetEvidenceSource;
        commentSource: AnalysisV2CanonicalTargetEvidenceSource;
    }>
): string {
    const parsed = z.array(canonicalTargetEvidenceRowSchema)
        .max(ANALYSIS_V2_TARGET_EVIDENCE_LIMIT)
        .parse(rows);
    const rowsHash = sha256(
        `analysis-v2-target-evidence-rows-v2\n${targetEvidenceHashMaterial(parsed)}`
    );
    const likerSourceHash = createAnalysisV2TargetEvidenceSourceHash(
        'target_post_like',
        sources.likerSource
    );
    const commentSourceHash = createAnalysisV2TargetEvidenceSourceHash(
        'target_post_comment',
        sources.commentSource
    );
    return sha256(
        [
            'analysis-v2-target-evidence-result-v2',
            rowsHash,
            likerSourceHash,
            commentSourceHash,
        ].join('\n')
    );
}

function relationshipRowsForDatabase(
    rows: readonly AnalysisV2CanonicalRelationshipRow[]
): Record<string, unknown>[] {
    return rows.map(row => ({
        username: row.username,
        is_private: row.isPrivate,
        is_verified: row.isVerified,
        full_name: row.fullName,
        profile_pic_url: row.profilePicUrl,
    }));
}

function targetRowsForDatabase(
    rows: readonly AnalysisV2CanonicalTargetEvidenceRow[]
): Record<string, unknown>[] {
    return rows.map(row => ({
        actor_username: row.actorUsername,
        post_id: row.postId,
        signal: row.signal,
        source_interaction_id: row.sourceInteractionId,
        occurred_at: row.occurredAt,
        content: row.content,
    }));
}

function targetSourceForDatabase(
    source: AnalysisV2CanonicalTargetEvidenceSource
): Record<string, unknown> {
    return {
        status: source.status,
        input_hash: source.inputHash,
        provider: source.provider,
        provider_run_id: source.providerRunId,
        provider_operation_key: source.providerOperationKey,
        provider_credential_slot: source.providerCredentialSlot,
        coverage: source.coverage.map(row => ({
            post_id: row.postId,
            declared_count: row.declaredCount,
            returned_count: row.returnedCount,
            requested_limit: row.requestedLimit,
        })),
    };
}

function safeRpcCode(error: RpcError): string {
    return typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : 'unknown';
}

function throwRpcError(error: RpcError, operation: string): never {
    if (error.message === 'ANALYSIS_V2_EVIDENCE_FENCE_MISMATCH') {
        throw new AnalysisV2EvidenceFenceError();
    }
    if (error.message === 'ANALYSIS_V2_RELATIONSHIP_INCOMPLETE') {
        throw new AnalysisV2RelationshipIncompleteError();
    }
    if (
        error.message === 'ANALYSIS_V2_RELATIONSHIP_SIDE_CONFLICT'
        || error.message === 'ANALYSIS_V2_RELATIONSHIP_FREEZE_CONFLICT'
        || error.message === 'ANALYSIS_V2_TARGET_EVIDENCE_CONFLICT'
    ) {
        throw new AnalysisV2EvidenceConflictError(error.message);
    }
    if (
        error.message === 'ANALYSIS_V2_EVIDENCE_INVALID'
        || error.message === 'ANALYSIS_V2_EVIDENCE_NOT_ACTIVE'
        || error.message === 'ANALYSIS_V2_RELATIONSHIP_NOT_READY'
    ) {
        throw new Error(error.message);
    }
    throw new Error(
        `ANALYSIS_V2_EVIDENCE_PERSISTENCE_ERROR: ${operation} failed (${safeRpcCode(error)}).`
    );
}

function parseResponse<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
    const candidate = Array.isArray(data) && data.length === 1 ? data[0] : data;
    const parsed = schema.safeParse(candidate);
    if (!parsed.success) {
        throw new Error(`ANALYSIS_V2_EVIDENCE_PERSISTENCE_ERROR: invalid ${label} response.`);
    }
    return parsed.data;
}

function relationshipOperationKey(
    side: AnalysisV2RelationshipSide,
    operationKey: string
): string {
    const pattern = new RegExp(`^relationship-${side}:[0-9a-f]{64}$`);
    if (!pattern.test(operationKey)) {
        throw new Error(
            'ANALYSIS_V2_EVIDENCE_VALIDATION_ERROR: invalid provider operation key.'
        );
    }
    return operationKey;
}

function persistenceDrift(label: string): never {
    throw new Error(`ANALYSIS_V2_EVIDENCE_PERSISTENCE_ERROR: ${label} drift.`);
}

function assertRelationshipSnapshotIntegrity(
    snapshot: AnalysisV2RelationshipStagingSnapshot
): void {
    for (const side of ['followers', 'following'] as const) {
        const staged = snapshot[side];
        const expectedCoverage = staged.declaredCount === 0
            ? 10_000
            : Math.floor(staged.rows.length * 10_000 / staged.declaredCount);
        const isNotApplicable = staged.sourceStatus === 'not_applicable';
        if (isNotApplicable) {
            if (
                staged.declaredCount !== 0
                || staged.rows.length !== 0
                || staged.inputHash !== createAnalysisV2RelationshipNotApplicableInputHash(side)
                || staged.provider !== null
                || staged.providerRunId !== null
                || staged.providerOperationKey !== null
                || staged.providerCredentialSlot !== null
            ) {
                persistenceDrift(`${side} relationship source`);
            }
        } else {
            if (
                staged.declaredCount === 0
                || staged.provider !== 'apify'
                || staged.providerRunId === null
                || staged.providerOperationKey === null
                || staged.providerCredentialSlot === null
            ) {
                persistenceDrift(`${side} relationship source`);
            }
            relationshipOperationKey(side, staged.providerOperationKey);
        }
        if (
            staged.collectedCount !== staged.rows.length
            || staged.coverageBps !== expectedCoverage
            || staged.resultHash !== createAnalysisV2RelationshipResultHash(side, staged.rows)
        ) {
            persistenceDrift(`${side} relationship staging`);
        }
    }

    const expectedMutualRows = deriveAnalysisV2MutualRows({
        followers: snapshot.followers.rows,
        following: snapshot.following.rows,
        excludedUsername: snapshot.excludedUsername,
        detailedMutualLimit: snapshot.detailedMutualLimit,
    });
    const expectedPrivateRows = expectedMutualRows.filter(row => row.isPrivate);
    const expectedDetailedUsernames = expectedMutualRows
        .filter(row => row.detailedOrdinal !== null)
        .map(row => row.username);
    const exclusionDecisionHash = createAnalysisV2ExclusionDecisionHash(
        snapshot.excludedUsername
    );
    const publicCount = expectedMutualRows.filter(row => !row.isPrivate).length;
    const detailedPublicCount = expectedDetailedUsernames.length;
    if (
        JSON.stringify(snapshot.mutualRows) !== JSON.stringify(expectedMutualRows)
        || JSON.stringify(snapshot.privateMutualRows) !== JSON.stringify(expectedPrivateRows)
        || JSON.stringify(snapshot.privateMutualUsernames)
            !== JSON.stringify(expectedPrivateRows.map(row => row.username))
        || JSON.stringify(snapshot.detailedPublicUsernames)
            !== JSON.stringify(expectedDetailedUsernames)
        || snapshot.manifest.exclusionDecisionHash !== exclusionDecisionHash
        || snapshot.manifest.followersResultHash !== snapshot.followers.resultHash
        || snapshot.manifest.followingResultHash !== snapshot.following.resultHash
        || snapshot.manifest.mutualCount !== expectedMutualRows.length
        || snapshot.manifest.publicCount !== publicCount
        || snapshot.manifest.privateCount !== expectedPrivateRows.length
        || snapshot.manifest.detailedPublicCount !== detailedPublicCount
        || snapshot.manifest.unscreenedPublicCount !== publicCount - detailedPublicCount
        || snapshot.manifest.resultHash !== createAnalysisV2RelationshipFreezeHash({
            followersResultHash: snapshot.followers.resultHash,
            followingResultHash: snapshot.following.resultHash,
            exclusionDecisionHash,
            detailedMutualLimit: snapshot.detailedMutualLimit,
            mutualRows: expectedMutualRows,
        })
    ) {
        persistenceDrift('relationship staging');
    }
}

function sourceInputFromCanonical(
    source: AnalysisV2CanonicalTargetEvidenceSource
): AnalysisV2TargetEvidenceSourceInput {
    if (source.status === 'not_applicable') {
        return { status: source.status, inputHash: source.inputHash };
    }
    if (
        source.provider === null
        || source.providerRunId === null
        || source.providerOperationKey === null
        || source.providerCredentialSlot === null
    ) {
        persistenceDrift('target provider source');
    }
    return {
        status: source.status,
        inputHash: source.inputHash,
        provider: source.provider,
        providerRunId: source.providerRunId,
        providerOperationKey: source.providerOperationKey,
        providerCredentialSlot: source.providerCredentialSlot,
        coverage: source.coverage,
    };
}

function assertTargetSnapshotIntegrity(snapshot: AnalysisV2TargetEvidenceStagingSnapshot): void {
    const likerSource = canonicalizeAnalysisV2TargetEvidenceSource(
        'target_post_like',
        sourceInputFromCanonical(snapshot.likerSource)
    );
    const commentSource = canonicalizeAnalysisV2TargetEvidenceSource(
        'target_post_comment',
        sourceInputFromCanonical(snapshot.commentSource)
    );
    validateEvidenceAgainstSource('target_post_like', snapshot.rows, likerSource);
    validateEvidenceAgainstSource('target_post_comment', snapshot.rows, commentSource);
    const likerCount = snapshot.rows.filter(row => row.signal === 'target_post_like').length;
    const commentCount = snapshot.rows.length - likerCount;
    if (
        snapshot.manifest.interactorCount !== snapshot.rows.length
        || snapshot.manifest.likerCount !== likerCount
        || snapshot.manifest.commentCount !== commentCount
        || snapshot.manifest.resultHash !== createAnalysisV2TargetEvidenceResultHash(
            snapshot.rows,
            { likerSource, commentSource }
        )
    ) {
        persistenceDrift('target evidence staging');
    }
}

export function createAnalysisV2EvidenceStore(
    client: AnalysisV2EvidenceSupabaseClient = supabaseAdmin
): AnalysisV2EvidenceStore {
    return {
        async checkpointRelationshipSide(input) {
            validateFixedJob(input, ANALYSIS_V2_RELATIONSHIPS_JOB_KEY);
            const side = z.enum(['followers', 'following']).parse(input.side);
            const declaredCount = requiredSafeInteger(
                input.declaredCount,
                'declared relationship count',
                0,
                ANALYSIS_V2_RELATIONSHIP_SIDE_LIMIT
            );
            const rows = canonicalRelationshipRows(input.rows);
            const minimum = Math.ceil(declaredCount * 0.99);
            const source = relationshipSideSourceInputSchema.parse(input.source);
            const inputHash = requiredHash(source.inputHash, 'relationship input');
            if (source.status === 'not_applicable') {
                if (
                    declaredCount !== 0
                    || rows.length !== 0
                    || inputHash !== createAnalysisV2RelationshipNotApplicableInputHash(side)
                ) {
                    throw new AnalysisV2RelationshipIncompleteError();
                }
            } else if (
                declaredCount === 0
                || rows.length > declaredCount
                || rows.length < minimum
            ) {
                throw new AnalysisV2RelationshipIncompleteError();
            }
            const resultHash = createAnalysisV2RelationshipResultHash(side, rows);
            const providerOperationKey = source.status === 'collected'
                ? relationshipOperationKey(side, source.providerOperationKey)
                : null;

            const { data, error } = source.status === 'not_applicable'
                ? await client.rpc(
                    ANALYSIS_V2_EVIDENCE_DATABASE_NAMES
                        .checkpointRelationshipNotApplicableRpc,
                    {
                        p_request_id: input.requestId.toLowerCase(),
                        p_job_key: input.jobKey,
                        p_claim_token: input.claimToken.toLowerCase(),
                        p_job_input_hash: input.jobInputHash,
                        p_side: side,
                    }
                )
                : await client.rpc(
                    ANALYSIS_V2_EVIDENCE_DATABASE_NAMES.checkpointRelationshipSideRpc,
                    {
                    p_request_id: input.requestId.toLowerCase(),
                    p_job_key: input.jobKey,
                    p_claim_token: input.claimToken.toLowerCase(),
                    p_job_input_hash: input.jobInputHash,
                    p_side: side,
                    p_declared_count: declaredCount,
                    p_input_hash: inputHash,
                    p_result_hash: resultHash,
                    p_provider: source.provider,
                    p_provider_run_id: source.providerRunId,
                    p_provider_operation_key: providerOperationKey,
                    p_rows: relationshipRowsForDatabase(rows),
                    }
                );
            if (error) throwRpcError(error, 'relationship side checkpoint');
            const result = parseResponse(
                relationshipSideManifestSchema,
                data,
                'relationship side checkpoint'
            );
            if (
                result.side !== side
                || result.sourceStatus !== source.status
                || result.declaredCount !== declaredCount
                || result.collectedCount !== rows.length
                || result.coverageBps !== (declaredCount === 0
                    ? 10_000
                    : Math.floor(rows.length * 10_000 / declaredCount))
                || result.inputHash !== inputHash
                || result.resultHash !== resultHash
            ) {
                throw new Error(
                    'ANALYSIS_V2_EVIDENCE_PERSISTENCE_ERROR: relationship checkpoint drift.'
                );
            }
            return result;
        },

        async freezeRelationships(input) {
            validateFixedJob(input, ANALYSIS_V2_RELATIONSHIPS_JOB_KEY);
            const detailedMutualLimit = detailedLimitSchema.parse(input.detailedMutualLimit);
            const { data, error } = await client.rpc(
                ANALYSIS_V2_EVIDENCE_DATABASE_NAMES.freezeRelationshipsRpc,
                {
                    p_request_id: input.requestId.toLowerCase(),
                    p_job_key: input.jobKey,
                    p_claim_token: input.claimToken.toLowerCase(),
                    p_job_input_hash: input.jobInputHash,
                    p_detailed_mutual_limit: detailedMutualLimit,
                }
            );
            if (error) throwRpcError(error, 'relationship freeze');
            const result = parseResponse(
                relationshipDagManifestSchema,
                data,
                'relationship freeze'
            );
            if (result.detailedPublicCount > detailedMutualLimit) {
                throw new Error(
                    'ANALYSIS_V2_EVIDENCE_PERSISTENCE_ERROR: detailed relationship overflow.'
                );
            }
            return result;
        },

        async loadRelationshipStaging(input) {
            validateIdentity(input);
            const { data, error } = await client.rpc(
                ANALYSIS_V2_EVIDENCE_DATABASE_NAMES.loadRelationshipStagingRpc,
                {
                    p_request_id: input.requestId.toLowerCase(),
                    p_job_key: input.jobKey,
                }
            );
            if (error) throwRpcError(error, 'relationship staging load');
            if (data === null) return null;
            const snapshot = parseResponse(
                relationshipStagingSnapshotSchema,
                data,
                'relationship staging load'
            );
            assertRelationshipSnapshotIntegrity(snapshot);
            return snapshot;
        },

        async checkpointTargetEvidence(input) {
            validateFixedJob(input, ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY);
            const targetUsername = usernameSchema.parse(input.targetUsername);
            const excludedUsername = input.excludedUsername === null
                ? null
                : usernameSchema.parse(input.excludedUsername);
            const inputHash = requiredHash(input.inputHash, 'target evidence input');
            const rows = canonicalizeAnalysisV2TargetEvidenceRows({
                rows: input.rows,
                targetUsername,
                excludedUsername,
            });
            const likerSource = canonicalizeAnalysisV2TargetEvidenceSource(
                'target_post_like',
                input.likerSource
            );
            const commentSource = canonicalizeAnalysisV2TargetEvidenceSource(
                'target_post_comment',
                input.commentSource
            );
            validateEvidenceAgainstSource('target_post_like', rows, likerSource);
            validateEvidenceAgainstSource('target_post_comment', rows, commentSource);
            const resultHash = createAnalysisV2TargetEvidenceResultHash(rows, {
                likerSource,
                commentSource,
            });
            const { data, error } = await client.rpc(
                ANALYSIS_V2_EVIDENCE_DATABASE_NAMES.checkpointTargetEvidenceRpc,
                {
                    p_request_id: input.requestId.toLowerCase(),
                    p_job_key: input.jobKey,
                    p_claim_token: input.claimToken.toLowerCase(),
                    p_job_input_hash: input.jobInputHash,
                    p_target_username: targetUsername,
                    p_excluded_username: excludedUsername,
                    p_input_hash: inputHash,
                    p_result_hash: resultHash,
                    p_liker_source: targetSourceForDatabase(likerSource),
                    p_comment_source: targetSourceForDatabase(commentSource),
                    p_rows: targetRowsForDatabase(rows),
                }
            );
            if (error) throwRpcError(error, 'target evidence checkpoint');
            const result = parseResponse(
                targetEvidenceDagManifestSchema,
                data,
                'target evidence checkpoint'
            );
            if (
                result.inputHash !== inputHash
                || result.resultHash !== resultHash
                || result.interactorCount !== rows.length
                || result.likerCount !== rows.filter(
                    row => row.signal === 'target_post_like'
                ).length
                || result.commentCount !== rows.filter(
                    row => row.signal === 'target_post_comment'
                ).length
            ) {
                throw new Error(
                    'ANALYSIS_V2_EVIDENCE_PERSISTENCE_ERROR: target evidence checkpoint drift.'
                );
            }
            return result;
        },

        async loadTargetEvidence(input) {
            validateIdentity(input);
            const { data, error } = await client.rpc(
                ANALYSIS_V2_EVIDENCE_DATABASE_NAMES.loadTargetEvidenceRpc,
                {
                    p_request_id: input.requestId.toLowerCase(),
                    p_job_key: input.jobKey,
                }
            );
            if (error) throwRpcError(error, 'target evidence staging load');
            if (data === null) return null;
            const snapshot = parseResponse(
                targetEvidenceStagingSnapshotSchema,
                data,
                'target evidence staging load'
            );
            assertTargetSnapshotIntegrity(snapshot);
            return snapshot;
        },
    };
}

export const analysisV2EvidenceStore = createAnalysisV2EvidenceStore();
