'use client';

import { useEffect, useState, use } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { trackEvent, EVENTS } from '@/lib/services/analytics';
import {
    TopBar,
    Eyebrow,
    CaseCard,
    ThreatBar,
    RiskTag,
    PrimaryButton,
    ghostCls,
    primaryCls,
} from '@/components/case-ui';

interface PageProps {
    params: Promise<{ token: string }>;
}

const getProxyImageUrl = (url: string | undefined): string | undefined => {
    if (!url) return undefined;
    if (url.startsWith('/api/image-proxy')) return url;
    return `/api/image-proxy?url=${encodeURIComponent(url)}`;
};

function FallbackGlyph({ variant }: { variant: 'person' | 'private' }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5 text-fg-mute" aria-hidden="true">
            {variant === 'private' ? (
                <>
                    <rect x="5" y="10.5" width="14" height="9" rx="1" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M8 10.5V8a4 4 0 018 0v2.5" stroke="currentColor" strokeWidth="1.5" />
                </>
            ) : (
                <>
                    <circle cx="12" cy="8.5" r="3.5" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" stroke="currentColor" strokeWidth="1.5" />
                </>
            )}
        </svg>
    );
}

function ProfileImage({
    src,
    variant = 'person',
    className = 'h-full w-full object-cover',
}: {
    src?: string;
    variant?: 'person' | 'private';
    className?: string;
}) {
    const [error, setError] = useState(false);
    const proxiedSrc = getProxyImageUrl(src);

    if (!proxiedSrc || error) {
        return (
            <div className="flex h-full w-full items-center justify-center">
                <FallbackGlyph variant={variant} />
            </div>
        );
    }

    return (
        <Image src={proxiedSrc} alt="" width={48} height={48} unoptimized className={className} onError={() => setError(true)} />
    );
}

interface GenderRatio {
    male: { count: number; percentage: number };
    female: { count: number; percentage: number };
    unknown: { count: number; percentage: number };
}

interface FemaleAccount {
    instagramId: string;
    fullName?: string;
    profileImage?: string;
    instagramUrl: string;
    riskGrade: 'high_risk' | 'caution' | 'normal';
    bio: string;
}

interface PrivateAccount {
    instagramId: string;
    fullName?: string;
    profileImage?: string;
    instagramUrl: string;
    bio?: string;
}

interface ResultData {
    requestId: string;
    status: string;
    isShared: boolean;
    summary: {
        targetInstagramId: string;
        mutualFollows: number;
        genderRatio: GenderRatio;
    };
    femaleAccounts: FemaleAccount[];
    privateAccounts: PrivateAccount[];
}

const InstaLink = ({ url }: { url: string }) => (
    <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-fg-mute transition-colors hover:text-blood"
        aria-label="인스타그램에서 보기"
    >
        <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z" />
        </svg>
    </a>
);

const BRACKET_BY_GRADE: Record<string, string> = {
    high_risk: 'var(--color-blood)',
    caution: 'var(--color-amber)',
    normal: 'var(--color-line-2)',
};

export default function ShareResultPage({ params }: PageProps) {
    const { token } = use(params);
    const [data, setData] = useState<ResultData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const router = useRouter();

    useEffect(() => {
        const fetchResult = async () => {
            try {
                const response = await fetch(`/api/share/${token}`);
                const result = await response.json();

                if (!response.ok) {
                    throw new Error(result.error || '결과를 불러올 수 없습니다.');
                }

                setData(result);
                trackEvent(EVENTS.VIEW_RESULT, {
                    femaleCount: result.femaleAccounts?.length,
                    isShared: true,
                });
            } catch (err) {
                setError(err instanceof Error ? err.message : '결과를 불러오는데 실패했습니다.');
            } finally {
                setLoading(false);
            }
        };

        fetchResult();
    }, [token]);

    const handleShare = async () => {
        trackEvent(EVENTS.CLICK_SHARE_KAKAO);

        const url = window.location.href;
        const shareData = {
            title: 'AI 위장 여사친 판독기 분석 결과',
            text: `${data?.summary.targetInstagramId}님의 인스타 분석 결과를 확인해보세요!`,
            url: url,
        };

        if (navigator.share) {
            try {
                await navigator.share(shareData);
                return;
            } catch {
                // fallback
            }
        }

        try {
            await navigator.clipboard.writeText(url);
            alert('링크가 클립보드에 복사되었습니다!');
        } catch {
            alert('공유하기에 실패했습니다.');
        }
    };

    if (loading) {
        return (
            <div className="flex min-h-dvh items-center justify-center">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-blood border-t-transparent" />
            </div>
        );
    }

    if (error || !data) {
        return (
            <div className="flex min-h-dvh flex-col items-center justify-center px-5">
                <p className="mb-5 text-[14px] text-blood">{error}</p>
                <Link href="/" className={`${primaryCls} max-w-[220px]`}>
                    서비스 이용하기
                </Link>
            </div>
        );
    }

    const { summary, femaleAccounts, privateAccounts } = data;
    const gr = summary.genderRatio;
    const highCount = femaleAccounts.filter((a) => a.riskGrade === 'high_risk').length;

    return (
        <div className="min-h-dvh pb-16">
            <TopBar
                right={
                    <Link href="/" className="text-[13px] font-bold text-blood transition-colors hover:text-blood-2">
                        나도 판독해보기 →
                    </Link>
                }
            />

            <main className="mx-auto max-w-[480px] px-5 pt-8">
                <div className="flex items-center justify-between">
                    <Eyebrow>판독 리포트 · 공유본</Eyebrow>
                    <span className="num text-[11px] tracking-[0.18em] text-fg-mute">@{summary.targetInstagramId}</span>
                </div>
                <h1 className="mt-3 text-[24px] font-extrabold tracking-tight text-fg">판독 결과</h1>
                {highCount > 0 && (
                    <p className="mt-2 text-[13px] text-fg-dim">
                        위협 등급 <span className="font-bold text-blood">고위험 {highCount}건</span>이 감지됐습니다.
                    </p>
                )}

                {/* gender breakdown */}
                <CaseCard className="mt-6 p-5">
                    <div className="mb-4 flex items-center justify-between">
                        <span className="eyebrow">맞팔 계정 성별 분석</span>
                        <span className="num text-[12px] text-fg-dim">맞팔 {summary.mutualFollows}명</span>
                    </div>
                    <div className="flex h-3 w-full overflow-hidden bg-line">
                        <div className="h-full bg-fg-dim" style={{ width: `${gr.male.percentage}%` }} />
                        <div className="h-full bg-blood" style={{ width: `${gr.female.percentage}%` }} />
                        <div className="h-full bg-line-2" style={{ width: `${gr.unknown.percentage}%` }} />
                    </div>
                    <div className="mt-4 grid grid-cols-3 gap-3">
                        {[
                            { label: '남성', c: gr.male, dot: 'bg-fg-dim', txt: 'text-fg' },
                            { label: '여성', c: gr.female, dot: 'bg-blood', txt: 'text-blood' },
                            { label: '미상', c: gr.unknown, dot: 'bg-line-2', txt: 'text-fg-dim' },
                        ].map((row) => (
                            <div key={row.label} className="border-l border-line pl-3">
                                <div className="flex items-center gap-1.5">
                                    <span className={`h-2 w-2 ${row.dot}`} />
                                    <span className="text-[12px] text-fg-dim">{row.label}</span>
                                </div>
                                <div className={`num mt-1 text-[18px] font-extrabold ${row.txt}`}>{row.c.count}</div>
                                <div className="num text-[11px] text-fg-mute">{row.c.percentage}%</div>
                            </div>
                        ))}
                    </div>
                </CaseCard>

                {/* suspects */}
                <section className="mt-9">
                    <div className="flex items-baseline justify-between">
                        <Eyebrow>위협 등급 순위</Eyebrow>
                        <span className="num text-[12px] text-fg-dim">{femaleAccounts.length}명</span>
                    </div>
                    {femaleAccounts.length === 0 ? (
                        <CaseCard className="mt-5 px-4 py-10 text-center">
                            <p className="text-[13px] text-fg-mute">판독된 여성 계정이 없습니다.</p>
                        </CaseCard>
                    ) : (
                        <div className="mt-5 space-y-2.5">
                            {femaleAccounts.map((account, i) => (
                                <CaseCard key={account.instagramId} bracket={BRACKET_BY_GRADE[account.riskGrade]} className="p-4">
                                    <div className="flex items-start gap-3">
                                        <div className="relative h-11 w-11 shrink-0 overflow-hidden border border-line bg-panel">
                                            <ProfileImage src={account.profileImage} variant="person" />
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-2">
                                                <span className="num shrink-0 text-[12px] font-bold tracking-widest text-fg-mute">
                                                    #{String(i + 1).padStart(2, '0')}
                                                </span>
                                                <a
                                                    href={account.instagramUrl}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="truncate text-[14px] font-bold text-fg transition-colors hover:text-blood"
                                                >
                                                    @{account.instagramId}
                                                </a>
                                                <RiskTag grade={account.riskGrade} className="ml-auto" />
                                            </div>
                                            {(account.fullName || account.bio) && (
                                                <p className="mt-1 truncate text-[12px] text-fg-dim">
                                                    {account.fullName && <span>{account.fullName}</span>}
                                                    {account.fullName && account.bio && ' · '}
                                                    {account.bio}
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                    <div className="mt-3 flex items-center gap-3">
                                        <ThreatBar grade={account.riskGrade} className="flex-1" />
                                        <InstaLink url={account.instagramUrl} />
                                    </div>
                                </CaseCard>
                            ))}
                        </div>
                    )}
                </section>

                {/* private */}
                <section className="mt-9">
                    <div className="flex items-baseline justify-between">
                        <Eyebrow>숨은 위험인물들 / 비공개 계정</Eyebrow>
                        <span className="num text-[12px] text-fg-dim">{privateAccounts.length}개</span>
                    </div>
                    {privateAccounts.length === 0 ? (
                        <CaseCard className="mt-5 px-4 py-10 text-center">
                            <p className="text-[13px] text-fg-mute">비공개 계정이 없습니다.</p>
                        </CaseCard>
                    ) : (
                        <div className="mt-5 space-y-2.5">
                            {privateAccounts.map((account) => (
                                <div key={account.instagramId} className="flex items-start gap-3 border border-line bg-ink-2/60 p-3.5">
                                    <div className="relative h-11 w-11 shrink-0 overflow-hidden border border-line bg-panel">
                                        <ProfileImage src={account.profileImage} variant="private" />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <a
                                            href={account.instagramUrl}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="block truncate text-[14px] font-bold text-fg transition-colors hover:text-blood"
                                        >
                                            @{account.instagramId}
                                        </a>
                                        {(account.fullName || account.bio) && (
                                            <p className="mt-0.5 truncate text-[12px] text-fg-dim">
                                                {account.fullName && <span>{account.fullName}</span>}
                                                {account.fullName && account.bio && ' · '}
                                                {account.bio}
                                            </p>
                                        )}
                                    </div>
                                    <InstaLink url={account.instagramUrl} />
                                </div>
                            ))}
                        </div>
                    )}
                    <p className="mt-3 text-[11px] text-fg-mute">비공개 계정은 게시물 분석이 어려워요. 프로필을 직접 확인해 보세요.</p>
                </section>

                {/* actions */}
                <div className="mt-9 space-y-2.5">
                    <button onClick={handleShare} className={ghostCls}>
                        리포트 공유하기
                    </button>
                    <Link href="/" className={primaryCls}>
                        나도 판독해보기
                    </Link>
                </div>

                <p className="mt-5 text-center text-[11px] text-fg-mute">
                    AI 판독 결과는 100% 정확하지 않으며, 참고용으로만 사용해 주세요.
                </p>
            </main>
        </div>
    );
}
