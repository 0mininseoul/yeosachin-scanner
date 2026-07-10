import { analyzeWithGemini, logTokenUsage } from './gemini';
import { prepareAnalysisImages } from './image-preprocessing';
import { getVertexAIAnalysisConcurrency } from './pipeline-config';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { COMBINED_ANALYSIS_PROMPT } from '@/lib/constants/prompts';
import { GENDER_CONFIDENCE_THRESHOLD } from '@/lib/constants/scoring';
import type { CombinedAnalysisResponse } from '@/lib/types/analysis';
import type { InstagramProfile, InstagramPost } from '@/lib/types/instagram';
import { combinedAnalysisResponseSchema } from './analysis-response-schemas';
import {
    buildCombinedAnalysisCacheVersion,
    COMBINED_ANALYSIS_CACHE_TTL_DAYS,
    createCombinedAnalysisCacheEntry,
    getCombinedProfileSnapshotTtlHours,
    MAX_COMBINED_CACHE_BATCH_SIZE,
    parseCombinedAnalysisCacheEntry,
    parseCombinedProfileSnapshot,
    tryCreateCombinedProfileSnapshot,
    type CombinedProfileSnapshotAccount,
} from './combined-cache';

interface CombinedAnalysisInput {
    profile: InstagramProfile;
    recentPosts: InstagramPost[];
    refreshCacheSnapshot?: boolean;
    requestId?: string; // 토큰 추적용
}

interface CachedAnalysisHit {
    result: CombinedAnalysisResponse;
    updatedAt: string | null;
}

/**
 * 캐시에서 분석 결과 조회 (updated_at 기준 30일 이내만 유효)
 */
async function getCachedAnalysis(
    username: string,
    cacheVersion: string
): Promise<CachedAnalysisHit | null> {
    try {
        const thirtyDaysAgo = new Date(
            Date.now() - COMBINED_ANALYSIS_CACHE_TTL_DAYS * 24 * 60 * 60 * 1_000
        ).toISOString();

        const { data, error } = await supabaseAdmin
            .from('ai_analysis_cache')
            .select('analysis_result, updated_at')
            .eq('instagram_username', username)
            .gte('updated_at', thirtyDaysAgo)
            .single();

        if (error || !data) {
            return null;
        }

        const cached = parseCombinedAnalysisCacheEntry(data.analysis_result, cacheVersion);
        if (!cached) return null;
        return {
            result: cached,
            updatedAt: typeof data.updated_at === 'string' ? data.updated_at : null,
        };
    } catch {
        return null;
    }
}

function createProfileSnapshotFromInput(
    input: Pick<CombinedAnalysisInput, 'profile' | 'recentPosts'>,
    capturedAt: string
) {
    return tryCreateCombinedProfileSnapshot({
        profile: {
            username: input.profile.username,
            ...(input.profile.profilePicUrl
                ? { profilePicUrl: input.profile.profilePicUrl }
                : {}),
            ...(input.profile.fullName ? { fullName: input.profile.fullName } : {}),
            ...(input.profile.bio ? { bio: input.profile.bio } : {}),
            isPrivate: input.profile.isPrivate,
        },
        recentPosts: input.recentPosts.map((post) => ({
            id: post.id,
            shortCode: post.shortCode,
            ...(post.caption ? { caption: post.caption } : {}),
            hashtags: post.hashtags ?? [],
            ...(post.imageUrl ? { imageUrl: post.imageUrl } : {}),
            type: post.type,
            likesCount: Math.max(0, post.likesCount),
            commentsCount: Math.max(0, post.commentsCount),
            timestamp: post.timestamp,
            taggedUsers: post.taggedUsers ?? [],
            mentionedUsers: post.mentionedUsers ?? [],
        })),
    }, capturedAt);
}

/**
 * 분석 결과를 캐시에 저장 (30일 후 자동 만료)
 */
async function setCachedAnalysis(
    username: string,
    result: CombinedAnalysisResponse,
    cacheVersion: string,
    input: Pick<CombinedAnalysisInput, 'profile' | 'recentPosts'>
): Promise<void> {
    try {
        const updatedAt = new Date().toISOString();
        const profileSnapshot = createProfileSnapshotFromInput(input, updatedAt);

        const { error } = await supabaseAdmin
            .from('ai_analysis_cache')
            .upsert({
                instagram_username: username,
                analysis_result: createCombinedAnalysisCacheEntry(
                    cacheVersion,
                    result,
                    profileSnapshot ?? undefined
                ),
                profile_pic_url: input.profile.profilePicUrl,
                updated_at: updatedAt,
            }, {
                onConflict: 'instagram_username',
            });
        if (error) throw error;

    } catch {
        // 캐시 저장 실패는 분석 실패로 이어지지 않도록
        console.warn('Failed to cache a combined analysis result');
    }
}

async function refreshCachedProfileSnapshot(
    username: string,
    cacheVersion: string,
    hit: CachedAnalysisHit,
    input: Pick<CombinedAnalysisInput, 'profile' | 'recentPosts'>
): Promise<void> {
    if (!hit.updatedAt) return;

    try {
        const capturedAt = new Date().toISOString();
        const profileSnapshot = createProfileSnapshotFromInput(input, capturedAt);
        if (!profileSnapshot) return;
        const { error } = await supabaseAdmin
            .from('ai_analysis_cache')
            .update({
                analysis_result: createCombinedAnalysisCacheEntry(
                    cacheVersion,
                    hit.result,
                    profileSnapshot
                ),
            })
            .eq('instagram_username', username)
            .eq('updated_at', hit.updatedAt);
        if (error) throw error;
    } catch {
        // Refresh acceleration is optional and must never fail the analysis itself.
        console.warn('Failed to refresh a combined analysis profile snapshot');
    }
}

/**
 * Read at most one profiles-stage batch from the current analysis cache.
 * Every returned snapshot has current-version AI output and a separately bounded freshness window.
 */
export async function getCachedCombinedProfileSnapshots(
    usernames: string[],
    options: {
        cacheVersion?: string;
        nowMs?: number;
        ttlHours?: number;
        loadRows?: (usernames: string[], updatedAfter: string) => Promise<unknown>;
    } = {}
): Promise<Map<string, CombinedProfileSnapshotAccount>> {
    if (usernames.length > MAX_COMBINED_CACHE_BATCH_SIZE) {
        throw new Error(`Combined cache snapshot batches are limited to ${MAX_COMBINED_CACHE_BATCH_SIZE}`);
    }

    const normalizedUsernames = [...new Set(
        usernames.map(username => username.trim().toLowerCase())
    )].filter(username => /^[a-z0-9._]{1,30}$/.test(username));
    const snapshots = new Map<string, CombinedProfileSnapshotAccount>();
    if (normalizedUsernames.length === 0) return snapshots;

    const cacheVersion = options.cacheVersion ?? buildCombinedAnalysisCacheVersion();
    const ttlHours = options.ttlHours ?? getCombinedProfileSnapshotTtlHours();
    const nowMs = options.nowMs ?? Date.now();
    const updatedAfter = new Date(
        nowMs - COMBINED_ANALYSIS_CACHE_TTL_DAYS * 24 * 60 * 60 * 1_000
    ).toISOString();

    try {
        const rows = options.loadRows
            ? await options.loadRows(normalizedUsernames, updatedAfter)
            : await (async () => {
                const { data, error } = await supabaseAdmin
                    .from('ai_analysis_cache')
                    .select('instagram_username, analysis_result')
                    .in('instagram_username', normalizedUsernames)
                    .gte('updated_at', updatedAfter);
                if (error) throw error;
                return data;
            })();

        if (!Array.isArray(rows)) return snapshots;

        const requested = new Set(normalizedUsernames);
        for (const row of rows) {
            if (!row || typeof row !== 'object') continue;
            const cacheRow = row as Record<string, unknown>;
            if (typeof cacheRow.instagram_username !== 'string') continue;
            const key = cacheRow.instagram_username.trim().toLowerCase();
            if (!requested.has(key) || snapshots.has(key)) continue;

            const snapshot = parseCombinedProfileSnapshot(cacheRow.analysis_result, cacheVersion, {
                nowMs,
                ttlHours,
            });
            if (!snapshot || snapshot.profile.username.toLowerCase() !== key) continue;
            snapshots.set(key, snapshot);
        }
    } catch {
        // Cache acceleration is optional; failures fall back to the configured profile provider.
    }

    return snapshots;
}

/**
 * 인스타그램 프로필의 성별 + (여성인 경우) 외모/노출을 AI로 통합 분석
 * 하나의 API 호출로 모든 분석을 수행하여 토큰 효율성 극대화
 * 캐싱 지원: 이전에 분석한 계정은 캐시에서 조회
 */
export async function analyzeCombined(
    input: CombinedAnalysisInput
): Promise<CombinedAnalysisResponse> {
    const { profile, recentPosts, refreshCacheSnapshot = false, requestId } = input;
    const cacheVersion = buildCombinedAnalysisCacheVersion();

    // 1. 캐시 확인
    const cachedHit = await getCachedAnalysis(profile.username, cacheVersion);
    if (cachedHit) {
        if (refreshCacheSnapshot) {
            await refreshCachedProfileSnapshot(
                profile.username,
                cacheVersion,
                cachedHit,
                { profile, recentPosts }
            );
        }
        // 캐시 히트 로깅 (토큰 0으로 기록)
        await logTokenUsage(
            { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            'combined',
            requestId,
            true // cached_hit = true
        );
        return cachedHit.result;
    }

    // 2. 활성 품질/비용 정책 범위에서 이미지를 병렬 다운로드하고 JPEG로 정규화
    const preparedImages = await prepareAnalysisImages(
        profile.profilePicUrl,
        recentPosts.flatMap(post => post.imageUrl ? [post.imageUrl] : [])
    );
    const images = preparedImages.map(image => image.base64);
    const hasProfileImage = preparedImages.some(image => image.role === 'profile');
    const feedImageCount = preparedImages.filter(image => image.role === 'post').length;

    // 2-2. 포스트 캡션/해시태그 수집 (기혼 여부 판단에 활용)
    const postsTextInfo = recentPosts
        .slice(0, 10) // 최대 10개 포스트
        .filter(post => post.caption || (post.hashtags && post.hashtags.length > 0)) // 캡션 또는 해시태그가 있는 포스트만
        .map((post, index) => {
            const caption = post.caption || '';
            // 스크래퍼에서 제공하는 hashtags 배열 우선 사용, 없으면 캡션에서 추출
            const hashtags = (post.hashtags && post.hashtags.length > 0)
                ? post.hashtags.map(tag => `#${tag}`)  // 스크래퍼는 # 없이 제공하므로 추가
                : (caption.match(/#[\w가-힣]+/g) || []);
            // 캡션은 최대 200자로 제한 (너무 길면 토큰 낭비)
            const truncatedCaption = caption.length > 200
                ? caption.substring(0, 200) + '...'
                : caption;
            return `[포스트 ${index + 1}] 캡션: ${truncatedCaption || '없음'}${hashtags.length > 0 ? ` | 해시태그: ${hashtags.join(' ')}` : ''}`;
        })
        .join('\n');

    // 3. 프롬프트 구성
    const prompt = COMBINED_ANALYSIS_PROMPT
        .replace('{profileImageDescription}', hasProfileImage ? '첨부된 이미지 참조' : '없음')
        .replace('{username}', profile.username)
        .replace('{fullName}', profile.fullName || '없음')
        .replace('{bio}', profile.bio || '없음')
        .replace('{feedImagesDescription}', feedImageCount > 0 ? '첨부된 이미지들 참조' : '없음')
        .replace('{postsTextInfo}', postsTextInfo || '없음');

    // 4. AI 분석 수행 (한 번의 호출로 모든 분석 + 재시도 로직 + 토큰 추적)
    const result = await analyzeWithGemini<CombinedAnalysisResponse>(prompt, images, {
        schema: combinedAnalysisResponseSchema,
        analysisType: 'combined',
        requestId,
    });

    // 5. genderConfidence가 임계값 미만이면 unknown 처리
    let finalResult: CombinedAnalysisResponse;
    if (result.genderConfidence < GENDER_CONFIDENCE_THRESHOLD) {
        finalResult = {
            gender: 'unknown',
            genderConfidence: result.genderConfidence,
            genderReasoning: result.genderReasoning,
        };
    } else {
        finalResult = result;
    }

    // 6. 결과 캐싱 (30일 후 자동 만료)
    await setCachedAnalysis(profile.username, finalResult, cacheVersion, { profile, recentPosts });

    return finalResult;
}

/**
 * 여러 계정을 일괄 통합 분석 (캐싱 지원)
 */
export async function analyzeCombinedBatch(
    accounts: { profile: InstagramProfile; recentPosts: InstagramPost[] }[],
    batchSize: number = getVertexAIAnalysisConcurrency(),
    requestId?: string
): Promise<Map<string, CombinedAnalysisResponse>> {
    const results = new Map<string, CombinedAnalysisResponse>();

    // 병렬 처리 (동시에 batchSize개씩)
    for (let i = 0; i < accounts.length; i += batchSize) {
        const batch = accounts.slice(i, i + batchSize);
        const batchResults = await Promise.all(
            batch.map(async (account) => {
                try {
                    const result = await analyzeCombined({
                        ...account,
                        requestId,
                    });
                    return { username: account.profile.username, result };
                } catch {
                    console.error('Combined batch analysis failed for one account');
                    return {
                        username: account.profile.username,
                        result: {
                            gender: 'unknown' as const,
                            genderConfidence: 0,
                            genderReasoning: 'Analysis failed',
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

/**
 * 캐시 통계 조회
 */
export async function getCacheStats(): Promise<{
    totalCached: number;
    oldestEntry: string | null;
    newestEntry: string | null;
}> {
    const { count } = await supabaseAdmin
        .from('ai_analysis_cache')
        .select('*', { count: 'exact', head: true });

    const { data: oldest } = await supabaseAdmin
        .from('ai_analysis_cache')
        .select('created_at')
        .order('created_at', { ascending: true })
        .limit(1)
        .single();

    const { data: newest } = await supabaseAdmin
        .from('ai_analysis_cache')
        .select('created_at')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

    return {
        totalCached: count || 0,
        oldestEntry: oldest?.created_at || null,
        newestEntry: newest?.created_at || null,
    };
}
