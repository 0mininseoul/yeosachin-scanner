import { z } from 'zod';
import type { InstagramProfile, InstagramPost } from '@/lib/types/instagram';
import type { ProviderCallContext, ScraperProvider } from './types';
import { INSTAGRAM_USERNAME_PATTERN } from '../username';
import { normalizeInstagramTimestamp } from '../timestamp';
import {
    getApifyClient,
    integerSetting,
    numberSetting,
    runApifyRelationshipActor,
    runWithApifyActorSlot,
    selectApifyCredentialSlot,
    startOrResumeApifyActor,
    type ApifyClientLike,
    type ApifyRelationshipActorDefinition,
    type ApifyRelationshipKind,
} from './apify-relationship';

const PROFILE_ACTOR_ID = 'apify/instagram-profile-scraper';
export const APIFY_RELATIONSHIP_ACTOR_ID =
    'scraping_solutions/instagram-scraper-followers-following-no-cookies';
const DEFAULT_APIFY_RELATIONSHIP_BUILD = '0.0.71';

interface ApifyProviderDeps {
    client?: ApifyClientLike;
    env?: Record<string, string | undefined>;
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

const latestPostSchema = z.object({
    id: z.union([z.string().min(1), z.number().int().nonnegative()]),
    shortCode: z.string().min(1),
    caption: z.string().nullable().optional(),
    hashtags: z.array(z.string()).optional(),
    displayUrl: optionalUrlSchema,
    videoUrl: optionalUrlSchema,
    type: z.string().optional(),
    is_video: z.boolean().optional(),
    likesCount: z.number().int().min(-1).optional(),
    commentsCount: z.number().int().min(-1).optional(),
    timestamp: z.union([z.string(), z.number()]).optional(),
    mentions: z.array(z.string()).optional(),
    taggedUsers: z.array(z.object({
        username: z.string().regex(INSTAGRAM_USERNAME_PATTERN),
    }).passthrough()).optional(),
}).passthrough();

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
        const type = post.type?.toLowerCase() || 'image';
        const mentionedUsers = post.mentions ?? [];
        const taggedUsers = (post.taggedUsers ?? []).map((user) => user.username);

        return {
            id: String(post.id),
            shortCode: post.shortCode,
            caption: post.caption ?? undefined,
            hashtags: post.hashtags ?? [],
            imageUrl: post.displayUrl || undefined,
            videoUrl: post.videoUrl || undefined,
            type: type === 'video' || post.is_video === true
                ? 'video'
                : type === 'sidecar'
                  ? 'carousel'
                  : 'image',
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
        ...(includePosts ? { latestPosts: parseLatestPosts(value.latestPosts) } : {}),
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
            1_000,
            1,
            500_000
        ),
        maximumMetadataItems: 0,
        maximumEstimatedCostUsd: numberSetting(
            env,
            'APIFY_RELATIONSHIP_MAX_ESTIMATED_COST_USD_PER_OPERATION',
            1,
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

    async function getProfile(
        username: string,
        context?: ProviderCallContext
    ): Promise<InstagramProfile | null> {
        const settings = profileSettings();
        const maximumChargeUsd = context?.maxChargeUsd
            ?? profileMaximumChargeUsd(1, settings);
        const apify = client(context?.credentialSlot);
        context?.recordUsage({ request_count: 1 });
        let run;
        try {
            run = await runWithApifyActorSlot(
                settings.actorConcurrency,
                () => startOrResumeApifyActor(
                    apify,
                    PROFILE_ACTOR_ID,
                    { usernames: [username] },
                    {
                        logicalProvider: 'apify',
                        credentialSlot: settings.credentialSlot,
                        timeoutSecs: settings.timeoutSecs,
                        maxItems: 1,
                        maxTotalChargeUsd: maximumChargeUsd,
                    },
                    context
                )
            );
        } catch (error) {
            if (
                error instanceof Error
                && (
                    error.message.startsWith('SCRAPING_AMBIGUOUS_START_ERROR:')
                    || error.message.startsWith('SCRAPING_RUN_CHECKPOINT_ERROR:')
                    || error.message.startsWith('ANALYSIS_PERSISTENCE_ERROR:')
                )
            ) {
                throw error;
            }
            throw new Error('SCRAPING_ERROR: Apify profile actor transport request failed.');
        }
        if (run.status !== 'SUCCEEDED') {
            throw new Error(`SCRAPING_ERROR: Apify profile actor 실행 실패 (status=${run.status}).`);
        }
        if (!run.defaultDatasetId) {
            throw new Error('SCRAPING_SCHEMA_ERROR: Apify profile run에 defaultDatasetId가 없습니다.');
        }

        let page;
        try {
            page = await apify.dataset(run.defaultDatasetId).listItems({ limit: 2 });
        } catch {
            throw new Error('SCRAPING_ERROR: Apify profile dataset transport request failed.');
        }
        if (!Array.isArray(page.items)) {
            throw new Error('SCRAPING_SCHEMA_ERROR: Apify profile dataset items가 배열이 아닙니다.');
        }
        context?.recordUsage({
            estimated_cost_usd: page.items.length * settings.estimatedCostPerResultUsd,
        });
        const { items } = page;
        if (items.length === 0) return null;
        if (items.length > 1) {
            throw new Error('SCRAPING_SCHEMA_ERROR: 단일 프로필 요청에 여러 결과가 반환되었습니다.');
        }
        context?.recordUsage({ result_count: 1 });
        const profile = mapProfile(items[0] as Record<string, unknown>, true);
        if (profile.username.toLowerCase() !== username.toLowerCase()) {
            throw new Error('SCRAPING_SCHEMA_ERROR: Apify profile username이 요청과 다릅니다.');
        }
        return profile;
    }

    async function getProfilesBatch(
        usernames: string[],
        batchSize: number = 10,
        context?: ProviderCallContext
    ): Promise<InstagramProfile[]> {
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
        const resultMap = new Map<string, InstagramProfile>();
        for (let i = 0; i < usernames.length; i += batchSize) {
            const batch = usernames.slice(i, i + batchSize);
            const maximumChargeUsd = context?.maxChargeUsd
                ?? profileMaximumChargeUsd(batch.length, settings);
            context?.recordUsage({ request_count: 1 });
            let run;
            try {
                run = await runWithApifyActorSlot(
                    settings.actorConcurrency,
                    () => startOrResumeApifyActor(
                        apify,
                        PROFILE_ACTOR_ID,
                        { usernames: batch },
                        {
                            logicalProvider: 'apify',
                            credentialSlot: settings.credentialSlot,
                            timeoutSecs: settings.timeoutSecs,
                            maxItems: batch.length,
                            maxTotalChargeUsd: maximumChargeUsd,
                        },
                        context
                    )
                );
            } catch (error) {
                if (
                    error instanceof Error
                    && (
                        error.message.startsWith('SCRAPING_AMBIGUOUS_START_ERROR:')
                        || error.message.startsWith('SCRAPING_RUN_CHECKPOINT_ERROR:')
                        || error.message.startsWith('ANALYSIS_PERSISTENCE_ERROR:')
                    )
                ) {
                    throw error;
                }
                throw new Error('SCRAPING_ERROR: Apify profile actor transport request failed.');
            }
            if (run.status !== 'SUCCEEDED') {
                throw new Error(`SCRAPING_ERROR: Apify profile actor status=${run.status}`);
            }
            if (!run.defaultDatasetId) {
                throw new Error('SCRAPING_SCHEMA_ERROR: Apify profile run에 defaultDatasetId가 없습니다.');
            }
            let page;
            try {
                page = await apify.dataset(run.defaultDatasetId).listItems({
                    limit: batch.length + 1,
                });
            } catch {
                throw new Error('SCRAPING_ERROR: Apify profile dataset transport request failed.');
            }
            if (!Array.isArray(page.items)) {
                throw new Error('SCRAPING_SCHEMA_ERROR: Apify profile dataset items가 배열이 아닙니다.');
            }
            context?.recordUsage({
                estimated_cost_usd: page.items.length * settings.estimatedCostPerResultUsd,
            });
            if (page.total > batch.length || page.items.length !== page.total) {
                throw new Error('SCRAPING_SCHEMA_ERROR: Apify profile dataset 크기가 batch와 일치하지 않습니다.');
            }
            for (const item of page.items) {
                const profile = mapProfile(item as Record<string, unknown>, true);
                const key = profile.username?.toLowerCase();
                if (!key || !requested.has(key)) {
                    throw new Error('SCRAPING_SCHEMA_ERROR: Apify profile username이 요청과 다릅니다.');
                }
                if (resultMap.has(key)) {
                    throw new Error('SCRAPING_SCHEMA_ERROR: Apify profile dataset에 중복 username이 있습니다.');
                }
                resultMap.set(key, profile);
            }
        }
        const results = [...resultMap.values()];
        context?.recordUsage({ result_count: results.length });
        const coverage = requested.size > 0 ? results.length / requested.size : 1;
        if (coverage < 0.95) {
            throw new Error(
                `SCRAPING_INCOMPLETE_ERROR: Apify profile batch 커버리지가 ${(coverage * 100).toFixed(1)}%입니다.`
            );
        }
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
        getProfile,
        getFollowers: (username, limit, context) =>
            collectRelationship(username, limit, 'followers', context),
        getFollowing: (username, limit, context) =>
            collectRelationship(username, limit, 'following', context),
        getProfilesBatch,
    };
}

export const apifyProvider = makeApifyProvider();
