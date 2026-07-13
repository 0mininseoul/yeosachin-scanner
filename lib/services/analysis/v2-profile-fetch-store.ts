import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    profileFetchOutcomeSchema,
    summarizeProfileFetchOutcomes,
    type ProfileFetchOutcome,
} from '@/lib/domain/analysis/profile-fetch-outcome';
import type { InstagramProfile } from '@/lib/types/instagram';
import { z } from 'zod';

const MAX_PROFILE_BATCH_SIZE = 30;
const MAX_CHECKPOINT_POSTS = 8;
const MAX_CAROUSEL_MEDIA = 20;
const MAX_URL_LENGTH = 8_192;
const JOB_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,159}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const usernameSchema = z.string()
    .trim()
    .min(1)
    .max(30)
    .regex(/^[A-Za-z0-9._]+$/)
    .transform(value => value.toLowerCase());
const boundedUrlSchema = z.string()
    .trim()
    .min(1)
    .max(MAX_URL_LENGTH)
    .regex(/^https?:\/\/[^\s]+$/i);
const boundedCountSchema = z.number().int().min(0).max(2_000_000_000);
const boundedMediaIdSchema = z.string().trim().min(1).max(255);

export const analysisV2CheckpointMediaItemSchema = z.object({
    id: boundedMediaIdSchema.optional(),
    type: z.enum(['image', 'video', 'reel']),
    imageUrl: boundedUrlSchema.optional(),
    thumbnailUrl: boundedUrlSchema.optional(),
    videoUrl: boundedUrlSchema.optional(),
}).strict().superRefine((value, context) => {
    if (!value.imageUrl && !value.thumbnailUrl && !value.videoUrl) {
        context.addIssue({
            code: 'custom',
            message: 'A checkpoint media item needs at least one bounded media URL.',
        });
    }
});

export const analysisV2CheckpointPostSchema = z.object({
    id: boundedMediaIdSchema,
    shortCode: z.string().trim().min(1).max(100),
    caption: z.string().max(2_200).optional(),
    hashtags: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
    imageUrl: boundedUrlSchema.optional(),
    thumbnailUrl: boundedUrlSchema.optional(),
    videoUrl: boundedUrlSchema.optional(),
    type: z.enum(['image', 'video', 'carousel', 'reel']),
    mediaItems: z.array(analysisV2CheckpointMediaItemSchema)
        .max(MAX_CAROUSEL_MEDIA)
        .optional(),
    declaredMediaCount: z.number().int().min(1).max(MAX_CAROUSEL_MEDIA).optional(),
    childrenComplete: z.boolean().optional(),
    likesCount: boundedCountSchema,
    commentsCount: boundedCountSchema,
    timestamp: z.string().datetime({ offset: true }),
    taggedUsers: z.array(usernameSchema).max(50),
    mentionedUsers: z.array(usernameSchema).max(50),
}).strict().superRefine((value, context) => {
    if (value.type !== 'carousel' && (
        value.mediaItems !== undefined
        || value.declaredMediaCount !== undefined
        || value.childrenComplete !== undefined
    )) {
        context.addIssue({
            code: 'custom',
            message: 'Only carousel posts may persist child coverage metadata.',
        });
    }
    if (value.childrenComplete === true && (
        value.declaredMediaCount === undefined
        || value.mediaItems?.length !== value.declaredMediaCount
    )) {
        context.addIssue({
            code: 'custom',
            message: 'Complete carousel metadata must account for every declared child.',
        });
    }
});

const checkpointProfileBase = z.object({
    username: usernameSchema,
    fullName: z.string().max(150).optional(),
    bio: z.string().max(2_200).optional(),
    externalUrl: boundedUrlSchema.optional(),
    profilePicUrl: boundedUrlSchema.optional(),
    followersCount: boundedCountSchema,
    followingCount: boundedCountSchema,
    postsCount: boundedCountSchema,
    isPrivate: z.boolean(),
    isVerified: z.boolean(),
});

const inputProfileSchema = checkpointProfileBase.extend({
    latestPosts: z.array(analysisV2CheckpointPostSchema).max(20).optional(),
}).strict();

export const analysisV2CheckpointProfileSchema = checkpointProfileBase.extend({
    latestPosts: z.array(analysisV2CheckpointPostSchema).max(MAX_CHECKPOINT_POSTS).optional(),
}).strict();

export type AnalysisV2CheckpointProfile = z.infer<
    typeof analysisV2CheckpointProfileSchema
>;

const successResultSchema = z.object({
    outcome: profileFetchOutcomeSchema.and(z.object({ status: z.literal('success') })),
    profile: analysisV2CheckpointProfileSchema,
}).strict();
const unavailableResultSchema = z.object({
    outcome: profileFetchOutcomeSchema.and(z.object({ status: z.literal('unavailable') })),
}).strict();
const failedResultSchema = z.object({
    outcome: profileFetchOutcomeSchema.and(z.object({ status: z.literal('failed') })),
}).strict();

export const analysisV2CheckpointResultSchema = z.union([
    successResultSchema,
    unavailableResultSchema,
    failedResultSchema,
]).superRefine((value, context) => {
    if (
        value.outcome.status === 'success'
        && (
            !('profile' in value)
            || value.profile.username !== value.outcome.requestedUsername
        )
    ) {
        context.addIssue({
            code: 'custom',
            message: 'Checkpoint profile username must match its requested username.',
        });
    }
});

export type AnalysisV2CheckpointResult = z.infer<
    typeof analysisV2CheckpointResultSchema
>;

export const analysisV2ProfileFetchResumeSchema = z.object({
    requestId: z.string().regex(UUID_PATTERN),
    jobKey: z.string().regex(JOB_KEY_PATTERN),
    requestedUsernames: z.array(usernameSchema).min(1).max(MAX_PROFILE_BATCH_SIZE),
    frozenUnresolvedUsernames: z.array(usernameSchema).max(MAX_PROFILE_BATCH_SIZE),
    primaryResults: z.array(analysisV2CheckpointResultSchema)
        .min(1)
        .max(MAX_PROFILE_BATCH_SIZE),
    fallbackResults: z.array(analysisV2CheckpointResultSchema)
        .max(MAX_PROFILE_BATCH_SIZE),
    primaryCapturedAt: z.string().datetime({ offset: true }),
    fallbackCapturedAt: z.string().datetime({ offset: true }).nullable(),
}).strict().superRefine((value, context) => {
    try {
        validateResumeSets(value);
    } catch (error) {
        context.addIssue({
            code: 'custom',
            message: error instanceof Error ? error.message : 'Invalid checkpoint resume set.',
        });
    }
});

export type AnalysisV2ProfileFetchResume = z.infer<
    typeof analysisV2ProfileFetchResumeSchema
>;

export interface AnalysisV2ProfileAttemptResultInput {
    outcome: ProfileFetchOutcome;
    profile?: InstagramProfile;
}

export interface AnalysisV2ProfileFetchCheckpointIdentity {
    requestId: string;
    jobKey: string;
    claimToken: string;
    jobInputHash: string;
}

export interface AnalysisV2ProfileFetchCheckpointStore {
    checkpointPrimary(input: AnalysisV2ProfileFetchCheckpointIdentity & {
        requestedUsernames: readonly string[];
        results: readonly AnalysisV2ProfileAttemptResultInput[];
    }): Promise<AnalysisV2ProfileFetchResume>;
    checkpointFallback(input: AnalysisV2ProfileFetchCheckpointIdentity & {
        results: readonly AnalysisV2ProfileAttemptResultInput[];
    }): Promise<AnalysisV2ProfileFetchResume>;
    load(input: AnalysisV2ProfileFetchCheckpointIdentity):
        Promise<AnalysisV2ProfileFetchResume | null>;
    purgeTerminal(requestId: string): Promise<number>;
}

interface RpcError {
    code?: string;
    message?: string;
}

interface RpcResult {
    data: unknown;
    error: RpcError | null;
}

export interface AnalysisV2ProfileFetchSupabaseClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<RpcResult>;
}

export const ANALYSIS_V2_PROFILE_FETCH_DATABASE_NAMES = Object.freeze({
    batchTable: 'analysis_v2_profile_fetch_batches',
    outcomeTable: 'analysis_v2_profile_fetch_outcomes',
    primaryRpc: 'checkpoint_analysis_v2_profile_primary',
    fallbackRpc: 'checkpoint_analysis_v2_profile_fallback',
    loadRpc: 'load_analysis_v2_profile_fetch_checkpoint',
    purgeRpc: 'purge_analysis_v2_profile_fetch_checkpoints',
});

function canonicalRequestedUsernames(usernames: readonly string[]): string[] {
    const parsed = z.array(usernameSchema)
        .min(1)
        .max(MAX_PROFILE_BATCH_SIZE)
        .parse(usernames);
    if (new Set(parsed).size !== parsed.length) {
        throw new Error('ANALYSIS_V2_PROFILE_CHECKPOINT_ERROR: duplicate requested username.');
    }
    return parsed;
}

function canonicalProfile(profile: InstagramProfile): AnalysisV2CheckpointProfile {
    const parsed = inputProfileSchema.safeParse(profile);
    if (!parsed.success) {
        throw new Error(
            'ANALYSIS_V2_PROFILE_CHECKPOINT_ERROR: profile evidence is incomplete or invalid.'
        );
    }
    const postIds = parsed.data.latestPosts?.map(post => post.id) ?? [];
    if (new Set(postIds).size !== postIds.length) {
        throw new Error(
            'ANALYSIS_V2_PROFILE_CHECKPOINT_ERROR: duplicate profile post id.'
        );
    }
    const latestPosts = parsed.data.latestPosts === undefined
        ? undefined
        : [...parsed.data.latestPosts]
            .sort((left, right) => (
                Date.parse(right.timestamp) - Date.parse(left.timestamp)
                || left.id.localeCompare(right.id)
            ))
            .slice(0, MAX_CHECKPOINT_POSTS);
    return analysisV2CheckpointProfileSchema.parse({
        ...parsed.data,
        ...(latestPosts === undefined ? {} : { latestPosts }),
    });
}

function canonicalResults(
    requestedUsernames: readonly string[],
    inputResults: readonly AnalysisV2ProfileAttemptResultInput[],
    allowedSources: readonly ProfileFetchOutcome['source'][]
): AnalysisV2CheckpointResult[] {
    const outcomes = inputResults.map(result => profileFetchOutcomeSchema.parse(result.outcome));
    summarizeProfileFetchOutcomes(requestedUsernames, outcomes);
    const allowed = new Set(allowedSources);
    const byUsername = new Map(inputResults.map(result => [
        profileFetchOutcomeSchema.parse(result.outcome).requestedUsername,
        result,
    ]));

    return requestedUsernames.map((username) => {
        const input = byUsername.get(username);
        if (!input) {
            throw new Error('ANALYSIS_V2_PROFILE_CHECKPOINT_ERROR: missing result.');
        }
        const outcome = profileFetchOutcomeSchema.parse(input.outcome);
        if (!allowed.has(outcome.source)) {
            throw new Error('ANALYSIS_V2_PROFILE_CHECKPOINT_ERROR: invalid attempt source.');
        }
        if (outcome.status === 'success') {
            if (!input.profile) {
                throw new Error('ANALYSIS_V2_PROFILE_CHECKPOINT_ERROR: success needs a profile.');
            }
            return analysisV2CheckpointResultSchema.parse({
                outcome,
                profile: canonicalProfile(input.profile),
            });
        }
        if (input.profile !== undefined) {
            throw new Error('ANALYSIS_V2_PROFILE_CHECKPOINT_ERROR: failed result has a profile.');
        }
        return analysisV2CheckpointResultSchema.parse({ outcome });
    });
}

function databaseOutcomes(results: readonly AnalysisV2CheckpointResult[]): unknown[] {
    return results.map((result) => ({
        username: result.outcome.requestedUsername,
        source: result.outcome.source,
        status: result.outcome.status,
        failure_category: result.outcome.failureCategory,
        http_status: result.outcome.httpStatus,
        request_count: result.outcome.requestCount,
        latency_ms: result.outcome.latencyMs,
        captured_at: result.outcome.capturedAt,
        profile: 'profile' in result ? result.profile : null,
    }));
}

function validateIdentity(input: AnalysisV2ProfileFetchCheckpointIdentity): void {
    if (
        !UUID_PATTERN.test(input.requestId)
        || !JOB_KEY_PATTERN.test(input.jobKey)
        || !UUID_PATTERN.test(input.claimToken)
        || !SHA256_PATTERN.test(input.jobInputHash)
    ) {
        throw new Error('ANALYSIS_V2_PROFILE_CHECKPOINT_ERROR: invalid checkpoint identity.');
    }
}

function sameOrderedSet(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length
        && left.every((username, index) => username === right[index]);
}

function validateResumeSets(value: {
    requestedUsernames: readonly string[];
    frozenUnresolvedUsernames: readonly string[];
    primaryResults: readonly AnalysisV2CheckpointResult[];
    fallbackResults: readonly AnalysisV2CheckpointResult[];
    fallbackCapturedAt: string | null;
}): void {
    const summary = summarizeProfileFetchOutcomes(
        value.requestedUsernames,
        value.primaryResults.map(result => result.outcome)
    );
    if (!sameOrderedSet(
        value.primaryResults.map(result => result.outcome.requestedUsername),
        value.requestedUsernames
    )) {
        throw new Error('Primary outcomes do not match requested username order.');
    }
    if (!sameOrderedSet(summary.unresolvedUsernames, value.frozenUnresolvedUsernames)) {
        throw new Error('Frozen unresolved usernames do not match primary outcomes.');
    }
    if (value.primaryResults.some(result => result.outcome.source === 'apify')) {
        throw new Error('Primary checkpoint contains a paid fallback outcome.');
    }
    if (value.fallbackResults.length === 0) {
        if (value.fallbackCapturedAt !== null) {
            throw new Error('Empty fallback checkpoint has a completion timestamp.');
        }
        return;
    }
    if (value.fallbackCapturedAt === null) {
        throw new Error('Fallback checkpoint is missing its completion timestamp.');
    }
    summarizeProfileFetchOutcomes(
        value.frozenUnresolvedUsernames,
        value.fallbackResults.map(result => result.outcome)
    );
    if (!sameOrderedSet(
        value.fallbackResults.map(result => result.outcome.requestedUsername),
        value.frozenUnresolvedUsernames
    )) {
        throw new Error('Fallback outcomes do not match frozen username order.');
    }
    if (value.fallbackResults.some(result => result.outcome.source !== 'apify')) {
        throw new Error('Fallback checkpoint contains a non-Apify outcome.');
    }
}

function safeRpcCode(error: RpcError): string {
    return typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : 'unknown';
}

function throwRpcError(error: RpcError, operation: string): never {
    const knownConflict = [
        'ANALYSIS_V2_PROFILE_PRIMARY_CONFLICT',
        'ANALYSIS_V2_PROFILE_FALLBACK_CONFLICT',
        'ANALYSIS_V2_PROFILE_CHECKPOINT_INVALID',
        'ANALYSIS_V2_PROFILE_CHECKPOINT_NOT_READY',
        'ANALYSIS_V2_PROFILE_CHECKPOINT_FENCE_MISMATCH',
    ].find(message => error.message === message);
    if (knownConflict) throw new Error(knownConflict);
    throw new Error(
        `ANALYSIS_V2_PROFILE_CHECKPOINT_ERROR: ${operation} failed (${safeRpcCode(error)}).`
    );
}

function parseResume(data: unknown, operation: string): AnalysisV2ProfileFetchResume {
    const parsed = analysisV2ProfileFetchResumeSchema.safeParse(data);
    if (!parsed.success) {
        throw new Error(
            `ANALYSIS_V2_PROFILE_CHECKPOINT_ERROR: invalid ${operation} response.`
        );
    }
    return parsed.data;
}

export function createAnalysisV2ProfileFetchCheckpointStore(
    client: AnalysisV2ProfileFetchSupabaseClient = supabaseAdmin
): AnalysisV2ProfileFetchCheckpointStore {
    const loadCheckpoint = async (
        input: AnalysisV2ProfileFetchCheckpointIdentity
    ): Promise<AnalysisV2ProfileFetchResume | null> => {
        validateIdentity(input);
        const { data, error } = await client.rpc(
            ANALYSIS_V2_PROFILE_FETCH_DATABASE_NAMES.loadRpc,
            {
                p_request_id: input.requestId,
                p_job_key: input.jobKey,
                p_claim_token: input.claimToken,
                p_job_input_hash: input.jobInputHash,
            }
        );
        if (error) throwRpcError(error, 'checkpoint load');
        return data === null ? null : parseResume(data, 'checkpoint load');
    };

    return {
        async checkpointPrimary(input) {
            validateIdentity(input);
            const requestedUsernames = canonicalRequestedUsernames(input.requestedUsernames);
            const results = canonicalResults(
                requestedUsernames,
                input.results,
                ['cache', 'selfhosted']
            );
            const { data, error } = await client.rpc(
                ANALYSIS_V2_PROFILE_FETCH_DATABASE_NAMES.primaryRpc,
                {
                    p_request_id: input.requestId,
                    p_job_key: input.jobKey,
                    p_claim_token: input.claimToken,
                    p_job_input_hash: input.jobInputHash,
                    p_requested_usernames: requestedUsernames,
                    p_outcomes: databaseOutcomes(results),
                }
            );
            if (error) throwRpcError(error, 'primary checkpoint');
            return parseResume(data, 'primary checkpoint');
        },

        async checkpointFallback(input) {
            validateIdentity(input);
            const current = await loadCheckpoint(input);
            if (!current) {
                throw new Error('ANALYSIS_V2_PROFILE_CHECKPOINT_NOT_READY');
            }
            if (current.frozenUnresolvedUsernames.length === 0) {
                throw new Error(
                    'ANALYSIS_V2_PROFILE_CHECKPOINT_ERROR: fallback set is empty.'
                );
            }
            const results = canonicalResults(
                current.frozenUnresolvedUsernames,
                input.results,
                ['apify']
            );
            const { data, error } = await client.rpc(
                ANALYSIS_V2_PROFILE_FETCH_DATABASE_NAMES.fallbackRpc,
                {
                    p_request_id: input.requestId,
                    p_job_key: input.jobKey,
                    p_claim_token: input.claimToken,
                    p_job_input_hash: input.jobInputHash,
                    p_outcomes: databaseOutcomes(results),
                }
            );
            if (error) throwRpcError(error, 'fallback checkpoint');
            return parseResume(data, 'fallback checkpoint');
        },

        async load(input) {
            return loadCheckpoint(input);
        },

        async purgeTerminal(requestId) {
            if (!UUID_PATTERN.test(requestId)) {
                throw new Error('ANALYSIS_V2_PROFILE_CHECKPOINT_ERROR: invalid request id.');
            }
            const { data, error } = await client.rpc(
                ANALYSIS_V2_PROFILE_FETCH_DATABASE_NAMES.purgeRpc,
                { p_request_id: requestId }
            );
            if (error) throwRpcError(error, 'terminal purge');
            if (!Number.isSafeInteger(data) || (data as number) < 0) {
                throw new Error(
                    'ANALYSIS_V2_PROFILE_CHECKPOINT_ERROR: invalid terminal purge response.'
                );
            }
            return data as number;
        },
    };
}

export const analysisV2ProfileFetchCheckpointStore =
    createAnalysisV2ProfileFetchCheckpointStore();
