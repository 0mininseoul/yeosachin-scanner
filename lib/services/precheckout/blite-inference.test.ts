import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    inferLegacyPrecheckoutBlite,
    inferPrecheckoutBlite,
} from './blite-inference';

type SourcePost = {
    type: 'image' | 'video' | 'carousel' | 'reel';
    captionExcerpt: string | null;
    hashtags: string[];
    carouselDepth: number | null;
    likesCount: number | null;
    likesHidden: boolean;
    commentsCount: number | null;
    commentsHidden: boolean;
    taggedUsernames: string[];
    mentionedUsernames: string[];
};

type DurableSource = {
    schemaVersion: 1;
    fullName: string | null;
    posts: SourcePost[];
    media: Array<{ role: 'profile' | 'post'; url: string }>;
};

const CANDIDATE_RANGE = { min: 3, max: 9 } as const;

function inferenceOptions(overrides: Record<string, unknown> = {}) {
    return {
        candidateRange: CANDIDATE_RANGE,
        submittedAtMs: Date.now(),
        ...overrides,
    };
}

// Every concept/data source that requires the paid pipeline (mutual-follow gender
// composition, who liked/commented on a post, follow-formation speed, or "erased/tidied
// traces") must never appear anywhere in the durable-source digest.
const FORBIDDEN_CONCEPT_SUBSTRINGS = [
    '맞팔', 'mutual', 'Mutual', 'MutualFollow',
    '좋아요를 누른', '댓글을 남긴', 'InteractionData', 'liker', 'Liker',
    '형성 속도', 'formation speed',
    '지운 흔적', '정리된', 'erased', 'tidied',
    'followersCount', 'followingCount',
];

const ALLOWED_DIGEST_KEYS = new Set([
    'postCount', 'postTypeDistribution', 'image', 'video', 'carousel', 'reel', 'posts',
    'type', 'captionExcerpt', 'hashtags', 'carouselDepth',
    'likesCount', 'likesHidden', 'commentsCount', 'commentsHidden',
    'taggedUsernames', 'mentionedUsernames', 'fullName',
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

function post(overrides: Partial<SourcePost> = {}): SourcePost {
    return {
        type: 'image',
        captionExcerpt: '오늘도 좋은 하루 #일상 #소통',
        hashtags: ['일상', '소통'],
        carouselDepth: null,
        likesCount: 120,
        likesHidden: false,
        commentsCount: 8,
        commentsHidden: false,
        taggedUsernames: ['friend_a'],
        mentionedUsernames: ['friend_b'],
        ...overrides,
    };
}

function source(overrides: Partial<DurableSource> = {}): DurableSource {
    return {
        schemaVersion: 1,
        fullName: '홍길동',
        posts: [
            post(),
            post({
                type: 'carousel',
                carouselDepth: 3,
                captionExcerpt: '캐러셀 게시물 캡션입니다 #여행',
                hashtags: ['여행'],
                taggedUsernames: ['friend_c'],
                mentionedUsernames: [],
            }),
            post({
                type: 'reel',
                likesCount: null,
                likesHidden: true,
                commentsCount: null,
                commentsHidden: true,
            }),
        ],
        media: [
            { role: 'profile', url: 'https://cdninstagram.com/profile.jpg' },
            { role: 'post', url: 'https://cdninstagram.com/a.jpg' },
            { role: 'post', url: 'https://cdninstagram.com/b.jpg' },
            { role: 'post', url: 'https://cdninstagram.com/c.jpg' },
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
        url: 'https://cdninstagram.com/profile.jpg',
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
    mocks.prepareAnalysisImages.mockResolvedValue([
        preparedImage(),
        preparedImage({ role: 'post', url: 'https://cdninstagram.com/a.jpg', base64: 'BASE64_POST_1' }),
    ]);
});

describe('buildPrecheckoutBliteDigest', () => {
    it('only contains allowlisted keys from the durable projection', () => {
        const digest = buildPrecheckoutBliteDigest(source());
        const keys = new Set<string>();
        collectKeysRecursively(digest, keys);
        for (const key of keys) expect(ALLOWED_DIGEST_KEYS.has(key)).toBe(true);
    });

    it('never contains a paid-pipeline concept', () => {
        const serialized = JSON.stringify(buildPrecheckoutBliteDigest(source()));
        for (const forbidden of FORBIDDEN_CONCEPT_SUBSTRINGS) {
            expect(serialized).not.toContain(forbidden);
        }
    });

    it('does not contain identity, URL, or follower/following metadata', () => {
        const serialized = JSON.stringify(buildPrecheckoutBliteDigest(source()));
        expect(serialized).not.toContain('target_user');
        expect(serialized).not.toContain('cdninstagram.com');
        expect(serialized).not.toContain('1200');
        expect(serialized).not.toContain('900');
    });

    it('uses fullName only as gender-read evidence and never invents bio', () => {
        const digest = buildPrecheckoutBliteDigest(source());
        expect(digest.fullName).toBe('홍길동');
        expect(digest).not.toHaveProperty('bio');
    });

    it('truncates an overlong fullName and returns an empty digest without posts', () => {
        const long = buildPrecheckoutBliteDigest(source({ fullName: '가'.repeat(100) }));
        expect(long.fullName?.length).toBeLessThanOrEqual(61);

        const empty = buildPrecheckoutBliteDigest(source({ fullName: null, posts: [] }));
        expect(empty.fullName).toBeNull();
        expect(empty.postCount).toBe(0);
        expect(empty.posts).toEqual([]);
    });

    it('reflects post type distribution, carousel depth, and hidden-count flags', () => {
        const digest = buildPrecheckoutBliteDigest(source());
        expect(digest.postCount).toBe(3);
        expect(digest.postTypeDistribution).toEqual({ image: 1, video: 0, carousel: 1, reel: 1 });
        expect(digest.posts[1].carouselDepth).toBe(3);
        expect(digest.posts[2].likesHidden).toBe(true);
        expect(digest.posts[2].likesCount).toBeNull();
        expect(digest.posts[2].commentsHidden).toBe(true);
    });
});

describe('buildPrecheckoutBlitePrompt', () => {
    it('does not leak source URLs or count metadata into the rendered prompt', () => {
        const prompt = buildPrecheckoutBlitePrompt(buildPrecheckoutBliteDigest(source()));
        expect(prompt).not.toContain('target_user');
        expect(prompt).not.toContain('cdninstagram.com');
        expect(prompt).not.toContain('1200');
        expect(prompt).not.toContain('900');
    });

    it('restricts fullName/image evidence to genderRead', () => {
        const prompt = buildPrecheckoutBlitePrompt(buildPrecheckoutBliteDigest(source()), {
            count: 2,
            hasProfileImage: true,
        });
        expect(prompt).toContain('홍길동');
        expect(prompt).not.toContain('소개글(bio)');
        expect(prompt).toContain('오직 성별 추정(genderRead)에만 사용');
        expect(prompt).toContain('이미지 2장이 첨부되어 있습니다');
        expect(prompt).toContain('프로필 사진');
    });

    it('describes zero attached images when no image evidence is passed', () => {
        const prompt = buildPrecheckoutBlitePrompt(buildPrecheckoutBliteDigest(source()));
        expect(prompt).toContain('첨부된 이미지가 없습니다');
    });

    it('is written in Korean and embeds the digest JSON', () => {
        const digest = buildPrecheckoutBliteDigest(source());
        const prompt = buildPrecheckoutBlitePrompt(digest);
        expect(/[가-힣]/u.test(prompt)).toBe(true);
        expect(prompt).toContain(JSON.stringify(digest));
    });
});

describe('inferPrecheckoutBlite', () => {
    it('keeps the legacy route behind an explicit one-shot profile adapter', async () => {
        mocks.analyzeWithGemini.mockResolvedValue(validModelResponse());
        const profile = {
            username: 'already_collected',
            fullName: '홍길동',
            profilePicUrl: 'https://cdninstagram.com/profile.jpg',
            followersCount: 1_200,
            followingCount: 900,
            postsCount: 1,
            isPrivate: false,
            isVerified: false,
            latestPosts: [{
                id: 'post-1',
                shortCode: 'post-1',
                type: 'image' as const,
                caption: '캡션',
                hashtags: ['일상'],
                imageUrl: 'https://cdninstagram.com/post.jpg',
                likesCount: 12,
                commentsCount: 2,
                timestamp: '2026-08-13T00:00:00.000Z',
                taggedUsers: [],
                mentionedUsers: [],
            }],
        };

        const result = await inferLegacyPrecheckoutBlite(profile, inferenceOptions());

        expect(result).not.toBeNull();
        expect(mocks.prepareAnalysisImages).toHaveBeenCalledWith(
            'https://cdninstagram.com/profile.jpg',
            ['https://cdninstagram.com/post.jpg'],
            expect.objectContaining({ policy: expect.any(Object) }),
        );
        expect(mocks.analyzeWithGemini).toHaveBeenCalledOnce();
    });

    it('requires the original submission timestamp and explicit candidate metadata', async () => {
        await expect(inferPrecheckoutBlite(source(), undefined as never)).resolves.toBeNull();
        await expect(inferPrecheckoutBlite(
            source(),
            { candidateRange: CANDIDATE_RANGE } as never,
        )).resolves.toBeNull();
        await expect(inferPrecheckoutBlite(
            source(),
            { submittedAtMs: Date.now() } as never,
        )).resolves.toBeNull();
        expect(mocks.prepareAnalysisImages).not.toHaveBeenCalled();
        expect(mocks.analyzeWithGemini).not.toHaveBeenCalled();
    });

    it('rejects a malformed durable source before media or Gemini work', async () => {
        const result = await inferPrecheckoutBlite(
            source({ posts: [post({ captionExcerpt: 'x'.repeat(161) })] }),
            inferenceOptions(),
        );
        expect(result).toBeNull();
        expect(mocks.prepareAnalysisImages).not.toHaveBeenCalled();
        expect(mocks.analyzeWithGemini).not.toHaveBeenCalled();
    });

    it('returns the assembled DTO using explicit preflight candidate metadata', async () => {
        mocks.analyzeWithGemini.mockResolvedValue(validModelResponse());
        const result = await inferPrecheckoutBlite(source(), {
            requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            candidateRange: CANDIDATE_RANGE,
            submittedAtMs: Date.now(),
        });

        expect(result).not.toBeNull();
        expect(result?.schemaVersion).toBe(1);
        expect(result?.signals).toHaveLength(4);
        expect(result?.genderRead.reasons).toHaveLength(3);
        expect(result?.postCount).toBe(3);
        expect(result?.candidateRange).toEqual(CANDIDATE_RANGE);
    });

    it('forwards requestId, abortSignal, and #368 attempt telemetry to Gemini', async () => {
        mocks.analyzeWithGemini.mockResolvedValue(validModelResponse());
        const controller = new AbortController();
        const onAttemptTelemetry = vi.fn();
        await inferPrecheckoutBlite(source(), {
            requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            abortSignal: controller.signal,
            candidateRange: CANDIDATE_RANGE,
            submittedAtMs: Date.now(),
            onAttemptTelemetry,
        });

        expect(mocks.analyzeWithGemini).toHaveBeenCalledTimes(1);
        const [, images, options] = mocks.analyzeWithGemini.mock.calls[0];
        expect(images).toEqual(['BASE64_PROFILE', 'BASE64_POST_1']);
        expect(options.requestId).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
        expect(options.abortSignal).toBeInstanceOf(AbortSignal);
        expect(options.onAttemptTelemetry).toBe(onAttemptTelemetry);
        expect(options.analysisType).toBe('precheckout_blite');
        expect(options.thinkingLevel).toBe('MINIMAL');
        expect(options.maxOutputTokens).toBe(3_072);
        expect(options.maxAttempts).toBe(2);
    });

    it('uses only the ordered durable image references, bounded to four total', async () => {
        mocks.analyzeWithGemini.mockResolvedValue(validModelResponse());
        await inferPrecheckoutBlite(source(), inferenceOptions());

        expect(mocks.prepareAnalysisImages).toHaveBeenCalledTimes(1);
        const [profilePicUrl, postImageUrls, prepareOptions] = mocks.prepareAnalysisImages.mock.calls[0];
        expect(profilePicUrl).toBe('https://cdninstagram.com/profile.jpg');
        expect(postImageUrls).toEqual([
            'https://cdninstagram.com/a.jpg',
            'https://cdninstagram.com/b.jpg',
            'https://cdninstagram.com/c.jpg',
        ]);
        expect(prepareOptions.policy).toEqual({
            maxImages: 4,
            maxPostImages: 3,
            maxDimension: 384,
            jpegQuality: 75,
        });
        expect(prepareOptions.abortSignal).toBeInstanceOf(AbortSignal);
        expect(mocks.getAnalysisImagePolicy).toHaveBeenCalledWith(true);
    });

    it('does not recollect a profile or use a scraper when the durable source has no posts', async () => {
        const result = await inferPrecheckoutBlite(source({ posts: [], media: [] }), {
            candidateRange: CANDIDATE_RANGE,
            submittedAtMs: Date.now(),
        });
        expect(result).toBeNull();
        expect(mocks.analyzeWithGemini).not.toHaveBeenCalled();
        expect(mocks.prepareAnalysisImages).not.toHaveBeenCalled();
    });

    it('does not start media or Gemini work when the inference deadline is exhausted', async () => {
        const result = await inferPrecheckoutBlite(source(), {
            candidateRange: CANDIDATE_RANGE,
            submittedAtMs: Date.now() - 57_000,
        });
        expect(result).toBeNull();
        expect(mocks.prepareAnalysisImages).not.toHaveBeenCalled();
        expect(mocks.analyzeWithGemini).not.toHaveBeenCalled();
    });

    it('aborts the entire inference at T+56 and forwards the deadline signal', async () => {
        vi.useFakeTimers();
        try {
            mocks.analyzeWithGemini.mockImplementation(() => new Promise(() => undefined));
            const submittedAtMs = Date.now();
            const resultPromise = inferPrecheckoutBlite(source(), {
                candidateRange: CANDIDATE_RANGE,
                submittedAtMs,
            });

            await vi.advanceTimersByTimeAsync(56_000);
            await expect(resultPromise).resolves.toBeNull();

            expect(mocks.analyzeWithGemini).toHaveBeenCalledTimes(1);
            const options = mocks.analyzeWithGemini.mock.calls[0][2];
            expect(options.abortSignal).toBeInstanceOf(AbortSignal);
            expect(options.abortSignal.aborted).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('forwards parent cancellation to image preparation', async () => {
        mocks.analyzeWithGemini.mockResolvedValue(validModelResponse());
        const controller = new AbortController();
        await inferPrecheckoutBlite(source(), {
            abortSignal: controller.signal,
            candidateRange: CANDIDATE_RANGE,
            submittedAtMs: Date.now(),
        });
        expect(mocks.prepareAnalysisImages.mock.calls[0][2].abortSignal)
            .toBeInstanceOf(AbortSignal);
    });

    it('still calls Gemini without image evidence when all media preparation fails', async () => {
        mocks.prepareAnalysisImages.mockResolvedValue([]);
        mocks.analyzeWithGemini.mockResolvedValue(validModelResponse());
        const result = await inferPrecheckoutBlite(source(), inferenceOptions());

        expect(result).not.toBeNull();
        expect(mocks.analyzeWithGemini.mock.calls[0][1]).toBeUndefined();
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
        const result = await inferPrecheckoutBlite(source(), inferenceOptions());

        expect(result).not.toBeNull();
        const bands = result?.signals.map(signal => signal.band) ?? [];
        expect(bands.some(band => band !== 'high')).toBe(true);
        const downgraded = result?.signals.find(signal => signal.band !== 'high');
        expect(downgraded?.confidence).toBeLessThan(0.72);
        expect(downgraded?.confidence).toBeLessThan(0.7);
    });

    it('returns null when the Gemini call throws', async () => {
        mocks.analyzeWithGemini.mockRejectedValue(new Error('AI_RATE_LIMIT_ERROR: boom'));
        const result = await inferPrecheckoutBlite(source(), inferenceOptions());
        expect(result).toBeNull();
    });

    it('returns null when image preparation itself throws', async () => {
        mocks.prepareAnalysisImages.mockRejectedValue(new Error('boom'));
        const result = await inferPrecheckoutBlite(source(), inferenceOptions());
        expect(result).toBeNull();
        expect(mocks.analyzeWithGemini).not.toHaveBeenCalled();
    });

    it('closes the timeout gap when image preparation hangs after parent cancellation', async () => {
        let releaseSlowPrepare: (() => void) | undefined;
        mocks.prepareAnalysisImages.mockImplementation(() => new Promise((resolve) => {
            releaseSlowPrepare = () => resolve([]);
        }));
        const controller = new AbortController();
        const resultPromise = inferPrecheckoutBlite(source(), {
            abortSignal: controller.signal,
            candidateRange: CANDIDATE_RANGE,
            submittedAtMs: Date.now(),
        });
        controller.abort();

        await expect(resultPromise).resolves.toBeNull();
        expect(mocks.analyzeWithGemini).not.toHaveBeenCalled();
        releaseSlowPrepare?.();
    });

    it('returns null when the assembled DTO fails final contract validation', async () => {
        const malformed = validModelResponse();
        malformed.persona.headline = 'no korean characters at all here';
        mocks.analyzeWithGemini.mockResolvedValue(malformed);
        const result = await inferPrecheckoutBlite(source(), inferenceOptions());
        expect(result).toBeNull();
    });
});
