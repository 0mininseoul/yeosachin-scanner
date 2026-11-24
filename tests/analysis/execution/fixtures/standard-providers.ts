export const target = 'target7';
export const candidate = 'sample2';
const postCode = (username: string) => (username === target ? 'TargetPost7' : 'SamplePost2');
const picture = (username: string) => 'https://scontent.cdninstagram.com/' + username + '.jpg';

export function profileItem(username: string) {
    const code = postCode(username);
    const postCount = username === target ? 4 : 1;
    return {
        username,
        fullName: username,
        biography: '여행 사진과 일상',
        followersCount: 1,
        followsCount: 1,
        postsCount: postCount,
        private: false,
        verified: false,
        profilePicUrl: picture(username),
        latestPosts: Array.from({ length: postCount }, (_, index) => {
            const shortCode = username === target ? code + index : code;
            return {
                id: String((username === target ? 701 : 201) + index),
                shortCode,
                type: 'Image',
                url: 'https://www.instagram.com/p/' + shortCode + '/',
                displayUrl: picture(shortCode),
                caption: '함께한 여행 사진 @' + (username === target ? candidate : target),
                timestamp: '2026-10-01T09:00:00.000Z',
                likesCount: 1,
                commentsCount: 1,
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

export class SyntheticApify {
    readonly starts: string[] = [];
    private readonly datasets = new Map<string, unknown[]>();
    private rows(actor: string, input: ActorInput) {
        if (actor === 'apify/instagram-profile-scraper' && input.usernames)
            return input.usernames.map(profileItem);
        if (input.Account)
            return [
                {
                    username_scrape: target,
                    type: input.dataToScrape,
                    id: '2',
                    username: candidate,
                    full_name: candidate,
                    is_private: false,
                    is_verified: false,
                    profile_pic_url: picture(candidate),
                },
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
                    profile_pic_url: picture(username),
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
                    text: '여행 사진 잘 봤어!',
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
            start: async (input: ActorInput) => {
                this.starts.push(actor);
                const id = 'Fixture' + String(this.starts.length).padStart(10, '0');
                this.datasets.set(id, this.rows(actor, input));
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
            waitForFinish: async () => ({
                id,
                status: 'SUCCEEDED',
                defaultDatasetId: id,
                usageTotalUsd: 0.001,
            }),
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
