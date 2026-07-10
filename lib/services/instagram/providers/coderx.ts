import { z } from 'zod';
import type { InstagramFollower } from '@/lib/types/instagram';
import type { ProviderCallContext, ScraperProvider } from './types';
import { INSTAGRAM_USERNAME_PATTERN } from '../username';
import {
    getApifyClient,
    integerSetting,
    numberSetting,
    runApifyRelationshipActor,
    selectApifyCredentialSlot,
    type ApifyClientLike,
    type ApifyRelationshipActorDefinition,
    type ApifyRelationshipKind,
} from './apify-relationship';

export const CODERX_RELATIONSHIP_ACTOR_ID =
    'coderx/instagram-followers-following-scraper-no-cookies-login';

interface CoderXProviderDeps {
    client?: ApifyClientLike;
    env?: Record<string, string | undefined>;
}

const decimalIdSchema = z.union([
    z.string().regex(/^[1-9]\d*$/),
    z.number().int().positive().safe(),
]);

const userItemSchema = z.object({
    pk: decimalIdSchema,
    id: decimalIdSchema,
    username: z.string().trim().regex(INSTAGRAM_USERNAME_PATTERN),
    full_name: z.string(),
    profile_pic_url: z.string().min(1),
    is_private: z.boolean(),
    is_verified: z.boolean(),
}).passthrough();

const cursorItemSchema = z.object({
    cursor: z.string().min(1),
    total_scraped: z.number().int().nonnegative(),
}).passthrough();

function idString(value: z.infer<typeof decimalIdSchema>): string {
    return typeof value === 'number' ? String(value) : value;
}

export function parseCoderXRelationshipDataset(
    items: Array<Record<string, unknown>>,
    _username: string,
    _kind: ApifyRelationshipKind,
    actorLimit: number
) {
    const results: InstagramFollower[] = [];
    let cursorSeen = false;
    let cursorTotal: number | undefined;

    for (let index = 0; index < items.length; index++) {
        const cursor = cursorItemSchema.safeParse(items[index]);
        if (cursor.success) {
            if (cursorSeen || index !== items.length - 1) {
                throw new Error('SCRAPING_SCHEMA_ERROR: CoderX cursor 행은 dataset의 마지막에 한 번만 올 수 있습니다.');
            }
            cursorSeen = true;
            cursorTotal = cursor.data.total_scraped;
            continue;
        }

        const parsed = userItemSchema.safeParse(items[index]);
        if (!parsed.success) {
            throw new Error(
                `SCRAPING_SCHEMA_ERROR: CoderX 결과 ${index}번 행이 올바르지 않습니다. ${parsed.error.issues[0]?.message ?? ''}`
            );
        }
        if (idString(parsed.data.pk) !== idString(parsed.data.id)) {
            throw new Error('SCRAPING_SCHEMA_ERROR: CoderX 결과의 pk와 id가 다릅니다.');
        }
        results.push({
            username: parsed.data.username,
            fullName: parsed.data.full_name || undefined,
            profilePicUrl: parsed.data.profile_pic_url,
            isPrivate: parsed.data.is_private,
            isVerified: parsed.data.is_verified,
        });
    }

    if (results.length > actorLimit) {
        throw new Error('SCRAPING_SCHEMA_ERROR: CoderX dataset이 max_items를 초과했습니다.');
    }
    if (cursorTotal !== undefined && cursorTotal !== results.length) {
        throw new Error('SCRAPING_INCOMPLETE_ERROR: CoderX total_scraped와 dataset 행 수가 다릅니다.');
    }
    return results;
}

function definition(env: Record<string, string | undefined>): ApifyRelationshipActorDefinition {
    return {
        logicalProvider: 'coderx',
        credentialSlot: selectApifyCredentialSlot(env),
        actorId: CODERX_RELATIONSHIP_ACTOR_ID,
        actorConcurrency: integerSetting(env, 'APIFY_ACTOR_CONCURRENCY', 1, 1, 10),
        minimumLimit: 1,
        maximumLimit: integerSetting(
            env,
            'CODERX_MAX_RESULTS_PER_OPERATION',
            1_000,
            1,
            500_000
        ),
        maximumMetadataItems: 1,
        maximumEstimatedCostUsd: numberSetting(
            env,
            'CODERX_MAX_ESTIMATED_COST_USD_PER_OPERATION',
            1.31,
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
            'CODERX_RELATIONSHIP_MIN_UNIQUE_RATIO',
            0.95,
            0,
            1
        ),
        timeoutSecs: integerSetting(env, 'CODERX_RELATIONSHIP_TIMEOUT_SECS', 300, 30, 3_600),
        estimatedCostPerResultUsd: numberSetting(
            env,
            'CODERX_ESTIMATED_COST_PER_RESULT_USD',
            0.0013,
            0,
            100
        ),
        buildInput: (username, kind, maxItems) => ({
            username,
            scrape_type: kind,
            max_items: maxItems,
        }),
        parseDataset: parseCoderXRelationshipDataset,
    };
}

export function makeCoderXProvider(deps: CoderXProviderDeps = {}): ScraperProvider {
    const env = deps.env ?? process.env;
    const client = (credentialSlot?: ProviderCallContext['credentialSlot']) =>
        deps.client ?? getApifyClient(env, credentialSlot);

    async function collect(
        username: string,
        limit: number,
        kind: ApifyRelationshipKind,
        context?: ProviderCallContext
    ) {
        return runApifyRelationshipActor(
            client(context?.credentialSlot),
            definition(env),
            username,
            kind,
            limit,
            context
        );
    }

    return {
        name: 'coderx',
        paid: true,
        getFollowers: (username, limit, context) => collect(username, limit, 'followers', context),
        getFollowing: (username, limit, context) => collect(username, limit, 'following', context),
    };
}

export const coderXProvider = makeCoderXProvider();
