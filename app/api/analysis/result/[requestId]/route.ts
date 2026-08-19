import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    hydratedMutualCountFromStepData,
    inferRecentMutualFemaleRanks,
    normalizeLegacyGenderStats,
    orderedMutualUsernamesFromStepData,
} from '@/lib/services/analysis/recent-mutuals';
import {
    targetProfileFullNameFromStepData,
    targetProfileImageFromStepData,
    toOwnerResultInteractionSummary,
} from '@/lib/services/analysis/result-interactions';
import { createImageProxyPath } from '@/lib/services/media/image-proxy-token';
import { NextResponse } from 'next/server';
import { isAnalysisDeletable } from '@/lib/services/analysis/deletion';
import { demoResponseHeaders, isDemoOperator } from '@/lib/services/demo-analysis/demo-analysis';
import { demoAnalysisStore } from '@/lib/services/demo-analysis/store';
import {
    isAnalysisResultOperator,
    resolveAnalysisResultOwner,
} from '@/lib/services/analysis/result-operator-access';
import {
    AccountPrincipalAdmissionError,
    requireActiveAccountClassification,
} from '@/lib/services/identity/account-principal-store';
import { isAnalysisResultAuthoritativelyPublished } from '@/lib/services/analysis/result-publication-authority';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ requestId: string }> }
) {
    let demoRecognized = false;
    try {
        const { requestId } = await params;
        const supabase = await createClient();

        // 1. 인증 체크
        const { data: { user }, error: authError } = await supabase.auth.getUser();

        if (authError || !user) {
            return NextResponse.json(
                { error: '로그인이 필요합니다.' },
                { status: 401 }
            );
        }
        try {
            await requireActiveAccountClassification(user.id);
        } catch (accountError) {
            if (accountError instanceof AccountPrincipalAdmissionError) {
                return NextResponse.json(
                    { error: '이 계정은 현재 사용할 수 없습니다.' },
                    { status: 403 },
                );
            }
            throw accountError;
        }

        const demo = await demoAnalysisStore.findForOwner(requestId, user.id);
        if (demo) {
            demoRecognized = true;
            if (demo.user_id !== user.id || !isDemoOperator(user.id)) return NextResponse.json(
                { error: '분석 요청을 찾을 수 없습니다.' },
                { status: 404, headers: demoResponseHeaders() }
            );
            return NextResponse.json({
                error: 'V2 분석은 전용 결과 경로를 사용합니다.', code: 'V2_ROUTE_REQUIRED', pipelineVersion: 'v2',
                resultUrl: `/api/analysis/v2/result/${encodeURIComponent(demo.id)}`,
            }, { status: 409, headers: demoResponseHeaders() });
        }

        const operator = isAnalysisResultOperator({ id: user.id, email: user.email });
        let authorizedUserId = user.id;
        if (operator) {
            if (await resolveAnalysisResultOwner(requestId)) {
                return NextResponse.json({
                    error: 'V2 분석은 전용 결과 경로를 사용합니다.',
                    code: 'V2_ROUTE_REQUIRED',
                    pipelineVersion: 'v2',
                    resultUrl: `/api/analysis/v2/result/${encodeURIComponent(requestId)}`,
                }, {
                    status: 409,
                    headers: {
                        'Cache-Control': 'private, no-store, max-age=0',
                        Vary: 'Cookie',
                    },
                });
            }
            authorizedUserId = await resolveAnalysisResultOwner(requestId, 'v1') ?? user.id;
        }

        // 2. 분석 요청 조회
        const { data: analysisRequest, error: requestError } = await supabaseAdmin
            .from('analysis_requests')
            .select('id, user_id, pipeline_version, target_instagram_id, status, progress, mutual_follows, gender_stats, step_data')
            .eq('id', requestId)
            .eq('user_id', authorizedUserId)
            .single();

        if (requestError || !analysisRequest) {
            return NextResponse.json(
                { error: '분석 요청을 찾을 수 없습니다.' },
                { status: 404 }
            );
        }

        if (analysisRequest.pipeline_version === 'v2') {
            return NextResponse.json({
                error: 'V2 분석은 전용 결과 경로를 사용합니다.',
                code: 'V2_ROUTE_REQUIRED',
                pipelineVersion: 'v2',
                resultUrl: `/api/analysis/v2/result/${encodeURIComponent(analysisRequest.id)}`,
            }, {
                status: 409,
                headers: {
                    'Cache-Control': 'private, no-store, max-age=0',
                    Vary: 'Cookie',
                },
            });
        }

        // 3. 분석이 완료되지 않은 경우
        if (analysisRequest.status !== 'completed') {
            return NextResponse.json(
                {
                    error: '분석이 아직 완료되지 않았습니다.',
                    status: analysisRequest.status,
                    progress: analysisRequest.progress,
                },
                { status: 400 }
            );
        }

        if (!await isAnalysisResultAuthoritativelyPublished(requestId)) {
            return NextResponse.json(
                {
                    error: '분석 결과가 아직 공개 준비 중입니다.',
                    code: 'RESULT_PENDING',
                    status: 'pending',
                    progress: 0,
                },
                { status: 400 }
            );
        }

        // 4. 분석 결과 조회 (여성 계정들)
        const { data: results, error: resultsError } = await supabaseAdmin
            .from('analysis_results')
            .select(`
                rank,
                suspect_instagram_id,
                suspect_profile_image,
                suspect_full_name,
                bio,
                risk_score,
                risk_grade,
                one_line_overview,
                risk_analysis
            `)
            .eq('request_id', requestId)
            .order('rank', { ascending: true });

        if (resultsError) {
            console.error('Results fetch error:', resultsError);
            return NextResponse.json(
                { error: '결과 조회에 실패했습니다.' },
                { status: 500 }
            );
        }

        // 5. 비공개 계정 조회
        const { data: privateAccounts, error: privateAccountsError } = await supabaseAdmin
            .from('private_accounts')
            .select('instagram_id, profile_image, full_name, name_female_score, name_confidence')
            .eq('request_id', requestId)
            .order('name_female_score', { ascending: false, nullsFirst: false })
            .order('name_confidence', { ascending: false, nullsFirst: false })
            .order('instagram_id', { ascending: true });
        if (privateAccountsError) {
            console.error('Private account results fetch failed', { requestId });
            return NextResponse.json({ error: '결과 조회에 실패했습니다.' }, { status: 500 });
        }

        // 6. 성별 비율 계산
        const genderStats = normalizeLegacyGenderStats(analysisRequest.gender_stats);
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

        // 7. 여성 계정 목록. Instagram은 팔로우 시각을 제공하지 않으므로
        // persisted provider order is used only as an inferred recent-mutual signal.
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
                displayScore: typeof result.risk_score === 'number'
                    && Number.isSafeInteger(result.risk_score)
                    && result.risk_score >= 0
                    && result.risk_score <= 100
                    ? Math.min(10, Math.max(1, result.risk_score / 10))
                    : undefined,
                bio: result.bio || '',
                recentMutualRank: recentMutualRanks.get(instagramId.toLowerCase()),
                ...toOwnerResultInteractionSummary(result, analysisRequest.target_instagram_id),
            };
        }) || [];

        // 8. 비공개 계정 목록
        const privateAccountsList = privateAccounts?.map((account) => ({
            instagramId: account.instagram_id,
            fullName: account.full_name,
            profileImage: createImageProxyPath(account.profile_image),
            instagramUrl: `https://instagram.com/${account.instagram_id}`,
        })) || [];
        const analyzedMutuals = hydratedMutualCountFromStepData(analysisRequest.step_data)
            ?? totalGender + privateAccountsList.length;

        // 9. 응답 구성
        return NextResponse.json({
            requestId,
            status: analysisRequest.status,
            summary: {
                targetInstagramId: analysisRequest.target_instagram_id,
                targetFullName: targetProfileFullNameFromStepData(analysisRequest.step_data),
                targetProfileImage: createImageProxyPath(
                    targetProfileImageFromStepData(analysisRequest.step_data)
                ),
                mutualFollows: analysisRequest.mutual_follows || 0,
                analyzedMutuals,
                genderRatio,
            },
            femaleAccounts,
            privateAccounts: privateAccountsList,
        });
    } catch (error) {
        console.error('Result fetch error:', error);
        return NextResponse.json(
            { error: '서버 오류가 발생했습니다.' },
            demoRecognized
                ? { status: 500, headers: demoResponseHeaders() }
                : { status: 500 }
        );
    }
}

export async function DELETE(
    _request: Request,
    { params }: { params: Promise<{ requestId: string }> }
) {
    let demoRecognized = false;
    try {
        const { requestId } = await params;
        const supabase = await createClient();
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 });
        }
        try {
            await requireActiveAccountClassification(user.id);
        } catch (accountError) {
            if (accountError instanceof AccountPrincipalAdmissionError) {
                return NextResponse.json(
                    { error: '이 계정은 현재 사용할 수 없습니다.' },
                    { status: 403 },
                );
            }
            throw accountError;
        }

        const demo = await demoAnalysisStore.findForOwner(requestId, user.id);
        if (demo) {
            demoRecognized = true;
            if (demo.user_id !== user.id || !isDemoOperator(user.id)) return NextResponse.json(
                { error: '판독 기록을 찾을 수 없습니다.' },
                { status: 404, headers: demoResponseHeaders() }
            );
            return await demoAnalysisStore.deleteForOwner(demo.id, user.id)
                ? new NextResponse(null, { status: 204, headers: demoResponseHeaders() })
                : NextResponse.json(
                    { error: '판독 기록을 찾을 수 없습니다.' },
                    { status: 404, headers: demoResponseHeaders() }
                );
        }

        const mutation = await supabaseAdmin
            .from('analysis_requests')
            .delete()
            .eq('id', requestId)
            .eq('user_id', user.id)
            .in('status', ['completed', 'failed'])
            .select('id')
            .maybeSingle();
        if (mutation.error) {
            console.error('Analysis deletion failed', { requestId });
            return NextResponse.json({ error: '삭제에 실패했습니다.' }, { status: 500 });
        }
        if (!mutation.data) {
            const existing = await supabaseAdmin
                .from('analysis_requests')
                .select('status')
                .eq('id', requestId)
                .eq('user_id', user.id)
                .maybeSingle();
            if (existing.error) {
                console.error('Analysis deletion status check failed', { requestId });
                return NextResponse.json({ error: '삭제에 실패했습니다.' }, { status: 500 });
            }
            if (existing.data && !isAnalysisDeletable(existing.data.status)) {
                return NextResponse.json(
                    { error: '진행 중인 판독은 삭제할 수 없습니다.' },
                    { status: 409 }
                );
            }
            return NextResponse.json(
                { error: '판독 기록을 찾을 수 없습니다.' },
                { status: 404 }
            );
        }

        return new NextResponse(null, { status: 204 });
    } catch {
        console.error('Analysis deletion API failed');
        return NextResponse.json(
            { error: '서버 오류가 발생했습니다.' },
            demoRecognized
                ? { status: 500, headers: demoResponseHeaders() }
                : { status: 500 }
        );
    }
}
