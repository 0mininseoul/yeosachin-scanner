'use client';

import { useCallback, useEffect, useRef, useState, use } from 'react';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import { CircleHelp, Mars, Venus } from 'lucide-react';
import type { AnalysisResultPageV1 } from '@/lib/contracts/analysis-v2';
import { trackEvent, EVENTS } from '@/lib/services/analytics';
import { shareResult } from '@/lib/services/result-share';
import {
    kakaoJavascriptKey,
    readyKakao,
    shareResultToKakao,
    shareToKakaoNow,
    type ResultShareContent,
} from '@/lib/services/kakao-share';
import { CANONICAL_APP_ORIGIN } from '@/lib/constants/app-url';
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
    countHighRiskBands,
    countHighRiskGrades,
    v2ResultFailureAction,
    type OwnerProgressStatus,
} from '@/lib/services/analysis/owner-view-presentation';
import {
    TopBar,
    Eyebrow,
    CaseCard,
    InstaButton,
    InstagramGlyph,
    PrimaryButton,
    ProfileFallback,
} from '@/components/case-ui';
import { SuspectRow } from '@/components/suspect-row';
import { ResultActions } from '@/components/result-actions';
import { ResultFeedback } from '@/components/result-feedback';
import { ResultPagination } from '@/components/result-pagination';
import { ProfilePreviewDialog, type InternalProfilePreview } from '@/components/profile-preview-dialog';
import { HighRiskSummary } from '@/components/high-risk-summary';
import { safeResultImageUrl } from '@/lib/services/result-local-image';

interface PageProps {
    params: Promise<{ requestId: string }>;
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
    const proxiedSrc = safeResultImageUrl(src);

    if (!proxiedSrc || error) {
        return <ProfileFallback variant={variant} />;
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
    instagramUrl?: string;
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
    instagramUrl?: string;
    bio?: string;
}

interface ResultData {
    requestId: string;
    status: string;
    pipelineVersion: 'v1' | 'v2';
    summary: {
        targetInstagramId: string;
        targetFullName?: string;
        targetProfileImage?: string;
        mutualFollows: number;
        analyzedMutuals: number;
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

function GenderRatioBreakdown({ gr }: { gr: GenderRatio }) {
    return (
        <>
            <div className="reveal-wipe flex h-1.5 w-full overflow-hidden bg-line" style={{ animationDelay: '900ms' }}>
                <div className="h-full bg-fg-dim" style={{ width: `${gr.male.percentage}%` }} />
                <div className="h-full bg-blood" style={{ width: `${gr.female.percentage}%` }} />
                <div className="h-full bg-line-2" style={{ width: `${gr.unknown.percentage}%` }} />
            </div>

            {/* Three columns pinned to the bar's own edges, not to the segments.
                Centring each label under its slice only works while every slice
                is wide enough to hold one: at 6% 미상 the label ran far past its
                segment and sat over 여자, so position was actively lying. The bar
                carries the proportion; these are counts, and they stay inside the
                bar's width where the eye expects to find them. */}
            <div className="reveal mt-2 flex w-full items-baseline justify-between gap-2" style={{ animationDelay: '1120ms' }}>
                {[
                    { label: OWNER_GENDER_LABELS.male, c: gr.male, Icon: Mars, txt: 'text-fg', align: 'justify-start' },
                    { label: OWNER_GENDER_LABELS.female, c: gr.female, Icon: Venus, txt: 'text-blood-2', align: 'justify-center' },
                    { label: OWNER_GENDER_LABELS.unknown, c: gr.unknown, Icon: CircleHelp, txt: 'text-fg-dim', align: 'justify-end' },
                ].map((row) => (
                    <div key={row.label} className={`flex min-w-0 flex-1 ${row.align}`}>
                        <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
                            <row.Icon aria-hidden="true"
                                className={`h-3 w-3 shrink-0 self-center ${row.txt}`}
                                strokeWidth={2.25}
                            />
                            <span className="text-[11px] text-fg-dim">{row.label}</span>
                            <span className={`num text-[13px] font-extrabold leading-tight ${row.txt}`}>
                                {row.c.count}
                            </span>
                        </span>
                    </div>
                ))}
            </div>
        </>
    );
}

export function mapV2Result(result: AnalysisResultPageV1, externalProfileLinks = true): ResultData {
    // genderStats is an additive summary field; tolerate results produced before
    // the backend contract ships it and fall back to hiding the gender breakdown.
    const genderStats = (result.summary as {
        genderStats?: { male: number; female: number; unknown: number };
    }).genderStats;
    // targetFullName is likewise additive: the headline falls back to the handle
    // until the backend contract carries the Instagram display name.
    const targetFullName = (result.summary as { targetFullName?: string | null }).targetFullName;
    return {
        requestId: result.requestId,
        status: 'completed',
        pipelineVersion: 'v2',
        summary: {
            targetInstagramId: result.summary.targetInstagramId,
            targetFullName: targetFullName || undefined,
            targetProfileImage: result.summary.targetProfileImage || undefined,
            mutualFollows: result.summary.detectedMutuals,
            analyzedMutuals: result.summary.detectedMutuals,
            genderRatio: genderStats ? genderBreakdownFromStats(genderStats) : null,
            v2: {
                followers: result.summary.followers,
                following: result.summary.following,
                publicMutuals: result.summary.publicMutuals,
                privateMutuals: result.summary.privateMutuals,
                screenedMutuals: result.summary.screenedMutuals,
                highRiskCount: countHighRiskBands(result.femaleAccounts),
            },
        },
        femaleAccounts: boundedOwnerResultPage(result.femaleAccounts).map(account => ({
            instagramId: account.instagramId,
            fullName: account.fullName || undefined,
            profileImage: account.profileImage || undefined,
            instagramUrl: externalProfileLinks ? `https://instagram.com/${account.instagramId}` : undefined,
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
            instagramUrl: externalProfileLinks ? `https://instagram.com/${account.instagramId}` : undefined,
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
    const [kakaoShareLoading, setKakaoShareLoading] = useState(false);
    // In-flight token mint, and its result once resolved, so the tap handler can
    // read the destination without awaiting anything.
    const sharePrepRef = useRef<Promise<Omit<ResultShareContent, 'title'>> | null>(null);
    const sharePreparedRef = useRef<Omit<ResultShareContent, 'title'> | null>(null);
    // Mirrors the ref so the menu can hold the Kakao item back until the link
    // exists. The ref stays the source of truth for the tap itself.
    const [shareTarget, setShareTarget] = useState<Omit<ResultShareContent, 'title'> | null>(null);
    const [deleting, setDeleting] = useState(false);
    const [pageAction, setPageAction] = useState<ResultPageAction | null>(null);
    const [pageError, setPageError] = useState<ResultPageAction | null>(null);
    const [pageNavigation, setPageNavigation] = useState(initialResultPageNavigation);
    const [resultRetry, setResultRetry] = useState(0);
    const [tab, setTab] = useState<'public' | 'private'>('public');
    const publicSectionRef = useRef<HTMLElement>(null);
    const privateSectionRef = useRef<HTMLElement>(null);
    const resultViewTrackedRef = useRef(false);
    const [externalProfileLinks, setExternalProfileLinks] = useState(true);
    const [profilePreview, setProfilePreview] = useState<InternalProfilePreview | null>(null);
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
                setExternalProfileLinks(response.headers.get('x-external-profile-links') !== 'disabled');

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
                    setExternalProfileLinks(response.headers.get('x-external-profile-links') !== 'disabled');
                }

                const responseAnalyticsEligible = response.headers.get('x-analytics-eligible') !== '0';
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
                    ? mapV2Result(result as AnalysisResultPageV1, response.headers.get('x-external-profile-links') !== 'disabled')
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
                if (responseAnalyticsEligible && !resultViewTrackedRef.current) {
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
            const linksAllowed = response.headers.get('x-external-profile-links') !== 'disabled';
            setExternalProfileLinks(linksAllowed);
            const next = mapV2Result(await response.json() as AnalysisResultPageV1, linksAllowed);
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

    /* Mints the share token and warms the Kakao SDK ahead of the tap.
     *
     * Kakao opens a popup, and Safari only permits that inside the task that
     * handled the tap — awaiting a network round trip first loses the gesture and
     * the popup is blocked, which is what pushed iOS onto the OS share sheet. So
     * everything slow happens when the menu opens, one interaction earlier. */
    /* Minting the link costs four sequential Supabase round trips, so doing it
       on intent meant the menu opened on "준비 중" and only settled a moment
       later. It runs once the report is on screen instead: by the time anyone
       reaches the menu it has long since finished, and the Kakao item is live
       from the first frame.
       The trade is that opening a report now enables its share link, so a
       revoke followed by a revisit re-mints one. Nothing exposes revoke today,
       and a re-mint issues a *new* token, so an old link stays dead either way. */
    const prepareShare = useCallback(() => {
        if (sharePrepRef.current) return sharePrepRef.current;
        sharePrepRef.current = (async () => {
            // The SDK download and the token round trip are independent, so they
            // run together rather than one after the other.
            const [, link] = await Promise.all([
                readyKakao(),
                (async () => {
                    try {
                        const response = await fetch('/api/share/enable', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ requestId }),
                        });
                        const payload = await response.json();
                        if (response.ok && payload?.success && typeof payload.shareUrl === 'string') {
                            return {
                                url: payload.shareUrl as string,
                                // Kakao ignores the page's OG tags, so the per-result
                                // card has to be handed over explicitly.
                                imageUrl: typeof payload.shareToken === 'string'
                                    ? `${CANONICAL_APP_ORIGIN}/api/share/${payload.shareToken}/opengraph-image`
                                    : `${CANONICAL_APP_ORIGIN}/og.png`,
                            };
                        }
                    } catch {
                        // fall through to the service link
                    }
                    sharePrepRef.current = null; // let a later attempt retry
                    return { url: CANONICAL_APP_ORIGIN, imageUrl: `${CANONICAL_APP_ORIGIN}/og.png` };
                })(),
            ]);
            sharePreparedRef.current = link;
            setShareTarget(link);
            return link;
        })();
        return sharePrepRef.current;
    }, [requestId]);

    // Only once the report exists: a link to a result that failed to load would
    // be worse than a moment of latency.
    useEffect(() => {
        if (!data || data.status !== 'completed') return;
        void prepareShare();
    }, [data, prepareShare]);

    const handleKakaoShare = async () => {
        if (kakaoShareLoading) return;

        const target = sharePreparedRef.current;
        let kakaoError = '';
        // The card repeats the headline the OG image already carries, and states
        // the scope of the reading underneath. Nothing about what was found —
        // that is what the recipient opens the link for.
        const card = {
            title: `${summary.targetFullName ?? summary.targetInstagramId}님의 위장 여사친 판독 결과`,
            description: '지금 바로 확인해보세요!',
        };
        // Everything was resolved before the tap, so the send stays inside the
        // tap's own task — which is the only way Kakao's sheet is allowed to open.
        if (target && shareToKakaoNow(
            { ...target, ...card },
            reason => { kakaoError = reason; },
        )) {
            trackEvent(EVENTS.RESULT_SHARED, { request_id: requestId, share_channel: 'kakao' });
            return;
        }

        /* Past this point the gesture is spent, so Kakao can no longer open. The
           async path below ends at the OS share sheet, which is the wrong answer
           for a button that says 카카오톡 — it is only correct when Kakao was
           never on the table (no key configured), where the button reads 공유. */
        if (kakaoJavascriptKey() !== null) {
            const link = target?.url ?? (await prepareShare()).url;
            const copied = await navigator.clipboard?.writeText(link).then(() => true, () => false);
            const detail = kakaoError ? `\n(${kakaoError})` : '';
            alert((copied
                ? '카카오톡 공유를 열지 못해 링크를 복사했습니다.'
                : '카카오톡 공유를 열지 못했습니다. 잠시 후 다시 시도해 주세요.') + detail);
            if (copied) {
                trackEvent(EVENTS.RESULT_SHARED, { request_id: requestId, share_channel: 'clipboard' });
            }
            return;
        }

        setKakaoShareLoading(true);
        try {
            const resolved = target ?? await prepareShare();
            const channel = await shareResultToKakao(
                { ...resolved, ...card },
                {
                    ...(navigator.share
                        ? { share: (payload: { title: string; text: string; url: string }) => navigator.share(payload) }
                        : {}),
                    ...(navigator.clipboard?.writeText
                        ? { writeText: (text: string) => navigator.clipboard.writeText(text) }
                        : {}),
                },
            );
            if (!channel) {
                alert('공유하기에 실패했습니다.');
                return;
            }
            trackEvent(EVENTS.RESULT_SHARED, { request_id: requestId, share_channel: channel });
            if (channel === 'clipboard') alert('링크가 클립보드에 복사되었습니다!');
        } finally {
            setKakaoShareLoading(false);
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
                    <p data-amp-mask className="mt-3 text-[13px] leading-relaxed text-fg-dim" role="alert">
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
        ?? countHighRiskGrades(femaleAccounts);

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

            <main className="mx-auto max-w-[480px] px-5 pt-7">
                {/* case header */}
                {/* The share control belongs to the report, not to the app chrome:
                    in the top bar it read as a site-level menu item rather than
                    "share this result". */}
                <div className="flex items-center justify-between gap-3">
                    <Eyebrow className="shrink-0">판독 리포트</Eyebrow>
                    <ResultActions
                        onKakaoShare={handleKakaoShare}
                        onPrepare={prepareShare}
                        kakaoBusy={kakaoShareLoading}
                        kakaoAvailable={kakaoJavascriptKey() !== null}
                        copyUrl={CANONICAL_APP_ORIGIN}
                        shareUrl={shareTarget?.url ?? null}
                    />
                </div>
                {/* pipeline-specific summary */}
                {summary.v2 && counts ? (
                    <>
                        {/* The reveal is scoped to the verdict block so the sweep's
                            overflow clipping never reaches the actions menu above. */}
                        <div className="relative overflow-hidden">
                        <span
                            aria-hidden="true"
                            className="reveal-sweep pointer-events-none absolute inset-x-0 z-10 h-16"
                            style={{
                                background:
                                    'linear-gradient(180deg, transparent, rgb(var(--glow-rgb) / 0.16), transparent)',
                            }}
                        />

                        {/* Profile lockup: the page needs a subject before it states
                            a number, and the handle confirms which account that
                            display name belongs to. */}
                        <div data-amp-block className="reveal mt-5 flex items-start gap-3" style={{ animationDelay: '80ms' }}>
                            <div className="relative h-11 w-11 shrink-0 overflow-hidden border border-line-2 bg-panel">
                                <ProfileImage src={summary.targetProfileImage} variant="person" />
                            </div>
                            <div className="min-w-0">
                                <h1 className="text-[23px] font-extrabold leading-snug tracking-tight text-fg">
                                    <span className="break-all">
                                        {summary.targetFullName ?? summary.targetInstagramId}
                                    </span>
                                    님의 위장 여사친
                                </h1>
                                {/* The handle already names the account, so it
                                    carries the link rather than a separate button
                                    competing with the headline beside it. */}
                                <a
                                    href={`https://instagram.com/${summary.targetInstagramId}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="mt-1 inline-flex max-w-full items-center gap-1.5 text-fg-dim transition-colors hover:text-fg"
                                >
                                    <InstagramGlyph className="h-3.5 w-3.5 shrink-0" />
                                    <span className="num truncate text-[12px]">
                                        @{summary.targetInstagramId}
                                    </span>
                                </a>
                            </div>
                        </div>

                        {/* The verdict. It used to sit outside the summary card in
                            13px grey while secondary counts held the frame. Crimson
                            means danger, so a clean result must not wear it — zero
                            high-risk accounts is the best outcome, not the loudest. */}
                        <HighRiskSummary
                            count={highCount}
                            context={<>맞팔 <span className="num">{counts.mutual.toLocaleString()}</span>명 중 모든 공개 계정들을 판독했습니다.</>}
                        />
                        </div>

                        <div className="mt-6 border-t border-line pt-5">
                            {gr && (
                                <>
                                    <div className="flex items-baseline justify-between gap-3">
                                        <span className="label-ko">공개 계정 판독 분포</span>
                                        <span className="num text-[10.5px] text-fg-dim">
                                            {counts.publicCount.toLocaleString()}명
                                        </span>
                                    </div>
                                    <div className="mt-2.5">
                                        <GenderRatioBreakdown gr={gr} />
                                    </div>
                                </>
                            )}

                        </div>
                    </>
                ) : gr ? (
                    <>
                    <h1 className="mt-3 text-[24px] font-extrabold tracking-tight text-fg">판독 결과</h1>
                    <HighRiskSummary
                        count={highCount}
                        context={<>맞팔 <span className="num">{summary.analyzedMutuals.toLocaleString()}</span>명 중 모든 공개 계정들을 판독했습니다.</>}
                    />
                    <div className="mt-6 border-t border-line pt-5">
                        <div className="flex items-baseline justify-between gap-3">
                            <span className="label-ko">맞팔 계정 성별 분석</span>
                            <span className="num text-[10.5px] text-fg-dim">맞팔 {summary.analyzedMutuals}명</span>
                        </div>
                        <div className="mt-2.5">
                            <GenderRatioBreakdown gr={gr} />
                        </div>
                    </div>
                    </>
                ) : null}

                {/* public / private tabs */}
                <div className="mt-9 grid grid-cols-2 border border-line bg-ink-2">
                    {([
                        {
                            key: 'public',
                            // The list below holds female-classified accounts only, so the
                            // tab must not count every public mutual — that overstated it
                            // by roughly 3x. This number now matches the female slice of
                            // the distribution bar above.
                            label: '공개 계정(여성)',
                            count: (gr ? gr.female.count : femaleAccounts.length).toLocaleString(),
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
                        <div className="mt-5">
                            {femaleAccounts.map((account, i) => (
                                <div data-amp-block key={account.instagramId}>
                                    <SuspectRow
                                        account={account}
                                        rank={
                                            pageNavigation.public.pageIndex
                                            * OWNER_RESULT_PAGE_SIZE
                                            + i
                                            + 1
                                        }
                                        avatar={<ProfileImage src={account.profileImage} variant="person" />}
                                        externalProfileLinks={externalProfileLinks}
                                        onPreview={!externalProfileLinks ? () => setProfilePreview({
                                            instagramId: account.instagramId,
                                            fullName: account.fullName,
                                            profileImage: account.profileImage,
                                            bio: account.bio,
                                            overview: account.oneLineOverview,
                                        }) : undefined}
                                    />
                                </div>
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
                        <div className="mt-5">
                            {privateAccounts.map((account) => (
                                <div
                                    data-amp-block
                                    key={account.instagramId}
                                    className="flex items-center gap-3.5 border-b border-line py-3.5"
                                >
                                    <div className="relative h-10 w-10 shrink-0 overflow-hidden border border-line bg-panel">
                                        <ProfileImage src={account.profileImage} variant="private" />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        {account.instagramUrl ? <a
                                            href={account.instagramUrl}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="block truncate text-[14px] font-bold text-fg transition-colors hover:text-blood"
                                        >
                                            @{account.instagramId}
                                        </a> : <span className="block truncate text-[14px] font-bold text-fg">@{account.instagramId}</span>}
                                        {(account.fullName || account.bio) && (
                                            <p className="mt-0.5 truncate text-[12px] text-fg-dim">
                                                {account.fullName && <span>{account.fullName}</span>}
                                                {account.fullName && account.bio && ' · '}
                                                {account.bio}
                                            </p>
                                        )}
                                    </div>
                                    {account.instagramUrl && externalProfileLinks && (
                                        <InstaButton url={account.instagramUrl} />
                                    )}
                                    {!account.instagramUrl && !externalProfileLinks && (
                                        <button
                                            type="button"
                                            onClick={() => setProfilePreview({
                                                instagramId: account.instagramId,
                                                fullName: account.fullName,
                                                profileImage: account.profileImage,
                                                bio: account.bio,
                                            })}
                                            className="shrink-0 border border-line px-3 py-2 text-[11px] font-bold text-fg transition-colors hover:border-fg-dim"
                                        >
                                            프로필 보기
                                        </button>
                                    )}
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
                </section>
                )}

                {profilePreview && (
                    <ProfilePreviewDialog
                        profile={profilePreview}
                        onClose={() => setProfilePreview(null)}
                        avatar={<ProfileImage src={profilePreview.profileImage} variant="person" />}
                    />
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

                <ResultFeedback requestId={requestId} />

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
