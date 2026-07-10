import { analyzeWithGemini } from './gemini';
import { prepareAnalysisImages } from './image-preprocessing';
import { PHOTOGENIC_ANALYSIS_PROMPT } from '@/lib/constants/prompts';
import type { PhotogenicAnalysisResponse } from '@/lib/types/analysis';
import { photogenicAnalysisResponseSchema } from './analysis-response-schemas';

/**
 * 인스타그램 계정 주인의 Photogenic Quality를 AI로 분석
 */
export async function analyzePhotogenic(
    profilePicUrl: string | undefined,
    postImageUrls: string[]
): Promise<PhotogenicAnalysisResponse> {
    // 이미지가 없으면 분석 불가
    if (!profilePicUrl && postImageUrls.length === 0) {
        return {
            ownerIdentified: false,
            photogenicGrade: 1,
            confidence: 0,
            reasoning: '분석할 이미지가 없습니다.',
            hasCouplePhoto: false,
            couplePhotoConfidence: 0,
        };
    }

    const preparedImages = await prepareAnalysisImages(profilePicUrl, postImageUrls);
    const images = preparedImages.map(image => image.base64);

    if (images.length === 0) {
        return {
            ownerIdentified: false,
            photogenicGrade: 1,
            confidence: 0,
            reasoning: '이미지 변환에 실패했습니다.',
            hasCouplePhoto: false,
            couplePhotoConfidence: 0,
        };
    }

    // 프롬프트 구성
    const prompt = PHOTOGENIC_ANALYSIS_PROMPT.replace(
        '{imageDescriptions}',
        `총 ${images.length}개의 이미지가 첨부되어 있습니다.${preparedImages[0]?.role === 'profile' ? ' 첫 번째는 프로필 사진입니다.' : ''}`
    );

    // AI 분석 수행
    try {
        const result = await analyzeWithGemini<PhotogenicAnalysisResponse>(prompt, images, {
            schema: photogenicAnalysisResponseSchema,
            analysisType: 'photogenic',
        });
        // 커플 사진 필드가 없는 경우 기본값 설정
        return {
            ...result,
            hasCouplePhoto: result.hasCouplePhoto ?? false,
            couplePhotoConfidence: result.couplePhotoConfidence ?? 0,
        };
    } catch {
        console.error('Photogenic analysis failed');
        return {
            ownerIdentified: false,
            photogenicGrade: 1,
            confidence: 0,
            reasoning: '분석 중 오류가 발생했습니다.',
            hasCouplePhoto: false,
            couplePhotoConfidence: 0,
        };
    }
}

/**
 * 여러 계정의 Photogenic Quality를 일괄 분석
 */
export async function analyzePhotogenicBatch(
    accounts: { username: string; profilePicUrl?: string; postImageUrls: string[] }[]
): Promise<Map<string, PhotogenicAnalysisResponse>> {
    const results = new Map<string, PhotogenicAnalysisResponse>();

    // 병렬 처리 (동시에 3개씩 - 이미지 분석은 더 무거움)
    const batchSize = 3;
    for (let i = 0; i < accounts.length; i += batchSize) {
        const batch = accounts.slice(i, i + batchSize);
        const batchResults = await Promise.all(
            batch.map(async (account) => {
                try {
                    const result = await analyzePhotogenic(
                        account.profilePicUrl,
                        account.postImageUrls
                    );
                    return { username: account.username, result };
                } catch {
                    console.error('Photogenic batch analysis failed for one account');
                    return {
                        username: account.username,
                        result: {
                            ownerIdentified: false,
                            photogenicGrade: 1 as const,
                            confidence: 0,
                            reasoning: 'Analysis failed',
                            hasCouplePhoto: false,
                            couplePhotoConfidence: 0,
                        },
                    };
                }
            })
        );

        for (const { username, result } of batchResults) {
            results.set(username, result);
        }
    }

    return results;
}
