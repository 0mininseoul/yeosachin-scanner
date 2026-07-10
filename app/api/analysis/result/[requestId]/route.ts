import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    inferRecentMutualFemaleRanks,
    orderedMutualUsernamesFromStepData,
} from '@/lib/services/analysis/recent-mutuals';
import {
    targetProfileImageFromStepData,
    toResultInteractionSummary,
} from '@/lib/services/analysis/result-interactions';
import { createImageProxyPath } from '@/lib/services/media/image-proxy-token';
import { NextResponse } from 'next/server';
import { isAnalysisDeletable } from '@/lib/services/analysis/deletion';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ requestId: string }> }
) {
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

        // 2. 분석 요청 조회
        const { data: analysisRequest, error: requestError } = await supabaseAdmin
            .from('analysis_requests')
            .select('id, user_id, target_instagram_id, status, progress, mutual_follows, gender_stats, step_data')
            .eq('id', requestId)
            .eq('user_id', user.id)
            .single();

        if (requestError || !analysisRequest) {
            return NextResponse.json(
                { error: '분석 요청을 찾을 수 없습니다.' },
                { status: 404 }
            );
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

        // 4. 분석 결과 조회 (여성 계정들)
        const { data: results, error: resultsError } = await supabaseAdmin
            .from('analysis_results')
            .select(`
                rank,
                suspect_instagram_id,
                suspect_profile_image,
                suspect_full_name,
                bio,
                risk_grade,
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
                bio: result.bio || '',
                recentMutualRank: recentMutualRanks.get(instagramId.toLowerCase()),
                ...toResultInteractionSummary(result),
            };
        }) || [];

        // 8. 비공개 계정 목록
        const privateAccountsList = privateAccounts?.map((account) => ({
            instagramId: account.instagram_id,
            fullName: account.full_name,
            profileImage: createImageProxyPath(account.profile_image),
            instagramUrl: `https://instagram.com/${account.instagram_id}`,
        })) || [];

        // 9. 응답 구성
        return NextResponse.json({
            requestId,
            status: analysisRequest.status,
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
        });
    } catch (error) {
        console.error('Result fetch error:', error);
        return NextResponse.json(
            { error: '서버 오류가 발생했습니다.' },
            { status: 500 }
        );
    }
}

export async function DELETE(
    _request: Request,
    { params }: { params: Promise<{ requestId: string }> }
) {
    try {
        const { requestId } = await params;
        const supabase = await createClient();
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 });
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
        return NextResponse.json({ error: '서버 오류가 발생했습니다.' }, { status: 500 });
    }
}
