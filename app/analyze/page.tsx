'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { trackEvent, EVENTS } from '@/lib/services/analytics';
import { TopBar, Eyebrow, CaseCard, PrimaryButton } from '@/components/case-ui';

export default function AnalyzePage() {
    const [instagramId, setInstagramId] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const router = useRouter();
    const { user } = useAuth();

    // 랜딩 히어로에서 입력한 아이디를 로그인 후 이어받아 프리필
    useEffect(() => {
        try {
            const pending = sessionStorage.getItem('pending_ig');
            if (pending) {
                setInstagramId(pending);
                sessionStorage.removeItem('pending_ig');
            }
        } catch {
            /* ignore */
        }
    }, []);

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
        <div className="min-h-dvh">
            <TopBar
                right={
                    user ? (
                        <button
                            onClick={handleLogout}
                            className="text-[13px] font-medium text-fg-dim transition-colors hover:text-fg"
                        >
                            로그아웃
                        </button>
                    ) : undefined
                }
            />

            <main className="mx-auto max-w-[460px] px-5 pt-12">
                <Eyebrow>판독 의뢰서 · 대상 지정</Eyebrow>
                <h1 className="mt-3 text-[26px] font-extrabold leading-snug tracking-tight text-fg">
                    누구를 판독할까요?
                </h1>
                <p className="mt-2 text-[14px] text-fg-dim">
                    남자친구의 인스타그램 아이디를 입력하면 판독을 시작합니다.
                </p>

                <CaseCard className="mt-8 p-5">
                    <label htmlFor="ig" className="eyebrow mb-3 block">
                        대상 인스타그램 아이디
                    </label>
                    <div className="relative">
                        <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-fg-dim">@</span>
                        <input
                            id="ig"
                            type="text"
                            value={instagramId}
                            onChange={(e) => setInstagramId(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && !loading && handleStartAnalysis()}
                            placeholder="username"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            className="w-full border border-line bg-ink py-3.5 pl-9 pr-4 text-[15px] text-fg placeholder-fg-mute transition-colors focus:border-blood focus:outline-none"
                        />
                    </div>

                    <div className="mt-4 flex items-start gap-2.5 border border-amber/30 bg-amber/[0.06] px-3 py-2.5">
                        <span className="mt-0.5 h-1.5 w-1.5 shrink-0 bg-amber" />
                        <p className="text-[12px] leading-relaxed text-fg-dim">
                            <span className="font-semibold text-amber">공개 계정</span>만 판독 가능합니다. 비공개 계정은 판독할 수 없어요.
                        </p>
                    </div>

                    {error && (
                        <div className="mt-4 border border-blood/45 bg-blood/10 px-3 py-2.5 text-[13px] text-blood">
                            {error}
                        </div>
                    )}

                    <div className="mt-5">
                        <PrimaryButton onClick={handleStartAnalysis} disabled={!instagramId.trim() || loading}>
                            {loading ? (
                                <>
                                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                                    판독 요청 중…
                                </>
                            ) : (
                                '판독 시작하기'
                            )}
                        </PrimaryButton>
                    </div>
                </CaseCard>

                <p className="mt-6 text-center text-[12px] leading-relaxed text-fg-mute">
                    AI 판독 결과는 100% 정확하지 않으며, 참고용으로만 이용해 주세요.
                </p>
            </main>
        </div>
    );
}
