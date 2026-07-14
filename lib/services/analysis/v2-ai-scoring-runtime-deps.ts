import { z } from 'zod';
import type { SelectedAnalysisMedia } from '@/lib/domain/analysis/media-policy';
import {
    AnalysisImagePreparationError,
    classifyAnalysisImagePreparationError,
    downloadImageBytes,
    normalizeImageToJpeg,
    runWithImagePreparationSlot,
} from '@/lib/services/ai/image-preprocessing';
import {
    APIFY_LIKERS_ACTOR_ID,
    apifyInteractionAdapter,
    type ApifyInteractionAdapter,
} from '@/lib/services/instagram/providers/apify-interactions';
import {
    numberSetting,
    selectAnalysisV2ApifyCredentialSlot,
} from '@/lib/services/instagram/providers/apify-relationship';
import type { ProviderCallContext } from '@/lib/services/instagram/providers/types';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    analysisV2ProfileFetchResumeSchema,
    type AnalysisV2CheckpointResult,
    type AnalysisV2ProfileFetchResume,
} from './v2-profile-fetch-store';
import {
    analysisV2CollectionRequestContextStore,
    type AnalysisV2CollectionRequestContextStore,
} from './v2-request-context';
import {
    ANALYSIS_V2_RELATIONSHIPS_JOB_KEY,
    ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY,
} from './v2-coordinator';
import {
    analysisV2EvidenceStore,
    type AnalysisV2EvidenceStore,
} from './v2-evidence-store';
import {
    analysisV2ProviderRunStore,
    createAnalysisV2ProviderInputHash,
    createAnalysisV2ProviderOperationKey,
    type AnalysisV2ProviderRunStore,
} from './v2-provider-run-store';
import type {
    AnalysisV2ProfileBatchReadModel,
    AnalysisV2RelationshipEvidenceReadModel,
    AnalysisV2ReverseLikeCollector,
    AnalysisV2StageReadClaim,
    AnalysisV2TargetProfileReadModel,
} from './v2-ai-scoring-executors';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,159}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PROFILE_JOB_PREFIX = 'track:profiles:batch:';
const PROFILE_AI_JOB_PREFIX = 'track:profile-ai:batch:';
const REVERSE_LIKE_JOB_KEY = 'track:reverse-likes:collect';
const MAX_REVERSE_CANDIDATES = 10;
const REVERSE_LIKE_LIMIT = 100;

export const ANALYSIS_V2_PROFILE_CONSUMER_DATABASE_NAMES = Object.freeze({
    loadRpc: 'load_analysis_v2_profile_fetch_for_consumer',
});

interface RpcResult {
    data: unknown;
    error: null | { code?: string; message?: string };
}

export interface AnalysisV2ProfileConsumerSupabaseClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<RpcResult>;
}

function validateClaim(claim: AnalysisV2StageReadClaim): AnalysisV2StageReadClaim {
    if (
        !UUID_PATTERN.test(claim.requestId)
        || !JOB_KEY_PATTERN.test(claim.jobKey)
        || !UUID_PATTERN.test(claim.claimToken)
        || !SHA256_PATTERN.test(claim.jobInputHash)
    ) {
        throw new Error('ANALYSIS_V2_RUNTIME_DEPENDENCY_VALIDATION_ERROR: invalid claim.');
    }
    return {
        requestId: claim.requestId.toLowerCase(),
        jobKey: claim.jobKey,
        claimToken: claim.claimToken.toLowerCase(),
        jobInputHash: claim.jobInputHash,
    };
}

function safeRpcCode(error: { code?: string }): string {
    return typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : 'unknown';
}

function profileRpcError(error: NonNullable<RpcResult['error']>): never {
    const known = [
        'ANALYSIS_V2_PROFILE_CONSUMER_FENCE_MISMATCH',
        'ANALYSIS_V2_PROFILE_CONSUMER_NOT_READY',
        'ANALYSIS_V2_PROFILE_CONSUMER_SCOPE_MISMATCH',
    ].find(message => error.message === message);
    if (known) throw new Error(known);
    throw new Error(
        `ANALYSIS_V2_PROFILE_CONSUMER_PERSISTENCE_ERROR (${safeRpcCode(error)}).`
    );
}

function finalResults(resume: AnalysisV2ProfileFetchResume): AnalysisV2CheckpointResult[] {
    const fallback = new Map(resume.fallbackResults.map(result => [
        result.outcome.requestedUsername,
        result,
    ]));
    return resume.primaryResults.map(primary => primary.outcome.status === 'success'
        ? primary
        : fallback.get(primary.outcome.requestedUsername) ?? primary);
}

function parseConsumerResume(data: unknown): AnalysisV2ProfileFetchResume {
    const parsed = analysisV2ProfileFetchResumeSchema.safeParse(
        Array.isArray(data) && data.length === 1 ? data[0] : data
    );
    if (!parsed.success) {
        throw new Error('ANALYSIS_V2_PROFILE_CONSUMER_PERSISTENCE_ERROR: invalid result.');
    }
    return parsed.data;
}

function projectTerminalResults(resume: AnalysisV2ProfileFetchResume) {
    return finalResults(resume).map(result => {
        if (result.outcome.status === 'failed') {
            throw new Error('ANALYSIS_V2_PROFILE_CONSUMER_RETRYABLE_OUTCOME');
        }
        if (result.outcome.status === 'success') {
            if (!('profile' in result)) {
                throw new Error('ANALYSIS_V2_PROFILE_CONSUMER_PERSISTENCE_ERROR: missing profile.');
            }
            return {
                username: result.outcome.requestedUsername,
                status: 'success' as const,
                profile: result.profile,
            };
        }
        return {
            username: result.outcome.requestedUsername,
            status: 'unavailable' as const,
        };
    });
}

async function loadConsumerResume(input: {
    client: AnalysisV2ProfileConsumerSupabaseClient;
    claim: AnalysisV2StageReadClaim;
    producerJobKey: string;
    expectedProducerInputHash: string | null;
    expectedItemCount: number;
}) {
    const claim = validateClaim(input.claim);
    if (
        !JOB_KEY_PATTERN.test(input.producerJobKey)
        || (input.expectedProducerInputHash !== null
            && !SHA256_PATTERN.test(input.expectedProducerInputHash))
        || !Number.isSafeInteger(input.expectedItemCount)
        || input.expectedItemCount < 1
        || input.expectedItemCount > 30
    ) {
        throw new Error('ANALYSIS_V2_RUNTIME_DEPENDENCY_VALIDATION_ERROR: invalid profile scope.');
    }
    const { data, error } = await input.client.rpc(
        ANALYSIS_V2_PROFILE_CONSUMER_DATABASE_NAMES.loadRpc,
        {
            p_request_id: claim.requestId,
            p_consumer_job_key: claim.jobKey,
            p_consumer_claim_token: claim.claimToken,
            p_consumer_input_hash: claim.jobInputHash,
            p_producer_job_key: input.producerJobKey,
            p_expected_producer_input_hash: input.expectedProducerInputHash,
            p_expected_item_count: input.expectedItemCount,
        }
    );
    if (error) profileRpcError(error);
    return data === null ? null : parseConsumerResume(data);
}

export function createAnalysisV2ProfileBatchReadModel(
    client: AnalysisV2ProfileConsumerSupabaseClient = supabaseAdmin
): AnalysisV2ProfileBatchReadModel {
    return {
        async loadExactBatch(input) {
            if (
                !Number.isSafeInteger(input.batch)
                || input.batch < 0
                || input.batch > 100_000
                || input.producerJobKey !== `${PROFILE_JOB_PREFIX}${input.batch}`
                || input.consumerJobKey !== `${PROFILE_AI_JOB_PREFIX}${input.batch}`
            ) {
                throw new Error('ANALYSIS_V2_PROFILE_CONSUMER_SCOPE_MISMATCH');
            }
            const resume = await loadConsumerResume({
                client,
                claim: {
                    requestId: input.requestId,
                    jobKey: input.consumerJobKey,
                    claimToken: input.consumerClaimToken,
                    jobInputHash: input.consumerInputHash,
                },
                producerJobKey: input.producerJobKey,
                expectedProducerInputHash: input.expectedProducerInputHash,
                expectedItemCount: input.expectedItemCount,
            });
            if (resume === null) return null;
            if (
                resume.jobKey !== input.producerJobKey
                || resume.requestedUsernames.length !== input.expectedItemCount
            ) {
                throw new Error('ANALYSIS_V2_PROFILE_CONSUMER_SCOPE_MISMATCH');
            }
            return Object.freeze({
                requestedUsernames: Object.freeze([...resume.requestedUsernames]),
                results: Object.freeze(projectTerminalResults(resume)),
            });
        },
    };
}

export function createAnalysisV2TargetProfileReadModel(
    client: AnalysisV2ProfileConsumerSupabaseClient = supabaseAdmin
): AnalysisV2TargetProfileReadModel {
    return {
        async loadTargetProfile(rawClaim) {
            const claim = validateClaim(rawClaim);
            const resume = await loadConsumerResume({
                client,
                claim,
                producerJobKey: ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY,
                expectedProducerInputHash: null,
                expectedItemCount: 1,
            });
            if (!resume || resume.requestedUsernames.length !== 1) {
                throw new Error('ANALYSIS_V2_TARGET_PROFILE_NOT_READY');
            }
            const [result] = projectTerminalResults(resume);
            if (result.status !== 'success') {
                throw new Error('ANALYSIS_V2_TARGET_PROFILE_UNAVAILABLE');
            }
            return result.profile;
        },
    };
}

export function createAnalysisV2RelationshipEvidenceReadModel(input: {
    contextStore?: AnalysisV2CollectionRequestContextStore;
    evidenceStore?: AnalysisV2EvidenceStore;
} = {}): AnalysisV2RelationshipEvidenceReadModel {
    const contextStore = input.contextStore ?? analysisV2CollectionRequestContextStore;
    const evidenceStore = input.evidenceStore ?? analysisV2EvidenceStore;
    return {
        async loadRelationships(rawClaim) {
            const claim = validateClaim(rawClaim);
            const context = await contextStore.load(claim);
            const snapshot = await evidenceStore.loadRelationshipStaging({
                requestId: claim.requestId,
                jobKey: ANALYSIS_V2_RELATIONSHIPS_JOB_KEY,
            });
            if (
                !snapshot
                || snapshot.requestId !== claim.requestId
                || snapshot.excludedUsername !== context.excludedUsername
                || snapshot.detailedMutualLimit !== context.detailedMutualLimit
            ) {
                throw new Error('ANALYSIS_V2_RELATIONSHIP_EVIDENCE_NOT_READY');
            }
            return snapshot;
        },

        async loadTargetEvidence(rawClaim) {
            const claim = validateClaim(rawClaim);
            const context = await contextStore.load(claim);
            const snapshot = await evidenceStore.loadTargetEvidence({
                requestId: claim.requestId,
                jobKey: ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY,
            });
            if (
                !snapshot
                || snapshot.requestId !== claim.requestId
                || snapshot.targetUsername !== context.targetUsername
                || snapshot.excludedUsername !== context.excludedUsername
            ) {
                throw new Error('ANALYSIS_V2_TARGET_EVIDENCE_NOT_READY');
            }
            return snapshot;
        },
    };
}

function canonicalPostUrl(value: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error('ANALYSIS_V2_REVERSE_LIKE_INVALID_POST_URL');
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const segments = url.pathname.split('/').filter(Boolean);
    const kind = segments[0] === 'p' ? 'p' : 'reel';
    if (
        url.protocol !== 'https:'
        || host !== 'instagram.com'
        || !['p', 'reel', 'reels'].includes(segments[0])
        || segments.length !== 2
        || !/^[A-Za-z0-9_-]+$/.test(segments[1])
    ) {
        throw new Error('ANALYSIS_V2_REVERSE_LIKE_INVALID_POST_URL');
    }
    return `https://www.instagram.com/${kind}/${segments[1]}/`;
}

function lengthPrefixed(value: string): string {
    return `${Buffer.byteLength(value, 'utf8')}:${value}`;
}

function reverseLikeMaximumCharge(
    candidateCount: number,
    env: Record<string, string | undefined>
): number {
    const costPerResult = numberSetting(
        env,
        'APIFY_LIKERS_ESTIMATED_COST_PER_RESULT_USD',
        0.00155,
        0.00000001,
        100
    );
    const maximum = numberSetting(
        env,
        'APIFY_LIKERS_MAX_ESTIMATED_COST_USD_PER_OPERATION',
        1_500 * 0.00155,
        0.00000001,
        100_000
    );
    const estimated = Number((candidateCount * REVERSE_LIKE_LIMIT * costPerResult).toFixed(12));
    if (estimated > maximum + Number.EPSILON) {
        throw new Error('ANALYSIS_V2_REVERSE_LIKE_BUDGET_EXCEEDED');
    }
    return estimated;
}

function providerContext(
    checkpoint: Awaited<ReturnType<AnalysisV2ProviderRunStore['bindAdapterCheckpoint']>>['checkpoint']
): ProviderCallContext {
    return { ...checkpoint, recordUsage: () => undefined };
}

export function createAnalysisV2ReverseLikeCollector(input: {
    adapter?: ApifyInteractionAdapter;
    providerRunStore?: AnalysisV2ProviderRunStore;
    env?: Record<string, string | undefined>;
} = {}): AnalysisV2ReverseLikeCollector {
    const adapter = input.adapter ?? apifyInteractionAdapter;
    const providerRunStore = input.providerRunStore ?? analysisV2ProviderRunStore;
    const env = input.env ?? process.env;
    return {
        async collect(rawInput) {
            const claim = validateClaim({
                requestId: rawInput.requestId,
                jobKey: rawInput.jobKey,
                claimToken: rawInput.claimToken,
                jobInputHash: rawInput.jobInputHash,
            });
            if (
                claim.jobKey !== REVERSE_LIKE_JOB_KEY
                || rawInput.limitPerPost !== REVERSE_LIKE_LIMIT
                || rawInput.candidates.length > MAX_REVERSE_CANDIDATES
            ) {
                throw new Error('ANALYSIS_V2_REVERSE_LIKE_SCOPE_MISMATCH');
            }
            if (rawInput.candidates.length === 0) {
                return Object.freeze({ operationKey: null, results: Object.freeze([]) });
            }
            const targetUsername = z.string().trim().toLowerCase()
                .regex(/^[a-z0-9._]{1,30}$/)
                .parse(rawInput.targetUsername);
            const candidates = rawInput.candidates.map(candidate => ({
                candidateId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/)
                    .parse(candidate.candidateId),
                postUrl: canonicalPostUrl(candidate.postUrl),
                declaredLikesCount: z.number().int().min(0).max(2_000_000_000)
                    .parse(candidate.declaredLikesCount),
            }));
            if (
                new Set(candidates.map(row => row.candidateId)).size !== candidates.length
                || new Set(candidates.map(row => row.postUrl)).size !== candidates.length
            ) {
                throw new Error('ANALYSIS_V2_REVERSE_LIKE_SCOPE_MISMATCH');
            }
            const canonicalInput = [
                'candidate-likers-v2',
                targetUsername,
                String(REVERSE_LIKE_LIMIT),
                ...candidates.flatMap(row => [
                    row.candidateId,
                    row.postUrl,
                    String(row.declaredLikesCount),
                ]),
            ].map(lengthPrefixed).join('\n');
            const operationKey = createAnalysisV2ProviderOperationKey(
                'candidate-likers',
                canonicalInput
            );
            const binding = await providerRunStore.bindAdapterCheckpoint({
                ...claim,
                operationKey,
                inputHash: createAnalysisV2ProviderInputHash(canonicalInput),
                logicalProvider: 'apify',
                actorId: APIFY_LIKERS_ACTOR_ID,
                credentialSlot: selectAnalysisV2ApifyCredentialSlot(env),
                maxChargeUsd: reverseLikeMaximumCharge(candidates.length, env),
            });
            const likers = await adapter.getPostLikers(
                candidates.map(row => row.postUrl),
                REVERSE_LIKE_LIMIT,
                providerContext(binding.checkpoint)
            );
            const stored = await providerRunStore.load({
                requestId: claim.requestId,
                jobKey: claim.jobKey,
                operationKey,
            });
            if (!stored || stored.status !== 'succeeded' || !stored.runId) {
                throw new Error('ANALYSIS_V2_REVERSE_LIKE_PROVIDER_RUN_NOT_SUCCEEDED');
            }
            const candidateByUrl = new Map(candidates.map(row => [row.postUrl, row]));
            const usernamesByCandidate = new Map(candidates.map(row => [
                row.candidateId,
                new Set<string>(),
            ]));
            if (likers.length > candidates.length * REVERSE_LIKE_LIMIT) {
                throw new Error('ANALYSIS_V2_REVERSE_LIKE_RESULT_LIMIT_EXCEEDED');
            }
            for (const liker of likers) {
                const url = canonicalPostUrl(liker.postUrl);
                const candidate = candidateByUrl.get(url);
                const username = liker.username.trim().replace(/^@/, '').toLowerCase();
                if (!candidate || !/^[a-z0-9._]{1,30}$/.test(username)) {
                    throw new Error('ANALYSIS_V2_REVERSE_LIKE_RESULT_SCOPE_MISMATCH');
                }
                const usernames = usernamesByCandidate.get(candidate.candidateId)!;
                usernames.add(username);
                if (usernames.size > REVERSE_LIKE_LIMIT) {
                    throw new Error('ANALYSIS_V2_REVERSE_LIKE_RESULT_LIMIT_EXCEEDED');
                }
            }
            return Object.freeze({
                operationKey,
                results: Object.freeze(candidates.map(candidate => {
                    const likerUsernames = Object.freeze([
                        ...usernamesByCandidate.get(candidate.candidateId)!,
                    ]);
                    const targetObserved = likerUsernames.includes(targetUsername);
                    const globalAbsenceConfirmed = candidate.declaredLikesCount <= REVERSE_LIKE_LIMIT
                        && likerUsernames.length >= candidate.declaredLikesCount;
                    return Object.freeze({
                        candidateId: candidate.candidateId,
                        status: targetObserved
                            ? 'observed' as const
                            : globalAbsenceConfirmed
                                ? 'not_observed' as const
                                : 'not_collected' as const,
                    });
                })),
            });
        },
    };
}

export interface AnalysisV2MediaNormalizerDependencies {
    download?: (url: string) => Promise<Buffer>;
    normalize?: (bytes: Buffer) => Promise<Buffer>;
    withSlot?: <T>(task: () => Promise<T>) => Promise<T>;
}

/** Uses the shared process-wide eight-slot preparation semaphore and the secure image fetcher. */
export function createAnalysisV2MediaNormalizer(
    input: AnalysisV2MediaNormalizerDependencies = {}
): (media: SelectedAnalysisMedia) => Promise<Buffer> {
    const download = input.download ?? (url => downloadImageBytes(url));
    const normalize = input.normalize ?? (bytes => normalizeImageToJpeg(bytes));
    const withSlot = input.withSlot ?? runWithImagePreparationSlot;
    return async (media) => withSlot(async () => {
        if (
            !media.selectionId.trim()
            || !media.imageUrl.trim()
        ) {
            throw new AnalysisImagePreparationError('invalid_source', 'permanent');
        }
        let downloaded: Buffer;
        try {
            downloaded = await download(media.imageUrl);
        } catch (error) {
            throw classifyAnalysisImagePreparationError(error, 'download');
        }
        let normalized: Buffer;
        try {
            normalized = await normalize(downloaded);
        } catch (error) {
            throw classifyAnalysisImagePreparationError(error, 'decode');
        }
        if (normalized.length === 0) {
            throw new AnalysisImagePreparationError('empty_output', 'permanent');
        }
        return normalized;
    });
}

export const analysisV2ProfileBatchReadModel = createAnalysisV2ProfileBatchReadModel();
export const analysisV2TargetProfileReadModel = createAnalysisV2TargetProfileReadModel();
export const analysisV2RelationshipEvidenceReadModel =
    createAnalysisV2RelationshipEvidenceReadModel();
export const analysisV2ReverseLikeCollector = createAnalysisV2ReverseLikeCollector();
export const analysisV2MediaNormalizer = createAnalysisV2MediaNormalizer();
