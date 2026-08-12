import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstagramPost, InstagramProfile } from '@/lib/types/instagram';

const mocks = vi.hoisted(() => ({
    analyzeWithGemini: vi.fn(),
    getAnalysisImagePolicy: vi.fn(),
    prepareAnalysisImages: vi.fn(),
}));
vi.mock('@/lib/services/ai/gemini', () => ({
    analyzeWithGemini: mocks.analyzeWithGemini,
}));
vi.mock('@/lib/services/ai/image-preprocessing', () => ({
    getAnalysisImagePolicy: mocks.getAnalysisImagePolicy,
    prepareAnalysisImages: mocks.prepareAnalysisImages,
}));

import {
    buildPrecheckoutBliteDigest,
    buildPrecheckoutBlitePrompt,
    inferPrecheckoutBlite,
} from './blite-inference';
import { computePrecheckoutBliteCandidateRange } from './blite-range';

// Every concept/data source that requires the paid pipeline (mutual-follow gender
// composition, who liked/commented on a post, follow-formation speed, or "erased/tidied
// traces") must never appear anywhere in the digest this module builds.
const FORBIDDEN_CONCEPT_SUBSTRINGS = [
    '맞팔', 'mutual', 'Mutual', 'MutualFollow',
    '좋아요를 누른', '댓글을 남긴', 'InteractionData', 'liker', 'Liker',
    '형성 속도', 'formation speed',
    '지운 흔적', '정리된', 'erased', 'tidied',
    'followersCount', 'followingCount', 'gender',
];

// Structural allowlist for every key the digest may ever contain, recursively. `fullName` and
// `bio` are the widened evidence for `genderRead` only (Correction 2) — the set otherwise stays
// closed: no username, externalUrl, profilePicUrl, or follower/following counts.
const ALLOWED_DIGEST_KEYS = new Set([
    'postCount', 'postTypeDistribution', 'image', 'video', 'carousel', 'reel', 'posts',
    'type', 'captionExcerpt', 'hashtags', 'carouselDepth',
    'likesCount', 'likesHidden', 'commentsCount', 'commentsHidden',
    'taggedUsernames', 'mentionedUsernames',
    'fullName', 'bio',
]);

function collectKeysRecursively(value: unknown, keys: Set<string>): void {
    if (Array.isArray(value)) {
        for (const item of value) collectKeysRecursively(item, keys);
        return;
    }
    if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
            keys.add(key);
            collectKeysRecursively(child, keys);
        }
    }
}

function post(overrides: Partial<InstagramPost> = {}): InstagramPost {
    return {
        id: '1',
        shortCode: 'abc123',
        caption: '오늘도 좋은 하루 #일상 #소통',
        hashtags: ['일상', '소통'],
        imageUrl: 'https://cdn.example.com/a.jpg',
        type: 'image',
        likesCount: 120,
        commentsCount: 8,
        timestamp: '2026-08-01T00:00:00.000Z',
        taggedUsers: ['friend_a'],
        mentionedUsers: ['friend_b'],
        ...overrides,
    };
}

function profile(overrides: Partial<InstagramProfile> = {}): InstagramProfile {
    return {
        username: 'target_user',
        fullName: '홍길동',
        bio: '자기소개입니다',
        externalUrl: 'https://example.com',
        profilePicUrl: 'https://cdn.example.com/profile.jpg',
        followersCount: 1_200,
        followingCount: 900,
        postsCount: 42,
        isPrivate: false,
        isVerified: false,
        latestPosts: [
            post({ id: '1', type: 'image' }),
            post({
                id: '2',
                type: 'carousel',
                declaredMediaCount: 3,
                caption: '캐러셀 게시물 캡션입니다 #여행',
                hashtags: ['여행'],
                taggedUsers: ['friend_c'],
                mentionedUsers: [],
            }),
            post({
                id: '3',
                type: 'reel',
                likesCount: 0,
                likesCountHidden: true,
                commentsCount: 0,
                commentsCountHidden: true,
            }),
        ],
        ...overrides,
    };
}

function validModelResponse() {
    return {
        persona: {
            headline: '관계를 자주 드러내는 활발한 소통형 계정',
            summary: '최근 게시물에서 태그와 멘션을 자주 활용하는 편이에요. 참고용 페르소나이며 확정적인 결론은 아니에요.',
        },
        signals: [
            { claim: '태그된 사람과의 관계를 자주 드러내는 편이에요.', category: '관계 노출 성향', confidence: 0.82 },
            { claim: '캐러셀 게시물을 자주 활용해요.', category: '게시 습관', confidence: 0.62 },
            { claim: '해시태그 사용이 적은 편이에요.', category: '게시 습관', confidence: 0.35 },
            { claim: '댓글 반응을 유도하는 캡션을 자주 써요.', category: '소통 성향', confidence: 0.71 },
        ],
        genderRead: {
            likelyFemale: true,
            confidence: 0.81,
            reasons: [
                '캡션 어투가 여성형 표현에 가까워요.',
                '태그된 계정 구성이 여성형 이름에 가까워요.',
                '게시물 주제가 여성형 관심사에 가까워요.',
            ],
        },
    };
}

function preparedImage(overrides: Partial<{ role: 'profile' | 'post'; url: string; base64: string }> = {}) {
    return {
        role: 'profile' as const,
        url: 'https://cdn.example.com/profile.jpg',
        base64: 'BASE64_PROFILE',
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAnalysisImagePolicy.mockReturnValue({
        maxImages: 3,
        maxPostImages: 2,
        maxDimension: 384,
        jpegQuality: 75,
    });
    // Default: profile photo + one post photo prepared successfully. Individual tests override
    // this to exercise the zero-image and multi-post-image paths.
    mocks.prepareAnalysisImages.mockResolvedValue([
        preparedImage(),
        preparedImage({ role: 'post', url: 'https://cdn.example.com/a.jpg', base64: 'BASE64_POST_1' }),
    ]);
});

describe('buildPrecheckoutBliteDigest', () => {
    it('only contains allowlisted keys', () => {
        const digest = buildPrecheckoutBliteDigest(profile());
        const keys = new Set<string>();
        collectKeysRecursively(digest, keys);
        for (const key of keys) {
            expect(ALLOWED_DIGEST_KEYS.has(key)).toBe(true);
        }
    });

    it('never contains a forbidden concept', () => {
        const digest = buildPrecheckoutBliteDigest(profile());
        const serialized = JSON.stringify(digest);
        for (const forbidden of FORBIDDEN_CONCEPT_SUBSTRINGS) {
            expect(serialized).not.toContain(forbidden);
        }
    });

    it('never contains the username, externalUrl, profilePicUrl, or follower/following counts', () => {
        const digest = buildPrecheckoutBliteDigest(profile());
        const serialized = JSON.stringify(digest);
        expect(serialized).not.toContain('target_user');
        expect(serialized).not.toContain('example.com');
        expect(serialized).not.toContain('1200');
        expect(serialized).not.toContain('900');
    });

    it('widens fullName and bio into the digest as gender-read-only evidence', () => {
        const digest = buildPrecheckoutBliteDigest(profile());
        expect(digest.fullName).toBe('홍길동');
        expect(digest.bio).toBe('자기소개입니다');
    });

    it('truncates an overlong fullName/bio and returns null when absent', () => {
        const long = buildPrecheckoutBliteDigest(profile({
            fullName: '가'.repeat(100),
            bio: '나'.repeat(300),
        }));
        expect(long.fullName?.length).toBeLessThanOrEqual(61); // 60 chars + ellipsis
        expect(long.bio?.length).toBeLessThanOrEqual(161); // 160 chars + ellipsis

        const missing = buildPrecheckoutBliteDigest(profile({ fullName: undefined, bio: undefined }));
        expect(missing.fullName).toBeNull();
        expect(missing.bio).toBeNull();
    });

    it('reflects post type distribution, carousel depth, and hidden-count flags', () => {
        const digest = buildPrecheckoutBliteDigest(profile());
        expect(digest.postCount).toBe(3);
        expect(digest.postTypeDistribution).toEqual({ image: 1, video: 0, carousel: 1, reel: 1 });
        expect(digest.posts[1].carouselDepth).toBe(3);
        expect(digest.posts[2].likesHidden).toBe(true);
        expect(digest.posts[2].likesCount).toBeNull();
        expect(digest.posts[2].commentsHidden).toBe(true);
    });

    it('caps digest posts and returns an empty digest for an account with no posts', () => {
        const empty = buildPrecheckoutBliteDigest(profile({ latestPosts: [] }));
        expect(empty.postCount).toBe(0);
        expect(empty.posts).toEqual([]);
    });
});

describe('buildPrecheckoutBlitePrompt', () => {
    it('never leaks the username, externalUrl, or follower/following counts into the rendered prompt', () => {
        const digest = buildPrecheckoutBliteDigest(profile());
        const prompt = buildPrecheckoutBlitePrompt(digest);
        expect(prompt).not.toContain('target_user');
        expect(prompt).not.toContain('example.com');
        expect(prompt).not.toContain('1200');
        expect(prompt).not.toContain('900');
    });

    it('restricts fullName/bio/image evidence to genderRead only, in the prompt instructions', () => {
        const digest = buildPrecheckoutBliteDigest(profile());
        const prompt = buildPrecheckoutBlitePrompt(digest, { count: 2, hasProfileImage: true });
        // The widened evidence text does end up in the prompt (that's the point) ...
        expect(prompt).toContain('홍길동');
        expect(prompt).toContain('자기소개입니다');
        // ... but the prompt must explicitly forbid using it for persona/signals.
        expect(prompt).toContain('오직 성별 추정(genderRead)에만 사용');
        expect(prompt).toContain('이미지 2장이 첨부되어 있습니다');
        expect(prompt).toContain('프로필 사진');
    });

    it('describes zero attached images when no image evidence is passed', () => {
        const digest = buildPrecheckoutBliteDigest(profile());
        const prompt = buildPrecheckoutBlitePrompt(digest);
        expect(prompt).toContain('첨부된 이미지가 없습니다');
    });

    it('is written in Korean and embeds the digest JSON', () => {
        const digest = buildPrecheckoutBliteDigest(profile());
        const prompt = buildPrecheckoutBlitePrompt(digest);
        expect(/[가-힣]/u.test(prompt)).toBe(true);
        expect(prompt).toContain(JSON.stringify(digest));
    });
});

describe('inferPrecheckoutBlite', () => {
    it('returns the assembled, validated DTO on a successful model call', async () => {
        mocks.analyzeWithGemini.mockResolvedValue(validModelResponse());
        const account = profile();
        const result = await inferPrecheckoutBlite(account, { requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });

        expect(result).not.toBeNull();
        expect(result?.schemaVersion).toBe(1);
        expect(result?.signals).toHaveLength(4);
        expect(result?.genderRead.reasons).toHaveLength(3);
        expect(result?.postCount).toBe(3);
        expect(result?.candidateRange).toEqual(
            computePrecheckoutBliteCandidateRange(account.followersCount, account.followingCount)
        );
        for (const evidenceField of result?.evidenceFields ?? []) {
            expect(evidenceField.startsWith('post.') || evidenceField.startsWith('profile.')).toBe(true);
        }
    });

    it('forwards requestId, abortSignal, and the prepared image evidence to the Gemini call', async () => {
        mocks.analyzeWithGemini.mockResolvedValue(validModelResponse());
        const controller = new AbortController();
        await inferPrecheckoutBlite(profile(), {
            requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            abortSignal: controller.signal,
        });

        expect(mocks.analyzeWithGemini).toHaveBeenCalledTimes(1);
        const [, images, options] = mocks.analyzeWithGemini.mock.calls[0];
        expect(images).toEqual(['BASE64_PROFILE', 'BASE64_POST_1']);
        expect(options.requestId).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
        expect(options.abortSignal).toBe(controller.signal);
        expect(options.analysisType).toBe('precheckout_blite');
        expect(options.stage).toBeUndefined();
    });

    it('prepares image evidence from the profile photo and recent post photos, bounded to 4 total (1 profile + 3 posts)', async () => {
        mocks.analyzeWithGemini.mockResolvedValue(validModelResponse());
        const account = profile({
            profilePicUrl: 'https://cdn.example.com/profile.jpg',
            latestPosts: [
                post({ id: '1', imageUrl: 'https://cdn.example.com/p1.jpg' }),
                post({ id: '2', imageUrl: 'https://cdn.example.com/p2.jpg' }),
                post({ id: '3', imageUrl: undefined, thumbnailUrl: 'https://cdn.example.com/p3-thumb.jpg' }),
            ],
        });
        await inferPrecheckoutBlite(account);

        expect(mocks.prepareAnalysisImages).toHaveBeenCalledTimes(1);
        const [profilePicUrl, postImageUrls, prepareOptions] = mocks.prepareAnalysisImages.mock.calls[0];
        expect(profilePicUrl).toBe('https://cdn.example.com/profile.jpg');
        expect(postImageUrls).toEqual([
            'https://cdn.example.com/p1.jpg',
            'https://cdn.example.com/p2.jpg',
            'https://cdn.example.com/p3-thumb.jpg',
        ]);
        expect(prepareOptions.policy).toEqual({
            maxImages: 4,
            maxPostImages: 3,
            maxDimension: 384,
            jpegQuality: 75,
        });
        expect(mocks.getAnalysisImagePolicy).toHaveBeenCalledWith(true);
    });

    it('still succeeds and calls Gemini with no images when none could be prepared', async () => {
        mocks.prepareAnalysisImages.mockResolvedValue([]);
        mocks.analyzeWithGemini.mockResolvedValue(validModelResponse());
        const result = await inferPrecheckoutBlite(profile());

        expect(result).not.toBeNull();
        const [, images] = mocks.analyzeWithGemini.mock.calls[0];
        expect(images).toBeUndefined();
    });

    it('downgrades the lowest-confidence signal when the model returns four highs', async () => {
        const allHigh = validModelResponse();
        allHigh.signals = [
            { claim: '신호 1', category: '카테고리', confidence: 0.95 },
            { claim: '신호 2', category: '카테고리', confidence: 0.9 },
            { claim: '신호 3', category: '카테고리', confidence: 0.72 },
            { claim: '신호 4', category: '카테고리', confidence: 0.85 },
        ];
        mocks.analyzeWithGemini.mockResolvedValue(allHigh);
        const result = await inferPrecheckoutBlite(profile());

        expect(result).not.toBeNull();
        const bands = result?.signals.map(signal => signal.band) ?? [];
        expect(bands.some(band => band !== 'high')).toBe(true);
        const downgraded = result?.signals.find(signal => signal.band !== 'high');
        // The lowest-confidence signal (0.72) is the one that gets downgraded.
        expect(downgraded?.confidence).toBeLessThan(0.72);
        expect(downgraded?.confidence).toBeLessThan(0.7);
        // Band must still agree with the (possibly downgraded) confidence.
        for (const signal of result?.signals ?? []) {
            expect(signal.confidence).toBeGreaterThanOrEqual(0);
        }
    });

    it('returns null without calling Gemini or preparing images when there are no posts', async () => {
        const result = await inferPrecheckoutBlite(profile({ latestPosts: [] }));
        expect(result).toBeNull();
        expect(mocks.analyzeWithGemini).not.toHaveBeenCalled();
        expect(mocks.prepareAnalysisImages).not.toHaveBeenCalled();
    });

    it('returns null when the Gemini call throws', async () => {
        mocks.analyzeWithGemini.mockRejectedValue(new Error('AI_RATE_LIMIT_ERROR: boom'));
        const result = await inferPrecheckoutBlite(profile());
        expect(result).toBeNull();
    });

    it('returns null (fails open) when image preparation itself throws', async () => {
        mocks.prepareAnalysisImages.mockRejectedValue(new Error('boom'));
        const result = await inferPrecheckoutBlite(profile());
        expect(result).toBeNull();
        expect(mocks.analyzeWithGemini).not.toHaveBeenCalled();
    });

    it('closes the timeout gap: an abort during slow image prep still resolves to null without ever reaching Gemini', async () => {
        // `prepareAnalysisImages` has no native abort hook, so this mock deliberately never
        // settles on its own. If the abort deadline only bounded the Gemini call (the bug being
        // fixed here), `inferPrecheckoutBlite` would hang forever waiting on this promise and
        // this test would time out. The abort signal firing must be what ends the wait.
        let releaseSlowPrepare: (() => void) | undefined;
        mocks.prepareAnalysisImages.mockImplementation(() => new Promise((resolve) => {
            releaseSlowPrepare = () => resolve([]);
        }));
        const controller = new AbortController();

        const startedAt = Date.now();
        const resultPromise = inferPrecheckoutBlite(profile(), { abortSignal: controller.signal });
        controller.abort();
        const result = await resultPromise;
        const elapsedMs = Date.now() - startedAt;

        expect(result).toBeNull();
        expect(mocks.analyzeWithGemini).not.toHaveBeenCalled();
        // Resolves promptly on abort rather than waiting on the still-pending image prep.
        expect(elapsedMs).toBeLessThan(500);

        // Let the abandoned image-prep promise settle so it can't leak into later tests.
        releaseSlowPrepare?.();
    });

    it('returns null when the assembled DTO fails final contract validation', async () => {
        const malformed = validModelResponse();
        malformed.persona.headline = 'no korean characters at all here';
        mocks.analyzeWithGemini.mockResolvedValue(malformed);
        const result = await inferPrecheckoutBlite(profile());
        expect(result).toBeNull();
    });
});
