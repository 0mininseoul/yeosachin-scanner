import { describe, expect, it, vi } from 'vitest';

const conciergeBatchTestMocks = vi.hoisted(() => ({
    analyzeWithGemini: vi.fn(),
}));

vi.mock('@/lib/services/ai/gemini', async importOriginal => ({
    ...await importOriginal<typeof import('@/lib/services/ai/gemini')>(),
    analyzeWithGemini: conciergeBatchTestMocks.analyzeWithGemini,
}));

import {
    buildConciergeBatchHighRiskCopyPrompt,
    generateConciergeBatchCandidateCopies,
    generateConciergeBatchHighRiskCopy,
    isRecoverableTargetProfileArtifactError,
    isMatchingTargetProfileArtifactRun,
    parseConciergeExistingRelationshipArtifacts,
    relationshipArtifactProviderContext,
    type ConciergeBatchHighRiskCopyEvidence,
    validateConciergeBatchHighRiskCopy,
} from './run-concierge-batch';
import { runConciergeBatch } from '@/lib/services/analysis/concierge-batch-runner';

describe('concierge existing relationship artifact resolver', () => {
    it('accepts only approved callback-free resume identities', () => {
        const artifacts = parseConciergeExistingRelationshipArtifacts(JSON.stringify({
            target_user: {
                followers: {
                    runId: 'Abcdef12',
                    credentialSlot: 'secondary',
                    sourceDeclaredCount: 120,
                },
                following: {
                    runId: 'Zyxwvu98',
                    credentialSlot: 'secondary',
                    sourceDeclaredCount: 80,
                },
            },
        }));

        expect(artifacts.get('target_user')).toEqual({
            followers: {
                runId: 'Abcdef12',
                credentialSlot: 'secondary',
                sourceDeclaredCount: 120,
            },
            following: {
                runId: 'Zyxwvu98',
                credentialSlot: 'secondary',
                sourceDeclaredCount: 80,
            },
        });
        expect(relationshipArtifactProviderContext(
            'request-id',
            artifacts.get('target_user')!.followers!,
            100,
        )).toMatchObject({
            requestId: 'request-id',
            resumeRunId: 'Abcdef12',
            logicalProvider: 'apify',
            actorId: 'scraping_solutions/instagram-scraper-followers-following-no-cookies',
            credentialSlot: 'secondary',
            maxChargeUsd: 100,
            allowAdoptedRelationshipTruncation: true,
            adoptedRelationshipSourceDeclaredCount: 120,
        });
    });

    it('rejects an unapproved or malformed artifact identity', () => {
        expect(() => parseConciergeExistingRelationshipArtifacts(JSON.stringify({
            target_user: {
                followers: {
                    runId: 'bad run id',
                    credentialSlot: 'tertiary',
                    sourceDeclaredCount: 0,
                },
            },
        }))).toThrow('CONCIERGE_BATCH_EXISTING_ARTIFACT_MAP_INVALID');
    });

    it('falls back only for target-profile artifact lineage failures', () => {
        expect(isRecoverableTargetProfileArtifactError(new Error('CONCIERGE_PROVIDER_ARTIFACT_INVALID'))).toBe(true);
        expect(isRecoverableTargetProfileArtifactError(new Error('CONCIERGE_PROVIDER_ARTIFACT_LOOKUP_FAILED'))).toBe(true);
        expect(isRecoverableTargetProfileArtifactError(new Error('CONCIERGE_TARGET_PROFILE_PRIVATE'))).toBe(false);
        expect(isRecoverableTargetProfileArtifactError(new Error('CONCIERGE_PROVIDER_ARTIFACT_INVALID_EXTRA'))).toBe(false);
    });

    it('matches the opaque canonical actor id returned by Apify, not the actor slug', () => {
        const run = {
            id: 'Abcdef12',
            actId: 'opaqueCanonicalActorId123',
            status: 'SUCCEEDED',
            defaultDatasetId: 'dataset123',
        };

        expect(isMatchingTargetProfileArtifactRun(
            run,
            'Abcdef12',
            'opaqueCanonicalActorId123',
        )).toBe(true);
        expect(isMatchingTargetProfileArtifactRun(
            run,
            'Abcdef12',
            'apify/instagram-profile-scraper',
        )).toBe(false);
    });

    const copyEvidence = (facts: ConciergeBatchHighRiskCopyEvidence['facts']): ConciergeBatchHighRiskCopyEvidence => ({
        requestId: '00000000-0000-4000-8000-000000000001',
        targetUsername: 'target_user',
        targetFullName: '대상 이름',
        candidateUsername: 'candidate_user',
        candidateFullName: '후보 이름',
        bio: '여행과 커피를 즐기는 기록',
        captions: ['주말 여행과 커피 기록'],
        appearanceGrade: 4,
        facts,
        images: [],
    });

    it.each([
        ['강민주', '민주님'],
        ['이지훈', '지훈님'],
        ['수경', '수경님'],
        ['Alex Kim', 'Alex Kim님'],
        [null, 'candidate_user'],
    ])('formats %s as %s', (fullName, expected) => {
        const evidence = { ...copyEvidence([]), candidateFullName: fullName };
        expect(buildConciergeBatchHighRiskCopyPrompt(evidence))
            .toContain(`후보 이름: ${expected}`);
    });

    it('states the image availability and bans internal person labels in the prompt', () => {
        const prompt = buildConciergeBatchHighRiskCopyPrompt({
            ...copyEvidence([]),
            images: [],
            bio: null,
            captions: [],
            appearanceGrade: 0,
        });

        expect(prompt).toContain('후보 프로필 이미지 제공 여부: 없음');
        expect(prompt).toContain('대상 계정·후보·후보 계정 같은 내부 역할명은 쓰지 마세요.');
        expect(prompt).toContain('이미지에서 실제로 보이는 요소만 묘사하세요');
        expect(prompt).toContain('이미지가 없으면 실루엣·이목구비·얼굴·표정·헤어스타일·체형·옷차림·포즈를 만들지 마세요.');
        expect(prompt).toContain('드러난 단서가 적다는 한계를 솔직하게 쓰되 다른 후보와 같은 문장을 반복하지 마세요.');
    });

    it('rejects visual claims when no candidate image exists', () => {
        const evidence = {
            ...copyEvidence([]),
            targetFullName: null,
            candidateFullName: null,
            bio: null,
            captions: [],
            images: [],
            appearanceGrade: 0,
        };

        expect(() => validateConciergeBatchHighRiskCopy({
            oneLineOverview: 'candidate_user는 선명한 이목구비와 차분한 실루엣으로 묘한 긴장감을 남깁니다.',
            riskAnalysis: [
                'candidate_user는 얼굴 표정만으로 주변 시선을 붙드는 인상을 선명하게 보여줍니다.',
                'candidate_user는 헤어스타일과 체형에서 도발적인 분위기를 자연스럽게 드러냅니다.',
            ],
        }, evidence)).toThrow('CONCIERGE_BATCH_COPY_UNOBSERVED_APPEARANCE');
    });

    it('allows visual claims when a profile image exists', () => {
        const evidence = {
            ...copyEvidence([]),
            targetFullName: null,
            candidateFullName: null,
            bio: null,
            captions: [],
            images: ['profile-image'],
            appearanceGrade: 0,
        };

        expect(validateConciergeBatchHighRiskCopy({
            oneLineOverview: 'candidate_user는 선명한 이목구비와 차분한 실루엣으로 묘한 긴장감을 남깁니다.',
            riskAnalysis: [
                'candidate_user는 얼굴 표정만으로 주변 시선을 붙드는 인상을 선명하게 보여줍니다.',
                'candidate_user는 헤어스타일과 체형에서 도발적인 분위기를 자연스럽게 드러냅니다.',
            ],
        }, evidence)).toMatchObject({ candidateUsername: 'candidate_user' });
    });

    it('accepts varied honest copy when every evidence source is absent', () => {
        const evidence = {
            ...copyEvidence([]),
            targetFullName: null,
            candidateFullName: null,
            bio: null,
            captions: [],
            images: [],
            appearanceGrade: 4,
        };

        expect(validateConciergeBatchHighRiskCopy({
            oneLineOverview: 'candidate_user는 현재 남겨진 정보가 적어 단정할 재료보다 조심스러운 여지를 남기는 계정입니다.',
            riskAnalysis: [
                'candidate_user의 공개 기록이 많지 않아 지금 드러난 단서만으로 관계의 온도를 섣불리 읽기는 어렵습니다.',
                'candidate_user는 추가로 확인되는 소개나 기록이 쌓일 때까지 열린 가능성으로 바라보는 편이 자연스럽습니다.',
            ],
        }, evidence)).toMatchObject({ candidateUsername: 'candidate_user' });
    });

    it('keeps the existing nonempty Zod guard for blank copy', () => {
        const evidence = {
            ...copyEvidence([]),
            targetFullName: null,
            candidateFullName: null,
        };

        expect(() => validateConciergeBatchHighRiskCopy({
            oneLineOverview: '   ',
            riskAnalysis: [
                'candidate_user의 여행과 커피 기록이 가벼운 호기심을 남깁니다.',
                'candidate_user의 공개 기록이 자연스러운 분위기를 만듭니다.',
            ],
        }, evidence)).toThrow('CONCIERGE_BATCH_COPY_SCHEMA_INVALID');
    });

    it('uses the expanded output budget only for the candidate-copy Gemini call', async () => {
        conciergeBatchTestMocks.analyzeWithGemini.mockReset();
        conciergeBatchTestMocks.analyzeWithGemini.mockResolvedValue({
            oneLineOverview: 'candidate_user의 여행과 커피 기록이 서로 다른 장면에서 자연스럽게 이어져 가벼운 호기심을 남깁니다.',
            riskAnalysis: [
                'candidate_user의 여행 장면과 커피 취향이 피드의 분위기를 가볍게 끌어당깁니다.',
                'candidate_user의 공개 기록에서 주말의 결이 은근한 긴장감을 만들어 시선을 붙잡습니다.',
            ],
        });

        await generateConciergeBatchHighRiskCopy({
            ...copyEvidence([]),
            targetFullName: null,
            candidateFullName: null,
            appearanceGrade: 0,
        });

        const options = conciergeBatchTestMocks.analyzeWithGemini.mock.calls[0]?.[2];
        expect(options).toMatchObject({
            model: 'gemini-3-flash-preview',
            maxOutputTokens: 4_096,
            maxAttempts: 1,
        });
    });

    it('makes both overview and detail depend on the observed direction', async () => {
        const result = await generateConciergeBatchHighRiskCopy(
            copyEvidence([{ direction: 'candidate_to_target', kind: 'like' }]),
            async prompt => {
                expect(prompt).toContain('후보 이름님 -> 대상 이름님');
                return {
                    oneLineOverview: '후보 이름님이 대상 이름님 게시물에 좋아요를 남긴 장면이 먼저 눈에 들어와 흐름이 장난스럽게 번집니다.',
                    riskAnalysis: [
                        '후보 이름님이 대상 이름님 게시물에 좋아요를 남긴 흐름이 공개 기록의 분위기와 겹쳐 보입니다.',
                        '후보 이름님이 대상 이름님 게시물에 좋아요를 남긴 사실을 중심으로 두 사람의 장난스러운 결을 읽습니다.',
                    ],
                };
            },
        );
        expect(result.candidateUsername).toBe('candidate_user');
        expect(result.oneLineOverview).toContain('좋아요');
        expect(result.riskAnalysis).toHaveLength(2);
    });

    it('requires the overview to ground the strongest interaction while details cover each unique direction and kind', () => {
        const evidence = copyEvidence([
            { direction: 'candidate_to_target', kind: 'like' },
            { direction: 'candidate_to_target', kind: 'comment', content: '첫 번째 댓글' },
            { direction: 'candidate_to_target', kind: 'comment', content: '두 번째 댓글' },
            { direction: 'target_to_candidate', kind: 'like' },
        ]);

        expect(() => validateConciergeBatchHighRiskCopy({
            oneLineOverview: '후보 이름님이 대상 이름님 게시물에 좋아요를 남긴 장면이 먼저 눈에 들어와 가벼운 긴장감을 남깁니다.',
            riskAnalysis: [
                '후보 이름님이 대상 이름님 게시물에 좋아요와 댓글을 남긴 흐름이 공개 기록의 결을 바꿔 보입니다.',
                '대상 이름님이 후보 이름님 게시물에 좋아요를 남긴 장면까지 이어져 두 사람의 온도를 읽게 합니다.',
            ],
        }, evidence)).toThrow('CONCIERGE_BATCH_COPY_OVERVIEW_INTERACTION_GROUNDING_INVALID');
    });

    it('deduplicates repeated raw facts by direction and kind before prompting Gemini', () => {
        const prompt = buildConciergeBatchHighRiskCopyPrompt(copyEvidence([
            { direction: 'candidate_to_target', kind: 'comment', content: '첫 번째 댓글' },
            { direction: 'candidate_to_target', kind: 'comment', content: '두 번째 댓글' },
            { direction: 'candidate_to_target', kind: 'like' },
        ]));

        expect(prompt.match(/방향=후보 이름님 -> 대상 이름님; 유형=댓글/gu)).toHaveLength(1);
        expect(prompt).toContain('첫 번째 댓글');
        expect(prompt).not.toContain('두 번째 댓글');
    });

    it('allows provocative no-interaction copy without trust-eroding wording', async () => {
        const result = await generateConciergeBatchHighRiskCopy(
            copyEvidence([]),
            async () => ({
                oneLineOverview: '후보 이름님의 여행과 커피 취향이 사진마다 은근한 신호처럼 번져 장난스러운 상상을 부릅니다.',
                riskAnalysis: [
                    '후보 이름님의 여행 기록과 커피 장면이 한 편의 가벼운 관계극처럼 이어져 시선을 잡습니다.',
                    '후보 이름님의 사진 속 분위기가 평범한 일상보다 조금 더 도발적인 여운을 남깁니다.',
                ],
            }),
        );
        const text = [result.oneLineOverview, ...result.riskAnalysis].join(' ');
        expect(text).not.toMatch(/확인되지 않았다|알 수 없다|수집 범위|공개 자료만으로는/u);
        expect(text).not.toMatch(/좋아요|댓글|태그|멘션/u);
    });

    it('rejects sparse deterministic prose and retries Gemini once', async () => {
        let attempts = 0;
        await expect(generateConciergeBatchHighRiskCopy(
            copyEvidence([]),
            async () => {
                attempts += 1;
                return {
                    oneLineOverview: '후보 이름님의 공개된 소개·캡션 문구가 비어 있어, 사진에서 이야기를 지어내지 않고 이름으로 확인되는 범위만 차분히 읽어봅니다.',
                    riskAnalysis: [
                        '후보 이름님의 공개 기록에서 사진과 소개의 결을 중심으로 장난스러운 분위기를 읽습니다.',
                        '후보 이름님의 피드에 남은 장면이 가벼운 긴장감을 만들어 시선을 붙잡습니다.',
                    ],
                };
            },
        )).rejects.toThrow('CONCIERGE_BATCH_COPY_GENERATION_FAILED');
        expect(attempts).toBe(2);
    });

    it('retries a cross-candidate template once and rejects it when it repeats', async () => {
        const first = copyEvidence([]);
        const second = {
            ...first,
            candidateUsername: 'second_candidate',
            candidateFullName: '두번째 이름',
        };
        let attempts = 0;
        const template = (candidate: string) => ({
            oneLineOverview: `${candidate}부터 대상 이름님까지 여행과 커피 기록이 사진마다 같은 결로 이어집니다.`,
            riskAnalysis: [
                `${candidate}부터 대상 이름님까지 여행과 커피 기록이 가벼운 긴장감을 만듭니다.`,
                `${candidate}부터 대상 이름님까지 여행과 커피 기록을 장난스럽게 읽습니다.`,
            ],
        });
        await expect(generateConciergeBatchCandidateCopies(
            [first, second],
            async prompt => {
                attempts += 1;
                return template(prompt.includes('두번째 이름') ? '두번째 이름님' : '후보 이름님');
            },
        )).rejects.toThrow('CONCIERGE_BATCH_COPY_GENERATION_FAILED');
        expect(attempts).toBe(3);
    });

    it('accepts distinct Gemini copy for every candidate in one batch', async () => {
        const first = copyEvidence([]);
        const second = {
            ...first,
            candidateUsername: 'second_candidate',
            candidateFullName: '두번째 이름',
            bio: '산책과 음악을 즐기는 기록',
        };
        let calls = 0;
        const copies = await generateConciergeBatchCandidateCopies(
            [first, second],
            async prompt => {
                calls += 1;
                if (prompt.includes('두번째 이름')) {
                    return {
                        oneLineOverview: '두번째 이름님의 산책과 음악 기록이 사진마다 다른 리듬으로 이어져 자연스러운 호기심을 남깁니다.',
                        riskAnalysis: [
                            '두번째 이름님의 산책 장면과 음악 취향이 피드의 분위기를 가볍게 끌어당깁니다.',
                            '두번째 이름님의 기록에서 일상과 취향이 섞인 결이 은근한 긴장감을 만듭니다.',
                        ],
                    };
                }
                return {
                    oneLineOverview: '후보 이름님의 여행과 커피 기록이 사진마다 다른 온도로 이어져 장난스러운 호기심을 남깁니다.',
                    riskAnalysis: [
                        '후보 이름님의 여행 장면과 커피 취향이 피드의 분위기를 가볍게 끌어당깁니다.',
                        '후보 이름님의 기록에서 주말의 결이 은근한 긴장감을 만들어 시선을 붙잡습니다.',
                    ],
                };
            },
        );
        expect(calls).toBe(2);
        expect(copies).toHaveLength(2);
        expect(new Set(copies.map(copy => copy.oneLineOverview)).size).toBe(2);
    });

    it('keeps an order retryable after the second copy contract failure', async () => {
        let attempts = 0;
        let publicationCalls = 0;
        let failureCode: string | null = null;
        const summary = await runConciergeBatch([
            {
                orderId: '00000000-0000-4000-8000-000000000002',
                ownerId: '00000000-0000-4000-8000-000000000003',
                targetUsername: 'target_user',
                planId: 'basic',
                cohort: 'awaiting_operator',
            },
        ], {
            async collect() { return null; },
            async classify() { return null; },
            async publish() {
                await generateConciergeBatchHighRiskCopy(
                    copyEvidence([{ direction: 'candidate_to_target', kind: 'comment' }]),
                    async () => {
                        attempts += 1;
                        return { oneLineOverview: '짧음', riskAnalysis: ['짧음', '짧음'] };
                    },
                );
                publicationCalls += 1;
                return { status: 'completed' as const };
            },
            async onFailure(_order, error) {
                failureCode = error instanceof Error ? error.message : null;
            },
        });
        expect(attempts).toBe(2);
        expect(publicationCalls).toBe(0);
        expect(summary).toMatchObject({ total: 1, completed: 0, failed: 1, running: 0 });
        expect(failureCode).toBe('CONCIERGE_BATCH_COPY_GENERATION_FAILED');
    });
});
