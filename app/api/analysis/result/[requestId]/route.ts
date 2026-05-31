import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

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
        const { data: analysisRequest, error: requestError } = await supabase
            .from('analysis_requests')
            .select('*')
            .eq('id', requestId)
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
        const { data: results, error: resultsError } = await supabase
            .from('analysis_results')
            .select('*')
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
        const { data: privateAccounts } = await supabase
            .from('private_accounts')
            .select('instagram_id, profile_image, full_name')
            .eq('request_id', requestId);

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

        // 7. 여성 계정 목록
        const femaleAccounts = results?.map((result) => ({
            instagramId: result.suspect_instagram_id,
            fullName: result.suspect_full_name,
            profileImage: result.suspect_profile_image,
            instagramUrl: `https://instagram.com/${result.suspect_instagram_id}`,
            riskGrade: result.risk_grade as 'high_risk' | 'caution' | 'normal',
            bio: result.bio || '',
        })) || [];

        // 8. 비공개 계정 목록
        const privateAccountsList = privateAccounts?.map((account) => ({
            instagramId: account.instagram_id,
            fullName: account.full_name,
            profileImage: account.profile_image,
            instagramUrl: `https://instagram.com/${account.instagram_id}`,
        })) || [];

        // 9. 응답 구성
        return NextResponse.json({
            requestId,
            status: analysisRequest.status,
            summary: {
                targetInstagramId: analysisRequest.target_instagram_id,
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
