import { z } from 'zod';
import { INSTAGRAM_USERNAME_PATTERN } from '../username';
import {
    APIFY_PROVIDER_QUOTA_ERROR_CODE,
    APIFY_PROVIDER_START_REJECTED_ERROR_CODE,
    getApifyClient,
    integerSetting,
    isApifyProviderLifecycleError,
    throwIfApifyQueuedStartCancelled,
    numberSetting,
    runWithApifyActorSlot,
    selectApifyCredentialSlot,
    startOrResumeApifyActor,
    type ApifyClientLike,
} from './apify-relationship';
import type { ApifyCredentialSlot, ProviderCallContext } from './types';

export const APIFY_LIKERS_ACTOR_ID = 'datadoping/instagram-likes-scraper';
export const APIFY_COMMENTS_ACTOR_ID = 'apify/instagram-comment-scraper';

const DEFAULT_LIKERS_BUILD = '0.0.9';
const DEFAULT_COMMENTS_BUILD = '0.0.498';
const MAX_DATASET_PAGE_SIZE = 1_000;

export interface ApifyPostLiker {
    postUrl: string;
    id: string;
    username: string;
    fullName?: string;
    profilePicUrl: string;
    isPrivate: boolean;
    isVerified: boolean;
    totalLikes: number;
}

export interface ApifyPostComment {
    postUrl: string;
    commentUrl?: string;
    parentCommentUrl?: string;
    id: string;
    text: string;
    ownerUsername: string;
    ownerProfilePicUrl?: string;
    timestamp: string;
    likesCount?: number;
}

export interface ApifyInteractionAdapter {
    getPostLikers(
        postUrls: string[],
        limitPerPost: number,
        context?: ProviderCallContext
    ): Promise<ApifyPostLiker[]>;
    getPostComments(
        postUrls: string[],
        limitPerPost: number,
        context?: ProviderCallContext
    ): Promise<ApifyPostComment[]>;
}

export interface ApifyInteractionDeps {
    client?: ApifyClientLike;
    env?: Record<string, string | undefined>;
}

interface PostIdentity {
    canonicalUrl: string;
    shortCode: string;
}

interface ActorDefinition {
    actorId: string;
    actorBuild: string;
    actorConcurrency: number;
    credentialSlot: ApifyCredentialSlot;
    datasetReadRetries: number;
    datasetRetryBaseDelayMs: number;
    estimatedCostPerResultUsd: number;
    maximumEstimatedCostUsd: number;
    maximumPerPostLimit: number;
    maximumTotalResults: number;
    maximumUrls: number;
    minimumUniqueRatio: number;
    timeoutSecs: number;
}

const unknownRecordSchema = z.record(z.string(), z.unknown());
const decimalIdSchema = z.union([
    z.string().regex(/^[1-9]\d*$/),
    z.number().int().positive().safe(),
]);

const likerCoreSchema = z.strictObject({
    full_name: z.string(),
    id: decimalIdSchema,
    is_private: z.boolean(),
    is_verified: z.boolean(),
    profile_pic_url: z.string().url(),
    username: z.string().trim().regex(INSTAGRAM_USERNAME_PATTERN),
    liked_post: z.string().trim().min(1),
    total_likes: z.number().int().nonnegative(),
});

const commentErrorSchema = z.strictObject({
    error: z.string().nullable().optional(),
    errorDescription: z.string().nullable().optional(),
    requestErrorMessages: z.array(z.string()).nullable().optional(),
});

const commentCoreSchema = z.strictObject({
    postUrl: z.string().url().nullable().optional(),
    url: z.string().url().nullable().optional(),
    commentUrl: z.string().url().nullable().optional(),
    parentCommentUrl: z.string().url().nullable().optional(),
    id: z.string().trim().min(1),
    text: z.string().min(1),
    ownerUsername: z.string().trim().regex(INSTAGRAM_USERNAME_PATTERN),
    ownerProfilePicUrl: z.string().url().nullable().optional(),
    timestamp: z.string().datetime({ offset: true }),
    likesCount: z.number().int().nonnegative().nullable().optional(),
    replies: z.array(z.unknown()).nullable().optional(),
});

const datasetPageSchema = z.object({
    items: z.array(unknownRecordSchema),
    total: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    count: z.number().int().nonnegative(),
}).passthrough();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function hasDurableRunCheckpoint(context?: ProviderCallContext): boolean {
    return Boolean(context?.resumeRunId || context?.onRunStarted);
}

function parsePostIdentity(value: string, allowNestedPath = false): PostIdentity {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error('SCRAPING_CONFIG_ERROR: Instagram post URL is invalid.');
    }

    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    const segments = url.pathname.split('/').filter(Boolean);
    const postType = segments[0]?.toLowerCase();
    const shortCode = segments[1];
    if (
        url.protocol !== 'https:' ||
        hostname !== 'instagram.com' ||
        !['p', 'reel', 'reels'].includes(postType) ||
        !shortCode ||
        !/^[A-Za-z0-9_-]+$/.test(shortCode) ||
        (!allowNestedPath && segments.length !== 2)
    ) {
        throw new Error('SCRAPING_CONFIG_ERROR: Instagram post URL is invalid.');
    }

    const canonicalType = postType === 'p' ? 'p' : 'reel';
    return {
        canonicalUrl: `https://www.instagram.com/${canonicalType}/${shortCode}/`,
        shortCode,
    };
}

function actorBuildSetting(
    env: Record<string, string | undefined>,
    key: string,
    fallback: string
): string {
    const build = env[key]?.trim() || fallback;
    if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(build)) {
        throw new Error(`SCRAPING_CONFIG_ERROR: ${key} must be an exact x.y.z build.`);
    }
    return build;
}

function definition(
    env: Record<string, string | undefined>,
    kind: 'likers' | 'comments'
): ActorDefinition {
    const prefix = kind === 'likers' ? 'APIFY_LIKERS' : 'APIFY_COMMENTS';
    const defaultMaximumPerPostLimit = kind === 'likers' ? 150 : 15;
    const defaultMaximumTotalResults = kind === 'likers' ? 1_500 : 90;
    const defaultMaximumUrls = kind === 'likers' ? 10 : 6;
    const defaultCostPerResult = kind === 'likers' ? 0.00155 : 0.0026;
    const defaultMaximumCost = defaultMaximumTotalResults * defaultCostPerResult;

    return {
        actorId: kind === 'likers' ? APIFY_LIKERS_ACTOR_ID : APIFY_COMMENTS_ACTOR_ID,
        actorBuild: actorBuildSetting(
            env,
            `${prefix}_BUILD`,
            kind === 'likers' ? DEFAULT_LIKERS_BUILD : DEFAULT_COMMENTS_BUILD
        ),
        actorConcurrency: integerSetting(env, 'APIFY_ACTOR_CONCURRENCY', 2, 1, 10),
        credentialSlot: selectApifyCredentialSlot(env),
        datasetReadRetries: integerSetting(env, 'APIFY_DATASET_READ_RETRIES', 5, 0, 8),
        datasetRetryBaseDelayMs: integerSetting(
            env,
            'APIFY_DATASET_RETRY_BASE_DELAY_MS',
            500,
            0,
            30_000
        ),
        estimatedCostPerResultUsd: numberSetting(
            env,
            `${prefix}_ESTIMATED_COST_PER_RESULT_USD`,
            defaultCostPerResult,
            0.00000001,
            100
        ),
        maximumEstimatedCostUsd: numberSetting(
            env,
            `${prefix}_MAX_ESTIMATED_COST_USD_PER_OPERATION`,
            defaultMaximumCost,
            0.00000001,
            100_000
        ),
        maximumPerPostLimit: integerSetting(
            env,
            `${prefix}_MAX_RESULTS_PER_POST`,
            defaultMaximumPerPostLimit,
            1,
            1_000
        ),
        maximumTotalResults: integerSetting(
            env,
            `${prefix}_MAX_TOTAL_RESULTS_PER_OPERATION`,
            defaultMaximumTotalResults,
            1,
            500_000
        ),
        maximumUrls: integerSetting(
            env,
            `${prefix}_MAX_URLS_PER_OPERATION`,
            defaultMaximumUrls,
            1,
            10_000
        ),
        minimumUniqueRatio: numberSetting(
            env,
            `${prefix}_MIN_UNIQUE_RATIO`,
            0.95,
            0,
            1
        ),
        timeoutSecs: integerSetting(env, `${prefix}_TIMEOUT_SECS`, 300, 30, 3_600),
    };
}

function assertOperationBudget(
    urlCount: number,
    limitPerPost: number,
    config: ActorDefinition,
    storedMaximumChargeUsd?: number
): { maximumChargeUsd: number; totalLimit: number } {
    if (urlCount < 1 || urlCount > config.maximumUrls) {
        throw new Error(
            `SCRAPING_CONFIG_ERROR: postUrls must contain 1 to ${config.maximumUrls} URLs.`
        );
    }
    if (
        !Number.isInteger(limitPerPost) ||
        limitPerPost < 1 ||
        limitPerPost > config.maximumPerPostLimit
    ) {
        throw new Error(
            `SCRAPING_CONFIG_ERROR: limitPerPost must be an integer from 1 to ${config.maximumPerPostLimit}.`
        );
    }
    const totalLimit = urlCount * limitPerPost;
    if (!Number.isSafeInteger(totalLimit) || totalLimit > config.maximumTotalResults) {
        throw new Error(
            `SCRAPING_BUDGET_ERROR: Apify interaction cannot exceed ${config.maximumTotalResults} total results per operation.`
        );
    }
    const rawEstimate = totalLimit * config.estimatedCostPerResultUsd;
    if (
        storedMaximumChargeUsd === undefined
        && rawEstimate > config.maximumEstimatedCostUsd + Number.EPSILON
    ) {
        throw new Error(
            'SCRAPING_BUDGET_ERROR: Apify interaction estimated-cost ceiling would be exceeded.'
        );
    }
    return {
        maximumChargeUsd: storedMaximumChargeUsd ?? Number(rawEstimate.toFixed(12)),
        totalLimit,
    };
}

function actorRequestError(error: unknown): Error {
    const parsed = z.object({ statusCode: z.number().int() }).safeParse(error);
    if (parsed.success && parsed.data.statusCode >= 400 && parsed.data.statusCode <= 599) {
        return new Error(
            `SCRAPING_ERROR: Apify interaction actor transport request failed (HTTP ${parsed.data.statusCode}).`
        );
    }
    return new Error('SCRAPING_ERROR: Apify interaction actor transport request failed.');
}

async function readBoundedDataset(
    client: ApifyClientLike,
    datasetId: string,
    limit: number,
    config: ActorDefinition,
    context?: ProviderCallContext
): Promise<Array<Record<string, unknown>>> {
    const dataset = client.dataset(datasetId);
    const items: Array<Record<string, unknown>> = [];
    const chargedItemsByOffset = new Map<number, number>();
    let expectedTotal: number | undefined;
    let offset = 0;

    while (offset <= limit) {
        const pageLimit = Math.min(MAX_DATASET_PAGE_SIZE, limit + 1 - offset);
        let page: z.infer<typeof datasetPageSchema> | undefined;
        let lastError: Error | undefined;

        for (let attempt = 0; attempt <= config.datasetReadRetries; attempt++) {
            try {
                const rawPage = await dataset.listItems({ offset, limit: pageLimit });
                const parsed = datasetPageSchema.safeParse(rawPage);
                if (!parsed.success) {
                    throw new Error(
                        `SCRAPING_SCHEMA_ERROR: APIFY_INTERACTION_DATASET_PAGE_INVALID ${parsed.error.issues[0]?.message ?? ''}`
                    );
                }
                page = parsed.data;
                lastError = undefined;
            } catch (error) {
                page = undefined;
                lastError = error instanceof Error && error.message.startsWith('SCRAPING_SCHEMA_ERROR:')
                    ? error
                    : hasDurableRunCheckpoint(context)
                        ? new Error(
                            'SCRAPING_DATASET_TRANSIENT_ERROR: APIFY_INTERACTION_DATASET_TRANSPORT_EXHAUSTED Dataset transport request failed.'
                        )
                        : new Error(
                            'SCRAPING_ERROR: APIFY_INTERACTION_DATASET_TRANSPORT_EXHAUSTED Dataset transport request failed.'
                        );
            }

            if (page) {
                const alreadyCharged = chargedItemsByOffset.get(offset) ?? 0;
                if (page.items.length > alreadyCharged) {
                    context?.recordUsage({
                        estimated_cost_usd:
                            (page.items.length - alreadyCharged) *
                            config.estimatedCostPerResultUsd,
                    });
                    chargedItemsByOffset.set(offset, page.items.length);
                }

                if (page.offset !== offset) {
                    lastError = new Error(
                        'SCRAPING_INCOMPLETE_ERROR: APIFY_INTERACTION_DATASET_OFFSET_MISMATCH Dataset offset changed.'
                    );
                } else if (page.count !== page.items.length) {
                    lastError = new Error(
                        'SCRAPING_INCOMPLETE_ERROR: APIFY_INTERACTION_DATASET_COUNT_MISMATCH Dataset count is inconsistent.'
                    );
                } else if (expectedTotal !== undefined && page.total !== expectedTotal) {
                    lastError = new Error(
                        'SCRAPING_INCOMPLETE_ERROR: APIFY_INTERACTION_DATASET_TOTAL_CHANGED Dataset total changed.'
                    );
                } else if (offset + page.items.length > page.total) {
                    lastError = new Error(
                        'SCRAPING_INCOMPLETE_ERROR: APIFY_INTERACTION_DATASET_TOTAL_LAGGING Dataset total is inconsistent.'
                    );
                } else if (page.items.length === 0 && offset < page.total) {
                    lastError = new Error(
                        'SCRAPING_INCOMPLETE_ERROR: APIFY_INTERACTION_DATASET_PAGE_EMPTY Dataset ended early.'
                    );
                } else if (
                    offset === 0 &&
                    page.total === 0 &&
                    attempt < config.datasetReadRetries
                ) {
                    lastError = hasDurableRunCheckpoint(context)
                        ? new Error(
                            'SCRAPING_DATASET_TRANSIENT_ERROR: APIFY_INTERACTION_DATASET_EMPTY_UNSETTLED Dataset is not settled yet.'
                        )
                        : new Error(
                            'SCRAPING_INCOMPLETE_ERROR: APIFY_INTERACTION_DATASET_EMPTY_UNSETTLED Dataset is not settled yet.'
                        );
                } else {
                    lastError = undefined;
                    break;
                }
            }

            if (attempt < config.datasetReadRetries) {
                await sleep(config.datasetRetryBaseDelayMs * 2 ** attempt);
            }
        }

        if (lastError) throw lastError;
        if (!page) {
            throw new Error('SCRAPING_ERROR: Apify interaction dataset response is missing.');
        }
        if (page.total > limit) {
            throw new Error(
                'SCRAPING_INCOMPLETE_ERROR: APIFY_INTERACTION_DATASET_LIMIT_EXCEEDED Dataset exceeded the requested limit.'
            );
        }

        expectedTotal = page.total;
        items.push(...page.items);
        offset += page.items.length;
        if (offset >= page.total) break;
    }

    if (expectedTotal !== undefined && items.length !== expectedTotal) {
        throw new Error(
            'SCRAPING_INCOMPLETE_ERROR: APIFY_INTERACTION_DATASET_READ_INCOMPLETE Dataset was not fully read.'
        );
    }
    return items;
}

async function runActor(
    client: ApifyClientLike,
    config: ActorDefinition,
    input: unknown,
    urlCount: number,
    limitPerPost: number,
    context?: ProviderCallContext
): Promise<Array<Record<string, unknown>>> {
    const { maximumChargeUsd, totalLimit } = assertOperationBudget(
        urlCount,
        limitPerPost,
        config,
        context?.maxChargeUsd
    );
    return runWithApifyActorSlot(config.actorConcurrency, async () => {
        throwIfApifyQueuedStartCancelled(context);
        context?.recordUsage({ request_count: 1 });
        let run;
        try {
            run = await startOrResumeApifyActor(client, config.actorId, input, {
                logicalProvider: 'apify',
                credentialSlot: config.credentialSlot,
                actorBuild: config.actorBuild,
                timeoutSecs: config.timeoutSecs,
                maxItems: totalLimit,
                maxTotalChargeUsd: maximumChargeUsd,
            }, context);
        } catch (error) {
            if (
                error instanceof Error
                && (
                    error.message.startsWith('SCRAPING_AMBIGUOUS_START_ERROR:')
                    || error.message === APIFY_PROVIDER_START_REJECTED_ERROR_CODE
                    || error.message.startsWith('SCRAPING_RUN_CHECKPOINT_ERROR:')
                    || error.message.startsWith('SCRAPING_RUN_PENDING_ERROR:')
                    || error.message === APIFY_PROVIDER_QUOTA_ERROR_CODE
                    || error.message.startsWith('ANALYSIS_PERSISTENCE_ERROR:')
                    || isApifyProviderLifecycleError(error)
                )
            ) {
                throw error;
            }
            throw actorRequestError(error);
        }

        if (run.status !== 'SUCCEEDED') {
            throw new Error(
                `SCRAPING_ERROR: Apify interaction actor failed (status=${run.status}).`
            );
        }
        if (!run.defaultDatasetId) {
            throw new Error(
                'SCRAPING_SCHEMA_ERROR: Apify interaction run has no defaultDatasetId.'
            );
        }
        return readBoundedDataset(client, run.defaultDatasetId, totalLimit, config, context);
    });
}

function parseRequestedPosts(postUrls: string[]): Map<string, PostIdentity> {
    if (!Array.isArray(postUrls)) {
        throw new Error('SCRAPING_CONFIG_ERROR: postUrls must be an array.');
    }
    const posts = new Map<string, PostIdentity>();
    for (const value of postUrls) {
        const post = parsePostIdentity(value);
        if (posts.has(post.shortCode)) {
            throw new Error('SCRAPING_CONFIG_ERROR: postUrls must not contain duplicates.');
        }
        posts.set(post.shortCode, post);
    }
    return posts;
}

function attributedPost(
    returnedUrl: string,
    expectedPosts: Map<string, PostIdentity>,
    resultType: 'liker' | 'comment'
): PostIdentity {
    let returned: PostIdentity;
    try {
        returned = parsePostIdentity(returnedUrl, true);
    } catch {
        throw new Error(
            `SCRAPING_SCHEMA_ERROR: APIFY_${resultType.toUpperCase()}_POST_URL_INVALID Actor result has an invalid post URL.`
        );
    }
    const expected = expectedPosts.get(returned.shortCode);
    if (!expected) {
        throw new Error(
            `SCRAPING_INCOMPLETE_ERROR: APIFY_${resultType.toUpperCase()}_POST_MISMATCH Actor result belongs to another post.`
        );
    }
    return expected;
}

function projectLiker(
    item: Record<string, unknown>,
    index: number,
    expectedPosts: Map<string, PostIdentity>
): ApifyPostLiker {
    const parsed = likerCoreSchema.safeParse({
        full_name: item.full_name,
        id: item.id,
        is_private: item.is_private,
        is_verified: item.is_verified,
        profile_pic_url: item.profile_pic_url,
        username: item.username,
        liked_post: item.liked_post,
        total_likes: item.total_likes,
    });
    if (!parsed.success) {
        throw new Error(
            `SCRAPING_SCHEMA_ERROR: APIFY_LIKER_ROW_INVALID Row ${index} is invalid. ${parsed.error.issues[0]?.message ?? ''}`
        );
    }
    const expectedPost = attributedPost(parsed.data.liked_post, expectedPosts, 'liker');
    return {
        postUrl: expectedPost.canonicalUrl,
        id: String(parsed.data.id),
        username: parsed.data.username,
        fullName: parsed.data.full_name || undefined,
        profilePicUrl: parsed.data.profile_pic_url,
        isPrivate: parsed.data.is_private,
        isVerified: parsed.data.is_verified,
        totalLikes: parsed.data.total_likes,
    };
}

function projectComment(
    item: Record<string, unknown>,
    index: number,
    expectedPosts: Map<string, PostIdentity>
): ApifyPostComment {
    const actorError = commentErrorSchema.safeParse({
        error: item.error,
        errorDescription: item.errorDescription,
        requestErrorMessages: item.requestErrorMessages,
    });
    if (!actorError.success) {
        throw new Error(
            `SCRAPING_SCHEMA_ERROR: APIFY_COMMENT_ERROR_ROW_INVALID Row ${index} has invalid error metadata.`
        );
    }
    const errorMessages = [
        actorError.data.error,
        actorError.data.errorDescription,
        ...(actorError.data.requestErrorMessages ?? []),
    ].filter((message): message is string => Boolean(message));
    if (errorMessages.length > 0) {
        throw new Error(
            'SCRAPING_ERROR: APIFY_COMMENT_ACTOR_ERROR Comment actor returned an error row.'
        );
    }

    const parsed = commentCoreSchema.safeParse({
        postUrl: item.postUrl,
        url: item.url,
        commentUrl: item.commentUrl,
        parentCommentUrl: item.parentCommentUrl,
        id: item.id,
        text: item.text,
        ownerUsername: item.ownerUsername,
        ownerProfilePicUrl: item.ownerProfilePicUrl,
        timestamp: item.timestamp,
        likesCount: item.likesCount,
        replies: item.replies,
    });
    if (!parsed.success) {
        throw new Error(
            `SCRAPING_SCHEMA_ERROR: APIFY_COMMENT_ROW_INVALID Row ${index} is invalid. ${parsed.error.issues[0]?.message ?? ''}`
        );
    }
    if ((parsed.data.replies?.length ?? 0) > 0) {
        throw new Error(
            'SCRAPING_SCHEMA_ERROR: APIFY_COMMENT_REPLIES_UNEXPECTED Nested replies were returned despite the bounded input.'
        );
    }

    const returnedPostUrl = parsed.data.postUrl ?? parsed.data.url;
    if (returnedPostUrl) {
        const expectedPost = attributedPost(returnedPostUrl, expectedPosts, 'comment');
        return {
            postUrl: expectedPost.canonicalUrl,
            commentUrl: parsed.data.commentUrl ?? undefined,
            parentCommentUrl: parsed.data.parentCommentUrl ?? undefined,
            id: parsed.data.id,
            text: parsed.data.text,
            ownerUsername: parsed.data.ownerUsername,
            ownerProfilePicUrl: parsed.data.ownerProfilePicUrl ?? undefined,
            timestamp: parsed.data.timestamp,
            likesCount: parsed.data.likesCount ?? undefined,
        };
    }
    if (expectedPosts.size !== 1) {
        throw new Error(
            'SCRAPING_SCHEMA_ERROR: APIFY_COMMENT_POST_URL_MISSING A batched comment row has no post attribution.'
        );
    }
    const expectedPost = expectedPosts.values().next().value;
    if (!expectedPost) {
        throw new Error('SCRAPING_SCHEMA_ERROR: APIFY_COMMENT_POST_URL_MISSING.');
    }
    return {
        postUrl: expectedPost.canonicalUrl,
        commentUrl: parsed.data.commentUrl ?? undefined,
        parentCommentUrl: parsed.data.parentCommentUrl ?? undefined,
        id: parsed.data.id,
        text: parsed.data.text,
        ownerUsername: parsed.data.ownerUsername,
        ownerProfilePicUrl: parsed.data.ownerProfilePicUrl ?? undefined,
        timestamp: parsed.data.timestamp,
        likesCount: parsed.data.likesCount ?? undefined,
    };
}

function dedupeAndRecord<T>(
    items: T[],
    keyFor: (item: T) => string,
    minimumUniqueRatio: number,
    context?: ProviderCallContext
): T[] {
    const unique = new Map<string, T>();
    for (const item of items) {
        const key = keyFor(item);
        if (!unique.has(key)) unique.set(key, item);
    }
    const uniqueRatio = items.length > 0 ? unique.size / items.length : 1;
    if (uniqueRatio < minimumUniqueRatio) {
        context?.recordUsage({
            raw_result_count: items.length,
            unique_result_count: unique.size,
        });
        throw new Error(
            'SCRAPING_INCOMPLETE_ERROR: Apify interaction duplicate ratio exceeded the configured threshold.'
        );
    }
    const result = [...unique.values()];
    context?.recordUsage({
        result_count: result.length,
        raw_result_count: items.length,
        unique_result_count: unique.size,
    });
    return result;
}

function assertPerPostLimit<T extends { postUrl: string }>(
    items: T[],
    limitPerPost: number
): void {
    const counts = new Map<string, number>();
    for (const item of items) {
        const next = (counts.get(item.postUrl) ?? 0) + 1;
        if (next > limitPerPost) {
            throw new Error(
                'SCRAPING_INCOMPLETE_ERROR: APIFY_INTERACTION_PER_POST_LIMIT_EXCEEDED Actor exceeded the per-post result limit.'
            );
        }
        counts.set(item.postUrl, next);
    }
}

export function makeApifyInteractionAdapter(
    deps: ApifyInteractionDeps = {}
): ApifyInteractionAdapter {
    const env = deps.env ?? process.env;
    const client = (credentialSlot?: ProviderCallContext['credentialSlot']) =>
        deps.client ?? getApifyClient(env, credentialSlot);

    return {
        async getPostLikers(postUrls, limitPerPost, context) {
            const posts = parseRequestedPosts(postUrls);
            const config = definition(env, 'likers');
            const items = await runActor(
                client(context?.credentialSlot),
                config,
                {
                    posts: [...posts.values()].map((post) => post.canonicalUrl),
                    max_count: limitPerPost,
                },
                posts.size,
                limitPerPost,
                context
            );
            const likers = items.map((item, index) => projectLiker(item, index, posts));
            assertPerPostLimit(likers, limitPerPost);
            return dedupeAndRecord(
                likers,
                (liker) => `${liker.postUrl}\n${liker.username.toLowerCase()}`,
                config.minimumUniqueRatio,
                context
            );
        },

        async getPostComments(postUrls, limitPerPost, context) {
            const posts = parseRequestedPosts(postUrls);
            const config = definition(env, 'comments');
            const items = await runActor(
                client(context?.credentialSlot),
                config,
                {
                    directUrls: [...posts.values()].map((post) => post.canonicalUrl),
                    resultsLimit: limitPerPost,
                    includeNestedComments: false,
                },
                posts.size,
                limitPerPost,
                context
            );
            const comments = items.map((item, index) => projectComment(item, index, posts));
            assertPerPostLimit(comments, limitPerPost);
            return dedupeAndRecord(
                comments,
                (comment) => `${comment.postUrl}\n${comment.id}`,
                config.minimumUniqueRatio,
                context
            );
        },
    };
}

export const apifyInteractionAdapter = makeApifyInteractionAdapter();
