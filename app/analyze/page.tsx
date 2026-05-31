'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { trackEvent, EVENTS } from '@/lib/services/analytics';

export default function AnalyzePage() {
    const [instagramId, setInstagramId] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const router = useRouter();
    const { user } = useAuth();

    const handleStartAnalysis = async () => {
        if (!instagramId.trim()) {
            setError('인스타그램 아이디를 입력해주세요.');
            return;
        }

        if (!user) {
            router.push('/login');
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const response = await fetch('/api/analysis/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    targetInstagramId: instagramId.replace('@', '').trim(),
                    targetGender: 'male',
                }),
            });

            const data = await response.json();

            if (!response.ok) {
                setError(data.error || '분석 시작에 실패했습니다.');
                setLoading(false);
                return;
            }

            trackEvent(EVENTS.ANALYSIS_START);
            router.push(`/progress/${data.requestId}`);
        } catch (err) {
            console.error('Failed to start analysis:', err);
            setError('서버 오류가 발생했습니다.');
            setLoading(false);
        }
    };

    const handleLogout = async () => {
        try {
            const response = await fetch('/api/auth/signout', { method: 'POST' });
            if (response.ok) {
                router.push('/');
            }
        } catch (err) {
            console.error('Logout failed:', err);
        }
    };

    return (
        <div className="min-h-screen bg-black flex flex-col items-center justify-center p-4">
            {/* 로그아웃 버튼 */}
            {user && (
                <div className="absolute top-4 right-4">
                    <button
                        onClick={handleLogout}
                        className="text-sm text-gray-400 hover:text-white transition-colors"
                    >
                        로그아웃
                    </button>
                </div>
            )}

            {/* 헤더 */}
            <div className="mb-8 text-center">
                <div className="text-4xl mb-4">🔍</div>
                <h1 className="text-xl font-bold text-white">
                    AI 위장 여사친 판독기
                </h1>
            </div>

            <div className="w-full max-w-sm space-y-6">
                {/* 인스타그램 ID 입력 */}
                <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                        남자친구 인스타그램 아이디
                    </label>
                    <div className="relative">
                        <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500">@</span>
                        <input
                            type="text"
                            value={instagramId}
                            onChange={(e) => setInstagramId(e.target.value)}
                            placeholder="username"
                            className="w-full bg-gray-900 border border-gray-700 rounded-xl py-3.5 pl-9 pr-4 text-white placeholder-gray-500 focus:outline-none focus:border-pink-400 focus:ring-1 focus:ring-pink-400 transition-all"
                        />
                    </div>
                </div>

                {/* 공개 계정 안내 */}
                <div className="flex items-start gap-2 p-3 bg-gray-900/50 rounded-xl border border-gray-800">
                    <span className="text-amber-400">⚠️</span>
                    <p className="text-xs text-gray-400">
                        공개 계정만 분석 가능합니다. 비공개 계정은 분석할 수 없어요.
                    </p>
                </div>

                {/* 에러 메시지 */}
                {error && (
                    <div className="p-3 bg-red-900/30 border border-red-500/50 rounded-xl text-red-300 text-sm">
                        {error}
                    </div>
                )}

                {/* 분석 시작 버튼 */}
                <button
                    onClick={handleStartAnalysis}
                    disabled={!instagramId.trim() || loading}
                    className="w-full bg-gradient-to-r from-pink-500 to-purple-500 hover:from-pink-400 hover:to-purple-400 disabled:from-gray-700 disabled:to-gray-700 disabled:text-gray-500 text-white font-bold py-4 px-4 rounded-xl transition-all"
                >
                    {loading ? '분석 요청 중...' : '분석 시작하기'}
                </button>
            </div>

            {/* 면책 조항 */}
            <p className="mt-8 text-xs text-gray-500 text-center max-w-sm">
                AI 분석 결과는 100% 정확하지 않으며, 참고용으로만 이용해주세요.
            </p>
        </div>
    );
}
