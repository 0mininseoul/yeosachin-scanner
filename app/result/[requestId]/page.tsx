'use client';

import { useEffect, useRef, useState, use } from 'react';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import { CircleHelp, Mars, Venus } from 'lucide-react';
import type { AnalysisResultPageV1 } from '@/lib/contracts/analysis-v2';
import { trackEvent, EVENTS } from '@/lib/services/analytics';
import { shareResult } from '@/lib/services/result-share';
import {
    availablePendingTargetStorage,
    clearPendingAnalysisTargetForTerminalState,
    signOutAndClearPendingAnalysisTarget,
} from '@/lib/services/pending-analysis-target';
import {
    boundedOwnerResultPage,
    genderBreakdownFromStats,
    OWNER_GENDER_LABELS,
    OWNER_RESULT_PAGE_SIZE,
    resolveResultPageCursor,
    resultPaginationModel,
    resultSummaryCounts,
    roundedOwnerScore,
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
import { ResultPagination } from '@/components/result-pagination';

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
            followers: AnalysisResultPageV1['summary']['followers'];
            following: AnalysisResultPageV1['summary']['following'];
            publicMutuals: number;
            privateMutuals: number;
            screenedMutuals: number;
            highRiskCount: number;
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

type ResultAccountKind = 'public' | 'private';

interface ResultPageAction {
    kind: ResultAccountKind;
    targetPageIndex: number;
}

interface ResultPageNavigation {
    pageIndex: number;
    // cursors[i] is the fetch cursor for page i (cursors[0] is always null).
    cursors: Array<string | null>;
    // fetch cursor for the page just past the furthest visited page, or null.
    frontierNextCursor: string | null;
}

type ResultPageNavigationState = Record<ResultAccountKind, ResultPageNavigation>;

function initialResultPageNavigation(
    femaleNextCursor?: string | null,
    privateNextCursor?: string | null,
): ResultPageNavigationState {
    return {
        public: { pageIndex: 0, cursors: [null], frontierNextCursor: femaleNextCursor ?? null },
        private: { pageIndex: 0, cursors: [null], frontierNextCursor: privateNextCursor ?? null },
    };
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

function GenderRatioBreakdown({ gr }: { gr: GenderRatio }) {
    return (
        <>
            <div className="flex h-2.5 w-full overflow-hidden bg-line">
                <div className="h-full bg-fg-dim" style={{ width: `${gr.male.percentage}%` }} />
                <div className="h-full bg-blood" style={{ width: `${gr.female.percentage}%` }} />
                <div className="h-full bg-line-2" style={{ width: `${gr.unknown.percentage}%` }} />
            </div>

            <div className="mt-3 grid grid-cols-3 gap-3">
                {[
                    { label: OWNER_GENDER_LABELS.male, c: gr.male, Icon: Mars, txt: 'text-fg' },
                    { label: OWNER_GENDER_LABELS.female, c: gr.female, Icon: Venus, txt: 'text-blood' },
                    { label: OWNER_GENDER_LABELS.unknown, c: gr.unknown, Icon: CircleHelp, txt: 'text-fg-dim' },
                ].map((row) => (
                    <div key={row.label} className="border-l border-line pl-3">
                        <div className="flex items-center gap-1.5">
                            <row.Icon aria-hidden="true" className={`h-3.5 w-3.5 ${row.txt}`} strokeWidth={2.25} />
                            <span className="text-[12px] text-fg-dim">{row.label}</span>
                        </div>
                        <div className={`num mt-0.5 text-[16px] font-extrabold ${row.txt}`}>{row.c.count}</div>
                        <div className="num text-[11px] text-fg-mute">{row.c.percentage}%</div>
                    </div>
                ))}
            </div>
        </>
    );
}

function mapV2Result(result: AnalysisResultPageV1): ResultData {
    // genderStats is an additive summary field; tolerate results produced before
    // the backend contract ships it and fall back to hiding the gender breakdown.
    const genderStats = (result.summary as {
        genderStats?: { male: number; female: number; unknown: number };
    }).genderStats;
    return {
        requestId: result.requestId,
        status: 'completed',
        pipelineVersion: 'v2',
        summary: {
            targetInstagramId: result.summary.targetInstagramId,
            targetProfileImage: result.summary.targetProfileImage || undefined,
            mutualFollows: result.summary.detectedMutuals,
            genderRatio: genderStats ? genderBreakdownFromStats(genderStats) : null,
            v2: {
                followers: result.summary.followers,
                following: result.summary.following,
                publicMutuals: result.summary.publicMutuals,
                privateMutuals: result.summary.privateMutuals,
                screenedMutuals: result.summary.screenedMutuals,
                highRiskCount: result.femaleAccounts.filter(
                    account => account.riskBand === 'high_risk'
                ).length,
            },
        },
        femaleAccounts: boundedOwnerResultPage(result.femaleAccounts).map(account => ({
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
        privateAccounts: boundedOwnerResultPage(result.privateAccounts).map(account => ({
            instagramId: account.instagramId,
            fullName: account.fullName || undefined,
            profileImage: account.profileImage || undefined,
            instagramUrl: `https://instagram.com/${account.instagramId}`,
        })),
        femaleNextCursor: result.femaleNextCursor,
        privateNextCursor: result.privateNextCursor,
    };
}

export default function ResultPage({ params }: PageProps) {
    const { requestId } = use(params);
    const [data, setData] = useState<ResultData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [shareLoading, setShareLoading] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [pageAction, setPageAction] = useState<ResultPageAction | null>(null);
    const [pageError, setPageError] = useState<ResultPageAction | null>(null);
    const [pageNavigation, setPageNavigation] = useState(initialResultPageNavigation);
    const [resultRetry, setResultRetry] = useState(0);
    const [tab, setTab] = useState<'public' | 'private'>('public');
    const publicSectionRef = useRef<HTMLElement>(null);
    const privateSectionRef = useRef<HTMLElement>(null);
    const resultViewTrackedRef = useRef(false);
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
                setPageNavigation(initialResultPageNavigation(
                    displayResult.femaleNextCursor,
                    displayResult.privateNextCursor,
                ));
                setPageAction(null);
                setPageError(null);
                setError(null);
                const storage = availablePendingTargetStorage();
                if (storage) clearPendingAnalysisTargetForTerminalState(storage, 'completed');
                if (!resultViewTrackedRef.current) {
                    resultViewTrackedRef.current = true;
                    trackEvent(EVENTS.RESULT_VIEWED, {
                        request_id: requestId,
                        result_count: displayResult.femaleAccounts.length + displayResult.privateAccounts.length,
                        is_shared: false,
                    });
                }
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

    const goToResultPage = async (
        kind: ResultAccountKind,
        targetPageIndex: number
    ) => {
        if (!data || data.pipelineVersion !== 'v2' || pageAction) return;
        const navigation = pageNavigation[kind];
        if (targetPageIndex === navigation.pageIndex) return;

        // Only land on a page whose cursor we already hold (a visited page or the
        // single frontier page); never guess a cursor for a far page.
        const resolution = resolveResultPageCursor(
            { cursors: navigation.cursors, frontierNextCursor: navigation.frontierNextCursor },
            targetPageIndex,
        );
        if (resolution.kind === 'unreachable') return;
        const cursor = resolution.cursor;

        const action = { kind, targetPageIndex } as const;
        setPageAction(action);
        setPageError(null);
        try {
            const cursorName = kind === 'public' ? 'femaleCursor' : 'privateCursor';
            const query = new URLSearchParams({ pageSize: String(OWNER_RESULT_PAGE_SIZE) });
            if (cursor) query.set(cursorName, cursor);
            const response = await fetch(
                `/api/analysis/v2/result/${requestId}?${query.toString()}`,
                { cache: 'no-store' }
            );
            if (!response.ok) throw new Error(`V2 result page failed (${response.status}).`);
            const next = mapV2Result(await response.json() as AnalysisResultPageV1);
            const nextCursor = kind === 'public'
                ? next.femaleNextCursor ?? null
                : next.privateNextCursor ?? null;
            setData(current => current && current.pipelineVersion === 'v2'
                ? {
                    ...current,
                    femaleAccounts: kind === 'public'
                        ? next.femaleAccounts
                        : current.femaleAccounts,
                    privateAccounts: kind === 'private'
                        ? next.privateAccounts
                        : current.privateAccounts,
                    femaleNextCursor: kind === 'public'
                        ? next.femaleNextCursor
                        : current.femaleNextCursor,
                    privateNextCursor: kind === 'private'
                        ? next.privateNextCursor
                        : current.privateNextCursor,
                }
                : current);
            setPageNavigation(current => {
                const nav = current[kind];
                if (resolution.kind === 'frontier') {
                    // Extend the visited set by exactly one page and advance the frontier.
                    return {
                        ...current,
                        [kind]: {
                            pageIndex: targetPageIndex,
                            cursors: [...nav.cursors, resolution.cursor],
                            frontierNextCursor: nextCursor,
                        },
                    };
                }
                // Revisiting a known page: cursors/frontier already reflect the
                // furthest progress, so only the current page moves.
                return { ...current, [kind]: { ...nav, pageIndex: targetPageIndex } };
            });
            window.requestAnimationFrame(() => {
                const section = kind === 'public'
                    ? publicSectionRef.current
                    : privateSectionRef.current;
                section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        } catch (err) {
            console.error('Failed to load a V2 result page:', err);
            setPageError(action);
        } finally {
            setPageAction(null);
        }
    };

    const handleShare = async () => {
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

            const shareChannel = await shareResult({
                ...(navigator.share
                    ? { share: (payload) => navigator.share(payload) }
                    : {}),
                ...(navigator.clipboard?.writeText
                    ? { writeText: (text) => navigator.clipboard.writeText(text) }
                    : {}),
            }, shareData);
            if (shareChannel) {
                trackEvent(EVENTS.RESULT_SHARED, {
                    request_id: requestId,
                    share_channel: shareChannel,
                });
                if (shareChannel === 'clipboard') {
                    alert('공유 링크가 클립보드에 복사되었습니다!');
                }
                return;
            }
            throw new Error('공유하기에 실패했습니다.');
        } catch (err) {
            console.error('Share error:', err);
            alert('공유하기에 실패했습니다.');
        } finally {
            setShareLoading(false);
        }
    };

    const handleDelete = async () => {
        if (!confirm('정말 이 판독 기록을 삭제하시겠습니까? 복구할 수 없습니다.')) return;
        setDeleting(true);
        try {
            const response = await fetch(`/api/analysis/result/${requestId}`, { method: 'DELETE' });
            if (!response.ok) {
                alert('삭제에 실패했습니다.');
                console.error('Analysis deletion request failed', { status: response.status });
                setDeleting(false);
                return;
            }
            router.push('/mypage');
        } catch (err) {
            console.error(err);
            alert('오류가 발생했습니다.');
            setDeleting(false);
        }
    };

    const handleLogout = async () => {
        try {
            const signedOut = await signOutAndClearPendingAnalysisTarget(
                availablePendingTargetStorage(),
            );
            if (signedOut) router.push('/');
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
    const counts = summary.v2
        ? resultSummaryCounts({
            detectedMutuals: summary.mutualFollows,
            publicMutuals: summary.v2.publicMutuals,
            privateMutuals: summary.v2.privateMutuals,
            screenedMutuals: summary.v2.screenedMutuals,
        })
        : null;
    const highCount = summary.v2?.highRiskCount
        ?? femaleAccounts.filter((a) => a.riskGrade === 'high_risk').length;

    return (
        <div className="min-h-dvh pb-16">
            <TopBar
                right={
                    <>
                        <button
                            onClick={() => router.push('/mypage')}
                            className="text-[13px] font-medium text-fg-dim transition-colors hover:text-fg"
                        >
                            보관함
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

            <main data-amp-block className="mx-auto max-w-[480px] px-5 pt-7">
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
                {summary.v2 && counts ? (
                    <CaseCard className="mt-6 p-4">
                        <span className="eyebrow">맞팔 계정 분석</span>
                        <div className="num mt-2.5 flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-[13px]">
                            <span className="text-fg-dim">맞팔</span>
                            <span className="font-bold text-fg">{counts.mutual.toLocaleString()}</span>
                            <span className="px-1 text-fg-mute">·</span>
                            <span className="text-fg-dim">공개</span>
                            <span className="font-bold text-fg">{counts.publicCount.toLocaleString()}</span>
                            <span className="px-1 text-fg-mute">·</span>
                            <span className="text-fg-dim">비공개</span>
                            <span className="font-bold text-fg">{counts.privateCount.toLocaleString()}</span>
                        </div>

                        {gr && (
                            <div className="mt-3.5 border-t border-line pt-3.5">
                                <div className="flex items-center justify-between">
                                    <span className="text-[12px] font-semibold text-fg-dim">공개 계정 판독 분포</span>
                                    <span className="num text-[11px] text-fg-mute">판독 {counts.screened.toLocaleString()}명</span>
                                </div>
                                <div className="mt-2.5">
                                    <GenderRatioBreakdown gr={gr} />
                                </div>
                            </div>
                        )}

                        <div className={`grid grid-cols-2 gap-px bg-line ${gr ? 'mt-3.5' : 'mt-3'}`}>
                            {[
                                { label: '팔로워', value: summary.v2.followers.declared },
                                { label: '팔로잉', value: summary.v2.following.declared },
                            ].map((item) => (
                                <div key={item.label} className="bg-ink-2 px-3 py-2.5">
                                    <span className="text-[11px] text-fg-mute">{item.label}</span>
                                    <p className="num mt-0.5 text-[16px] font-bold text-fg">
                                        {item.value.toLocaleString()}
                                    </p>
                                </div>
                            ))}
                        </div>
                    </CaseCard>
                ) : gr ? (
                    <CaseCard className="mt-6 p-5">
                        <div className="mb-4 flex items-center justify-between">
                            <span className="eyebrow">맞팔 계정 성별 분석</span>
                            <span className="num text-[12px] text-fg-dim">맞팔 {summary.mutualFollows}명</span>
                        </div>

                        <GenderRatioBreakdown gr={gr} />
                    </CaseCard>
                ) : null}

                {/* public / private tabs */}
                <div className="mt-9 grid grid-cols-2 border border-line bg-ink-2">
                    {([
                        {
                            key: 'public',
                            label: '공개 계정',
                            count: summary.v2
                                ? summary.v2.publicMutuals.toLocaleString()
                                : String(femaleAccounts.length),
                        },
                        {
                            key: 'private',
                            label: '비공개 계정',
                            count: summary.v2
                                ? summary.v2.privateMutuals.toLocaleString()
                                : String(privateAccounts.length),
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
                <section ref={publicSectionRef} className="mt-5 scroll-mt-20">
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
                                                    #{String(
                                                        pageNavigation.public.pageIndex
                                                        * OWNER_RESULT_PAGE_SIZE
                                                        + i
                                                        + 1
                                                    ).padStart(2, '0')}
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
                                        <ThreatBar
                                            grade={account.riskGrade}
                                            score={account.displayScore}
                                            className="flex-1"
                                        />
                                        {account.displayScore !== undefined && (
                                            <span className="num shrink-0 text-[12px] font-bold text-fg">
                                                {roundedOwnerScore(account.displayScore)}/10
                                            </span>
                                        )}
                                        <InstaLink url={account.instagramUrl} />
                                    </div>
                                </CaseCard>
                            ))}
                        </div>
                    )}
                    {data.pipelineVersion === 'v2' && (
                        <ResultPagination
                            view={resultPaginationModel({
                                pageIndex: pageNavigation.public.pageIndex,
                                knownPageCount: pageNavigation.public.cursors.length,
                                hasFrontier: pageNavigation.public.frontierNextCursor !== null,
                            })}
                            busy={pageAction?.kind === 'public'}
                            failed={pageError?.kind === 'public'}
                            label="공개 계정"
                            onGoto={(pageIndex) => goToResultPage('public', pageIndex)}
                        />
                    )}
                </section>
                ) : (
                <section ref={privateSectionRef} className="mt-5 scroll-mt-20">
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
                    {data.pipelineVersion === 'v2' && (
                        <ResultPagination
                            view={resultPaginationModel({
                                pageIndex: pageNavigation.private.pageIndex,
                                knownPageCount: pageNavigation.private.cursors.length,
                                hasFrontier: pageNavigation.private.frontierNextCursor !== null,
                            })}
                            busy={pageAction?.kind === 'private'}
                            failed={pageError?.kind === 'private'}
                            label="비공개 계정"
                            onGoto={(pageIndex) => goToResultPage('private', pageIndex)}
                        />
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

                <div className="mt-8 border-t border-line pt-6 text-center">
                    <button
                        type="button"
                        onClick={handleDelete}
                        disabled={deleting}
                        className="inline-flex items-center gap-1.5 text-[12px] font-medium text-fg-mute transition-colors hover:text-blood disabled:opacity-50"
                    >
                        {deleting ? (
                            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                        ) : (
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-[15px] w-[15px]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                        )}
                        {deleting ? '삭제 중…' : '이 판독 기록 삭제'}
                    </button>
                </div>
            </main>
        </div>
    );
}
