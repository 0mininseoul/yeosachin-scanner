import { setTimeout as sleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';

export const target = 'target7'.padStart(30, 't');
export const candidate = 'sample2'.padStart(30, 's');
export const privateCandidate = 'fixture_private_0';
function publicOrdinal(username: string) {
    const match = /^fixture_public_([1-9][0-9]*)$/.exec(username);
    return match ? Number(match[1]) : 0;
}

function publicUsername(ordinal: number) {
    return ordinal === 0 ? candidate : 'fixture_public_' + ordinal;
}

function postCode(username: string) {
    if (username === target) return 'TargetPost7';
    const ordinal = publicOrdinal(username);
    return ordinal ? 'FixturePub' + ordinal + 'Post' : 'SamplePost2';
}
const picture = (username: string) => 'https://scontent.cdninstagram.com/' + username + '.jpg';

export function profileItem(username: string, candidatePostCount = 1, mutualCount = 1) {
    const ordinal = publicOrdinal(username);
    const code = postCode(username);
    const postCount = username === target ? 4 : candidatePostCount;
    return {
        username,
        fullName: username,
        biography: '여행 사진과 일상',
        followersCount: username === target ? mutualCount : 1,
        followsCount: username === target ? mutualCount : 1,
        postsCount: postCount,
        private: false,
        verified: false,
        profilePicUrl: picture(username) + '?z=2&a=1&utm_source=offline',
        latestPosts: Array.from({ length: postCount }, (_, index) => {
            const shortCode = postCount > 1 ? code + index : code;
            return {
                id: ordinal
                    ? '9' + String(ordinal).padStart(3, '0') + String(index).padStart(6, '0')
                    : String((username === target ? 701 : 201) + index),
                shortCode,
                type: 'Image',
                url: 'https://www.instagram.com/p/' + shortCode + '/',
                displayUrl: picture(shortCode),
                caption: '함께한 여행 사진 @' + (username === target ? candidate : target),
                timestamp: '2026-10-01T09:00:00.000Z',
                likesCount: 1,
                commentsCount: username === target ? 2 : 1,
                taggedUsers: [{ username: username === target ? candidate : target }],
            };
        }),
    };
}

type ActorInput = {
    usernames?: string[];
    Account?: string[];
    dataToScrape?: string;
    posts?: string[];
    directUrls?: string[];
};

export type SyntheticActorStart = { runId: string; actor: string; inputHash: string; usageUsd: number };

export class SyntheticApify {
    readonly starts: string[] = [];
    private readonly datasets = new Map<string, unknown[]>();
    private readonly readyAt = new Map<string, number>();
    private readonly receipts = new Map<string, { usageTotalUsd: number; finishedAt?: Date }>();
    constructor(private readonly candidatePostCount = 1, private readonly privateCount = 0, private readonly publicCount = 1,
        private readonly onStart?: (start: SyntheticActorStart) => void,
        private readonly durationMs?: () => number) {
        if (!Number.isInteger(publicCount) || publicCount < 1 || publicCount > 600)
            throw new Error('Synthetic Standard fixture supports 1 to 600 public candidates');
    }

    private rows(actor: string, input: ActorInput) {
        if (actor === 'apify/instagram-profile-scraper' && input.usernames)
            return input.usernames.map(username => profileItem(username, this.candidatePostCount, this.publicCount + this.privateCount));
        if (input.Account)
            return [
                ...Array.from({ length: this.publicCount }, (_, index) => {
                    const username = publicUsername(index);
                    return {
                        username_scrape: target, type: input.dataToScrape,
                        id: String(index + 2), username, full_name: username,
                        is_private: false, is_verified: false, profile_pic_url: picture(username),
                    };
                }),
                ...Array.from({ length: this.privateCount }, (_, index) => {
                    const username = 'fixture_private_' + index;
                    return {
                        username_scrape: target, type: input.dataToScrape,
                        id: String(index + 1000), username, full_name: username,
                        is_private: true, is_verified: false, profile_pic_url: picture(username) + '?z=2&a=1&utm_source=offline',
                    };
                }),
            ];
        if (input.posts)
            return input.posts.map((url) => {
                const username = url.includes(postCode(target)) ? candidate : target;
                return {
                    username,
                    full_name: username,
                    id: '2',
                    is_private: false,
                    is_verified: false,
                    profile_pic_url: picture(username) + '?z=2&a=1&utm_source=offline',
                    liked_post: url,
                    total_likes: 1,
                    is_new: true,
                };
            });
        if (input.directUrls)
            return input.directUrls.flatMap((url, i) =>
                [0, 1].map((j) => ({
                    postUrl: url,
                    commentUrl: url + 'c/' + (51 + 2 * i + j) + '/',
                    id: String(51 + 2 * i + j),
                    text: '여행지에서기억에남는사진들!',
                    ownerUsername: candidate,
                    ownerProfilePicUrl: picture(candidate),
                    timestamp: '2026-10-02T09:00:00.000Z',
                    likesCount: 1,
                    replies: [],
                })),
            );
        throw new Error('Unexpected synthetic actor input for ' + actor);
    }
    actor(actor: string) {
        return {
            start: async (input: ActorInput, options?: { maxTotalChargeUsd?: number }) => {
                this.starts.push(actor);
                const id = 'Fixture' + String(this.starts.length).padStart(10, '0');
                this.datasets.set(id, this.rows(actor, input));
                const usageTotalUsd = this.onStart ? Math.min(0.001, options?.maxTotalChargeUsd ?? 0.001) : 0.001;
                this.receipts.set(id, { usageTotalUsd });
                if (this.durationMs) this.readyAt.set(id, Date.now() + this.durationMs());
                if (this.onStart) {
                    const inputHash = createHash('sha256').update(JSON.stringify(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
                    this.onStart({ runId: id, actor, inputHash, usageUsd: usageTotalUsd });
                }
                return { id };
            },
        };
    }
    run(id: string) {
        const restricted = { update: async () => ({ generalAccess: 'RESTRICTED' }) };
        return {
            ...restricted,
            dataset: () => restricted,
            keyValueStore: () => restricted,
            requestQueue: () => restricted,
            waitForFinish: async () => {
                const waitMs = (this.readyAt.get(id) ?? 0) - Date.now();
                if (waitMs > 0) await sleep(waitMs);
                const receipt = this.receipts.get(id);
                if (!receipt) throw new Error('Unknown synthetic run');
                // Only the shared cost fixture requests a stable finish time. Round up for
                // the millisecond SDK clock relative to PostgreSQL's microsecond start time.
                if (this.onStart) receipt.finishedAt ??= new Date(Date.now() + 1);
                return { id, status: 'SUCCEEDED', defaultDatasetId: id, ...receipt };
            },
            get: async () => {
                const receipt = this.receipts.get(id);
                if (!receipt?.finishedAt) throw new Error('Missing terminal synthetic run receipt');
                return { id, status: 'SUCCEEDED', ...receipt };
            },
        };
    }
    dataset(id: string) {
        const rows = this.datasets.get(id);
        if (!rows) throw new Error('Unknown synthetic dataset');
        return {
            listItems: async ({ offset = 0, limit = 100 }) => {
                const items = rows.slice(offset, offset + limit);
                return { items, count: items.length, total: rows.length, offset, limit };
            },
        };
    }
}
