import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { NextResponse } from 'next/server';
import { generateShareToken } from '@/lib/services/share/generate-token';

export async function POST(request: Request) {
    try {
        const { requestId } = await request.json();

        if (!requestId) {
            return NextResponse.json(
                { error: 'requestId가 필요합니다.' },
                { status: 400 }
            );
        }

        const supabase = await createClient();

        // 1. 인증 체크
        const { data: { user }, error: authError } = await supabase.auth.getUser();

        if (authError || !user) {
            return NextResponse.json(
                { error: '로그인이 필요합니다.' },
                { status: 401 }
            );
        }

        // 2. 분석 요청 조회 및 소유자 확인
        const { data: analysisRequest, error: requestError } = await supabaseAdmin
            .from('analysis_requests')
            .select('id, user_id, status, share_token, share_enabled')
            .eq('id', requestId)
            .eq('user_id', user.id)
            .single();

        if (requestError || !analysisRequest) {
            return NextResponse.json(
                { error: '분석 요청을 찾을 수 없습니다.' },
                { status: 404 }
            );
        }

        // 3. 소유자 확인
        if (analysisRequest.user_id !== user.id) {
            return NextResponse.json(
                { error: '권한이 없습니다.' },
                { status: 403 }
            );
        }

        // 4. 분석 완료 상태 확인
        if (analysisRequest.status !== 'completed') {
            return NextResponse.json(
                { error: '분석이 완료된 후에 공유할 수 있습니다.' },
                { status: 400 }
            );
        }

        // 5. 이미 공유 토큰이 있으면 재사용
        let shareToken = analysisRequest.share_token;

        if (!shareToken) {
            // 새 토큰 생성
            shareToken = generateShareToken();

            // DB 업데이트 (admin 클라이언트 사용)
            const { error: updateError } = await supabaseAdmin
                .from('analysis_requests')
                .update({
                    share_token: shareToken,
                    share_enabled: true,
                })
                .eq('id', requestId);

            if (updateError) {
                console.error('Share token update error:', updateError);
                return NextResponse.json(
                    { error: '공유 토큰 생성에 실패했습니다.' },
                    { status: 500 }
                );
            }
        } else if (!analysisRequest.share_enabled) {
            // 토큰은 있지만 비활성화된 경우 활성화
            const { error: updateError } = await supabaseAdmin
                .from('analysis_requests')
                .update({ share_enabled: true })
                .eq('id', requestId);

            if (updateError) {
                console.error('Share enable error:', updateError);
                return NextResponse.json(
                    { error: '공유 활성화에 실패했습니다.' },
                    { status: 500 }
                );
            }
        }

        // 6. 공유 URL 생성
        const host = request.headers.get('host') || 'localhost:3000';
        const protocol = host.includes('localhost') ? 'http' : 'https';
        const shareUrl = `${protocol}://${host}/share/${shareToken}`;

        return NextResponse.json({
            success: true,
            shareToken,
            shareUrl,
        });
    } catch (error) {
        console.error('Share enable error:', error);
        return NextResponse.json(
            { error: '서버 오류가 발생했습니다.' },
            { status: 500 }
        );
    }
}
