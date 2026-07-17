import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    analyzeWithGemini: vi.fn(),
}));

vi.mock('./gemini', async importOriginal => ({
    ...await importOriginal<typeof import('./gemini')>(),
    analyzeWithGemini: mocks.analyzeWithGemini,
}));

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

import { parseSafePublicRiskNarrative } from '@/lib/services/analysis/narrative-privacy';
import {
    AnalysisV2AiResultRateLimitExhaustedError,
    createAnalysisV2AiAuditAdapter,
    type AnalysisV2AiResultStore,
} from '@/lib/services/analysis/v2-ai-result-store';
import type {
    AnalysisV2AiAttemptRecord,
    AnalysisV2AiAttemptStore,
} from '@/lib/services/analysis/v2-ai-attempt-store';
import { zodToGeminiResponseJsonSchema } from './gemini';
import {
    createFeatureAnalysisResultIdentity,
    createGenderTriageResultIdentity,
    createHighRiskNarrativeResultIdentity,
    createPartnerSafetyResultIdentity,
    featureAnalysis,
    featureAnalysisModelResponseSchema,
    genderTriage,
    highRiskNarrative,
    highRiskNarrativeInputSchema,
    highRiskNarrativeModelResponseSchema,
    normalizedAiMediaSelectionSchema,
    partnerSafetyAnalysis,
    partnerSafetyInputSchema,
    partnerSafetyModelResponseSchema,
    type FeatureAnalysisInput,
    type FeatureAnalysisResult,
    type GenderTriageResult,
    type HighRiskNarrativeInput,
    type NormalizedAiMediaSelection,
    type StagedAiAuditContext,
} from './v2-staged-analysis';

const requestId = '11111111-1111-4111-8111-111111111111';

function encoded(value: string): string {
    return Buffer.from(value).toString('base64');
}

function media(): NormalizedAiMediaSelection[] {
    return [
        {
            selectionId: 'profile:candidate',
            kind: 'profile',
            normalizedJpegBase64: encoded('profile'),
        },
        ...Array.from({ length: 10 }, (_, index) => ({
            selectionId: `post:${index + 1}:thumbnail`,
            kind: 'feed' as const,
            normalizedJpegBase64: encoded(`post-${index + 1}`),
            postId: `post-${index + 1}`,
        })),
    ];
}

function audit(
    stage: 'genderTriage' | 'featureAnalysis' | 'partnerSafety' | 'highRiskNarrative'
    = 'genderTriage',
    rawInput?: unknown
): StagedAiAuditContext {
    const resultIdentity = stage === 'genderTriage'
        ? createGenderTriageResultIdentity(
            (rawInput ?? { media: media() }) as Parameters<
                typeof createGenderTriageResultIdentity
            >[0]
        )
        : stage === 'featureAnalysis'
            ? createFeatureAnalysisResultIdentity(
                (rawInput ?? featureInput()) as Parameters<
                    typeof createFeatureAnalysisResultIdentity
                >[0]
            )
            : stage === 'partnerSafety'
                ? createPartnerSafetyResultIdentity(
                    (rawInput ?? {
                        feature: verifiedFeatureResult(),
                        contactSheet: contactSheet(),
                    }) as Parameters<typeof createPartnerSafetyResultIdentity>[0]
                )
                : createHighRiskNarrativeResultIdentity(
                    (rawInput ?? narrativeInput()) as Parameters<
                        typeof createHighRiskNarrativeResultIdentity
                    >[0]
                );
    if (!resultIdentity) throw new Error('Test audit requires a generated stage identity.');
    return {
        requestId,
        operationKey: resultIdentity.operationKey,
        resultIdentity,
        prepare: vi.fn().mockResolvedValue({
            result: null,
            source: null,
            startingAttempt: 1,
        }),
        onBeforeAttempt: vi.fn(),
        onAttemptTelemetry: vi.fn(),
    };
}

function routedTriage(
    assessment: GenderTriageResult['assessment'] = {
        inferredGender: 'unknown',
        confidence: 'low',
        ownerConsistency: 'multiple_or_unclear',
        evidenceSelectionIds: ['profile:candidate'],
    }
): GenderTriageResult {
    return {
        assessment,
        routingDecision: 'route_to_feature_analysis',
        routingReason: 'conserve_female_recall',
        analyzedSelectionIds: media().slice(0, 5).map(item => item.selectionId),
    };
}

function featureResponse(overrides: Record<string, unknown> = {}) {
    return {
        gender: 'female',
        genderConfidence: 'high',
        ownerConsistency: 'same_person',
        appearanceGrade: 4,
        exposureScore: 2,
        businessClassification: 'personal',
        businessConfidence: 'high',
        marriageEvidence: 'none',
        partnerEvidence: 'none',
        partnerExclusionContext: 'none',
        evidenceSelectionIds: {
            gender: ['profile:candidate', 'post:1:thumbnail'],
            appearance: ['post:1:thumbnail'],
            exposure: ['post:1:thumbnail'],
            business: ['profile:candidate'],
            marriagePartner: [],
        },
        oneLineOverview: '여행과 일상을 선명한 사진으로 정돈해 보여 주는 계정입니다.',
        ...overrides,
    };
}

function featureInput(triage = routedTriage()): FeatureAnalysisInput {
    return {
        triage,
        bio: '여행과 일상 기록',
        media: media(),
        captions: media().slice(1).map((item, index) => ({
            evidenceRefId: `caption:${index + 1}`,
            selectionId: item.selectionId,
            text: `여행 기록 ${index + 1}`,
        })),
    };
}

function verifiedFeatureResult(
    overrides: Record<string, unknown> = {}
): FeatureAnalysisResult {
    return {
        features: featureResponse(overrides) as FeatureAnalysisResult['features'],
        finalGenderDecision: 'verified_female',
        analyzedSelectionIds: media().map(item => item.selectionId),
    };
}

function contactSheet() {
    return {
        selectionId: `contact-sheet:${'a'.repeat(64)}`,
        normalizedJpegBase64: encoded('contact-sheet'),
        sourceSelectionIds: ['post:carousel:media:1', 'post:carousel:media:2'],
        width: 388,
        height: 192,
    };
}

function partnerCaptions() {
    return [{
        evidenceRefId: 'carousel-caption:second-slide',
        selectionId: 'post:carousel:media:2',
        text: '  @target.user\nsecond slide text  ',
    }];
}

function carouselCaptionDossier() {
    return {
        evidenceRefId: 'carousel-dossier:latest-complete-carousel',
        text: '[슬라이드 1] city walk\n[슬라이드 2] @target.user with candidate.user',
    };
}

function observed(ref: string) {
    return { status: 'observed' as const, evidenceRefIds: [ref] };
}

function narrativeInput(): HighRiskNarrativeInput {
    return {
        forbiddenIdentifiers: {
            targetUsername: 'target.user',
            candidateUsername: 'candidate.user',
        },
        bio: 'candidate.user 여행 계정 https://example.com user@example.com 010-1234-5678',
        media: media(),
        captions: [{
            evidenceRefId: 'caption:1',
            selectionId: 'post:1:thumbnail',
            text: '@target.user 와 함께한 여행',
        }],
        interactions: {
            candidateToTargetLike: observed('like:candidate-to-target'),
            targetToCandidateLike: observed('like:target-to-candidate'),
            candidateToTargetComment: observed('comment:1'),
            comments: [{
                evidenceRefId: 'comment:1',
                targetPostEvidenceRefId: 'target-post:1',
                text: '@target.user 반가워 또 보자 010-2222-3333',
            }],
            coverage: {
                status: 'partial',
                evidenceRefId: 'coverage:target-interactions',
            },
        },
    };
}

describe('V2 staged AI services', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('keeps derived gender and feature results inside the current request', () => {
        expect(createGenderTriageResultIdentity({ media: media() }).cacheScope)
            .toBe('request');
        expect(createFeatureAnalysisResultIdentity(featureInput()).cacheScope)
            .toBe('request');
    });

    it('accepts only bounded normalized JPEG artifacts with stable IDs', () => {
        expect(normalizedAiMediaSelectionSchema.parse(media()[0])).toEqual(media()[0]);
        expect(() => normalizedAiMediaSelectionSchema.parse({
            ...media()[0],
            normalizedJpegBase64: 'not base64',
        })).toThrow('standard base64');
    });

    it('triages with one profile and four feed images and excludes only a high-confidence same-owner male', async () => {
        mocks.analyzeWithGemini.mockImplementation(async (
            _prompt: string,
            _images: string[],
            options: { schema: { parse(value: unknown): unknown } }
        ) => options.schema.parse({
            inferredGender: 'male',
            confidence: 'high',
            ownerConsistency: 'same_person',
            evidenceSelectionIds: ['profile:candidate', 'post:1:thumbnail'],
        }));
        const hooks = audit();

        const result = await genderTriage({ media: media() }, hooks);

        expect(result.routingDecision).toBe('exclude_high_confidence_male');
        expect(result.analyzedSelectionIds).toEqual([
            'profile:candidate',
            'post:1:thumbnail',
            'post:2:thumbnail',
            'post:3:thumbnail',
            'post:4:thumbnail',
        ]);
        const [prompt, images, options] = mocks.analyzeWithGemini.mock.calls[0];
        expect(images).toHaveLength(5);
        expect(prompt).toContain('multiple_or_unclear');
        expect(prompt).toContain('중복 selectionId');
        expect(prompt).toContain('unknown, low, not_visible');
        expect(prompt).not.toContain('post:5:thumbnail');
        expect(zodToGeminiResponseJsonSchema(
            options.schema as Parameters<typeof zodToGeminiResponseJsonSchema>[0]
        )).toMatchObject({
            type: 'object',
            properties: { evidenceSelectionIds: { type: 'array' } },
        });
        expect(options).toMatchObject({
            stage: 'genderTriage',
            requestId,
            onBeforeAttempt: hooks.onBeforeAttempt,
            onAttemptTelemetry: hooks.onAttemptTelemetry,
        });
    });

    it('routes uncertain male and all female or unknown triage results to preserve female recall', async () => {
        for (const assessment of [
            {
                inferredGender: 'male',
                confidence: 'medium',
                ownerConsistency: 'same_person',
                evidenceSelectionIds: ['profile:candidate'],
            },
            {
                inferredGender: 'female',
                confidence: 'high',
                ownerConsistency: 'same_person',
                evidenceSelectionIds: ['profile:candidate', 'post:1:thumbnail'],
            },
            {
                inferredGender: 'unknown',
                confidence: 'low',
                ownerConsistency: 'not_visible',
                evidenceSelectionIds: [],
            },
        ]) {
            mocks.analyzeWithGemini.mockImplementationOnce(async (
                _prompt: string,
                _images: string[],
                options: { schema: { parse(value: unknown): unknown } }
            ) => options.schema.parse(assessment));
            const result = await genderTriage({ media: media() }, audit());
            expect(result.routingDecision).toBe('route_to_feature_analysis');
            expect(result.routingReason).toBe('conserve_female_recall');
        }
    });

    it('rejects an audit adapter bound to different media before calling Gemini', async () => {
        const inputA = { media: media() };
        const inputB = {
            media: media().map((item, index) => index === 0
                ? { ...item, normalizedJpegBase64: encoded('different-profile') }
                : item),
        };

        await expect(genderTriage(inputB, audit('genderTriage', inputA)))
            .rejects.toThrow('operationKey');
        expect(mocks.analyzeWithGemini).not.toHaveBeenCalled();
    });

    it('returns a prepared request checkpoint without calling Gemini', async () => {
        const input = { media: media() };
        const hooks = audit('genderTriage', input);
        const cachedAssessment = {
            inferredGender: 'female' as const,
            confidence: 'high' as const,
            ownerConsistency: 'same_person' as const,
            evidenceSelectionIds: ['profile:candidate', 'post:1:thumbnail'],
        };
        hooks.prepare = vi.fn().mockResolvedValue({
            result: cachedAssessment,
            source: 'request',
            startingAttempt: 1,
        });

        const result = await genderTriage(input, hooks);

        expect(result.assessment).toEqual(cachedAssessment);
        expect(mocks.analyzeWithGemini).not.toHaveBeenCalled();
    });

    it('filters and deduplicates hallucinated triage evidence before routing', async () => {
        mocks.analyzeWithGemini.mockImplementation(async (
            _prompt: string,
            _images: string[],
            options: { schema: { parse(value: unknown): unknown } }
        ) => options.schema.parse({
            inferredGender: 'male',
            confidence: 'high',
            ownerConsistency: 'same_person',
            evidenceSelectionIds: [
                'profile:candidate',
                'profile:candidate',
                'post:not-supplied',
            ],
        }));

        const result = await genderTriage({ media: media() }, audit());

        expect(result.assessment).toEqual({
            inferredGender: 'male',
            confidence: 'medium',
            ownerConsistency: 'same_person',
            evidenceSelectionIds: ['profile:candidate'],
        });
        expect(result.routingDecision).toBe('route_to_feature_analysis');
        expect(mocks.analyzeWithGemini).toHaveBeenCalledOnce();
    });

    it('neutralizes triage when no supplied evidence remains', async () => {
        mocks.analyzeWithGemini.mockImplementation(async (
            _prompt: string,
            _images: string[],
            options: { schema: { parse(value: unknown): unknown } }
        ) => options.schema.parse({
            inferredGender: 'male',
            confidence: 'high',
            ownerConsistency: 'same_person',
            evidenceSelectionIds: ['post:not-supplied', 'post:not-supplied'],
        }));

        const result = await genderTriage({ media: media() }, audit());

        expect(result.assessment).toEqual({
            inferredGender: 'unknown',
            confidence: 'low',
            ownerConsistency: 'not_visible',
            evidenceSelectionIds: [],
        });
        expect(result.routingDecision).toBe('route_to_feature_analysis');
    });

    it('requires both durable attempt hooks', async () => {
        await expect(genderTriage({ media: media() }, {
            ...audit(),
            onBeforeAttempt: undefined,
        } as unknown as StagedAiAuditContext)).rejects.toThrow('onBeforeAttempt');
        await expect(genderTriage({ media: media() }, {
            ...audit(),
            operationKey: 'candidate.user',
        })).rejects.toThrow('operationKey');
    });

    it('downgrades high-confidence gender based on only one visual item', async () => {
        mocks.analyzeWithGemini.mockImplementation(async (
            _prompt: string,
            _images: string[],
            options: { schema: { parse(value: unknown): unknown } }
        ) => options.schema.parse({
            inferredGender: 'male',
            confidence: 'high',
            ownerConsistency: 'same_person',
            evidenceSelectionIds: ['profile:candidate'],
        }));

        const result = await genderTriage({ media: media() }, audit());

        expect(result.assessment.confidence).toBe('medium');
        expect(result.routingDecision).toBe('route_to_feature_analysis');
        expect(mocks.analyzeWithGemini).toHaveBeenCalledOnce();
    });

    it('runs feature analysis with medium-stage policy inputs and verifies an unconflicted woman', async () => {
        mocks.analyzeWithGemini.mockImplementation(async (
            _prompt: string,
            _images: string[],
            options: { schema: { parse(value: unknown): unknown } }
        ) => options.schema.parse(featureResponse()));
        const hooks = audit('featureAnalysis');

        const result = await featureAnalysis(featureInput(), hooks);

        expect(result.finalGenderDecision).toBe('verified_female');
        expect(result.features.appearanceGrade).toBe(4);
        expect(result.features.exposureScore).toBe(2);
        const [prompt, images, options] = mocks.analyzeWithGemini.mock.calls[0];
        expect(images).toHaveLength(11);
        expect(prompt).toContain('여행과 일상 기록');
        expect(prompt).toContain('caption:10');
        expect(prompt).toContain('근거가 없으면 보수적인 중립값');
        expect(prompt).toContain('서로 모순되게 반환하지 마세요');
        expect(prompt).toContain(
            'gender=unknown, genderConfidence=low, ownerConsistency=not_visible'
        );
        expect(prompt).toContain(
            'businessClassification=uncertain, businessConfidence=low'
        );
        expect(prompt).toContain(
            'marriageEvidence=none, partnerEvidence=none, partnerExclusionContext=none'
        );
        expect(prompt).toContain('appearanceGrade=1, exposureScore=0');
        expect(prompt).toContain(
            '공개된 프로필과 게시물을 바탕으로 보수적으로 분석한 계정입니다.'
        );
        expect(zodToGeminiResponseJsonSchema(
            options.schema as Parameters<typeof zodToGeminiResponseJsonSchema>[0]
        )).toMatchObject({
            type: 'object',
            properties: {
                evidenceSelectionIds: { type: 'object' },
                oneLineOverview: { type: 'string' },
            },
        });
        expect(options).toMatchObject({
            stage: 'featureAnalysis',
            requestId,
            onBeforeAttempt: hooks.onBeforeAttempt,
            onAttemptTelemetry: hooks.onAttemptTelemetry,
        });
    });

    it('lets high-confidence feature evidence override an uncertain triage guess', async () => {
        const triage = routedTriage({
            inferredGender: 'male',
            confidence: 'medium',
            ownerConsistency: 'multiple_or_unclear',
            evidenceSelectionIds: ['profile:candidate'],
        });
        mocks.analyzeWithGemini.mockImplementation(async (
            _prompt: string,
            _images: string[],
            options: { schema: { parse(value: unknown): unknown } }
        ) => options.schema.parse(featureResponse()));

        const input = featureInput(triage);
        const result = await featureAnalysis(input, audit('featureAnalysis', input));

        expect(result.finalGenderDecision).toBe('verified_female');
    });

    it('rejects partner or marriage evidence that also claims an excluded companion context', () => {
        expect(() => featureAnalysisModelResponseSchema.parse(featureResponse({
            marriageEvidence: 'possible',
            partnerExclusionContext: 'older_relative',
            evidenceSelectionIds: {
                ...featureResponse().evidenceSelectionIds,
                marriagePartner: ['post:1:thumbnail'],
            },
        }))).toThrow('excluded context');
        expect(() => featureAnalysisModelResponseSchema.parse(featureResponse({
            partnerEvidence: 'weak',
            partnerExclusionContext: 'celebrity_or_public_figure',
            evidenceSelectionIds: {
                ...featureResponse().evidenceSelectionIds,
                marriagePartner: ['post:1:thumbnail'],
            },
        }))).toThrow('excluded context');
    });

    it('keeps genuinely conflicting high-confidence same-owner stages unresolved', async () => {
        const triage = routedTriage({
            inferredGender: 'female',
            confidence: 'high',
            ownerConsistency: 'same_person',
            evidenceSelectionIds: ['profile:candidate', 'post:1:thumbnail'],
        });
        mocks.analyzeWithGemini.mockImplementation(async (
            _prompt: string,
            _images: string[],
            options: { schema: { parse(value: unknown): unknown } }
        ) => options.schema.parse(featureResponse({ gender: 'male' })));

        const input = featureInput(triage);
        expect((await featureAnalysis(
            input,
            audit('featureAnalysis', input)
        )).finalGenderDecision)
            .toBe('unresolved_stage_conflict');
    });

    it('downgrades single-item feature gender and drops unsupported evidence IDs', async () => {
        mocks.analyzeWithGemini.mockImplementationOnce(async (
            _prompt: string,
            _images: string[],
            options: { schema: { parse(value: unknown): unknown } }
        ) => options.schema.parse(featureResponse({
            evidenceSelectionIds: {
                ...featureResponse().evidenceSelectionIds,
                gender: [
                    'profile:candidate',
                    'profile:candidate',
                    'post:not-supplied',
                ],
            },
        })));
        const downgraded = await featureAnalysis(
            featureInput(),
            audit('featureAnalysis')
        );
        expect(downgraded.features.genderConfidence).toBe('medium');
        expect(downgraded.features.evidenceSelectionIds.gender)
            .toEqual(['profile:candidate']);
        expect(downgraded.finalGenderDecision).toBe('unresolved');

        mocks.analyzeWithGemini.mockImplementationOnce(async (
            _prompt: string,
            _images: string[],
            options: { schema: { parse(value: unknown): unknown } }
        ) => options.schema.parse(featureResponse({
            evidenceSelectionIds: {
                ...featureResponse().evidenceSelectionIds,
                appearance: ['post:not-supplied'],
            },
        })));
        const normalized = await featureAnalysis(featureInput(), audit('featureAnalysis'));
        expect(normalized.features.evidenceSelectionIds.appearance).toEqual([]);
        expect(normalized.features.appearanceGrade).toBe(1);
    });

    it('rejects contradictory partner signals and internal metrics in one-line overviews', () => {
        expect(() => featureAnalysisModelResponseSchema.parse(featureResponse({
            partnerEvidence: 'strong',
            partnerExclusionContext: 'older_relative',
            evidenceSelectionIds: {
                ...featureResponse().evidenceSelectionIds,
                marriagePartner: ['post:1:thumbnail'],
            },
        }))).toThrow('excluded context');
        expect(() => featureAnalysisModelResponseSchema.parse(featureResponse({
            oneLineOverview: '고위험 점수 상위 계정입니다.',
        }))).toThrow('internals');
    });

    it('normalizes unsupported feature evidence and unsafe claims to strict grounded values', async () => {
        const response = featureResponse({
            appearanceGrade: 5,
            exposureScore: 5,
            businessClassification: 'business',
            businessConfidence: 'high',
            marriageEvidence: 'strong',
            partnerEvidence: 'strong',
            partnerExclusionContext: 'older_relative',
            evidenceSelectionIds: {
                gender: [
                    'profile:candidate',
                    'profile:candidate',
                    'post:1:thumbnail',
                    'post:not-supplied',
                ],
                appearance: ['post:not-supplied'],
                exposure: [],
                business: ['post:not-supplied'],
                marriagePartner: [
                    'post:2:thumbnail',
                    'post:2:thumbnail',
                    'post:not-supplied',
                ],
            },
            oneLineOverview: '고위험 점수 상위 계정입니다.',
        });
        mocks.analyzeWithGemini.mockImplementationOnce(async (
            _prompt: string,
            _images: string[],
            options: { schema: { parse(value: unknown): unknown } }
        ) => options.schema.parse(response));

        const result = await featureAnalysis(featureInput(), audit('featureAnalysis'));

        expect(result.features).toEqual({
            ...featureResponse(),
            appearanceGrade: 1,
            exposureScore: 0,
            businessClassification: 'uncertain',
            businessConfidence: 'low',
            marriageEvidence: 'strong',
            partnerEvidence: 'strong',
            partnerExclusionContext: 'none',
            evidenceSelectionIds: {
                gender: ['profile:candidate', 'post:1:thumbnail'],
                appearance: [],
                exposure: [],
                business: [],
                marriagePartner: ['post:2:thumbnail'],
            },
            oneLineOverview: '공개된 프로필과 게시물을 바탕으로 보수적으로 분석한 계정입니다.',
        });
        expect(() => featureAnalysisModelResponseSchema.parse(result.features)).not.toThrow();
        expect(result.finalGenderDecision).toBe('verified_female');
        expect(mocks.analyzeWithGemini).toHaveBeenCalledOnce();
    });

    it('preserves grounded relationship signals and drops a contradictory exclusion', async () => {
        mocks.analyzeWithGemini.mockImplementationOnce(async (
            _prompt: string,
            _images: string[],
            options: { schema: { parse(value: unknown): unknown } }
        ) => options.schema.parse(featureResponse({
            marriageEvidence: 'possible',
            partnerEvidence: 'weak',
            partnerExclusionContext: 'group_or_unclear',
            evidenceSelectionIds: {
                ...featureResponse().evidenceSelectionIds,
                marriagePartner: ['post:2:thumbnail'],
            },
        })));

        const result = await featureAnalysis(featureInput(), audit('featureAnalysis'));

        expect(result.features).toMatchObject({
            marriageEvidence: 'possible',
            partnerEvidence: 'weak',
            partnerExclusionContext: 'none',
            evidenceSelectionIds: {
                marriagePartner: ['post:2:thumbnail'],
            },
        });
        expect(() => featureAnalysisModelResponseSchema.parse(result.features)).not.toThrow();
    });

    it('neutralizes missing appearance and exposure evidence for uncertain owners', async () => {
        mocks.analyzeWithGemini.mockImplementationOnce(async (
            _prompt: string,
            _images: string[],
            options: { schema: { parse(value: unknown): unknown } }
        ) => options.schema.parse(featureResponse({
            genderConfidence: 'medium',
            ownerConsistency: 'multiple_or_unclear',
            appearanceGrade: 5,
            exposureScore: 5,
            evidenceSelectionIds: {
                ...featureResponse().evidenceSelectionIds,
                appearance: ['post:not-supplied'],
                exposure: [],
            },
        })));

        const result = await featureAnalysis(featureInput(), audit('featureAnalysis'));

        expect(result.features).toMatchObject({
            genderConfidence: 'medium',
            ownerConsistency: 'multiple_or_unclear',
            appearanceGrade: 1,
            exposureScore: 0,
            evidenceSelectionIds: { appearance: [], exposure: [] },
        });
        expect(result.finalGenderDecision).toBe('unresolved');
    });

    it('neutralizes uncertain relationship fields when no valid evidence remains', async () => {
        mocks.analyzeWithGemini.mockImplementationOnce(async (
            _prompt: string,
            _images: string[],
            options: { schema: { parse(value: unknown): unknown } }
        ) => options.schema.parse(featureResponse({
            marriageEvidence: 'uncertain',
            partnerEvidence: 'uncertain',
            partnerExclusionContext: 'older_relative',
            evidenceSelectionIds: {
                ...featureResponse().evidenceSelectionIds,
                marriagePartner: ['post:not-supplied'],
            },
        })));

        const result = await featureAnalysis(featureInput(), audit('featureAnalysis'));

        expect(result.features).toMatchObject({
            marriageEvidence: 'none',
            partnerEvidence: 'none',
            partnerExclusionContext: 'none',
            evidenceSelectionIds: { marriagePartner: [] },
        });
    });

    it('neutralizes uncertain relationship fields after clearing valid IDs with no signal', async () => {
        let checkpointedFeatures: FeatureAnalysisResult['features'] | null = null;
        mocks.analyzeWithGemini.mockImplementationOnce(async (
            _prompt: string,
            _images: string[],
            options: { schema: { parse(value: unknown): unknown } }
        ) => {
            checkpointedFeatures = options.schema.parse(featureResponse({
                marriageEvidence: 'uncertain',
                partnerEvidence: 'uncertain',
                partnerExclusionContext: 'none',
                evidenceSelectionIds: {
                    ...featureResponse().evidenceSelectionIds,
                    marriagePartner: ['post:2:thumbnail'],
                },
            })) as FeatureAnalysisResult['features'];
            return checkpointedFeatures;
        });

        const result = await featureAnalysis(featureInput(), audit('featureAnalysis'));

        expect(checkpointedFeatures).toMatchObject({
            marriageEvidence: 'none',
            partnerEvidence: 'none',
            partnerExclusionContext: 'none',
            evidenceSelectionIds: { marriagePartner: [] },
        });
        expect(result.features).toMatchObject({
            marriageEvidence: 'none',
            partnerEvidence: 'none',
            partnerExclusionContext: 'none',
            evidenceSelectionIds: { marriagePartner: [] },
        });
        expect(() => featureAnalysisModelResponseSchema.parse(result.features)).not.toThrow();
    });

    it('neutralizes unsupported relationship and gender signals without fabricating evidence', async () => {
        mocks.analyzeWithGemini.mockImplementationOnce(async (
            _prompt: string,
            _images: string[],
            options: { schema: { parse(value: unknown): unknown } }
        ) => options.schema.parse(featureResponse({
            gender: 'female',
            genderConfidence: 'high',
            ownerConsistency: 'same_person',
            marriageEvidence: 'strong',
            partnerEvidence: 'weak',
            evidenceSelectionIds: {
                ...featureResponse().evidenceSelectionIds,
                gender: ['post:not-supplied'],
                appearance: [],
                exposure: [],
                marriagePartner: ['post:not-supplied'],
            },
        })));

        const result = await featureAnalysis(featureInput(), audit('featureAnalysis'));

        expect(result.features).toMatchObject({
            gender: 'unknown',
            genderConfidence: 'low',
            ownerConsistency: 'not_visible',
            appearanceGrade: 1,
            exposureScore: 0,
            marriageEvidence: 'none',
            partnerEvidence: 'none',
            partnerExclusionContext: 'none',
            evidenceSelectionIds: {
                gender: [],
                marriagePartner: [],
            },
        });
        expect(result.finalGenderDecision).toBe('unresolved');
    });

    it('clears relationship IDs when no signal exists and leaves a valid response unchanged', async () => {
        const noSignal = featureResponse({
            evidenceSelectionIds: {
                ...featureResponse().evidenceSelectionIds,
                marriagePartner: ['post:2:thumbnail'],
            },
        });
        mocks.analyzeWithGemini.mockImplementationOnce(async (
            _prompt: string,
            _images: string[],
            options: { schema: { parse(value: unknown): unknown } }
        ) => options.schema.parse(noSignal));
        expect((await featureAnalysis(
            featureInput(),
            audit('featureAnalysis')
        )).features.evidenceSelectionIds.marriagePartner).toEqual([]);

        const valid = featureResponse();
        mocks.analyzeWithGemini.mockImplementationOnce(async (
            _prompt: string,
            _images: string[],
            options: { schema: { parse(value: unknown): unknown } }
        ) => options.schema.parse(valid));
        expect((await featureAnalysis(
            featureInput(),
            audit('featureAnalysis')
        )).features).toEqual(valid);
    });

    it('still rejects malformed structural feature responses without another generation', async () => {
        mocks.analyzeWithGemini.mockRejectedValueOnce(new Error(
            'AI_GENERATION_RESPONSE_REJECTED_ERROR: generated response failed strict validation.'
        ));

        await expect(featureAnalysis(featureInput(), audit('featureAnalysis'))).rejects.toThrow(
            'AI_GENERATION_RESPONSE_REJECTED_ERROR'
        );
        expect(mocks.analyzeWithGemini).toHaveBeenCalledOnce();
    });

    it('skips partner-safety generation when no contact sheet exists and preserves feature evidence', async () => {
        const result = await partnerSafetyAnalysis({
            feature: verifiedFeatureResult({
                partnerEvidence: 'strong',
                evidenceSelectionIds: {
                    ...featureResponse().evidenceSelectionIds,
                    marriagePartner: ['post:1:thumbnail'],
                },
            }),
            contactSheet: null,
        });

        expect(mocks.analyzeWithGemini).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            source: 'feature_only',
            hasStrongPartnerEvidence: true,
            strongEvidenceBasis: 'feature',
            analyzedContactSheetSelectionId: null,
        });
    });

    it('keeps caption fields optional for old partner and narrative callers', () => {
        expect(partnerSafetyInputSchema.parse({
            feature: verifiedFeatureResult(),
            contactSheet: null,
        }).partnerCaptions).toEqual([]);
        expect(highRiskNarrativeInputSchema.parse(narrativeInput()).carouselCaptionDossier)
            .toBeNull();
    });

    it('validates bounded unique contact-sheet-aligned partner captions', () => {
        const base = {
            feature: verifiedFeatureResult(),
            contactSheet: contactSheet(),
            partnerCaptions: partnerCaptions(),
        };
        expect(partnerSafetyInputSchema.parse(base).partnerCaptions).toHaveLength(1);
        expect(() => partnerSafetyInputSchema.parse({
            ...base,
            contactSheet: null,
        })).toThrow('contact sheet');
        expect(() => partnerSafetyInputSchema.parse({
            ...base,
            partnerCaptions: [{
                ...partnerCaptions()[0],
                selectionId: 'post:not-in-contact-sheet',
            }],
        })).toThrow('contact-sheet');
        expect(() => partnerSafetyInputSchema.parse({
            ...base,
            partnerCaptions: [partnerCaptions()[0], partnerCaptions()[0]],
        })).toThrow('unique');
        expect(() => partnerSafetyInputSchema.parse({
            ...base,
            partnerCaptions: [
                partnerCaptions()[0],
                { ...partnerCaptions()[0], evidenceRefId: 'carousel-caption:other-ref' },
            ],
        })).toThrow('unique');
        expect(() => partnerSafetyInputSchema.parse({
            ...base,
            partnerCaptions: Array.from({ length: 18 }, (_, index) => ({
                evidenceRefId: `caption:${index}`,
                selectionId: `post:${index}`,
                text: 'caption',
            })),
        })).toThrow();
        expect(() => partnerSafetyInputSchema.parse({
            ...base,
            partnerCaptions: [{
                ...partnerCaptions()[0],
                text: 'x'.repeat(2_201),
            }],
        })).toThrow();
        expect(() => partnerSafetyInputSchema.parse({
            ...base,
            contactSheet: {
                ...contactSheet(),
                sourceSelectionIds: [
                    'post:carousel:media:1',
                    'post:carousel:media:2',
                ],
            },
            partnerCaptions: [
                {
                    evidenceRefId: 'caption:1',
                    selectionId: 'post:carousel:media:1',
                    text: 'x'.repeat(1_001),
                },
                {
                    evidenceRefId: 'caption:2',
                    selectionId: 'post:carousel:media:2',
                    text: 'y'.repeat(1_000),
                },
            ],
        })).toThrow('2,000');
    });

    it('maps untrusted partner captions to the exact visual cell and includes them in identity', async () => {
        const input = {
            feature: verifiedFeatureResult(),
            contactSheet: contactSheet(),
            partnerCaptions: partnerCaptions(),
        } as Parameters<typeof partnerSafetyAnalysis>[0];
        const withoutCaptions = createPartnerSafetyResultIdentity({
            feature: verifiedFeatureResult(),
            contactSheet: contactSheet(),
        });
        expect(createPartnerSafetyResultIdentity(input)?.inputHash)
            .not.toBe(withoutCaptions?.inputHash);
        mocks.analyzeWithGemini.mockImplementation(async (
            _prompt: string,
            _images: string[],
            options: { schema: { parse(value: unknown): unknown } }
        ) => options.schema.parse({
            companionPattern: 'none',
            partnerEvidence: 'none',
            exclusionContext: 'none',
            confidence: 'medium',
            evidenceSourceSelectionIds: [],
        }));

        await partnerSafetyAnalysis(input, audit('partnerSafety', input));

        const [prompt] = mocks.analyzeWithGemini.mock.calls[0];
        expect(prompt).toContain('carousel-caption:second-slide');
        expect(prompt).toContain('"cellNumber":2');
        expect(prompt).toContain('"selectionId":"post:carousel:media:2"');
        expect(prompt).toContain('신뢰할 수 없는');
        expect(prompt).toContain('시각');
    });

    it('uses one contact sheet and records a non-excluded two-person photo as pending weak evidence', async () => {
        mocks.analyzeWithGemini.mockImplementation(async (
            _prompt: string,
            _images: string[],
            options: { schema: { parse(value: unknown): unknown } }
        ) => options.schema.parse({
            companionPattern: 'single_two_person',
            partnerEvidence: 'weak',
            exclusionContext: 'none',
            confidence: 'medium',
            evidenceSourceSelectionIds: ['post:carousel:media:1'],
        }));
        const hooks = audit('partnerSafety');

        const result = await partnerSafetyAnalysis({
            feature: verifiedFeatureResult(),
            contactSheet: contactSheet(),
        }, hooks);

        expect(result).toMatchObject({
            source: 'gemini',
            hasWeakNonExcludedMalePairEvidence: true,
            hasStrongPartnerEvidence: false,
            weakAdjustmentStatus: 'applied_policy_v2_2',
            analyzedContactSheetSelectionId: contactSheet().selectionId,
        });
        const [prompt, images, options] = mocks.analyzeWithGemini.mock.calls[0];
        expect(images).toEqual([contactSheet().normalizedJpegBase64]);
        expect(prompt).toContain('post:carousel:media:1');
        expect(options).toMatchObject({
            stage: 'partnerSafety',
            requestId,
            onBeforeAttempt: hooks.onBeforeAttempt,
            onAttemptTelemetry: hooks.onAttemptTelemetry,
        });
    });

    it('requires repeated or explicit high-confidence evidence for a strong partner cap', async () => {
        expect(() => partnerSafetyModelResponseSchema.parse({
            companionPattern: 'single_two_person',
            partnerEvidence: 'strong',
            exclusionContext: 'none',
            confidence: 'high',
            evidenceSourceSelectionIds: ['post:carousel:media:1'],
        })).toThrow('repeated or explicit');

        mocks.analyzeWithGemini.mockImplementation(async (
            _prompt: string,
            _images: string[],
            options: { schema: { parse(value: unknown): unknown } }
        ) => options.schema.parse({
            companionPattern: 'repeated_same_person',
            partnerEvidence: 'strong',
            exclusionContext: 'none',
            confidence: 'high',
            evidenceSourceSelectionIds: [
                'post:carousel:media:1',
                'post:carousel:media:2',
            ],
        }));

        const result = await partnerSafetyAnalysis({
            feature: verifiedFeatureResult(),
            contactSheet: contactSheet(),
        }, audit('partnerSafety'));
        expect(result).toMatchObject({
            hasStrongPartnerEvidence: true,
            strongEvidenceBasis: 'contact_sheet',
            weakAdjustmentStatus: 'not_applicable',
        });
    });

    it('falls back to feature-only partner evidence for invalid contact-sheet refs without regenerating', async () => {
        const input = {
            feature: verifiedFeatureResult(),
            contactSheet: contactSheet(),
            partnerCaptions: partnerCaptions(),
        } as Parameters<typeof partnerSafetyAnalysis>[0];
        mocks.analyzeWithGemini.mockImplementation(async (
            _prompt: string,
            _images: string[],
            options: { schema: { parse(value: unknown): unknown } }
        ) => options.schema.parse({
            companionPattern: 'single_two_person',
            partnerEvidence: 'weak',
            exclusionContext: 'none',
            confidence: 'medium',
            evidenceSourceSelectionIds: ['carousel-caption:second-slide'],
        }));

        const result = await partnerSafetyAnalysis(input, audit('partnerSafety', input));

        expect(mocks.analyzeWithGemini).toHaveBeenCalledOnce();
        expect(result).toMatchObject({
            source: 'safe_fallback',
            hasStrongPartnerEvidence: false,
            analyzedContactSheetSelectionId: null,
        });
    });

    it.each(['live', 'replay'] as const)(
        'uses deterministic partner fallback for %s exhausted rate limiting',
        async source => {
            const input = {
                feature: verifiedFeatureResult(),
                contactSheet: contactSheet(),
            };
            const hooks = audit('partnerSafety', input);
            const error = source === 'live'
                ? new Error(
                    'AI_RATE_LIMIT_ERROR: Gemini rejected the request due to rate limiting.'
                )
                : new AnalysisV2AiResultRateLimitExhaustedError();
            if (source === 'live') {
                mocks.analyzeWithGemini.mockRejectedValueOnce(error);
            } else {
                hooks.prepare = vi.fn().mockRejectedValue(error);
            }

            const result = await partnerSafetyAnalysis(input, hooks);

            expect(result).toMatchObject({
                source: 'safe_fallback',
                hasStrongPartnerEvidence: false,
                analyzedContactSheetSelectionId: null,
            });
            expect(mocks.analyzeWithGemini).toHaveBeenCalledTimes(source === 'live' ? 1 : 0);
        }
    );

    it('carries actual four-attempt durable exhaustion through partner fallback', async () => {
        const input = {
            feature: verifiedFeatureResult(),
            contactSheet: contactSheet(),
        };
        const resultIdentity = createPartnerSafetyResultIdentity(input);
        if (!resultIdentity) throw new Error('Test requires a partner result identity.');
        const attempts: AnalysisV2AiAttemptRecord[] = [1, 2, 3, 4].map(attempt => ({
            requestId,
            jobKey: 'track:partner-safety:batch:0',
            operationKey: resultIdentity.operationKey,
            attempt,
            retryCount: attempt - 1,
            reservationToken: `33333333-3333-4333-8333-33333333333${attempt}`,
            status: 'rate_limited',
            modelName: resultIdentity.modelName,
            location: 'global',
            stage: resultIdentity.stage,
            thinkingLevel: resultIdentity.thinkingLevel,
            mediaCount: 1,
            mediaResolution: resultIdentity.mediaResolution,
            promptVersion: resultIdentity.promptVersion,
            schemaVersion: resultIdentity.schemaVersion,
            maxOutputTokens: resultIdentity.maxOutputTokens,
            usageMetadataStatus: 'missing',
            usageComplete: false,
            tokenUsage: null,
            latencyMs: 1,
            estimatedCostUsd: null,
            finishReason: null,
            createdAt: '2026-07-17T08:00:00.000Z',
            terminalizedAt: '2026-07-17T08:00:01.000Z',
        }));
        const reserve = vi.fn();
        const adapter = createAnalysisV2AiAuditAdapter({
            requestId,
            jobKey: 'track:partner-safety:batch:0',
            claimToken: '22222222-2222-4222-8222-222222222222',
            resultIdentity,
            resultSchema: partnerSafetyModelResponseSchema,
            attemptStore: {
                reserve,
                terminalize: vi.fn(),
                loadOperation: vi.fn().mockResolvedValue(attempts),
            } as unknown as AnalysisV2AiAttemptStore,
            resultStore: {
                loadRequest: vi.fn().mockResolvedValue(null),
                checkpointGlobalHit: vi.fn(),
                terminalizeSuccess: vi.fn(),
            } as unknown as AnalysisV2AiResultStore,
        });

        const result = await partnerSafetyAnalysis(input, adapter);

        expect(result.source).toBe('safe_fallback');
        expect(reserve).not.toHaveBeenCalled();
        expect(mocks.analyzeWithGemini).not.toHaveBeenCalled();
    });

    it('reuses normalized media for the high-risk call and passes sanitized real comments with refs', async () => {
        mocks.analyzeWithGemini.mockImplementation(async (
            _prompt: string,
            _images: string[],
            options: { schema: { parse(value: unknown): unknown } }
        ) => options.schema.parse({
            lines: [{
                text: '여행과 일상을 선명하게 연출하는 솜씨가 공교롭게도 꽤 능숙한 계정입니다.',
                evidenceRefs: ['profile:bio', 'post:1:thumbnail'],
            }, {
                text: '서로 남긴 좋아요와 후보가 대상 게시물에 남긴 댓글의 보자 표현은 제법 친절하지만, 수집 표본 밖 누락 가능성은 남습니다.',
                evidenceRefs: [
                    'like:candidate-to-target',
                    'like:target-to-candidate',
                    'comment:1',
                    'coverage:target-interactions',
                ],
            }],
        }));
        const hooks = audit('highRiskNarrative');

        const result = await highRiskNarrative(narrativeInput(), hooks);

        expect(result.source).toBe('gemini');
        expect(parseSafePublicRiskNarrative(result.lines)).toEqual(result.lines);
        const [prompt, images, options] = mocks.analyzeWithGemini.mock.calls[0];
        expect(images).toEqual(media().map(item => item.normalizedJpegBase64));
        expect(prompt).toContain('반가워 또 보자');
        expect(prompt).toContain('comment:1');
        expect(prompt).toContain('[계정명 제거]');
        expect(prompt).toContain('[링크 제거]');
        expect(prompt).toContain('[이메일 제거]');
        expect(prompt).toContain('[연락처 제거]');
        expect(prompt).not.toContain('candidate.user');
        expect(prompt).not.toContain('target.user');
        expect(options).toMatchObject({
            stage: 'highRiskNarrative',
            requestId,
            onBeforeAttempt: hooks.onBeforeAttempt,
            onAttemptTelemetry: hooks.onAttemptTelemetry,
        });
    });

    it('uses a sanitized carousel caption dossier only as first-line persona evidence', async () => {
        const input = {
            ...narrativeInput(),
            carouselCaptionDossier: carouselCaptionDossier(),
        } as HighRiskNarrativeInput;
        expect(createHighRiskNarrativeResultIdentity(input).inputHash)
            .not.toBe(createHighRiskNarrativeResultIdentity(narrativeInput()).inputHash);
        mocks.analyzeWithGemini.mockImplementation(async (
            _prompt: string,
            _images: string[],
            options: { schema: { parse(value: unknown): unknown } }
        ) => options.schema.parse({
            lines: [{
                text: '도시 산책과 사진 연출을 공교롭게도 자주 엮는 꽤 계획적인 계정입니다.',
                evidenceRefs: ['carousel-dossier:latest-complete-carousel'],
            }, {
                text: '서로 남긴 좋아요와 후보가 대상 게시물에 남긴 댓글의 보자 표현은 공교롭지만, 수집 표본 밖 누락 가능성은 남습니다.',
                evidenceRefs: [
                    'like:candidate-to-target',
                    'like:target-to-candidate',
                    'comment:1',
                    'coverage:target-interactions',
                ],
            }],
        }));

        const result = await highRiskNarrative(input, audit('highRiskNarrative', input));

        expect(result.source).toBe('gemini');
        expect(result.evidenceRefs[0]).toContain('carousel-dossier:latest-complete-carousel');
        const [prompt] = mocks.analyzeWithGemini.mock.calls[0];
        expect(prompt).toContain('carousel-dossier:latest-complete-carousel');
        expect(prompt).toContain('[계정명 제거]');
        expect(prompt).not.toContain('@target.user');
        expect(prompt).not.toContain('candidate.user');
        expect(prompt).toContain('페르소나');
    });

    it('rejects an over-budget dossier and never accepts its ref on the interaction line', async () => {
        expect(() => highRiskNarrativeInputSchema.parse({
            ...narrativeInput(),
            carouselCaptionDossier: {
                ...carouselCaptionDossier(),
                text: 'x'.repeat(2_001),
            },
        })).toThrow();

        const input = {
            ...narrativeInput(),
            carouselCaptionDossier: carouselCaptionDossier(),
        } as HighRiskNarrativeInput;
        mocks.analyzeWithGemini.mockImplementation(async (
            _prompt: string,
            _images: string[],
            options: { schema: { parse(value: unknown): unknown } }
        ) => options.schema.parse({
            lines: [{
                text: '도시 산책과 사진 연출을 공교롭게도 자주 엮는 꽤 계획적인 계정입니다.',
                evidenceRefs: ['carousel-dossier:latest-complete-carousel'],
            }, {
                text: '서로 남긴 좋아요와 후보가 대상 게시물에 남긴 댓글의 보자 표현은 공교롭지만, 수집 표본 밖 누락 가능성은 남습니다.',
                evidenceRefs: [
                    'carousel-dossier:latest-complete-carousel',
                    'like:candidate-to-target',
                    'like:target-to-candidate',
                    'comment:1',
                    'coverage:target-interactions',
                ],
            }],
        }));

        const result = await highRiskNarrative(input, audit('highRiskNarrative', input));

        expect(result.source).toBe('safe_fallback');
        expect(result.evidenceRefs[0]).toContain('carousel-dossier:latest-complete-carousel');
        expect(result.evidenceRefs[1]).not.toContain('carousel-dossier:latest-complete-carousel');
    });

    it('rejects a dossier ref that collides with any supplied evidence namespace', () => {
        for (const evidenceRefId of [
            'coverage:target-interactions',
            'caption:1',
            'post:1:thumbnail',
            'like:candidate-to-target',
            'like:target-to-candidate',
            'comment:1',
            'target-post:1',
            'profile:bio',
        ]) {
            expect(() => highRiskNarrativeInputSchema.parse({
                ...narrativeInput(),
                carouselCaptionDossier: {
                    ...carouselCaptionDossier(),
                    evidenceRefId,
                },
            }), evidenceRefId).toThrow('collide');
        }
    });

    it('rejects dossier-only input that has no style fact after sanitization', async () => {
        const input = {
            ...narrativeInput(),
            bio: null,
            media: [],
            captions: [],
            carouselCaptionDossier: {
                evidenceRefId: 'carousel-dossier:empty-after-sanitization',
                text: '<b>',
            },
        } as HighRiskNarrativeInput;

        expect(() => createHighRiskNarrativeResultIdentity(input)).toThrow('sanitized');
        await expect(highRiskNarrative(
            input,
            {} as StagedAiAuditContext
        )).rejects.toThrow('sanitized');
        expect(mocks.analyzeWithGemini).not.toHaveBeenCalled();
    });

    it('uses one deterministic safe fallback without a second generation for invalid output', async () => {
        mocks.analyzeWithGemini.mockImplementation(async (
            _prompt: string,
            _images: string[],
            options: { schema: { parse(value: unknown): unknown } }
        ) => options.schema.parse({
            lines: [{
                text: 'candidate.user는 고위험 점수 상위 계정입니다.',
                evidenceRefs: ['invented:evidence'],
            }, {
                text: '대상 계정이 후보 피드에 남긴 댓글로 두 사람은 교제 중입니다.',
                evidenceRefs: ['coverage:target-interactions'],
            }],
        }));

        const result = await highRiskNarrative(narrativeInput(), audit('highRiskNarrative'));

        expect(mocks.analyzeWithGemini).toHaveBeenCalledTimes(1);
        expect(result.source).toBe('safe_fallback');
        expect(parseSafePublicRiskNarrative(result.lines)).toEqual(result.lines);
        expect(result.lines.join(' ')).not.toContain('candidate.user');
        expect(result.evidenceRefs[1]).toContain('like:candidate-to-target');
        expect(result.evidenceRefs[1]).toContain('like:target-to-candidate');
        expect(result.evidenceRefs[1]).toContain('comment:1');
        expect(result.evidenceRefs[1]).toContain('coverage:target-interactions');
    });

    it.each(['live', 'replay'] as const)(
        'uses deterministic narrative fallback for %s exhausted rate limiting',
        async source => {
            const input = narrativeInput();
            const hooks = audit('highRiskNarrative', input);
            const error = source === 'live'
                ? new Error(
                    'AI_RATE_LIMIT_ERROR: Gemini rejected the request due to rate limiting.'
                )
                : new AnalysisV2AiResultRateLimitExhaustedError();
            if (source === 'live') {
                mocks.analyzeWithGemini.mockRejectedValueOnce(error);
            } else {
                hooks.prepare = vi.fn().mockRejectedValue(error);
            }

            const result = await highRiskNarrative(input, hooks);

            expect(result.source).toBe('safe_fallback');
            expect(parseSafePublicRiskNarrative(result.lines)).toEqual(result.lines);
            expect(mocks.analyzeWithGemini).toHaveBeenCalledTimes(source === 'live' ? 1 : 0);
        }
    );

    it.each([
        'ANALYSIS_V2_AI_RESULT_REPLAY_BLOCKED',
        'AI_AMBIGUOUS_GENERATION_ERROR: generation status is unknown.',
        'ANALYSIS_V2_AI_RESULT_RATE_LIMIT_EXHAUSTED',
    ])('keeps non-fallback staged AI failure fatal: %s', async message => {
        const partnerInput = {
            feature: verifiedFeatureResult(),
            contactSheet: contactSheet(),
        };
        const partnerAudit = audit('partnerSafety', partnerInput);
        partnerAudit.prepare = vi.fn().mockRejectedValue(new Error(message));
        await expect(partnerSafetyAnalysis(partnerInput, partnerAudit)).rejects.toThrow(message);

        const input = narrativeInput();
        const narrativeAudit = audit('highRiskNarrative', input);
        narrativeAudit.prepare = vi.fn().mockRejectedValue(new Error(message));
        await expect(highRiskNarrative(input, narrativeAudit)).rejects.toThrow(message);
        expect(mocks.analyzeWithGemini).not.toHaveBeenCalled();
    });

    it('propagates audit and ambiguous generation failures instead of hiding them as copy fallback', async () => {
        mocks.analyzeWithGemini.mockRejectedValueOnce(new Error(
            'AI_ATTEMPT_AUDIT_PERSISTENCE_ERROR: intent was not durably stored.'
        ));
        await expect(highRiskNarrative(
            narrativeInput(),
            audit('highRiskNarrative')
        )).rejects.toThrow(
            'AI_ATTEMPT_AUDIT_PERSISTENCE_ERROR'
        );

        mocks.analyzeWithGemini.mockRejectedValueOnce(new Error(
            'AI_AMBIGUOUS_GENERATION_ERROR: generation status is unknown.'
        ));
        await expect(highRiskNarrative(
            narrativeInput(),
            audit('highRiskNarrative')
        )).rejects.toThrow(
            'AI_AMBIGUOUS_GENERATION_ERROR'
        );
        expect(mocks.analyzeWithGemini).toHaveBeenCalledTimes(2);
    });

    it('falls back for a terminal strict-response rejection without generating again', async () => {
        mocks.analyzeWithGemini.mockRejectedValueOnce(new Error(
            'AI_GENERATION_RESPONSE_REJECTED_ERROR: generated response failed strict validation.'
        ));

        const result = await highRiskNarrative(narrativeInput(), audit('highRiskNarrative'));

        expect(result.source).toBe('safe_fallback');
        expect(mocks.analyzeWithGemini).toHaveBeenCalledTimes(1);
    });

    it('keeps response schemas exact and rejects a third narrative line', () => {
        expect(() => highRiskNarrativeModelResponseSchema.parse({
            lines: [
                { text: '첫 문장입니다.', evidenceRefs: ['profile:bio'] },
                { text: '둘째 문장입니다.', evidenceRefs: ['coverage:target-interactions'] },
                { text: '셋째 문장입니다.', evidenceRefs: ['profile:bio'] },
            ],
        })).toThrow();
    });
});
