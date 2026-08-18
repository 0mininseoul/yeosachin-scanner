import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    inferRecentMutualFemaleRanks,
    orderedMutualUsernamesFromStepData,
} from '@/lib/services/analysis/recent-mutuals';
import {
    targetProfileImageFromStepData,
    toOwnerResultInteractionSummary,
} from '@/lib/services/analysis/result-interactions';
import { createImageProxyPath } from '@/lib/services/media/image-proxy-token';
import {
    RESULT_PAGE_SIZE_DEFAULT,
    RESULT_PAGE_SIZE_MAX,
    ResultPaginationError,
} from '@/lib/domain/analysis/result-pagination';
import { v2ShareResultService } from '@/lib/services/share/v2-result-share';
import { isAnalysisResultAuthoritativelyPublished } from '@/lib/services/analysis/result-publication-authority';
import { NextResponse } from 'next/server';

const SHARE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const NO_STORE_HEADERS = {
    'Cache-Control': 'private, no-store, max-age=0',
} as const;

function isLegacySharePipeline(pipelineVersion: unknown): pipelineVersion is 'v1' | null {
    return pipelineVersion === null || pipelineVersion === 'v1';
}

function json(body: unknown, status: number) {
    return NextResponse.json(body, {
        status,
        headers: NO_STORE_HEADERS,
    });
}

function parseV2Pagination(url: URL) {
    const allowed = new Set(['femaleCursor', 'privateCursor', 'pageSize']);
    const keys = [...url.searchParams.keys()];
    if (
        keys.some(key => !allowed.has(key))
        || [...new Set(keys)].some(
            key => url.searchParams.getAll(key).length !== 1
        )
    ) {
        throw new Error('INVALID_SHARE_PAGINATION');
    }
    const rawPageSize = url.searchParams.get('pageSize');
    const pageSize = rawPageSize === null
        ? RESULT_PAGE_SIZE_DEFAULT
        : /^\d{1,2}$/.test(rawPageSize)
            ? Number(rawPageSize)
            : Number.NaN;
    if (
        !Number.isSafeInteger(pageSize)
        || pageSize < 1
        || pageSize > RESULT_PAGE_SIZE_MAX
    ) {
        throw new Error('INVALID_SHARE_PAGINATION');
    }
    return {
        femaleCursor: url.searchParams.get('femaleCursor'),
        privateCursor: url.searchParams.get('privateCursor'),
        pageSize,
    };
}

export async function GET(
    request: Request,
    { params }: { params: Promise<{ token: string }> }
) {
    try {
        const { token } = await params;

        if (!SHARE_TOKEN_PATTERN.test(token)) {
            return json(
                { error: '유효하지 않은 공유 링크입니다.' },
                400
            );
        }

        // 1. 토큰으로 분석 요청 조회 (인증 불필요, admin 사용)
        const { data: analysisRequest, error: requestError } = await supabaseAdmin
            .from('analysis_requests')
            .select('*')
            .eq('share_token', token)
            .eq('share_enabled', true)
            .single();

        if (requestError || !analysisRequest) {
            return json(
                { error: '공유 링크를 찾을 수 없거나 비활성화되었습니다.' },
                404
            );
        }

        if (
            !isLegacySharePipeline(analysisRequest.pipeline_version)
            && analysisRequest.pipeline_version !== 'v2'
        ) {
            return json(
                { error: '공유 링크를 찾을 수 없거나 비활성화되었습니다.' },
                404
            );
        }

        // 2. 분석이 완료되지 않은 경우
        if (analysisRequest.status !== 'completed') {
            return json(
                { error: '분석이 아직 완료되지 않았습니다.' },
                400
            );
        }

        if (!await isAnalysisResultAuthoritativelyPublished(analysisRequest.id)) {
            return json({
                error: '분석 결과가 아직 공개 준비 중입니다.',
                code: 'RESULT_PENDING',
                status: 'pending',
            }, 400);
        }

        const requestId = analysisRequest.id;
        if (analysisRequest.pipeline_version === 'v2') {
            let pagination: ReturnType<typeof parseV2Pagination>;
            try {
                pagination = parseV2Pagination(new URL(request.url));
            } catch {
                return json({ error: '유효하지 않은 공유 요청입니다.' }, 400);
            }
            try {
                const result = await v2ShareResultService.loadPage({
                    requestId,
                    ownerUserId: analysisRequest.user_id,
                    shareToken: token,
                    ...pagination,
                });
                return result
                    ? json(result, 200)
                    : json(
                        { error: '공유 링크를 찾을 수 없거나 비활성화되었습니다.' },
                        404
                    );
            } catch (error) {
                if (error instanceof ResultPaginationError) {
                    return json(
                        { error: '유효하지 않은 공유 요청입니다.' },
                        400
                    );
                }
                console.error('[v2-share] result read failed');
                return json({ error: '결과 조회에 실패했습니다.' }, 500);
            }
        }

        // 3. 분석 결과 조회 (여성 계정들)
        const { data: results, error: resultsError } = await supabaseAdmin
            .from('analysis_results')
            .select(`
                rank,
                suspect_instagram_id,
                suspect_profile_image,
                suspect_full_name,
                risk_grade,
                one_line_overview,
                risk_analysis
            `)
            .eq('request_id', requestId)
            .order('rank', { ascending: true });

        if (resultsError) {
            console.error('Results fetch error');
            return json(
                { error: '결과 조회에 실패했습니다.' },
                500
            );
        }

        // 4. 비공개 계정 조회
        const { data: privateAccounts, error: privateAccountsError } = await supabaseAdmin
            .from('private_accounts')
            .select('instagram_id, profile_image, full_name, name_female_score, name_confidence')
            .eq('request_id', requestId)
            .order('name_female_score', { ascending: false, nullsFirst: false })
            .order('name_confidence', { ascending: false, nullsFirst: false })
            .order('instagram_id', { ascending: true });
        if (privateAccountsError) {
            console.error('Shared private account results fetch failed');
            return json({ error: '결과 조회에 실패했습니다.' }, 500);
        }

        // 5. 성별 비율 계산
        const genderStats = analysisRequest.gender_stats || { male: 0, female: 0, unknown: 0 };
        const totalGender = genderStats.male + genderStats.female + genderStats.unknown;
        const genderRatio = {
            male: {
                count: genderStats.male,
                percentage: totalGender > 0 ? Math.round((genderStats.male / totalGender) * 100) : 0,
            },
            female: {
                count: genderStats.female,
                percentage: totalGender > 0 ? Math.round((genderStats.female / totalGender) * 100) : 0,
            },
            unknown: {
                count: genderStats.unknown,
                percentage: totalGender > 0 ? Math.round((genderStats.unknown / totalGender) * 100) : 0,
            },
        };

        // 6. 여성 계정 목록. 수집 응답 순서는 실제 팔로우 시각이 아닌 최근 맞팔 추정치로만 사용한다.
        const recentMutualRanks = inferRecentMutualFemaleRanks(
            orderedMutualUsernamesFromStepData(analysisRequest.step_data),
            (results || []).map((result) => result.suspect_instagram_id)
        );
        const femaleAccounts = results?.map((result) => {
            const instagramId = result.suspect_instagram_id;
            return {
                instagramId,
                fullName: result.suspect_full_name,
                profileImage: createImageProxyPath(result.suspect_profile_image),
                instagramUrl: `https://instagram.com/${instagramId}`,
                riskGrade: result.risk_grade as 'high_risk' | 'caution' | 'normal',
                /* Anyone holding the link can call this route, so the bio never
                   leaves the database: it names workplaces, schools and other
                   handles, and identifies at least as readily as the name does.
                   The bounded one-line overview is the public result copy and is
                   intentionally retained for the shared report. */
                recentMutualRank: recentMutualRanks.get(instagramId.toLowerCase()),
                ...toOwnerResultInteractionSummary(result, analysisRequest.target_instagram_id),
            };
        }) || [];

        // 7. 비공개 계정 목록
        const privateAccountsList = privateAccounts?.map((account) => ({
            instagramId: account.instagram_id,
            fullName: account.full_name,
            profileImage: createImageProxyPath(account.profile_image),
            instagramUrl: `https://instagram.com/${account.instagram_id}`,
        })) || [];

        // 8. 응답 구성 (공유 페이지용)
        return json({
            requestId,
            status: analysisRequest.status,
            isShared: true, // 공유 링크로 접근했음을 표시
            summary: {
                targetInstagramId: analysisRequest.target_instagram_id,
                targetProfileImage: createImageProxyPath(
                    targetProfileImageFromStepData(analysisRequest.step_data)
                ),
                mutualFollows: analysisRequest.mutual_follows || 0,
                genderRatio,
            },
            femaleAccounts,
            privateAccounts: privateAccountsList,
        }, 200);
    } catch {
        console.error('Share result fetch error');
        return json(
            { error: '서버 오류가 발생했습니다.' },
            500
        );
    }
}
