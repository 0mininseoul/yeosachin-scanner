import { z } from 'zod';
import { MAX_TRIAGE_FEED_MEDIA } from '@/lib/domain/analysis/media-policy';

const selectionId = z.string().trim().min(1).max(240);
export const pureGenderResolutionAssessmentSchema = z.object({
    inferredGender: z.enum(['female', 'male', 'unknown']),
    confidence: z.enum(['low', 'medium', 'high']),
    ownerConsistency: z.enum(['same_person', 'mixed_people', 'not_visible']),
    evidenceSelectionIds: z.array(selectionId).max(5),
}).strict();

export interface PureGenderResolutionMedia {
    selectionId: string;
    kind: 'profile' | 'feed';
    normalizedJpegBase64: string;
    postId?: string;
}

export function projectGenderResolutionMedia(
    rawMedia: readonly PureGenderResolutionMedia[],
    feedLimit = MAX_TRIAGE_FEED_MEDIA,
    v211QualityPrompt = false,
) {
    const profile = rawMedia.find(item => item.kind === 'profile');
    const media = [
        ...(profile ? [profile] : []),
        ...rawMedia.filter(item => item.kind === 'feed').slice(0, feedLimit),
    ];
    const originalByOpaqueId = new Map<string, string>();
    const opaqueByOriginalId = new Map<string, string>();
    const projectedMedia = media.map((item, index) => {
        const opaqueId = `resolver-media:${index + 1}`;
        originalByOpaqueId.set(opaqueId, item.selectionId);
        opaqueByOriginalId.set(item.selectionId, opaqueId);
        return { ...item, selectionId: opaqueId, postId: undefined };
    });
    const prompt = [
        '아래 이미지만 보고 계정 소유자의 성별을 독립적으로 재판정하세요.',
        '추측을 강요하지 말고 보이는 시각 근거만 사용하세요.',
        '여러 사람이 섞이면 ownerConsistency=mixed_people로 반환하세요.',
        ...(v211QualityPrompt
            ? ['반복해서 보이는 계정 소유자를 찾되, 여러 사람이 섞였으면 한 사람으로 강제하지 마세요.']
            : []),
        '근거가 없으면 inferredGender=unknown, confidence=low, ownerConsistency=not_visible로 반환하세요.',
        'high confidence 이진 판정에는 서로 다른 이미지 근거가 최소 2개 필요합니다.',
        `사용 가능한 selectionId: ${projectedMedia.map(item => item.selectionId).join(', ')}`,
    ].join('\n');
    const allowed = new Set(projectedMedia.map(item => item.selectionId));
    const schema = pureGenderResolutionAssessmentSchema.superRefine((value, context) => {
        for (const [index, id] of value.evidenceSelectionIds.entries()) {
            if (!allowed.has(id)) {
                context.addIssue({ code: 'custom', path: ['evidenceSelectionIds', index], message: 'Unknown evidence selection ID.' });
            }
        }
        if (
            value.inferredGender !== 'unknown'
            && value.confidence === 'high'
            && new Set(value.evidenceSelectionIds).size < 2
        ) context.addIssue({ code: 'custom', path: ['evidenceSelectionIds'], message: 'High confidence requires two images.' });
    });
    return {
        media,
        projectedMedia,
        prompt,
        schema,
        originalByOpaqueId,
        opaqueByOriginalId,
        finalize(raw: z.infer<typeof pureGenderResolutionAssessmentSchema>) {
            const parsed = pureGenderResolutionAssessmentSchema.parse(raw);
            return {
                ...parsed,
                evidenceSelectionIds: parsed.evidenceSelectionIds.map(id => {
                    const original = originalByOpaqueId.get(id);
                    if (!original) throw new Error('ANALYSIS_V2_GENDER_RESOLUTION_EVIDENCE_DRIFT');
                    return original;
                }),
            };
        },
    };
}
