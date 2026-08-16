import { createHash } from 'node:crypto';
import type { InstagramPost, InstagramProfile } from '@/lib/types/instagram';
import type { PrivateNameAnalysisResult } from '@/lib/services/ai/private-name-analysis';
import {
    buildCanonicalConciergeResult,
    validateCanonicalConciergeCorrection,
    type ConciergeLegacyResultRow,
    type ConciergePrivateAccountRow,
} from './concierge-basic-correction';
import type {
    RawTargetInteractionEvidence,
} from './v2-target-interactions';
import type { InteractionEvidenceRow, StoredInteractionCoverage } from './interaction-stage';
import type { ReverseLikeStatus } from '@/lib/domain/analysis/risk-policy';
import type { ReplayAccountAiDetail } from './replay/replay-runner';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    applyConciergeManualClassificationImport,
    createConciergeClassificationLedgerHash,
    type ConciergeClassificationLedger,
    type ConciergeManualClassificationImport,
} from './concierge-classification-import';

const HASH_PATTERN = /^[a-f0-9]{64}$/;

type ConciergeInteractionCollectionStatus = 'collected' | 'not_collected' | 'failed';

/**
 * Durable interaction evidence is retained as lineage, while the PR403
 * canonical result builder consumes its target-only mention contract.
 */
interface ConciergeBidirectionalInteractionEvidence {
    targetToCandidate: {
        status: ConciergeInteractionCollectionStatus;
        evidence: readonly RawTargetInteractionEvidence[];
        observedUsernames: readonly string[];
        likerCoverage: readonly StoredInteractionCoverage[];
        commentCoverage: readonly StoredInteractionCoverage[];
    };
    candidateToTarget: {
        status: ConciergeInteractionCollectionStatus;
        evidence: readonly InteractionEvidenceRow[];
        coverage: readonly StoredInteractionCoverage[];
    };
    targetPosts: readonly InstagramPost[];
    candidatePostsByUsername: ReadonlyMap<string, readonly InstagramPost[]>;
    reverseLikeStatusByUsername: ReadonlyMap<string, ReverseLikeStatus | 'failed'>;
    targetInputHash: string;
    candidateInputHash: string;
    reverseLikeInputHash: string;
    coverageHash: string;
}

export class ConciergePublicationError extends Error {
    readonly code: string;

    constructor(code: string) {
        super(code);
        this.name = 'ConciergePublicationError';
        this.code = code;
    }
}

export interface ConciergeStoredReplayFeatures {
    profilesByOrdinal: ReadonlyMap<number, InstagramProfile>;
    details: readonly ReplayAccountAiDetail[];
    orderedMutualUsernames: readonly string[];
    targetInteractions: readonly RawTargetInteractionEvidence[];
    /** Exact frozen target/candidate evidence and collection status; no provider recollection occurs here. */
    bidirectionalInteractions: ConciergeBidirectionalInteractionEvidence;
    classificationByOrdinal: ReadonlyMap<number, {
        originalAiClassification: 'male' | 'female' | 'unknown';
        confidence: 'low' | 'medium' | 'high';
        classifier: string;
        modelName: string;
        promptVersion: string;
        schemaVersion: string;
        classificationOperationKey: string;
        classificationResultHash: string;
        secondPassStatus: 'collected' | 'not_collected' | 'failed' | 'not_applicable';
        secondPassCompleteMedia: boolean | null;
    }>;
    privateProfiles: readonly InstagramProfile[];
    /** Exact text-only private-name analysis output for every frozen private mutual. */
    privateNameResults: readonly PrivateNameAnalysisResult[];
    fetchedCount: number;
    hydratedPublicCount: number;
    hydratedPrivateCount: number;
    analyzedPublicCount: number;
    unresolvedCount: number;
}

export interface ConciergePublicationState {
    version: number;
    resultHash: string | null;
    resultUrl: string;
}

export interface ConciergeManualPublicationInput {
    orderId: string;
    requestId: string;
    /** The result pointer must remain exactly this request. */
    resultRequestId: string;
    ownerId: string;
    targetUsername: string;
    targetInputHash: string;
    sourceRequestId: string;
    replayLineageHash: string;
    relationshipManifestHash: string;
    /** Counts are supplied by the exact frozen relationship manifest, never inferred from a result projection. */
    expectedMutualCount: number;
    expectedHydratedCount: number;
    expectedVersion: number;
    expectedResultHash: string | null;
    currentPublication: ConciergePublicationState;
    ledger: ConciergeClassificationLedger;
    manualImport: ConciergeManualClassificationImport;
    replay: ConciergeStoredReplayFeatures;
}

export interface ConciergeCanonicalPublication {
    sourceRequestId: string;
    requestId: string;
    targetInputHash: string;
    replayLineageHash: string;
    relationshipManifestHash: string;
    ledgerHash: string;
    interactionLineageHash: string;
    interactionLineage: unknown;
    resultHash: string;
    resultUrl: string;
    rows: readonly ConciergeLegacyResultRow[];
    privateRows: readonly ConciergePrivateAccountRow[];
    counts: {
        male: number;
        female: number;
        unknown: number;
        public: number;
        private: number;
        unresolved: number;
        mutual: number;
        authoritativeMutual: number;
        hydrated: number;
        analyzed: number;
    };
}

export interface ConciergePublicationStore {
    /** Implementations must perform all guards and projection writes in one DB transaction/RPC. */
    publishAtomic(input: {
        publication: ConciergeCanonicalPublication;
        expectedVersion: number;
        expectedResultHash: string | null;
        orderId: string;
        requestId: string;
        ownerId: string;
        targetUsername: string;
        classificationLedger: ConciergeClassificationLedger;
        manualImport: ConciergeManualClassificationImport;
    }): Promise<{ published: true; idempotent: boolean }>;
}

/**
 * Narrow adapter boundary for the service-role RPC.  The Supabase client is
 * deliberately not imported here: callers inject the already-authenticated
 * service-role RPC and this module never reads environment variables or logs
 * arguments.  The RPC owns the transaction, owner/payment/read-contract
 * guards, and expected-version/hash compare-and-swap.
 */
export type ConciergePublicationRpc = (args: Readonly<Record<string, unknown>>) => Promise<{
    data: unknown;
    error: { code?: string | null; message?: string | null } | null;
}>;

export interface ConciergePublicationSupabaseClient {
    rpc(
        name: string,
        args: Readonly<Record<string, unknown>>,
    ): PromiseLike<{
        data: unknown;
        error: { code?: string | null; message?: string | null } | null;
    }>;
}

export const CONCIERGE_BATCH_PUBLICATION_RPC = 'publish_concierge_batch_manual_override';

function privateReadContractRows(rows: readonly ConciergePrivateAccountRow[]): readonly {
    sortOrdinal: number;
    instagramId: string;
    profileImage: string | null;
    fullName: string | null;
    nameFemaleScore: number;
    nameIsName: boolean;
    nameConfidence: number;
}[] {
    return rows.map(row => ({
        sortOrdinal: row.sort_ordinal,
        instagramId: row.instagram_id,
        profileImage: row.profile_image,
        fullName: row.full_name,
        nameFemaleScore: row.name_female_score,
        nameIsName: row.name_is_name,
        nameConfidence: row.name_confidence,
    }));
}

function privateReadContractMatches(
    actual: unknown,
    expected: readonly ReturnType<typeof privateReadContractRows>[number][],
): boolean {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return actual.every((value, index) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const row = value as Record<string, unknown>;
        const expectedRow = expected[index]!;
        return row.sortOrdinal === expectedRow.sortOrdinal
            && row.instagramId === expectedRow.instagramId
            && row.profileImage === expectedRow.profileImage
            && row.fullName === expectedRow.fullName
            && typeof row.nameFemaleScore === 'number'
            && Number.isFinite(row.nameFemaleScore)
            && Math.fround(row.nameFemaleScore) === expectedRow.nameFemaleScore
            && row.nameIsName === expectedRow.nameIsName
            && typeof row.nameConfidence === 'number'
            && Number.isFinite(row.nameConfidence)
            && Math.fround(row.nameConfidence) === expectedRow.nameConfidence;
    });
}

export function createConciergePublicationStore(
    invoke: ConciergePublicationRpc,
): ConciergePublicationStore {
    return {
        async publishAtomic(input) {
            const publication = deepCloneAndFreeze(input.publication);
            const classificationLedger = deepCloneAndFreeze(input.classificationLedger);
            const manualImport = deepCloneAndFreeze(input.manualImport);
            const response = await invoke({
                order_id: input.orderId,
                request_id: input.requestId,
                owner_id: input.ownerId,
                target_username: input.targetUsername,
                target_input_hash: publication.targetInputHash,
                source_request_id: publication.sourceRequestId,
                replay_lineage_hash: publication.replayLineageHash,
                relationship_manifest_hash: publication.relationshipManifestHash,
                expected_version: input.expectedVersion,
                expected_result_hash: input.expectedResultHash,
                result_hash: publication.resultHash,
                result_url: publication.resultUrl,
                interaction_lineage_hash: publication.interactionLineageHash,
                interaction_lineage: publication.interactionLineage,
                publication,
                classification_ledger: classificationLedger,
                manual_import: manualImport,
            });
            if (response.error) {
                throw new ConciergePublicationError(
                    response.error.code && /^CONCIERGE_[A-Z0-9_]+$/.test(response.error.code)
                        ? response.error.code
                        : 'CONCIERGE_PUBLICATION_RPC_FAILED',
                );
            }
            if (!response.data || typeof response.data !== 'object') {
                throw new ConciergePublicationError('CONCIERGE_PUBLICATION_RPC_INVALID_RESPONSE');
            }
            const data = response.data as {
                published?: unknown;
                idempotent?: unknown;
                ownerReadContractVerified?: unknown;
                adminReadContractVerified?: unknown;
                resultHash?: unknown;
                resultUrl?: unknown;
                requestId?: unknown;
                version?: unknown;
                counts?: unknown;
                privateRows?: unknown;
            };
            if (data.published !== true || typeof data.idempotent !== 'boolean') {
                throw new ConciergePublicationError('CONCIERGE_PUBLICATION_RPC_INVALID_RESPONSE');
            }
            if (data.ownerReadContractVerified !== true
                || data.adminReadContractVerified !== true) {
                throw new ConciergePublicationError('CONCIERGE_PUBLICATION_READ_CONTRACT_FAILED');
            }
            if (data.resultHash !== publication.resultHash
                || data.resultUrl !== publication.resultUrl
                || data.requestId !== input.requestId
                || data.version !== input.expectedVersion + 1
                || canonicalJson(data.counts) !== canonicalJson(publication.counts)) {
                throw new ConciergePublicationError('CONCIERGE_PUBLICATION_RPC_ECHO_MISMATCH');
            }
            if (!privateReadContractMatches(
                data.privateRows,
                privateReadContractRows(publication.privateRows),
            )) {
                throw new ConciergePublicationError('CONCIERGE_PUBLICATION_READ_CONTRACT_FAILED');
            }
            return { published: true, idempotent: data.idempotent };
        },
    };
}

/**
 * Production adapter for the forward-only service-role RPC.  Its database
 * function owns the transaction and returns the ordered private-row readback;
 * the already-published first concierge order remains on its one-shot RPC.
 */
export function createSupabaseConciergePublicationStore(
    client: ConciergePublicationSupabaseClient = supabaseAdmin,
): ConciergePublicationStore {
    return createConciergePublicationStore(async args => {
        const response = await client.rpc(CONCIERGE_BATCH_PUBLICATION_RPC, args);
        return { data: response.data, error: response.error };
    });
}

/** Service-role store for future concierge batch publications only. */
export const conciergePublicationStore = createSupabaseConciergePublicationStore();

function normalizeUsername(value: string): string {
    return value.trim().replace(/^@/, '').toLowerCase();
}

function fail(code: string): never {
    throw new ConciergePublicationError(code);
}

function hash(value: unknown): string {
    return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/** A locale-independent comparator for persisted provider values. */
function compareStable(left: string, right: string): number {
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
        const leftCode = left.charCodeAt(index);
        const rightCode = right.charCodeAt(index);
        if (leftCode !== rightCode) return leftCode - rightCode;
    }
    return left.length - right.length;
}

function stableObject(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stableObject);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.entries(value)
            .sort(([left], [right]) => compareStable(left, right))
            .map(([key, entry]) => [key, stableObject(entry)]),
    );
}

function canonicalJson(value: unknown): string {
    return JSON.stringify(stableObject(value));
}

function deepCloneAndFreeze<T>(value: T): T {
    if (Array.isArray(value)) {
        const clone = value.map(item => deepCloneAndFreeze(item)) as unknown as T;
        return Object.freeze(clone);
    }
    if (!value || typeof value !== 'object') return value;
    if (value instanceof Map) {
        const clone = new Map(
            [...value.entries()].map(([key, entry]) => [
                deepCloneAndFreeze(key), deepCloneAndFreeze(entry),
            ]),
        );
        return Object.freeze(clone) as T;
    }
    const clone = Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .map(([key, entry]) => [key, deepCloneAndFreeze(entry)]),
    ) as T;
    return Object.freeze(clone);
}

function canonicalPost(post: InstagramPost): InstagramPost {
    const canonical = stableObject(post) as InstagramPost & {
        hashtags?: string[];
        taggedUsers: string[];
        mentionedUsers: string[];
    };
    for (const key of ['hashtags', 'taggedUsers', 'mentionedUsers'] as const) {
        if (canonical[key]) canonical[key] = [...canonical[key]!].sort(compareStable);
    }
    return canonical;
}

function canonicalPosts(posts: readonly InstagramPost[]): readonly InstagramPost[] {
    return posts.map(canonicalPost).sort((left, right) => (
        compareStable(left.id, right.id)
        || compareStable(left.shortCode, right.shortCode)
        || compareStable(left.timestamp, right.timestamp)
        || compareStable(canonicalJson(left), canonicalJson(right))
    ));
}

function canonicalTargetPostMentionEvidence(
    posts: readonly InstagramPost[],
): readonly { taggedUsers: string[]; mentionedUsers: string[] }[] {
    return canonicalPosts(posts).map(post => ({
        taggedUsers: [...post.taggedUsers],
        mentionedUsers: [...post.mentionedUsers],
    }));
}

function profilesWithCanonicalCandidatePosts(
    profilesByOrdinal: ReadonlyMap<number, InstagramProfile>,
    interaction: ConciergeBidirectionalInteractionEvidence,
): ReadonlyMap<number, InstagramProfile> {
    const postsCollected = interaction.candidateToTarget.status === 'collected';
    return new Map([...profilesByOrdinal.entries()].map(([ordinal, profile]) => {
        const username = normalizeEvidenceUsername(profile.username);
        const latestPosts = postsCollected
            ? interaction.candidatePostsByUsername.get(username) ?? []
            : [];
        return [ordinal, { ...profile, latestPosts: [...latestPosts] }] as const;
    }));
}

function canonicalRawEvidence(rows: readonly RawTargetInteractionEvidence[]): readonly RawTargetInteractionEvidence[] {
    return rows.map(row => stableObject({
        ...row,
        actorUsername: row.actorUsername.trim().replace(/^@/, '').toLowerCase(),
    }) as RawTargetInteractionEvidence).sort((left, right) => (
        compareStable(left.actorUsername, right.actorUsername)
        || compareStable(left.postId, right.postId)
        || compareStable(left.signal, right.signal)
        || compareStable(left.sourceInteractionId, right.sourceInteractionId)
        || compareStable(left.occurredAt ?? '', right.occurredAt ?? '')
        || compareStable(left.content ?? '', right.content ?? '')
        || compareStable(canonicalJson(left), canonicalJson(right))
    ));
}

function canonicalInteractionEvidence(rows: readonly InteractionEvidenceRow[]): readonly InteractionEvidenceRow[] {
    return rows.map(row => stableObject({
        ...row,
        candidateUsername: row.candidateUsername.trim().replace(/^@/, '').toLowerCase(),
    }) as InteractionEvidenceRow).sort((left, right) => (
        compareStable(left.candidateUsername, right.candidateUsername)
        || compareStable(left.postId, right.postId)
        || compareStable(left.signal, right.signal)
        || compareStable(left.sourceInteractionId, right.sourceInteractionId)
        || compareStable(left.occurredAt ?? '', right.occurredAt ?? '')
        || compareStable(left.content ?? '', right.content ?? '')
        || compareStable(canonicalJson(left), canonicalJson(right))
    ));
}

function canonicalCoverage(rows: readonly StoredInteractionCoverage[]): readonly StoredInteractionCoverage[] {
    return rows.map(row => stableObject({
        ...row,
        ...(row.candidateUsername
            ? { candidateUsername: normalizeEvidenceUsername(row.candidateUsername) }
            : {}),
    }) as StoredInteractionCoverage).sort((left, right) => (
        compareStable(left.candidateUsername ?? '', right.candidateUsername ?? '')
        || compareStable(left.postId, right.postId)
        || left.declaredCount - right.declaredCount
        || left.returnedCount - right.returnedCount
        || left.requestedLimit - right.requestedLimit
        || compareStable(canonicalJson(left), canonicalJson(right))
    ));
}

function canonicalizeBidirectionalInteractions(
    interaction: ConciergeBidirectionalInteractionEvidence,
): ConciergeBidirectionalInteractionEvidence {
    return {
        targetToCandidate: {
            status: interaction.targetToCandidate.status,
            evidence: canonicalRawEvidence(interaction.targetToCandidate.evidence),
            observedUsernames: [...interaction.targetToCandidate.observedUsernames]
                .map(value => value.trim().replace(/^@/, '').toLowerCase())
                .sort(compareStable),
            likerCoverage: canonicalCoverage(interaction.targetToCandidate.likerCoverage),
            commentCoverage: canonicalCoverage(interaction.targetToCandidate.commentCoverage),
        },
        candidateToTarget: {
            status: interaction.candidateToTarget.status,
            evidence: canonicalInteractionEvidence(interaction.candidateToTarget.evidence),
            coverage: canonicalCoverage(interaction.candidateToTarget.coverage),
        },
        targetPosts: canonicalPosts(interaction.targetPosts),
        candidatePostsByUsername: new Map(
            [...interaction.candidatePostsByUsername.entries()]
                .map(([username, posts]) => [
                    username.trim().replace(/^@/, '').toLowerCase(), canonicalPosts(posts),
                ] as const)
                .sort(([left], [right]) => compareStable(left, right)),
        ),
        reverseLikeStatusByUsername: new Map(
            [...interaction.reverseLikeStatusByUsername.entries()]
                .map(([username, status]) => [username.trim().replace(/^@/, '').toLowerCase(), status] as const)
                .sort(([left], [right]) => compareStable(left, right)),
        ),
        targetInputHash: interaction.targetInputHash,
        candidateInputHash: interaction.candidateInputHash,
        reverseLikeInputHash: interaction.reverseLikeInputHash,
        coverageHash: interaction.coverageHash,
    };
}

function canonicalInteractionLineage(interaction: ConciergeBidirectionalInteractionEvidence): unknown {
    const canonical = canonicalizeBidirectionalInteractions(interaction);
    return {
        targetToCandidate: canonical.targetToCandidate,
        candidateToTarget: canonical.candidateToTarget,
        targetPosts: canonical.targetPosts,
        candidatePostsByUsername: [...canonical.candidatePostsByUsername.entries()],
        reverseLikeStatusByUsername: [...canonical.reverseLikeStatusByUsername.entries()],
        targetInputHash: canonical.targetInputHash,
        candidateInputHash: canonical.candidateInputHash,
        reverseLikeInputHash: canonical.reverseLikeInputHash,
        coverageHash: canonical.coverageHash,
    };
}

function detailClassification(detail: ReplayAccountAiDetail): 'male' | 'female' | 'unknown' {
    if (detail.finalClassification === 'verified_female') return 'female';
    if (detail.finalClassification === 'verified_non_female') return 'male';
    return 'unknown';
}

function normalizeEvidenceUsername(value: string): string {
    return value.trim().replace(/^@/, '').toLowerCase();
}

function validateCoverageRows(
    rows: readonly StoredInteractionCoverage[],
    postIds: ReadonlySet<string>,
    publicNames: ReadonlySet<string>,
    requireCandidateUsername: boolean,
): void {
    const seen = new Set<string>();
    for (const row of rows) {
        if (!postIds.has(row.postId)
            || !Number.isInteger(row.declaredCount) || row.declaredCount < 0
            || !Number.isInteger(row.returnedCount) || row.returnedCount < 0
            || !Number.isInteger(row.requestedLimit) || row.requestedLimit <= 0
            || row.returnedCount > row.requestedLimit
            || row.returnedCount > row.declaredCount) {
            fail('CONCIERGE_PUBLICATION_INTERACTION_COVERAGE_MISMATCH');
        }
        const username = row.candidateUsername
            ? normalizeEvidenceUsername(row.candidateUsername)
            : null;
        if (requireCandidateUsername !== Boolean(username)
            || (username !== null && !publicNames.has(username))) {
            fail('CONCIERGE_PUBLICATION_INTERACTION_COVERAGE_MISMATCH');
        }
        const key = `${username ?? ''}\u0000${row.postId}`;
        if (seen.has(key)) fail('CONCIERGE_PUBLICATION_INTERACTION_COVERAGE_MISMATCH');
        seen.add(key);
    }
}

function validateInteractionEvidence(
    interaction: ConciergeBidirectionalInteractionEvidence,
    publicNames: ReadonlySet<string>,
): void {
    const targetPostIds = new Set<string>();
    for (const post of interaction.targetPosts) {
        if (!post.id || targetPostIds.has(post.id)) {
            fail('CONCIERGE_PUBLICATION_INTERACTION_POST_MISMATCH');
        }
        targetPostIds.add(post.id);
    }
    const candidatePostIdsByUsername = new Map<string, Set<string>>();
    for (const [rawUsername, posts] of interaction.candidatePostsByUsername) {
        const username = normalizeEvidenceUsername(rawUsername);
        if (!publicNames.has(username) || candidatePostIdsByUsername.has(username)) {
            fail('CONCIERGE_PUBLICATION_INTERACTION_POST_MISMATCH');
        }
        const ids = new Set<string>();
        for (const post of posts) {
            if (!post.id || ids.has(post.id)) {
                fail('CONCIERGE_PUBLICATION_INTERACTION_POST_MISMATCH');
            }
            ids.add(post.id);
        }
        candidatePostIdsByUsername.set(username, ids);
    }
    const targetSnapshot = interaction.targetToCandidate;
    if (!['collected', 'not_collected', 'failed'].includes(targetSnapshot.status)) {
        fail('CONCIERGE_PUBLICATION_INTERACTION_LINEAGE_MISMATCH');
    }
    if (targetSnapshot.status !== 'collected'
        && (targetSnapshot.evidence.length > 0
            || targetSnapshot.observedUsernames.length > 0
            || targetSnapshot.likerCoverage.length > 0
            || targetSnapshot.commentCoverage.length > 0)) {
        fail('CONCIERGE_PUBLICATION_INTERACTION_LINEAGE_MISMATCH');
    }
    const targetActors = new Set<string>();
    const targetSourceIds = new Set<string>();
    for (const row of targetSnapshot.evidence) {
        const actor = normalizeEvidenceUsername(row.actorUsername);
        if (!publicNames.has(actor) || !targetPostIds.has(row.postId)
            || (row.signal !== 'target_post_like' && row.signal !== 'target_post_comment')
            || !row.sourceInteractionId || targetSourceIds.has(row.sourceInteractionId)) {
            fail(!targetPostIds.has(row.postId)
                ? 'CONCIERGE_PUBLICATION_INTERACTION_POST_MISMATCH'
                : 'CONCIERGE_PUBLICATION_INTERACTION_DIRECTION_MISMATCH');
        }
        targetActors.add(actor);
        targetSourceIds.add(row.sourceInteractionId);
    }
    const observed = new Set(targetSnapshot.observedUsernames.map(normalizeEvidenceUsername));
    if (observed.size !== targetSnapshot.observedUsernames.length
        || observed.size !== targetActors.size
        || [...observed].some(username => !targetActors.has(username))) {
        fail('CONCIERGE_PUBLICATION_INTERACTION_LINEAGE_MISMATCH');
    }
    validateCoverageRows(targetSnapshot.likerCoverage, targetPostIds, publicNames, false);
    validateCoverageRows(targetSnapshot.commentCoverage, targetPostIds, publicNames, false);

    const candidateSnapshot = interaction.candidateToTarget;
    if (!['collected', 'not_collected', 'failed'].includes(candidateSnapshot.status)) {
        fail('CONCIERGE_PUBLICATION_INTERACTION_LINEAGE_MISMATCH');
    }
    if (candidateSnapshot.status !== 'collected'
        && (candidateSnapshot.evidence.length > 0 || candidateSnapshot.coverage.length > 0)) {
        fail('CONCIERGE_PUBLICATION_INTERACTION_LINEAGE_MISMATCH');
    }
    const candidateSourceIds = new Set<string>();
    for (const row of candidateSnapshot.evidence) {
        const username = normalizeEvidenceUsername(row.candidateUsername);
        const candidatePosts = candidatePostIdsByUsername.get(username);
        if (!publicNames.has(username) || !candidatePosts?.has(row.postId)) {
            fail('CONCIERGE_PUBLICATION_INTERACTION_POST_MISMATCH');
        }
        if (row.signal !== 'target_female_like' || !row.sourceInteractionId
            || candidateSourceIds.has(row.sourceInteractionId)) {
            fail('CONCIERGE_PUBLICATION_INTERACTION_DIRECTION_MISMATCH');
        }
        candidateSourceIds.add(row.sourceInteractionId);
    }
    for (const row of candidateSnapshot.coverage) {
        const username = row.candidateUsername
            ? normalizeEvidenceUsername(row.candidateUsername)
            : null;
        const candidatePosts = username ? candidatePostIdsByUsername.get(username) : undefined;
        if (!username || !candidatePosts?.has(row.postId)) {
            fail('CONCIERGE_PUBLICATION_INTERACTION_POST_MISMATCH');
        }
    }
    validateCoverageRows(candidateSnapshot.coverage, new Set(
        [...candidatePostIdsByUsername.values()].flatMap(ids => [...ids]),
    ), publicNames, true);

    for (const [rawUsername, status] of interaction.reverseLikeStatusByUsername) {
        if (!publicNames.has(normalizeEvidenceUsername(rawUsername))
            || !['observed', 'not_observed', 'not_collected', 'failed'].includes(status)) {
            fail('CONCIERGE_PUBLICATION_INTERACTION_LINEAGE_MISMATCH');
        }
    }
    if (new Set([...interaction.reverseLikeStatusByUsername.keys()]
        .map(normalizeEvidenceUsername)).size !== interaction.reverseLikeStatusByUsername.size) {
        fail('CONCIERGE_PUBLICATION_INTERACTION_LINEAGE_MISMATCH');
    }
    if (targetSnapshot.status === 'collected' || candidateSnapshot.status === 'collected') {
        for (const username of publicNames) {
            if (!candidatePostIdsByUsername.has(username)) {
                fail('CONCIERGE_PUBLICATION_INTERACTION_COVERAGE_MISMATCH');
            }
        }
    }
}

function validateReplayBindings(
    ledger: ConciergeClassificationLedger,
    replay: ConciergeStoredReplayFeatures,
): void {
    const orderedRecords = [...ledger.records]
        .sort((left, right) => left.mutualOrdinal - right.mutualOrdinal);
    const orderedNames = replay.orderedMutualUsernames.map(normalizeUsername);
    if (orderedNames.length !== orderedRecords.length
        || new Set(orderedNames).size !== orderedNames.length
        || orderedNames.some((name, index) => (
            name !== normalizeUsername(orderedRecords[index]!.instagramId)
        ))) {
        fail('CONCIERGE_PUBLICATION_PARTITION_BINDING_MISMATCH');
    }
    const recordByUsername = new Map(orderedRecords.map(record => [
        normalizeUsername(record.instagramId), record,
    ]));
    const aiRecords = orderedRecords.filter(row => row.partition !== 'private');
    if (replay.classificationByOrdinal.size !== aiRecords.length) {
        fail('CONCIERGE_PUBLICATION_REPLAY_AI_BINDING_MISMATCH');
    }
    for (const record of aiRecords) {
        const binding = replay.classificationByOrdinal.get(record.mutualOrdinal);
        if (!binding
            || binding.originalAiClassification !== record.originalAiClassification
            || binding.confidence !== record.confidence
            || binding.classifier !== record.classifier
            || binding.modelName !== record.modelName
            || binding.promptVersion !== record.promptVersion
            || binding.schemaVersion !== record.schemaVersion
            || binding.classificationOperationKey !== record.classificationOperationKey
            || binding.classificationResultHash !== record.classificationResultHash
            || binding.secondPassStatus !== record.secondPass.status
            || binding.secondPassCompleteMedia !== record.secondPass.completeMedia) {
            fail('CONCIERGE_PUBLICATION_REPLAY_AI_BINDING_MISMATCH');
        }
    }
    if (replay.profilesByOrdinal.size !== ledger.hydratedPublicCount
        || replay.details.length !== ledger.hydratedPublicCount) {
        fail('CONCIERGE_PUBLICATION_ANALYZED_COUNT_MISMATCH');
    }
    for (const [ordinal, profile] of replay.profilesByOrdinal) {
        const record = recordByUsername.get(normalizeUsername(profile.username));
        if (!record || record.mutualOrdinal !== ordinal
            || record.partition !== 'public' || profile.isPrivate) {
            fail('CONCIERGE_PUBLICATION_PARTITION_BINDING_MISMATCH');
        }
    }
    const detailOrdinals = new Set<number>();
    for (const detail of replay.details) {
        if (detailOrdinals.has(detail.ordinal) || !replay.profilesByOrdinal.has(detail.ordinal)) {
            fail('CONCIERGE_PUBLICATION_ANALYZED_COUNT_MISMATCH');
        }
        detailOrdinals.add(detail.ordinal);
    }
    const privateNames = new Set<string>();
    for (const profile of replay.privateProfiles) {
        const username = normalizeUsername(profile.username);
        const record = recordByUsername.get(username);
        if (!record || record.partition !== 'private' || !profile.isPrivate || privateNames.has(username)) {
            fail('CONCIERGE_PUBLICATION_PRIVATE_PARTITION_MISMATCH');
        }
        privateNames.add(username);
    }
    if (privateNames.size !== ledger.hydratedPrivateCount) {
        fail('CONCIERGE_PUBLICATION_PRIVATE_PARTITION_MISMATCH');
    }
    const interaction = replay.bidirectionalInteractions;
    if (!HASH_PATTERN.test(interaction.targetInputHash)
        || !HASH_PATTERN.test(interaction.candidateInputHash)
        || !HASH_PATTERN.test(interaction.reverseLikeInputHash)
        || !HASH_PATTERN.test(interaction.coverageHash)
        || (interaction.targetToCandidate.status !== 'collected'
            && interaction.targetToCandidate.evidence.length > 0)
        || (interaction.candidateToTarget.status !== 'collected'
            && interaction.candidateToTarget.evidence.length > 0)) {
        fail('CONCIERGE_PUBLICATION_INTERACTION_LINEAGE_MISMATCH');
    }
    const publicNames = new Set(
        [...replay.profilesByOrdinal.values()].map(profile => normalizeUsername(profile.username)),
    );
    validateInteractionEvidence(interaction, publicNames);
    if (interaction.targetToCandidate.status === 'collected'
        || interaction.candidateToTarget.status === 'collected') {
        for (const profile of replay.profilesByOrdinal.values()) {
            if (!interaction.candidatePostsByUsername.has(normalizeUsername(profile.username))) {
                fail('CONCIERGE_PUBLICATION_INTERACTION_COVERAGE_MISMATCH');
            }
        }
    }
}

function buildEffectiveDetails(
    ledger: ConciergeClassificationLedger,
    replay: ConciergeStoredReplayFeatures,
): readonly ReplayAccountAiDetail[] {
    const profileByOrdinal = replay.profilesByOrdinal;
    const recordByUsername = new Map(ledger.records.map(record => [
        normalizeUsername(record.instagramId), record,
    ]));
    return replay.details.map(detail => {
        const profile = profileByOrdinal.get(detail.ordinal);
        if (!profile) fail('CONCIERGE_PUBLICATION_FEATURE_PROFILE_MISSING');
        const username = normalizeUsername(profile.username);
        const record = recordByUsername.get(username);
        const binding = replay.classificationByOrdinal.get(detail.ordinal);
        if (!record || !binding || record.partition !== 'public' || !record.effectiveClassification) {
            fail('CONCIERGE_PUBLICATION_CLASSIFICATION_MISSING');
        }
        if (detailClassification(detail) !== binding.originalAiClassification) {
            fail('CONCIERGE_PUBLICATION_REPLAY_AI_BINDING_MISMATCH');
        }
        const effective = record.effectiveClassification;
        if (effective === 'female') {
            if (!detail.feature) fail('CONCIERGE_PUBLICATION_MANUAL_FEATURE_MISSING');
            if (record.secondPass.status !== 'collected'
                || record.secondPass.completeMedia !== true
                || binding.secondPassStatus !== 'collected'
                || binding.secondPassCompleteMedia !== true) {
                fail('CONCIERGE_PUBLICATION_SECOND_PASS_INCOMPLETE');
            }
        }
        const original = detailClassification(detail);
        if (!record.manualOverride && original !== effective) {
            fail('CONCIERGE_PUBLICATION_AI_CLASSIFICATION_DRIFT');
        }
        const finalClassification = effective === 'female'
            ? 'verified_female'
            : effective === 'male' ? 'verified_non_female' : 'unresolved';
        return {
            ...detail,
            finalClassification,
            // This remains the original AI source. Manual provenance is held in
            // the immutable classification ledger, never disguised as AI output.
            classificationSource: detail.classificationSource,
            featureOverview: detail.feature?.features.oneLineOverview ?? null,
        };
    });
}

export function buildConciergeManualPublication(
    input: ConciergeManualPublicationInput,
): ConciergeCanonicalPublication {
    if (!input.orderId || !input.requestId || !input.ownerId || !input.sourceRequestId
        || input.resultRequestId !== input.requestId || input.sourceRequestId === input.requestId
        || input.manualImport.orderId !== input.orderId
        || input.manualImport.requestId !== input.requestId) {
        fail('CONCIERGE_PUBLICATION_SCOPE_CONFLICT');
    }
    if (input.currentPublication.resultUrl !== `/result/${input.requestId}`) {
        fail('CONCIERGE_PUBLICATION_RESULT_URL_MISMATCH');
    }
    if (!HASH_PATTERN.test(input.targetInputHash)
        || !HASH_PATTERN.test(input.replayLineageHash)
        || !HASH_PATTERN.test(input.relationshipManifestHash)
        || input.relationshipManifestHash !== input.ledger.relationshipResultHash
        || input.manualImport.mutualManifestHash !== input.relationshipManifestHash) {
        fail('CONCIERGE_PUBLICATION_LINEAGE_HASH_MISMATCH');
    }
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0
        || input.currentPublication.version !== input.expectedVersion
        || (input.expectedResultHash !== null && !HASH_PATTERN.test(input.expectedResultHash))
        || (input.currentPublication.resultHash !== null
            && !HASH_PATTERN.test(input.currentPublication.resultHash))) {
        fail('CONCIERGE_PUBLICATION_STALE_VERSION');
    }
    if (!Number.isInteger(input.expectedMutualCount) || input.expectedMutualCount < 0
        || !Number.isInteger(input.expectedHydratedCount) || input.expectedHydratedCount < 0
        || input.ledger.mutualCount !== input.expectedMutualCount
        || input.ledger.hydratedPublicCount + input.ledger.hydratedPrivateCount !== input.expectedHydratedCount
        || input.replay.fetchedCount !== input.expectedMutualCount
        || input.replay.hydratedPublicCount + input.replay.hydratedPrivateCount !== input.expectedHydratedCount
        || !Number.isInteger(input.replay.analyzedPublicCount)
        || input.replay.analyzedPublicCount < 0
        || input.replay.analyzedPublicCount !== input.replay.details.length
        || input.replay.fetchedCount !== input.ledger.mutualCount
        || input.replay.hydratedPublicCount !== input.ledger.hydratedPublicCount
        || input.replay.hydratedPrivateCount !== input.ledger.hydratedPrivateCount
        || input.replay.unresolvedCount !== input.ledger.unresolvedCount) {
        fail('CONCIERGE_PUBLICATION_PARTITION_COUNT_MISMATCH');
    }
    validateReplayBindings(input.ledger, input.replay);
    const effectiveLedger = applyConciergeManualClassificationImport(input.ledger, input.manualImport);
    const details = buildEffectiveDetails(effectiveLedger, input.replay);
    const canonicalInteractions = canonicalizeBidirectionalInteractions(
        input.replay.bidirectionalInteractions,
    );
    const result = buildCanonicalConciergeResult({
        targetUsername: input.targetUsername,
        profilesByOrdinal: profilesWithCanonicalCandidatePosts(
            input.replay.profilesByOrdinal,
            canonicalInteractions,
        ),
        details,
        orderedMutualUsernames: input.replay.orderedMutualUsernames,
        targetInteractions: canonicalInteractions.targetToCandidate.status === 'collected'
            ? canonicalInteractions.targetToCandidate.evidence
            : [],
        targetPosts: canonicalTargetPostMentionEvidence(canonicalInteractions.targetPosts),
        privateProfiles: input.replay.privateProfiles,
        privateNameResults: input.replay.privateNameResults,
    });
    validateCanonicalConciergeCorrection({
        fetchedCount: input.replay.fetchedCount,
        partition: {
            publicProfiles: [...input.replay.profilesByOrdinal.values()],
            privateProfiles: input.replay.privateProfiles,
            unresolvedUsernames: effectiveLedger.records
                .filter(record => record.partition === 'unresolved')
                .map(record => record.instagramId),
        },
        result,
    });
    const ledgerHash = createConciergeClassificationLedgerHash(effectiveLedger);
    const interactionLineage = deepCloneAndFreeze(canonicalInteractionLineage(canonicalInteractions));
    const interactionLineageHash = hash(interactionLineage);
    const rows = deepCloneAndFreeze(result.femaleRows);
    const privateRows = deepCloneAndFreeze(result.privateRows);
    const counts = deepCloneAndFreeze({
        male: result.counts.male,
        female: result.counts.female,
        unknown: result.counts.unknown,
        public: effectiveLedger.hydratedPublicCount,
        private: effectiveLedger.hydratedPrivateCount,
        unresolved: effectiveLedger.unresolvedCount,
        mutual: effectiveLedger.mutualCount,
        authoritativeMutual: effectiveLedger.mutualCount,
        hydrated: effectiveLedger.hydratedPublicCount + effectiveLedger.hydratedPrivateCount,
        analyzed: input.replay.analyzedPublicCount,
    });
    const resultHash = hash({
        schema: 'concierge-manual-publication-v1',
        orderId: input.orderId,
        requestId: input.requestId,
        sourceRequestId: input.sourceRequestId,
        targetInputHash: input.targetInputHash,
        replayLineageHash: input.replayLineageHash,
        relationshipManifestHash: input.relationshipManifestHash,
        ledgerHash,
        interactionLineageHash,
        interactionLineage,
        resultUrl: input.currentPublication.resultUrl,
        rows,
        privateRows,
        counts,
    });
    // A caller that races with a completed identical publication may have an
    // old expected hash.  Permit only that exact already-published hash; a
    // different current hash remains a CAS conflict.
    if (input.currentPublication.resultHash !== input.expectedResultHash
        && input.currentPublication.resultHash !== resultHash) {
        fail('CONCIERGE_PUBLICATION_STALE_VERSION');
    }
    return deepCloneAndFreeze({
        sourceRequestId: input.sourceRequestId,
        requestId: input.requestId,
        targetInputHash: input.targetInputHash,
        replayLineageHash: input.replayLineageHash,
        relationshipManifestHash: input.relationshipManifestHash,
        ledgerHash,
        interactionLineageHash,
        interactionLineage,
        resultHash,
        resultUrl: input.currentPublication.resultUrl,
        rows,
        privateRows,
        counts,
    });
}

export async function publishConciergeManualOverride(
    input: ConciergeManualPublicationInput,
    store: ConciergePublicationStore = conciergePublicationStore,
): Promise<{ published: true; idempotent: boolean; resultHash: string; resultUrl: string; counts: ConciergeCanonicalPublication['counts'] }> {
    const publication = buildConciergeManualPublication(input);
    const applied = await store.publishAtomic({
        publication,
        expectedVersion: input.expectedVersion,
        expectedResultHash: input.expectedResultHash,
        orderId: input.orderId,
        requestId: input.requestId,
        ownerId: input.ownerId,
        targetUsername: input.targetUsername,
        classificationLedger: input.ledger,
        manualImport: input.manualImport,
    });
    return {
        published: true,
        idempotent: applied.idempotent,
        resultHash: publication.resultHash,
        resultUrl: publication.resultUrl,
        counts: publication.counts,
    };
}
