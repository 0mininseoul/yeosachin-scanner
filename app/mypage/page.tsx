import { createClient } from '@/lib/supabase/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import AnalysisList from './analysis-list';

export const metadata = {
    title: '마이페이지 - AI 위장 여사친 판독기',
};

export default async function MyPage() {
    const supabase = await createClient();

    // 1. 사용자 인증 확인
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
        redirect('/login');
    }

    // 2. 분석 기록 조회
    const { data: analyses, error: analysisError } = await supabase
        .from('analysis_requests')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

    if (analysisError) {
        console.error('Error fetching analysis history:', analysisError);
    }

    return (
        <div className="min-h-screen bg-black text-white">
            {/* 네비게이션 */}
            <nav className="border-b border-gray-800 bg-black/80 backdrop-blur-md sticky top-0 z-50">
                <div className="max-w-md mx-auto px-4 h-14 flex items-center justify-between">
                    <Link href="/" className="flex items-center gap-2">
                        <span className="text-2xl">🕵️‍♀️</span>
                        <span className="font-bold text-lg bg-gradient-to-r from-pink-400 to-purple-400 text-transparent bg-clip-text">
                            AI 판독기
                        </span>
                    </Link>
                    <div className="flex items-center gap-4">
                        <span className="text-xs text-gray-500">{user.email}</span>
                        <form action="/api/auth/signout" method="post">
                            <button className="text-sm text-gray-400 hover:text-white">로그아웃</button>
                        </form>
                    </div>
                </div>
            </nav>

            <main className="max-w-md mx-auto px-4 py-8">
                <div className="mb-8">
                    <h1 className="text-2xl font-bold mb-2">마이페이지</h1>
                    <p className="text-gray-400 text-sm">과거 분석 기록을 확인하고 관리하세요.</p>
                </div>

                {/* 분석 목록 리스트 (클라이언트 컴포넌트) */}
                <AnalysisList initialAnalyses={analyses || []} />
            </main>
        </div>
    );
}
