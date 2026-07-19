import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { TopBar, Eyebrow } from '@/components/case-ui';
import { LogoutButton } from '@/components/logout-button';
import { ownerAnalysisHistoryV1Schema } from '@/lib/services/analysis/owner-history';
import AnalysisList from './analysis-list';

export const metadata = {
    title: '보관함 - AI 위장 여사친 판독기',
};

export default async function MyPage() {
    const supabase = await createClient();

    // 1. 사용자 인증 확인
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
        redirect('/login');
    }

    // 2. V2 terminal PII scrub 이후에도 owner-safe projection으로 분석 기록 조회
    const { data: historyPayload, error: analysisError } = await supabase
        .rpc('load_analysis_owner_history_v1');

    if (analysisError) {
        console.error('Error fetching analysis history:', analysisError);
    }
    const parsedHistory = ownerAnalysisHistoryV1Schema.safeParse(historyPayload);
    if (!analysisError && !parsedHistory.success) {
        console.error('Analysis owner history response failed validation');
    }
    const analyses = parsedHistory.success ? parsedHistory.data.items : [];

    return (
        <div className="min-h-dvh">
            <TopBar
                right={
                    <>
                        <span className="hidden max-w-[140px] truncate text-[12px] text-fg-mute sm:inline">
                            {user.email}
                        </span>
                        <LogoutButton />
                    </>
                }
            />

            <main className="mx-auto max-w-[480px] px-5 pt-10">
                <Eyebrow>판독 기록</Eyebrow>
                <h1 className="mt-3 text-[26px] font-extrabold tracking-tight text-fg">보관함</h1>
                <p className="mt-2 text-[13px] text-fg-dim">지난 판독 기록을 확인하고 관리하세요.</p>

                <div className="mt-8">
                    <AnalysisList initialAnalyses={analyses} />
                </div>
            </main>
        </div>
    );
}
