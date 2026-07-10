import { analyzeWithGemini } from './gemini';
import { prepareAnalysisImages } from './image-preprocessing';
import { APPEARANCE_ANALYSIS_PROMPT } from '@/lib/constants/prompts';
import type { AppearanceAnalysisResponse } from '@/lib/types/analysis';
import { appearanceAnalysisResponseSchema } from './analysis-response-schemas';

/**
 * 인스타그램 계정 주인의 외모를 AI로 분석
 */
export async function analyzeAppearance(
    profilePicUrl: string | undefined,
    postImageUrls: string[]
): Promise<AppearanceAnalysisResponse> {
    // 이미지가 없으면 분석 불가
    if (!profilePicUrl && postImageUrls.length === 0) {
        return {
            ownerIdentified: false,
            attractivenessLevel: 'low',
            confidence: 0,
            reasoning: '분석할 이미지가 없습니다.',
        };
    }

    const preparedImages = await prepareAnalysisImages(profilePicUrl, postImageUrls);
    const images = preparedImages.map(image => image.base64);

    if (images.length === 0) {
        return {
            ownerIdentified: false,
            attractivenessLevel: 'low',
            confidence: 0,
            reasoning: '이미지 변환에 실패했습니다.',
        };
    }

    // 프롬프트 구성
    const prompt = APPEARANCE_ANALYSIS_PROMPT.replace(
        '{imageDescriptions}',
        `총 ${images.length}개의 이미지가 첨부되어 있습니다.${preparedImages[0]?.role === 'profile' ? ' 첫 번째는 프로필 사진입니다.' : ''}`
    );

    // AI 분석 수행
    const result = await analyzeWithGemini<AppearanceAnalysisResponse>(prompt, images, {
        schema: appearanceAnalysisResponseSchema,
        analysisType: 'appearance',
    });

    return result;
}
