'use client';

import { useEffect, useState, use } from 'react';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import type { AnalysisResultPageV1 } from '@/lib/contracts/analysis-v2';
import { trackEvent, EVENTS } from '@/lib/services/analytics';
import {
    paginatedCountLabel,
    v2ResultFailureAction,
    type OwnerProgressStatus,
} from '@/lib/services/analysis/owner-view-presentation';
import {
    TopBar,
    Eyebrow,
    CaseCard,
    ThreatBar,
    RiskTag,
    RecentMutualBadge,
    DeepRiskAnalysis,
    PrimaryButton,
} from '@/components/case-ui';

interface PageProps {
    params: Promise<{ requestId: string }>;
}

const getProxyImageUrl = (url: string | undefined): string | undefined => {
    if (!url) return undefined;
    return url.startsWith('/api/image-proxy?') ? url : undefined;
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

// 프로필 이미지 컴포넌트 (로드 실패 시 fallback)
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
        <Image
            src={proxiedSrc}
            alt=""
            width={48}
            height={48}
            unoptimized
            className={className}
            onError={() => setError(true)}
        />
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
    recentMutualRank?: 1 | 2 | 3 | 4 | 5;
    riskAnalysis: string[];
    oneLineOverview?: string;
    displayScore?: number;
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
    pipelineVersion: 'v1' | 'v2';
    summary: {
        targetInstagramId: string;
        targetProfileImage?: string;
        mutualFollows: number;
        genderRatio: GenderRatio | null;
        v2?: {
            planId: 'basic' | 'standard' | 'plus';
            followers: AnalysisResultPageV1['summary']['followers'];
            following: AnalysisResultPageV1['summary']['following'];
            publicMutuals: number;
            privateMutuals: number;
            screenedMutuals: number;
            successfullyScreenedMutuals: number;
            notScreenedMutuals: number;
            exclusionApplied: boolean;
        };
    };
    femaleAccounts: FemaleAccount[];
    privateAccounts: PrivateAccount[];
    femaleNextCursor?: string | null;
    privateNextCursor?: string | null;
}

interface ShareResponse {
    success: boolean;
    shareUrl: string;
    shareToken: string;
}

interface V2ProgressStatusResponse {
    snapshot?: { status?: OwnerProgressStatus };
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

function mapV2Result(result: AnalysisResultPageV1): ResultData {
    return {
        requestId: result.requestId,
        status: 'completed',
        pipelineVersion: 'v2',
        summary: {
            targetInstagramId: result.summary.targetInstagramId,
            targetProfileImage: result.summary.targetProfileImage || undefined,
            mutualFollows: result.summary.detectedMutuals,
            genderRatio: null,
            v2: {
                planId: result.summary.planId,
                followers: result.summary.followers,
                following: result.summary.following,
                publicMutuals: result.summary.publicMutuals,
                privateMutuals: result.summary.privateMutuals,
                screenedMutuals: result.summary.screenedMutuals,
                successfullyScreenedMutuals: result.summary.successfullyScreenedMutuals,
                notScreenedMutuals: result.summary.notScreenedMutuals,
                exclusionApplied: result.summary.exclusionApplied,
            },
        },
        femaleAccounts: result.femaleAccounts.map(account => ({
            instagramId: account.instagramId,
            fullName: account.fullName || undefined,
            profileImage: account.profileImage || undefined,
            instagramUrl: `https://instagram.com/${account.instagramId}`,
            riskGrade: account.riskBand,
            bio: account.bio || '',
            recentMutualRank: account.recentMutualRank !== null && account.recentMutualRank <= 5
                ? account.recentMutualRank as 1 | 2 | 3 | 4 | 5
                : undefined,
            riskAnalysis: account.highRiskNarrative ? [...account.highRiskNarrative] : [],
            oneLineOverview: account.oneLineOverview,
            displayScore: account.displayScore,
        })),
        privateAccounts: result.privateAccounts.map(account => ({
            instagramId: account.instagramId,
            fullName: account.fullName || undefined,
            profileImage: account.profileImage || undefined,
            instagramUrl: `https://instagram.com/${account.instagramId}`,
        })),
        femaleNextCursor: result.femaleNextCursor,
        privateNextCursor: result.privateNextCursor,
    };
}

function appendUniqueAccounts<T extends { instagramId: string }>(current: T[], next: T[]): T[] {
    const seen = new Set(current.map(account => account.instagramId));
    return [...current, ...next.filter(account => !seen.has(account.instagramId))];
}

export default function ResultPage({ params }: PageProps) {
    const { requestId } = use(params);
    const [data, setData] = useState<ResultData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [shareLoading, setShareLoading] = useState(false);
    const [loadMoreKind, setLoadMoreKind] = useState<'public' | 'private' | null>(null);
    const [loadMoreError, setLoadMoreError] = useState<'public' | 'private' | null>(null);
    const [resultRetry, setResultRetry] = useState(0);
    const [tab, setTab] = useState<'public' | 'private'>('public');
    const router = useRouter();
    const requestedPipeline = useSearchParams().get('pipeline');

    useEffect(() => {
        const abortController = new AbortController();

        const fetchResult = async () => {
            try {
                setError(null);
                let isV2Request = requestedPipeline === 'v2';
                let response = await fetch(
                    requestedPipeline === 'v2'
                        ? `/api/analysis/v2/result/${requestId}?pageSize=50`
                        : `/api/analysis/result/${requestId}`,
                    { cache: 'no-store', signal: abortController.signal }
                );
                let result = await response.json();

                if (
                    response.status === 409
                    && result.code === 'V2_ROUTE_REQUIRED'
                    && result.pipelineVersion === 'v2'
                    && typeof result.resultUrl === 'string'
                    && result.resultUrl.startsWith('/api/analysis/v2/result/')
                ) {
                    isV2Request = true;
                    response = await fetch(`${result.resultUrl}?pageSize=50`, {
                        cache: 'no-store',
                        signal: abortController.signal,
                    });
                    result = await response.json();
                }

                if (!response.ok) {
                    if (isV2Request) {
                        let progressStatus: OwnerProgressStatus | null = null;
                        if (response.status === 404) {
                            const progressResponse = await fetch(
                                `/api/analysis/progress/${encodeURIComponent(requestId)}?limit=1`,
                                { cache: 'no-store', signal: abortController.signal }
                            );
                            if (progressResponse.ok) {
                                const progress = await progressResponse.json() as V2ProgressStatusResponse;
                                progressStatus = progress.snapshot?.status ?? null;
                            }
                        }
                        if (v2ResultFailureAction({
                            resultStatus: response.status,
                            progressStatus,
                        }) === 'show_progress') {
                            router.replace(`/progress/${requestId}`);
                            return;
                        }
                        throw new Error('V2_RESULT_UNAVAILABLE');
                    }
                    if (result.status && result.status !== 'completed') {
                        router.push(`/progress/${requestId}`);
                        return;
                    }
                    throw new Error(result.error);
                }

                const isV2Result = result.schemaVersion === 1
                    && result.summary
                    && 'detectedMutuals' in result.summary;
                const displayResult = isV2Result
                    ? mapV2Result(result as AnalysisResultPageV1)
                    : { ...result, pipelineVersion: 'v1' as const };
                setData(displayResult);
                setError(null);
                trackEvent(EVENTS.VIEW_RESULT, { femaleCount: result.femaleAccounts?.length });
            } catch (err) {
                if (err instanceof Error && err.name === 'AbortError') return;
                console.error('Failed to fetch analysis result:', err);
                setError('완료된 판독 결과를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
            } finally {
                if (!abortController.signal.aborted) setLoading(false);
            }
        };

        void fetchResult();
        return () => abortController.abort();
    }, [requestId, requestedPipeline, resultRetry, router]);

    const handleLoadMore = async (kind: 'public' | 'private') => {
        if (!data || data.pipelineVersion !== 'v2' || loadMoreKind) return;
        const cursor = kind === 'public' ? data.femaleNextCursor : data.privateNextCursor;
        if (!cursor) return;
        setLoadMoreKind(kind);
        setLoadMoreError(current => current === kind ? null : current);
        try {
            const cursorName = kind === 'public' ? 'femaleCursor' : 'privateCursor';
            const response = await fetch(
                `/api/analysis/v2/result/${requestId}?pageSize=50&${cursorName}=${encodeURIComponent(cursor)}`,
                { cache: 'no-store' }
            );
            if (!response.ok) throw new Error(`V2 result page failed (${response.status}).`);
            const next = mapV2Result(await response.json() as AnalysisResultPageV1);
            setData(current => current && current.pipelineVersion === 'v2'
                ? {
                    ...current,
                    femaleAccounts: kind === 'public'
                        ? appendUniqueAccounts(current.femaleAccounts, next.femaleAccounts)
                        : current.femaleAccounts,
                    privateAccounts: kind === 'private'
                        ? appendUniqueAccounts(current.privateAccounts, next.privateAccounts)
                        : current.privateAccounts,
                    femaleNextCursor: kind === 'public'
                        ? next.femaleNextCursor
                        : current.femaleNextCursor,
                    privateNextCursor: kind === 'private'
                        ? next.privateNextCursor
                        : current.privateNextCursor,
                }
                : current);
        } catch (err) {
            console.error('Failed to load the next V2 result page:', err);
            setLoadMoreError(kind);
        } finally {
            setLoadMoreKind(null);
        }
    };

    const handleShare = async () => {
        trackEvent(EVENTS.CLICK_SHARE_KAKAO);

        setShareLoading(true);

        try {
            const response = await fetch('/api/share/enable', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ requestId }),
            });

            const result: ShareResponse = await response.json();

            if (!response.ok || !result.success) {
                throw new Error('공유 링크 생성에 실패했습니다.');
            }

            const shareUrl = result.shareUrl;
            const shareData = {
                title: 'AI 위장 여사친 판독기 분석 결과',
                text: `${data?.summary.targetInstagramId}님의 인스타 분석 결과를 확인해보세요!`,
                url: shareUrl,
            };

            if (navigator.share) {
                try {
                    await navigator.share(shareData);
                    return;
                } catch {
                    // fallback
                }
            }

            await navigator.clipboard.writeText(shareUrl);
            alert('공유 링크가 클립보드에 복사되었습니다!');
        } catch (err) {
            console.error('Share error:', err);
            alert('공유하기에 실패했습니다.');
        } finally {
            setShareLoading(false);
        }
    };

    const handleLogout = async () => {
        try {
            const response = await fetch('/api/auth/signout', { method: 'POST' });
            if (response.ok) router.push('/');
        } catch (err) {
            console.error('Logout failed:', err);
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
                <CaseCard bracket="var(--color-blood)" className="w-full max-w-[400px] p-8 text-center">
                    <Eyebrow className="justify-center">결과 조회 오류</Eyebrow>
                    <h1 className="mt-4 text-[21px] font-extrabold tracking-tight text-fg">
                        판독 결과를 열지 못했습니다
                    </h1>
                    <p className="mt-3 text-[13px] leading-relaxed text-fg-dim" role="alert">
                        {error || '판독 결과를 찾을 수 없습니다.'}
                    </p>
                    <div className="mt-7">
                        <PrimaryButton
                            onClick={() => {
                                setLoading(true);
                                setResultRetry(value => value + 1);
                            }}
                        >
                            결과 다시 불러오기
                        </PrimaryButton>
                    </div>
                    <button
                        type="button"
                        onClick={() => router.push('/analyze')}
                        className="mt-4 text-[12px] font-medium text-fg-mute transition-colors hover:text-fg"
                    >
                        새 판독으로 돌아가기
                    </button>
                </CaseCard>
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
                    <>
                        <button
                            onClick={() => router.push('/mypage')}
                            className="text-[13px] font-medium text-fg-dim transition-colors hover:text-fg"
                        >
                            기록실
                        </button>
                        <button
                            onClick={handleLogout}
                            className="text-[13px] font-medium text-fg-dim transition-colors hover:text-fg"
                        >
                            로그아웃
                        </button>
                    </>
                }
            />

            <main className="mx-auto max-w-[480px] px-5 pt-8">
                {/* case header */}
                <div className="flex items-center justify-between gap-3">
                    <Eyebrow className="shrink-0">판독 리포트</Eyebrow>
                    <div className="flex min-w-0 max-w-[62%] items-center gap-2">
                        <div className="relative h-9 w-9 shrink-0 overflow-hidden border border-line-2 bg-panel">
                            <ProfileImage src={summary.targetProfileImage} variant="person" />
                        </div>
                        <span className="num block truncate text-[10px] text-fg-mute">
                            @{summary.targetInstagramId}
                        </span>
                    </div>
                </div>
                <h1 className="mt-3 text-[24px] font-extrabold tracking-tight text-fg">판독 결과</h1>
                {highCount > 0 && (
                    <p className="mt-2 text-[13px] text-fg-dim">
                        위협 등급 <span className="font-bold text-blood">고위험 {highCount}건</span>이 감지됐습니다.
                    </p>
                )}

                {/* pipeline-specific summary */}
                {gr ? <CaseCard className="mt-6 p-5">
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
                </CaseCard> : summary.v2 ? (
                    <CaseCard className="mt-6 p-5">
                        <div className="flex items-center justify-between gap-3">
                            <span className="eyebrow">수집 및 판독 범위</span>
                            <span className="num text-[11px] uppercase text-fg-dim">{summary.v2.planId}</span>
                        </div>
                        <div className="mt-4 grid grid-cols-2 gap-px bg-line">
                            {[
                                { label: '팔로워', value: `${summary.v2.followers.collected}/${summary.v2.followers.declared}` },
                                { label: '팔로잉', value: `${summary.v2.following.collected}/${summary.v2.following.declared}` },
                                { label: '확인된 맞팔', value: String(summary.mutualFollows) },
                                { label: '상세 판독', value: String(summary.v2.screenedMutuals) },
                            ].map(item => (
                                <div key={item.label} className="bg-ink-2 px-3 py-3">
                                    <span className="text-[11px] text-fg-mute">{item.label}</span>
                                    <p className="num mt-1 text-[17px] font-bold text-fg">{item.value}</p>
                                </div>
                            ))}
                        </div>
                        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-fg-dim">
                            <span>공개 {summary.v2.publicMutuals}명</span>
                            <span>비공개 {summary.v2.privateMutuals}명</span>
                            <span>판독 완료 {summary.v2.successfullyScreenedMutuals}명</span>
                            {summary.v2.notScreenedMutuals > 0 && (
                                <span>플랜 범위 외 {summary.v2.notScreenedMutuals}명</span>
                            )}
                        </div>
                    </CaseCard>
                ) : null}

                {/* public / private tabs */}
                <div className="mt-9 grid grid-cols-2 border border-line bg-ink-2">
                    {([
                        {
                            key: 'public',
                            label: '공개 계정',
                            count: paginatedCountLabel(
                                femaleAccounts.length,
                                Boolean(data.femaleNextCursor)
                            ),
                        },
                        {
                            key: 'private',
                            label: '비공개 계정',
                            count: paginatedCountLabel(
                                privateAccounts.length,
                                Boolean(data.privateNextCursor)
                            ),
                        },
                    ] as const).map((t) => (
                        <button
                            key={t.key}
                            onClick={() => setTab(t.key)}
                            className={`flex items-center justify-center gap-1.5 px-4 py-3 text-[13px] font-bold tracking-tight transition-colors ${
                                tab === t.key ? 'bg-blood text-white' : 'text-fg-dim hover:bg-panel hover:text-fg'
                            }`}
                        >
                            {t.label}
                            <span className="num text-[12px] opacity-80">{t.count}</span>
                        </button>
                    ))}
                </div>

                {tab === 'public' ? (
                <section className="mt-5">
                    <Eyebrow>위협 등급 순위</Eyebrow>

                    {femaleAccounts.length === 0 ? (
                        <CaseCard className="mt-5 px-4 py-10 text-center">
                            <p className="text-[13px] text-fg-mute">판독된 여성 계정이 없습니다.</p>
                        </CaseCard>
                    ) : (
                        <div className="mt-5 space-y-2.5">
                            {femaleAccounts.map((account, i) => (
                                <CaseCard
                                    key={account.instagramId}
                                    bracket={BRACKET_BY_GRADE[account.riskGrade]}
                                    className="p-4"
                                >
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
                                            {account.recentMutualRank && (
                                                <div className="mt-2 flex flex-wrap items-center gap-2">
                                                    <RecentMutualBadge rank={account.recentMutualRank} />
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                    {account.oneLineOverview && (
                                        <p className="mt-3 border-t border-line pt-3 text-[12px] leading-relaxed text-fg-dim">
                                            {account.oneLineOverview}
                                        </p>
                                    )}
                                    {account.riskGrade === 'high_risk' && account.riskAnalysis.length > 0 && (
                                        <DeepRiskAnalysis lines={account.riskAnalysis} className="mt-3" />
                                    )}
                                    <div className="mt-3 flex items-center gap-3">
                                        <ThreatBar grade={account.riskGrade} className="flex-1" />
                                        {account.displayScore !== undefined && (
                                            <span className="num shrink-0 text-[12px] font-bold text-fg">
                                                {account.displayScore.toFixed(1)}/10
                                            </span>
                                        )}
                                        <InstaLink url={account.instagramUrl} />
                                    </div>
                                </CaseCard>
                            ))}
                        </div>
                    )}
                    {data.pipelineVersion === 'v2' && data.femaleNextCursor && (
                        <div className="mt-4">
                            <button
                                type="button"
                                onClick={() => handleLoadMore('public')}
                                disabled={loadMoreKind !== null}
                                className="w-full border border-line-2 px-4 py-3 text-[13px] font-bold text-fg transition-colors hover:bg-panel disabled:text-fg-mute"
                            >
                                {loadMoreKind === 'public'
                                    ? '불러오는 중…'
                                    : loadMoreError === 'public'
                                        ? '공개 계정 다시 불러오기'
                                        : '공개 계정 더 보기'}
                            </button>
                            {loadMoreError === 'public' && (
                                <p className="mt-2 text-center text-[11px] text-blood" role="alert">
                                    다음 공개 계정을 불러오지 못했습니다. 다시 시도해 주세요.
                                </p>
                            )}
                        </div>
                    )}
                </section>
                ) : (
                <section className="mt-5">
                    <Eyebrow>숨은 위험인물들</Eyebrow>

                    {privateAccounts.length === 0 ? (
                        <CaseCard className="mt-5 px-4 py-10 text-center">
                            <p className="text-[13px] text-fg-mute">비공개 계정이 없습니다.</p>
                        </CaseCard>
                    ) : (
                        <div className="mt-5 space-y-2.5">
                            {privateAccounts.map((account) => (
                                <div
                                    key={account.instagramId}
                                    className="flex items-start gap-3 border border-line bg-ink-2/60 p-3.5"
                                >
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
                    {data.pipelineVersion === 'v2' && data.privateNextCursor && (
                        <div className="mt-4">
                            <button
                                type="button"
                                onClick={() => handleLoadMore('private')}
                                disabled={loadMoreKind !== null}
                                className="w-full border border-line-2 px-4 py-3 text-[13px] font-bold text-fg transition-colors hover:bg-panel disabled:text-fg-mute"
                            >
                                {loadMoreKind === 'private'
                                    ? '불러오는 중…'
                                    : loadMoreError === 'private'
                                        ? '비공개 계정 다시 불러오기'
                                        : '비공개 계정 더 보기'}
                            </button>
                            {loadMoreError === 'private' && (
                                <p className="mt-2 text-center text-[11px] text-blood" role="alert">
                                    다음 비공개 계정을 불러오지 못했습니다. 다시 시도해 주세요.
                                </p>
                            )}
                        </div>
                    )}
                    <p className="mt-3 text-[11px] text-fg-mute">
                        비공개 계정은 이름 텍스트의 여성형 가능성 순이며, 이 추정은 틀릴 수 있어요.
                    </p>
                </section>
                )}

                {/* share */}
                {data.pipelineVersion === 'v1' && <div className="mt-9">
                    <PrimaryButton onClick={handleShare} disabled={shareLoading}>
                        {shareLoading ? (
                            <>
                                <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                                공유 링크 생성 중…
                            </>
                        ) : (
                            '리포트 공유하기'
                        )}
                    </PrimaryButton>
                </div>}

                <p className="mt-5 text-center text-[11px] text-fg-mute">
                    AI 판독 결과는 100% 정확하지 않으며, 참고용으로만 사용해 주세요.
                </p>
            </main>
        </div>
    );
}
