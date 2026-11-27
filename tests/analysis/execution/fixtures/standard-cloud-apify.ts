import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { privateCandidate, profileItem, publicUsername, syntheticActorRows, syntheticActorUsageUsd, target } from './standard-providers';
import type { SyntheticCloudFinish, SyntheticCloudSelector, SyntheticCloudStart, SyntheticCloudStore } from './standard-cloud-apify-store';

const actors = {
    profiles: 'apify/instagram-profile-scraper',
    relationship: 'scraping_solutions/instagram-scraper-followers-following-no-cookies',
    likes: 'datadoping/instagram-likes-scraper',
    comments: 'apify/instagram-comment-scraper',
} as const;

// Exactly the 600 public and one private candidates of the six-order load fixture.
const publicCount = process.env.DEV_STANDARD_QA_PLAN === 'plus' ? 900 : 600;
const publicNames = Array.from({ length: publicCount }, (_, index) => publicUsername(index));
const names = [target, ...publicNames, privateCandidate];
const postUrls = [target, ...publicNames].flatMap(name => profileItem(name).latestPosts.map(post => post.url));
const count = z.number().int().min(1).max(20_000);
const values = z.array(z.string().min(1).max(180)).min(1).max(names.length);
const profileInput = z.strictObject({ usernames: values });
const relationInput = z.strictObject({
    Account: z.tuple([z.literal(target)]), resultsLimit: count, dataToScrape: z.enum(['Followers', 'Followings']),
});
const likeInput = z.strictObject({ posts: values, max_count: count });
const commentInput = z.strictObject({ directUrls: values, resultsLimit: count, includeNestedComments: z.literal(false) });

function invalid(): never { throw new Error('CLOUD_SYNTHETIC_APIFY_INVALID'); }
function inputData<T>(schema: z.ZodType<T>, input: unknown): T {
    const result = schema.safeParse(input);
    return result.success ? result.data : invalid();
}

function indexes(items: string[], catalog: string[]) {
    return items.map(item => {
        const index = catalog.indexOf(item);
        return index < 0 ? invalid() : index;
    });
}

function identify(actor: string, input: unknown): SyntheticCloudSelector {
    switch (actor) {
        case actors.profiles:
            return { kind: 'profiles', indexes: indexes(inputData(profileInput, input).usernames, names) };
        case actors.relationship: {
            const parsed = inputData(relationInput, input);
            return { kind: parsed.dataToScrape === 'Followers' ? 'followers' : 'followings', limit: parsed.resultsLimit };
        }
        case actors.likes: {
            const parsed = inputData(likeInput, input);
            return { kind: 'likes', indexes: indexes(parsed.posts, postUrls), limit: parsed.max_count };
        }
        case actors.comments: {
            const parsed = inputData(commentInput, input);
            return { kind: 'comments', indexes: indexes(parsed.directUrls, postUrls), limit: parsed.resultsLimit };
        }
        default: return invalid();
    }
}

function rows(selector: SyntheticCloudSelector) {
    const select = (indices: number[], catalog: string[]) => indices.map(index => catalog[index] ?? invalid());
    switch (selector.kind) {
        case 'profiles': return syntheticActorRows(actors.profiles, { usernames: select(selector.indexes, names) }, 1, 1, publicCount);
        case 'followers':
        case 'followings': return syntheticActorRows(actors.relationship, {
            Account: [target], dataToScrape: selector.kind === 'followers' ? 'Followers' : 'Followings',
        }, 1, 1, publicCount);
        case 'likes': return syntheticActorRows(actors.likes, { posts: select(selector.indexes, postUrls) }, 1, 1, publicCount);
        case 'comments': return syntheticActorRows(actors.comments, { directUrls: select(selector.indexes, postUrls) }, 1, 1, publicCount);
    }
}

export function createCloudSyntheticApify(input: {
    store: SyntheticCloudStore;
    // Must identify the logical QA operation/owner; never use a delivery attempt ID.
    operationKey: () => string;
    durationMs: () => number;
}) {
    const { store } = input;
    function terminal(receipt: SyntheticCloudFinish) {
        return { id: receipt.id, status: receipt.status, finishedAt: new Date(receipt.finishedAtMs),
            // The native Dev ledger records actual provider spend. The GCS receipt keeps the modeled price.
            usageTotalUsd: 0, ...(receipt.status === 'SUCCEEDED' ? { defaultDatasetId: receipt.id } : {}) };
    }
    async function settle(start: SyntheticCloudStart, status: SyntheticCloudFinish['status']) {
        return terminal(await store.finishOnce({
            version: 2, id: start.id, status, finishedAtMs: Date.now() + 1, usageUsd: start.usageUsd,
        }));
    }
    async function poll(start: SyntheticCloudStart, waitMs: number) {
        const existing = await store.getFinish(start.id);
        if (existing) return terminal(existing);
        const ready = start.startedAtMs + start.delayMs;
        const remaining = ready - Date.now();
        if (remaining > 0 && waitMs > 0) await sleep(Math.min(remaining, waitMs));
        if (Date.now() >= ready) return settle(start, 'SUCCEEDED');
        const observed = waitMs > 0 ? await store.getFinish(start.id) : null;
        return observed ? terminal(observed) : { id: start.id, status: 'RUNNING' as const };
    }
    return {
        actor(actor: string) {
            return { start: async (raw: unknown, options?: { maxTotalChargeUsd?: number }) => {
                // A new SDK entry represents a potential second paid call, even for
                // exactly the same logical operation. Only transport retries reuse this nonce.
                const entryNonce = randomUUID();
                let proposed: SyntheticCloudStart;
                try {
                    const selection = identify(actor, raw);
                    const operation = input.operationKey();
                    const delayMs = input.durationMs();
                    const cap = options?.maxTotalChargeUsd ?? 0.001;
                    if (!/^[a-f0-9]{64}$/.test(operation) || !Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 300_000
                        || !Number.isFinite(cap) || cap < 0) invalid();
                    const id = 'CloudQa' + createHash('sha256')
                        .update(JSON.stringify([store.waveDigest, operation, selection])).digest('hex').slice(0, 48);
                    proposed = { version: 2, id, selector: selection, startedAtMs: Date.now(), delayMs, usageUsd: syntheticActorUsageUsd(cap) };
                } catch {
                    await store.recordInvocation(null, entryNonce);
                    return invalid();
                }
                await store.recordInvocation(proposed.id, entryNonce);
                const existing = await store.startOnce(proposed);
                if (JSON.stringify(existing.selector) !== JSON.stringify(proposed.selector) || existing.usageUsd !== proposed.usageUsd
                    || existing.delayMs !== proposed.delayMs) return invalid();
                return { id: existing.id };
            } };
        },
        run(id: string) {
            if (!/^CloudQa[a-f0-9]{48}$/.test(id)) return invalid();
            // GCS objects are private up front. Preserve the standard SDK acknowledgement.
            const restricted = { update: async (access: { generalAccess: string }) => {
                if (access.generalAccess !== 'RESTRICTED') return invalid();
                return { generalAccess: 'RESTRICTED' };
            } };
            return {
                ...restricted, dataset: () => restricted, keyValueStore: () => restricted, requestQueue: () => restricted,
                get: async () => poll(await store.getStart(id), 0),
                abort: async () => settle(await store.getStart(id), 'ABORTED'),
                waitForFinish: async (options?: { waitSecs?: number }) => {
                    const secs = options?.waitSecs ?? 300;
                    if (!Number.isFinite(secs) || secs < 0 || secs > 3_600) return invalid();
                    return poll(await store.getStart(id), secs * 1000);
                },
            };
        },
        dataset(id: string) {
            return { listItems: async ({ offset = 0, limit = 100 } = {}) => {
                if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
                    return invalid();
                const start = await store.getStart(id);
                const receipt = await poll(start, 0);
                if (receipt.status === 'ABORTED') throw new Error('CLOUD_SYNTHETIC_APIFY_DATASET_ABORTED');
                if (receipt.status !== 'SUCCEEDED') throw new Error('CLOUD_SYNTHETIC_APIFY_DATASET_PENDING');
                const all = rows(start.selector);
                const items = all.slice(offset, offset + limit);
                return { items, count: items.length, total: all.length, offset, limit };
            } };
        },
    };
}
