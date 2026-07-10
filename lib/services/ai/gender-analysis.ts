import { analyzeWithGemini } from './gemini';
import { prepareAnalysisImages } from './image-preprocessing';
import { GENDER_ANALYSIS_PROMPT } from '@/lib/constants/prompts';
import { GENDER_CONFIDENCE_THRESHOLD } from '@/lib/constants/scoring';
import type { GenderAnalysisResponse } from '@/lib/types/analysis';
import type { InstagramProfile, InstagramPost } from '@/lib/types/instagram';
import { genderAnalysisResponseSchema } from './analysis-response-schemas';

interface GenderAnalysisInput {
    profile: InstagramProfile;
    recentPosts: InstagramPost[];
}

/**
 * 인스타그램 프로필의 성별을 AI로 분석
 */
export async function analyzeGender(
    input: GenderAnalysisInput
): Promise<GenderAnalysisResponse> {
    const { profile, recentPosts } = input;

    const preparedImages = await prepareAnalysisImages(
        profile.profilePicUrl,
        recentPosts.flatMap(post => post.imageUrl ? [post.imageUrl] : [])
    );
    const images = preparedImages.map(image => image.base64);
    const hasProfileImage = preparedImages.some(image => image.role === 'profile');
    const feedImageCount = preparedImages.filter(image => image.role === 'post').length;

    // 프롬프트 구성
    const prompt = GENDER_ANALYSIS_PROMPT
        .replace('{profileImageDescription}', hasProfileImage ? '첨부된 이미지 참조' : '없음')
        .replace('{username}', profile.username)
        .replace('{fullName}', profile.fullName || '없음')
        .replace('{bio}', profile.bio || '없음')
        .replace('{feedImagesDescription}', feedImageCount > 0 ? '첨부된 이미지들 참조' : '없음');

    // AI 분석 수행
    const result = await analyzeWithGemini<GenderAnalysisResponse>(prompt, images, {
        schema: genderAnalysisResponseSchema,
        analysisType: 'gender',
    });

    // confidence가 임계값 미만이면 unknown 처리
    if (result.confidence < GENDER_CONFIDENCE_THRESHOLD) {
        return {
            gender: 'unknown',
            confidence: result.confidence,
            reasoning: result.reasoning,
        };
    }

    return result;
}

/**
 * 여러 계정의 성별을 일괄 분석
 */
export async function analyzeGenderBatch(
    accounts: { profile: InstagramProfile; recentPosts: InstagramPost[] }[]
): Promise<Map<string, GenderAnalysisResponse>> {
    const results = new Map<string, GenderAnalysisResponse>();

    // 병렬 처리 (동시에 5개씩)
    const batchSize = 5;
    for (let i = 0; i < accounts.length; i += batchSize) {
        const batch = accounts.slice(i, i + batchSize);
        const batchResults = await Promise.all(
            batch.map(async (account) => {
                try {
                    const result = await analyzeGender(account);
                    return { username: account.profile.username, result };
                } catch {
                    console.error('Gender batch analysis failed for one account');
                    return {
                        username: account.profile.username,
                        result: {
                            gender: 'unknown' as const,
                            confidence: 0,
                            reasoning: 'Analysis failed',
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
