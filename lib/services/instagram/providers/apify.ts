import { z } from 'zod';
import type {
    InstagramPostMediaItem,
    InstagramProfile,
    InstagramPost,
} from '@/lib/types/instagram';
import { MAX_RECENT_POSTS } from '@/lib/domain/analysis/media-policy';
import type {
    ProfileAttemptResult,
    ProviderCallContext,
    ScraperProvider,
} from './types';
import {
    failedProfileAttempt,
    profileAttemptLatency,
    successfulProfileAttempt,
    unavailableProfileAttempt,
} from './profile-attempt';
import { INSTAGRAM_USERNAME_PATTERN, mergeInstagramMentions } from '../username';
import { normalizeInstagramTimestamp } from '../timestamp';
import {
    APIFY_PROVIDER_QUOTA_ERROR_CODE,
    getApifyClient,
    integerSetting,
    isApifyProviderLifecycleError,
    isApifyQueuedStartCancellation,
    throwIfApifyQueuedStartCancelled,
    numberSetting,
    runApifyRelationshipActor,
    runWithApifyActorSlot,
    selectApifyCredentialSlot,
    startOrResumeApifyActor,
    type ApifyClientLike,
    type ApifyRelationshipActorDefinition,
    type ApifyRelationshipKind,
} from './apify-relationship';

export const APIFY_PROFILE_ACTOR_ID = 'apify/instagram-profile-scraper';
export const APIFY_PROFILE_SUMMARY_MAX_CHARGE_USD = 0.0026;
const APIFY_PROFILE_SUMMARY_WAIT_LIMIT_SECS = 75;
export const APIFY_RELATIONSHIP_ACTOR_ID =
    'scraping_solutions/instagram-scraper-followers-following-no-cookies';
const DEFAULT_APIFY_RELATIONSHIP_BUILD = '0.0.71';
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const RESUMABLE_APIFY_STATUSES = new Set(['READY', 'RUNNING', 'TIMING-OUT', 'ABORTING']);
export const APIFY_PROFILE_DATASET_HEADROOM_MS = 20_000;

async function withinProfileDeadline<T>(pending: Promise<T>, deadlineAtMs?: number): Promise<T> {
    if (deadlineAtMs === undefined) return pending;
    const remainingMs = deadlineAtMs - Date.now();
    if (!Number.isFinite(deadlineAtMs) || remainingMs <= 0) {
        throw new Error(
            'SCRAPING_INCOMPLETE_ERROR: Apify profile dataset deadline was exhausted.'
        );
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            pending,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error(
                        'SCRAPING_INCOMPLETE_ERROR: Apify profile dataset deadline was exhausted.'
                    )),
                    remainingMs
                );
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

interface ApifyProviderDeps {
    client?: ApifyClientLike;
    env?: Record<string, string | undefined>;
}

function hasDurableProfileRunCheckpoint(context?: ProviderCallContext): boolean {
    return Boolean(
        context?.resumeRunId
        || context?.startReserved
        || context?.onRunStarted
    );
}

function isTypedScrapingError(error: unknown, ...prefixes: string[]): error is Error {
    return error instanceof Error
        && prefixes.some(prefix => error.message.startsWith(prefix));
}

function isProgressPersistenceError(error: unknown): error is Error {
    return isTypedScrapingError(
        error,
        'ANALYSIS_PERSISTENCE_ERROR:',
        'ANALYSIS_V2_PROGRESS_'
    );
}

async function reportProfileStart(
    context: ProviderCallContext | undefined,
    username: string
): Promise<void> {
    try {
        await context?.onProfileStart?.(username);
    } catch (error) {
        if (isProgressPersistenceError(error)) throw error;
        throw new Error('ANALYSIS_PERSISTENCE_ERROR: active profile heartbeat failed.');
    }
}

function profileRunPending(message: string): Error {
    return new Error(`SCRAPING_RUN_PENDING_ERROR: ${message}`);
}

function relationshipBuildSetting(env: Record<string, string | undefined>): string {
    const build = env.APIFY_RELATIONSHIP_BUILD?.trim() || DEFAULT_APIFY_RELATIONSHIP_BUILD;
    if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(build)) {
        throw new Error(
            'SCRAPING_CONFIG_ERROR: APIFY_RELATIONSHIP_BUILD는 정확한 x.y.z 버전이어야 합니다.'
        );
    }
    return build;
}

const decimalIdSchema = z.union([
    z.string().regex(/^[1-9]\d*$/),
    z.number().int().positive().safe(),
]);

const relationshipItemSchema = z.object({
    username_scrape: z.string().trim().min(1),
    type: z.enum([
        'Followers',
        'followers',
        'Following',
        'following',
        'Followings',
        'followings',
    ]),
    id: decimalIdSchema,
    username: z.string().trim().regex(INSTAGRAM_USERNAME_PATTERN),
    full_name: z.string(),
    is_private: z.boolean(),
    is_verified: z.boolean(),
    profile_pic_url: z.string().min(1),
}).passthrough();

const optionalUrlSchema = z.union([z.string().url(), z.literal('')]).nullable().optional();
const requiredUrlSchema = z.string().url();

const profileSchema = z.object({
    username: z.string().trim().regex(INSTAGRAM_USERNAME_PATTERN),
    fullName: z.string().nullable().optional(),
    biography: z.string().nullable().optional(),
    externalUrl: optionalUrlSchema,
    profilePicUrl: optionalUrlSchema,
    followersCount: z.number().int().nonnegative(),
    followsCount: z.number().int().nonnegative(),
    postsCount: z.number().int().nonnegative(),
    private: z.boolean(),
    verified: z.boolean(),
    latestPosts: z.array(z.unknown()).optional(),
}).passthrough();

const profileUsernameEnvelopeSchema = z.object({
    username: z.string().trim().regex(INSTAGRAM_USERNAME_PATTERN),
}).passthrough();

const profileNotFoundEnvelopeSchema = z.object({
    username: z.string().trim().regex(INSTAGRAM_USERNAME_PATTERN),
    statusCode: z.literal(404).optional(),
    errorCode: z.enum(['NOT_FOUND', 'not_found']).optional(),
    error: z.literal('not_found').optional(),
}).passthrough().refine(value => (
    value.statusCode === 404
    || value.errorCode === 'NOT_FOUND'
    || value.errorCode === 'not_found'
    || value.error === 'not_found'
), { message: 'explicit not-found evidence is required' });

const latestPostSchema = z.object({
    id: z.union([z.string().min(1), z.number().int().nonnegative()]),
    shortCode: z.string().min(1),
    caption: z.string().nullable().optional(),
    hashtags: z.array(z.string()).optional(),
    displayUrl: requiredUrlSchema,
    videoUrl: optionalUrlSchema,
    type: z.string().trim().min(1),
    productType: z.string().nullable().optional(),
    likesCount: z.number().int().min(-1).optional(),
    commentsCount: z.number().int().min(-1).optional(),
    timestamp: z.union([z.string(), z.number()]).optional(),
    mentions: z.array(z.string()).optional(),
    taggedUsers: z.array(z.object({
        username: z.string().regex(INSTAGRAM_USERNAME_PATTERN),
    }).passthrough()).optional(),
    images: z.array(requiredUrlSchema).max(20).optional(),
    childPosts: z.array(z.unknown()).max(20).optional(),
}).passthrough();

const latestPostChildSchema = z.object({
    id: z.union([z.string().min(1), z.number().int().nonnegative()]),
    type: z.string().trim().min(1),
    caption: z.string().nullable().optional(),
    displayUrl: requiredUrlSchema,
    videoUrl: optionalUrlSchema,
}).passthrough();

const RAW_VIDEO_EXTENSION = /\.(?:m4v|mkv|mov|mp4|mpeg|mpg|ogv|webm)$/i;

function isExplicitReel(productType: string | null | undefined): boolean {
    const normalized = productType?.trim().toLowerCase();
    return normalized === 'clips' || normalized === 'reel' || normalized === 'reels';
}

function mediaPath(value: string): string {
    try {
        return decodeURIComponent(new URL(value).pathname);
    } catch {
        return value.split(/[?#]/, 1)[0];
    }
}

function displayThumbnail(
    url: string,
    context: string,
    videoUrl?: string | null
): string {
    if (url === videoUrl || RAW_VIDEO_EXTENSION.test(mediaPath(url))) {
        throw new Error(`SCRAPING_SCHEMA_ERROR: ${context}의 displayUrl이 원본 비디오 URL입니다.`);
    }
    return url;
}

function normalizeApifyPostType(
    type: string,
    productType: string | null | undefined,
    context: string
): InstagramPost['type'] {
    const normalized = type.trim().toLowerCase();
    const reel = isExplicitReel(productType);

    if (normalized === 'video') return reel ? 'reel' : 'video';
    if (normalized === 'image') {
        if (reel) {
            throw new Error(`SCRAPING_SCHEMA_ERROR: ${context}의 type과 productType이 서로 모순됩니다.`);
        }
        return 'image';
    }
    if (normalized === 'sidecar') {
        if (reel) {
            throw new Error(`SCRAPING_SCHEMA_ERROR: ${context}의 type과 productType이 서로 모순됩니다.`);
        }
        return 'carousel';
    }
    throw new Error(`SCRAPING_SCHEMA_ERROR: ${context}의 type을 판별할 수 없습니다.`);
}

function parseApifyChildPosts(
    post: z.infer<typeof latestPostSchema>,
    postIndex: number
): {
    mediaItems: InstagramPostMediaItem[];
    declaredMediaCount: number;
} {
    const rawChildren = post.childPosts;
    const images = post.images;
    if (!Array.isArray(rawChildren) || rawChildren.length === 0) {
        throw new Error(
            `SCRAPING_SCHEMA_ERROR: Apify latestPosts ${postIndex}번 carousel에 childPosts가 없습니다.`
        );
    }
    if (!Array.isArray(images) || images.length === 0) {
        throw new Error(
            `SCRAPING_SCHEMA_ERROR: Apify latestPosts ${postIndex}번 carousel에 images가 없습니다.`
        );
    }
    if (images.length !== rawChildren.length) {
        throw new Error(
            `SCRAPING_SCHEMA_ERROR: Apify latestPosts ${postIndex}번 carousel의 images와 childPosts 개수가 다릅니다.`
        );
    }
    const mediaItems = rawChildren.map((rawChild, childIndex) => {
        const parsed = latestPostChildSchema.safeParse(rawChild);
        if (!parsed.success) {
            throw new Error(
                `SCRAPING_SCHEMA_ERROR: Apify latestPosts ${postIndex}번 childPosts ${childIndex}번 행이 올바르지 않습니다. ${parsed.error.issues[0]?.message ?? ''}`
            );
        }
        const child = parsed.data;
        const type = normalizeApifyPostType(
            child.type,
            undefined,
            `Apify latestPosts ${postIndex}번 childPosts ${childIndex}번`
        );
        if (type === 'carousel') {
            throw new Error(
                `SCRAPING_SCHEMA_ERROR: Apify latestPosts ${postIndex}번 childPosts에 중첩 carousel이 있습니다.`
            );
        }
        const thumbnailUrl = displayThumbnail(
            child.displayUrl,
            `Apify latestPosts ${postIndex}번 childPosts ${childIndex}번`,
            child.videoUrl
        );
        if (images[childIndex] !== child.displayUrl) {
            throw new Error(
                `SCRAPING_SCHEMA_ERROR: Apify latestPosts ${postIndex}번 carousel의 images와 childPosts 순서가 다릅니다.`
            );
        }
        if (type === 'image' && child.videoUrl) {
            throw new Error(
                `SCRAPING_SCHEMA_ERROR: Apify latestPosts ${postIndex}번 childPosts ${childIndex}번의 type과 videoUrl이 서로 모순됩니다.`
            );
        }
        const id = String(child.id);
        const caption = child.caption?.trim() || undefined;
        return type === 'image'
            ? {
                id,
                type,
                ...(caption ? { caption } : {}),
                imageUrl: thumbnailUrl,
            }
            : {
                id,
                type,
                ...(caption ? { caption } : {}),
                thumbnailUrl,
                ...(child.videoUrl ? { videoUrl: child.videoUrl } : {}),
            };
    });
    return { mediaItems, declaredMediaCount: mediaItems.length };
}

/** latestPosts를 InstagramPost[] 형식으로 변환 */
function parseLatestPosts(rawPosts: unknown): InstagramPost[] {
    if (rawPosts === undefined) return [];
    if (!Array.isArray(rawPosts)) {
        throw new Error('SCRAPING_SCHEMA_ERROR: Apify latestPosts가 배열이 아닙니다.');
    }

    return rawPosts.slice(0, 10).map((item, index) => {
        const parsed = latestPostSchema.safeParse(item);
        if (!parsed.success) {
            throw new Error(
                `SCRAPING_SCHEMA_ERROR: Apify latestPosts ${index}번 행이 올바르지 않습니다. ${parsed.error.issues[0]?.message ?? ''}`
            );
        }
        const post = parsed.data;
        const type = normalizeApifyPostType(
            post.type,
            post.productType,
            `Apify latestPosts ${index}번`
        );
        const taggedUsers = (post.taggedUsers ?? []).map((user) => user.username);
        const thumbnailUrl = displayThumbnail(
            post.displayUrl,
            `Apify latestPosts ${index}번`,
            post.videoUrl
        );
        if (
            type !== 'carousel'
            && ((post.childPosts?.length ?? 0) > 0 || (post.images?.length ?? 0) > 0)
        ) {
            throw new Error(
                `SCRAPING_SCHEMA_ERROR: Apify latestPosts ${index}번의 type과 carousel 필드가 서로 모순됩니다.`
            );
        }
        if ((type === 'image' || type === 'carousel') && post.videoUrl) {
            throw new Error(
                `SCRAPING_SCHEMA_ERROR: Apify latestPosts ${index}번의 type과 videoUrl이 서로 모순됩니다.`
            );
        }

        const carousel = type === 'carousel'
            ? parseApifyChildPosts(post, index)
            : undefined;
        const mentionedUsers = mergeInstagramMentions(
            post.mentions ?? [],
            carousel?.mediaItems.map(media => media.caption) ?? []
        );

        return {
            id: String(post.id),
            shortCode: post.shortCode,
            caption: post.caption ?? undefined,
            hashtags: post.hashtags ?? [],
            imageUrl: thumbnailUrl,
            ...(type === 'video' || type === 'reel' ? { thumbnailUrl } : {}),
            videoUrl: post.videoUrl || undefined,
            type,
            ...(carousel
                ? {
                    mediaItems: carousel.mediaItems,
                    declaredMediaCount: carousel.declaredMediaCount,
                    childrenComplete: true,
                }
                : {}),
            likesCount: post.likesCount ?? 0,
            commentsCount: post.commentsCount ?? 0,
            timestamp: normalizeInstagramTimestamp(post.timestamp),
            taggedUsers,
            mentionedUsers,
        };
    });
}

function mapProfile(profile: Record<string, unknown>, includePosts: boolean): InstagramProfile {
    const parsed = profileSchema.safeParse(profile);
    if (!parsed.success) {
        throw new Error(
            `SCRAPING_SCHEMA_ERROR: Apify profile이 올바르지 않습니다. ${parsed.error.issues[0]?.message ?? ''}`
        );
    }
    const value = parsed.data;
    const latestPosts = includePosts ? parseLatestPosts(value.latestPosts) : undefined;
    if (includePosts && !value.private && value.postsCount > 0 && latestPosts?.length === 0) {
        throw new Error(
            'SCRAPING_INCOMPLETE_ERROR: Apify public profile has posts but no usable latestPosts.'
        );
    }
    const requiredRecentPosts = Math.min(value.postsCount, MAX_RECENT_POSTS);
    if (
        includePosts
        && !value.private
        && (latestPosts?.length ?? 0) < requiredRecentPosts
    ) {
        throw new Error(
            'SCRAPING_INCOMPLETE_ERROR: Apify public profile recent-post snapshot is incomplete.'
        );
    }
    return {
        username: value.username,
        fullName: value.fullName ?? undefined,
        bio: value.biography ?? undefined,
        externalUrl: value.externalUrl || undefined,
        profilePicUrl: value.profilePicUrl || undefined,
        followersCount: value.followersCount,
        followingCount: value.followsCount,
        postsCount: value.postsCount,
        isPrivate: value.private,
        isVerified: value.verified,
        ...(includePosts ? { latestPosts } : {}),
    };
}

export function parseApifyRelationshipDataset(
    items: Array<Record<string, unknown>>,
    username: string,
    kind: ApifyRelationshipKind,
    actorLimit: number
) {
    const expectedTypes = kind === 'followers'
        ? new Set(['followers'])
        : new Set(['following', 'followings']);
    if (items.length > actorLimit) {
        throw new Error('SCRAPING_SCHEMA_ERROR: Apify relationship dataset이 resultsLimit를 초과했습니다.');
    }

    return items.map((item, index) => {
        const parsed = relationshipItemSchema.safeParse(item);
        if (!parsed.success) {
            throw new Error(
                `SCRAPING_SCHEMA_ERROR: Apify relationship 결과 ${index}번 행이 올바르지 않습니다. ${parsed.error.issues[0]?.message ?? ''}`
            );
        }
        if (parsed.data.username_scrape.toLowerCase() !== username.toLowerCase()) {
            throw new Error('SCRAPING_SCHEMA_ERROR: Apify 결과의 대상 username이 요청과 다릅니다.');
        }
        if (!expectedTypes.has(parsed.data.type.toLowerCase())) {
            throw new Error('SCRAPING_SCHEMA_ERROR: Apify 결과의 relationship type이 요청과 다릅니다.');
        }
        return {
            username: parsed.data.username,
            fullName: parsed.data.full_name || undefined,
            profilePicUrl: parsed.data.profile_pic_url,
            isPrivate: parsed.data.is_private,
            isVerified: parsed.data.is_verified,
        };
    });
}

function relationshipDefinition(
    env: Record<string, string | undefined>
): ApifyRelationshipActorDefinition {
    return {
        logicalProvider: 'apify',
        credentialSlot: selectApifyCredentialSlot(env),
        actorId: APIFY_RELATIONSHIP_ACTOR_ID,
        actorBuild: relationshipBuildSetting(env),
        actorConcurrency: integerSetting(env, 'APIFY_ACTOR_CONCURRENCY', 2, 1, 10),
        minimumLimit: 25,
        maximumLimit: integerSetting(
            env,
            'APIFY_RELATIONSHIP_MAX_RESULTS_PER_OPERATION',
            1_200,
            1,
            500_000
        ),
        maximumMetadataItems: 0,
        maximumEstimatedCostUsd: numberSetting(
            env,
            'APIFY_RELATIONSHIP_MAX_ESTIMATED_COST_USD_PER_OPERATION',
            1.1,
            0.00000001,
            100_000
        ),
        datasetReadRetries: integerSetting(env, 'APIFY_DATASET_READ_RETRIES', 5, 0, 8),
        datasetRetryBaseDelayMs: integerSetting(
            env,
            'APIFY_DATASET_RETRY_BASE_DELAY_MS',
            500,
            0,
            30_000
        ),
        minimumUniqueRatio: numberSetting(
            env,
            'APIFY_RELATIONSHIP_MIN_UNIQUE_RATIO',
            0.95,
            0,
            1
        ),
        timeoutSecs: integerSetting(env, 'APIFY_RELATIONSHIP_TIMEOUT_SECS', 300, 30, 3_600),
        estimatedCostPerResultUsd: numberSetting(
            env,
            'APIFY_RELATIONSHIP_ESTIMATED_COST_PER_RESULT_USD',
            0.00085,
            0,
            100
        ),
        buildInput: (username, kind, resultsLimit) => ({
            Account: [username],
            resultsLimit,
            dataToScrape: kind === 'followers' ? 'Followers' : 'Followings',
        }),
        parseDataset: parseApifyRelationshipDataset,
    };
}

export function makeApifyProvider(deps: ApifyProviderDeps = {}): ScraperProvider {
    const env = deps.env ?? process.env;
    const client = (credentialSlot?: ProviderCallContext['credentialSlot']) =>
        deps.client ?? getApifyClient(env, credentialSlot);
    const profileSettings = () => ({
        credentialSlot: selectApifyCredentialSlot(env),
        actorConcurrency: integerSetting(env, 'APIFY_ACTOR_CONCURRENCY', 2, 1, 10),
        timeoutSecs: integerSetting(env, 'APIFY_PROFILE_TIMEOUT_SECS', 300, 30, 3_600),
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
            'APIFY_PROFILE_ESTIMATED_COST_PER_RESULT_USD',
            0.0026,
            0,
            100
        ),
        maximumEstimatedCostUsd: numberSetting(
            env,
            'APIFY_PROFILE_MAX_ESTIMATED_COST_USD_PER_OPERATION',
            1,
            0.00000001,
            100_000
        ),
    });

    function profileMaximumChargeUsd(
        resultLimit: number,
        settings: ReturnType<typeof profileSettings>
    ): number {
        const estimate = resultLimit * settings.estimatedCostPerResultUsd;
        if (estimate > settings.maximumEstimatedCostUsd + Number.EPSILON) {
            throw new Error(
                'SCRAPING_BUDGET_ERROR: Apify profile estimated-cost ceiling would be exceeded.'
            );
        }
        return Number(estimate.toFixed(12));
    }

    async function waitForSettledProfileDataset(
        apify: ApifyClientLike,
        datasetId: string,
        maximumItems: number,
        settings: ReturnType<typeof profileSettings>,
        deadlineAtMs?: number
    ) {
        let lastPage;
        for (let attempt = 0; attempt <= settings.datasetReadRetries; attempt++) {
            if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) {
                throw new Error(
                    'SCRAPING_INCOMPLETE_ERROR: Apify profile dataset deadline was exhausted.'
                );
            }
            try {
                lastPage = await withinProfileDeadline(
                    apify.dataset(datasetId).listItems({
                        limit: maximumItems + 1,
                    }),
                    deadlineAtMs
                );
            } catch {
                lastPage = undefined;
            }
            if (
                lastPage
                && Array.isArray(lastPage.items)
                && Number.isInteger(lastPage.total)
                && lastPage.total >= 0
                && lastPage.total <= maximumItems
                && lastPage.items.length === lastPage.total
            ) {
                // A just-finished Dataset can briefly report a valid-looking 0/0.
                // Exhaust bounded rereads before accepting a genuinely empty result.
                if (lastPage.total > 0 || attempt === settings.datasetReadRetries) {
                    return lastPage;
                }
            }
            if (attempt < settings.datasetReadRetries) {
                const delayMs = settings.datasetRetryBaseDelayMs * 2 ** attempt;
                if (deadlineAtMs !== undefined && Date.now() + delayMs >= deadlineAtMs) {
                    throw new Error(
                        'SCRAPING_INCOMPLETE_ERROR: Apify profile dataset deadline was exhausted.'
                    );
                }
                await sleep(delayMs);
            }
        }
        if (lastPage && !Array.isArray(lastPage.items)) {
            throw new Error('SCRAPING_SCHEMA_ERROR: Apify profile dataset items가 배열이 아닙니다.');
        }
        throw new Error(
            'SCRAPING_INCOMPLETE_ERROR: Apify profile dataset did not settle after completion.'
        );
    }

    async function getSingleProfile(
        username: string,
        includePosts: boolean,
        invocationWaitLimitSecs: number | undefined,
        context?: ProviderCallContext
    ): Promise<InstagramProfile | null> {
        const settings = profileSettings();
        let effectiveInvocationWaitLimitSecs = invocationWaitLimitSecs;
        if (context?.invocationDeadlineAtMs !== undefined) {
            const waitBudgetMs = context.invocationDeadlineAtMs
                - Date.now()
                - APIFY_PROFILE_DATASET_HEADROOM_MS;
            if (waitBudgetMs < 1_000) {
                throw profileRunPending(
                    'Apify profile invocation deadline is too close; retry the checkpointed run.'
                );
            }
            effectiveInvocationWaitLimitSecs = Math.min(
                effectiveInvocationWaitLimitSecs ?? APIFY_PROFILE_SUMMARY_WAIT_LIMIT_SECS,
                Math.floor(waitBudgetMs / 1_000)
            );
        }
        const configuredMaximumChargeUsd = profileMaximumChargeUsd(1, settings);
        const maximumChargeUsd = context?.maxChargeUsd ?? (
            includePosts
                ? configuredMaximumChargeUsd
                : Math.min(configuredMaximumChargeUsd, APIFY_PROFILE_SUMMARY_MAX_CHARGE_USD)
        );
        if (
            !includePosts
            && maximumChargeUsd > APIFY_PROFILE_SUMMARY_MAX_CHARGE_USD + Number.EPSILON
        ) {
            throw new Error(
                'SCRAPING_BUDGET_ERROR: Apify profile summary charge exceeds its fixed ceiling.'
            );
        }
        const apify = client(context?.credentialSlot);
        const durableRun = hasDurableProfileRunCheckpoint(context);
        let run;
        try {
            run = await runWithApifyActorSlot(
                settings.actorConcurrency,
                () => {
                    throwIfApifyQueuedStartCancelled(context);
                    context?.recordUsage({ request_count: 1 });
                    return startOrResumeApifyActor(
                        apify,
                        APIFY_PROFILE_ACTOR_ID,
                        { usernames: [username] },
                        {
                            logicalProvider: 'apify',
                            credentialSlot: settings.credentialSlot,
                            timeoutSecs: settings.timeoutSecs,
                            maxItems: 1,
                            maxTotalChargeUsd: maximumChargeUsd,
                            ...(effectiveInvocationWaitLimitSecs === undefined
                                ? {}
                                : { invocationWaitLimitSecs: effectiveInvocationWaitLimitSecs }),
                        },
                        context
                    );
                }
            );
        } catch (error) {
            if (
                error instanceof Error
                && (
                    error.message.startsWith('SCRAPING_AMBIGUOUS_START_ERROR:')
                    || error.message.startsWith('SCRAPING_RUN_CHECKPOINT_ERROR:')
                    || error.message.startsWith('SCRAPING_RUN_PENDING_ERROR:')
                    || error.message === APIFY_PROVIDER_QUOTA_ERROR_CODE
                    || error.message.startsWith('ANALYSIS_PERSISTENCE_ERROR:')
                    || isApifyProviderLifecycleError(error)
                    || isApifyQueuedStartCancellation(error)
                    || error.message.startsWith('SCRAPING_CONFIG_ERROR:')
                    || error.message.startsWith('SCRAPING_BUDGET_ERROR:')
                    || error.message.startsWith('SCRAPING_SCHEMA_ERROR:')
                )
            ) {
                throw error;
            }
            throw new Error('SCRAPING_ERROR: Apify profile actor transport request failed.');
        }
        if (run.status !== 'SUCCEEDED') {
            if (durableRun && RESUMABLE_APIFY_STATUSES.has(run.status)) {
                throw profileRunPending(
                    `Apify profile run status=${run.status}; retry the checkpointed run.`
                );
            }
            throw new Error(`SCRAPING_ERROR: Apify profile actor 실행 실패 (status=${run.status}).`);
        }
        if (!run.defaultDatasetId) {
            throw new Error('SCRAPING_SCHEMA_ERROR: Apify profile run에 defaultDatasetId가 없습니다.');
        }

        let page;
        try {
            page = await waitForSettledProfileDataset(
                apify,
                run.defaultDatasetId,
                1,
                settings,
                context?.invocationDeadlineAtMs
            );
        } catch (error) {
            if (
                durableRun
                && isTypedScrapingError(error, 'SCRAPING_INCOMPLETE_ERROR:', 'SCRAPING_ERROR:')
            ) {
                throw profileRunPending(
                    'Apify profile dataset is not yet readable; retry the checkpointed run.'
                );
            }
            throw error;
        }
        context?.recordUsage({
            estimated_cost_usd: page.items.length * settings.estimatedCostPerResultUsd,
        });
        const { items } = page;
        if (items.length === 0) {
            if (durableRun) {
                throw profileRunPending(
                    'Apify profile dataset is empty; retry the checkpointed run.'
                );
            }
            throw new Error(
                'SCRAPING_INCOMPLETE_ERROR: Apify profile dataset is empty without explicit not-found evidence.'
            );
        }
        if (items.length > 1) {
            throw new Error('SCRAPING_SCHEMA_ERROR: 단일 프로필 요청에 여러 결과가 반환되었습니다.');
        }
        context?.recordUsage({ result_count: 1 });
        const explicitNotFound = profileNotFoundEnvelopeSchema.safeParse(items[0]);
        if (explicitNotFound.success) {
            if (explicitNotFound.data.username.toLowerCase() !== username.toLowerCase()) {
                throw new Error('SCRAPING_SCHEMA_ERROR: Apify not-found username mismatch.');
            }
            return null;
        }
        const profile = mapProfile(items[0] as Record<string, unknown>, includePosts);
        if (profile.username.toLowerCase() !== username.toLowerCase()) {
            throw new Error('SCRAPING_SCHEMA_ERROR: Apify profile username이 요청과 다릅니다.');
        }
        return profile;
    }

    async function getProfile(
        username: string,
        context?: ProviderCallContext
    ): Promise<InstagramProfile | null> {
        return getSingleProfile(username, true, undefined, context);
    }

    async function getProfileSummary(
        username: string,
        context?: ProviderCallContext
    ): Promise<InstagramProfile | null> {
        return getSingleProfile(
            username,
            false,
            Math.min(
                context?.invocationWaitLimitSecs ?? APIFY_PROFILE_SUMMARY_WAIT_LIMIT_SECS,
                APIFY_PROFILE_SUMMARY_WAIT_LIMIT_SECS
            ),
            context
        );
    }

    interface CollectedProfileBatch {
        profilesByUsername: Map<string, InstagramProfile>;
        failuresByUsername: Map<string, Error>;
        notFoundUsernames: Set<string>;
        datasetContaminated: boolean;
    }

    async function collectProfilesBatch(
        usernames: string[],
        batchSize: number = 10,
        context?: ProviderCallContext
    ): Promise<CollectedProfileBatch> {
        if (!Number.isInteger(batchSize) || batchSize <= 0) {
            throw new Error('SCRAPING_CONFIG_ERROR: batchSize는 양의 정수여야 합니다.');
        }
        if (
            (context?.resumeRunId || context?.onRunStarted)
            && usernames.length > batchSize
        ) {
            throw new Error(
                'SCRAPING_CONFIG_ERROR: a durable Apify profile operation must fit in one batch.'
            );
        }
        const settings = profileSettings();
        const apify = client(context?.credentialSlot);
        const requested = new Set(usernames.map((username) => username.toLowerCase()));
        const profilesByUsername = new Map<string, InstagramProfile>();
        const failuresByUsername = new Map<string, Error>();
        const notFoundUsernames = new Set<string>();
        const seenDatasetUsernames = new Set<string>();
        let datasetContaminated = false;
        const durableRun = hasDurableProfileRunCheckpoint(context);
        for (let i = 0; i < usernames.length; i += batchSize) {
            const batch = usernames.slice(i, i + batchSize);
            const maximumChargeUsd = context?.maxChargeUsd
                ?? profileMaximumChargeUsd(batch.length, settings);
            let run;
            try {
                run = await runWithApifyActorSlot(
                    settings.actorConcurrency,
                    async () => {
                        throwIfApifyQueuedStartCancelled(context);
                        context?.recordUsage({ request_count: 1 });
                        // Apify executes the whole batch remotely, so expose one real
                        // representative only after the Actor slot is actually acquired.
                        if (batch[0]) await reportProfileStart(context, batch[0]);
                        return startOrResumeApifyActor(
                            apify,
                            APIFY_PROFILE_ACTOR_ID,
                            { usernames: batch },
                            {
                                logicalProvider: 'apify',
                                credentialSlot: settings.credentialSlot,
                                timeoutSecs: settings.timeoutSecs,
                                maxItems: batch.length,
                                maxTotalChargeUsd: maximumChargeUsd,
                            },
                            context
                        );
                    }
                );
            } catch (error) {
                if (isTypedScrapingError(
                    error,
                    'SCRAPING_AMBIGUOUS_START_ERROR:',
                    'SCRAPING_RUN_CHECKPOINT_ERROR:',
                    'SCRAPING_RUN_PENDING_ERROR:',
                    APIFY_PROVIDER_QUOTA_ERROR_CODE,
                    'ANALYSIS_PERSISTENCE_ERROR:',
                    'ANALYSIS_V2_PROGRESS_',
                    'SCRAPING_CONFIG_ERROR:',
                    'SCRAPING_BUDGET_ERROR:',
                    'SCRAPING_SCHEMA_ERROR:'
                )
                    || isApifyProviderLifecycleError(error)
                    || isApifyQueuedStartCancellation(error)
                ) {
                    throw error;
                }
                if (
                    durableRun
                    && isTypedScrapingError(
                        error,
                        'SCRAPING_ERROR: Apify run status request failed.'
                    )
                ) {
                    throw profileRunPending(
                        'Apify profile run status is not yet observable; retry the checkpointed run.'
                    );
                }
                throw new Error('SCRAPING_ERROR: Apify profile actor transport request failed.');
            }
            if (run.status !== 'SUCCEEDED') {
                if (durableRun && RESUMABLE_APIFY_STATUSES.has(run.status)) {
                    throw profileRunPending(
                        `Apify profile run status=${run.status}; retry the checkpointed run.`
                    );
                }
                throw new Error(`SCRAPING_ERROR: Apify profile actor status=${run.status}`);
            }
            if (!run.defaultDatasetId) {
                throw new Error('SCRAPING_SCHEMA_ERROR: Apify profile run에 defaultDatasetId가 없습니다.');
            }
            let page;
            try {
                page = await waitForSettledProfileDataset(
                    apify,
                    run.defaultDatasetId,
                    batch.length,
                    settings
                );
            } catch (error) {
                if (
                    durableRun
                    && isTypedScrapingError(
                        error,
                        'SCRAPING_ERROR:',
                        'SCRAPING_INCOMPLETE_ERROR:'
                    )
                ) {
                    throw profileRunPending(
                        'Apify profile dataset is not yet readable; retry the checkpointed run.'
                    );
                }
                throw error;
            }
            context?.recordUsage({
                estimated_cost_usd: page.items.length * settings.estimatedCostPerResultUsd,
            });
            for (const item of page.items) {
                const explicitNotFound = profileNotFoundEnvelopeSchema.safeParse(item);
                if (explicitNotFound.success) {
                    const key = explicitNotFound.data.username.toLowerCase();
                    if (!requested.has(key) || seenDatasetUsernames.has(key)) {
                        datasetContaminated = true;
                        continue;
                    }
                    seenDatasetUsernames.add(key);
                    notFoundUsernames.add(key);
                    continue;
                }
                const envelope = profileUsernameEnvelopeSchema.safeParse(item);
                if (!envelope.success) {
                    datasetContaminated = true;
                    continue;
                }
                const key = envelope.data.username.toLowerCase();
                if (!requested.has(key)) {
                    datasetContaminated = true;
                    continue;
                }
                if (seenDatasetUsernames.has(key)) {
                    profilesByUsername.delete(key);
                    failuresByUsername.set(
                        key,
                        new Error(
                            'SCRAPING_SCHEMA_ERROR: Apify profile dataset에 중복 username이 있습니다.'
                        )
                    );
                    datasetContaminated = true;
                    continue;
                }
                seenDatasetUsernames.add(key);
                try {
                    const profile = mapProfile(item as Record<string, unknown>, true);
                    profilesByUsername.set(key, profile);
                } catch (error) {
                    failuresByUsername.set(
                        key,
                        error instanceof Error
                            ? error
                            : new Error('SCRAPING_SCHEMA_ERROR: Apify profile row mapping failed.')
                    );
                }
            }
        }
        return {
            profilesByUsername,
            failuresByUsername,
            notFoundUsernames,
            datasetContaminated,
        };
    }

    async function getProfilesBatch(
        usernames: string[],
        batchSize: number = 10,
        context?: ProviderCallContext
    ): Promise<InstagramProfile[]> {
        const collected = await collectProfilesBatch(usernames, batchSize, context);
        const firstFailure = collected.failuresByUsername.values().next().value;
        if (firstFailure) throw firstFailure;
        if (collected.datasetContaminated) {
            throw new Error('SCRAPING_SCHEMA_ERROR: Apify profile dataset contains invalid rows.');
        }
        const results = [...collected.profilesByUsername.values()];
        context?.recordUsage({ result_count: results.length });
        const requested = new Set(usernames.map(username => username.toLowerCase()));
        const ambiguousOmissions = [...requested].filter(username => (
            !collected.profilesByUsername.has(username)
            && !collected.notFoundUsernames.has(username)
        ));
        if (ambiguousOmissions.length > 0) {
            if (hasDurableProfileRunCheckpoint(context)) {
                throw profileRunPending(
                    'Apify profile dataset omitted accounts without explicit not-found evidence.'
                );
            }
            throw new Error(
                'SCRAPING_INCOMPLETE_ERROR: Apify profile dataset omitted accounts without explicit not-found evidence.'
            );
        }
        return results;
    }

    async function getProfilesBatchOutcomes(
        usernames: string[],
        batchSize: number = 10,
        context?: ProviderCallContext
    ): Promise<ProfileAttemptResult[]> {
        const startedAt = Date.now();
        const collected = await collectProfilesBatch(usernames, batchSize, context);
        const latencyMs = profileAttemptLatency(startedAt);
        const missingUsernames = usernames.filter(requestedUsername => {
            const key = requestedUsername.trim().toLowerCase();
            return !collected.profilesByUsername.has(key)
                && !collected.failuresByUsername.has(key)
                && !collected.notFoundUsernames.has(key);
        });
        const results = usernames.map((requestedUsername) => {
            const key = requestedUsername.trim().toLowerCase();
            const profile = collected.profilesByUsername.get(key);
            if (profile) {
                return successfulProfileAttempt({
                    requestedUsername,
                    source: 'apify',
                    profile,
                    requestCount: 1,
                    latencyMs,
                });
            }
            const failure = collected.failuresByUsername.get(key);
            if (failure || collected.datasetContaminated) {
                return failedProfileAttempt({
                    requestedUsername,
                    source: 'apify',
                    error: failure ?? new Error(
                        'SCRAPING_SCHEMA_ERROR: Apify profile dataset has an unattributed row.'
                    ),
                    requestCount: 1,
                    latencyMs,
                });
            }
            if (missingUsernames.includes(requestedUsername)) {
                return failedProfileAttempt({
                    requestedUsername,
                    source: 'apify',
                    error: new Error(
                        'SCRAPING_INCOMPLETE_ERROR: Apify profile dataset omitted an account without explicit not-found evidence.'
                    ),
                    requestCount: 1,
                    latencyMs,
                });
            }
            return unavailableProfileAttempt({
                    requestedUsername,
                    source: 'apify',
                    reason: 'not_found',
                    requestCount: 1,
                    latencyMs,
                });
        });
        context?.recordUsage({
            result_count: results.filter(result => result.outcome.status === 'success').length,
        });
        return results;
    }

    async function collectRelationship(
        username: string,
        limit: number,
        kind: ApifyRelationshipKind,
        context?: ProviderCallContext
    ) {
        return runApifyRelationshipActor(
            client(context?.credentialSlot),
            relationshipDefinition(env),
            username,
            kind,
            limit,
            context
        );
    }

    return {
        name: 'apify',
        paid: true,
        getProfileSummary,
        getProfile,
        getFollowers: (username, limit, context) =>
            collectRelationship(username, limit, 'followers', context),
        getFollowing: (username, limit, context) =>
            collectRelationship(username, limit, 'following', context),
        getProfilesBatch,
        getProfilesBatchOutcomes,
    };
}

export const apifyProvider = makeApifyProvider();

export async function getApifyProfile(
    username: string,
    context?: ProviderCallContext
): Promise<InstagramProfile | null> {
    if (!apifyProvider.getProfile) {
        throw new Error('SCRAPING_CONFIG_ERROR: Apify full profile capability is unavailable.');
    }
    return apifyProvider.getProfile(username, context);
}

export async function getApifyProfileSummary(
    username: string,
    context?: ProviderCallContext
): Promise<InstagramProfile | null> {
    if (!apifyProvider.getProfileSummary) {
        throw new Error('SCRAPING_CONFIG_ERROR: Apify summary capability is unavailable.');
    }
    return apifyProvider.getProfileSummary(username, context);
}
