'use client';

import { useEffect, useRef, useState, use } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { trackEvent, EVENTS } from '@/lib/services/analytics';
import { shareResult } from '@/lib/services/result-share';
import { OWNER_GENDER_LABELS } from '@/lib/services/analysis/owner-view-presentation';
import {
    TopBar,
    Eyebrow,
    CaseCard,
    ProfileFallback,
    ghostCls,
    primaryCls,
} from '@/components/case-ui';
import { SuspectRow } from '@/components/suspect-row';
import { mapV2Result } from '@/app/result/[requestId]/page';
import type { AnalysisResultPageV1 } from '@/lib/contracts/analysis-v2';

interface PageProps {
    params: Promise<{ token: string }>;
}

const getProxyImageUrl = (url: string | undefined): string | undefined => {
    if (!url) return undefined;
    return url.startsWith('/api/image-proxy?') ? url : undefined;
};

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
        return <ProfileFallback variant={variant} />;
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
    recentMutualRank?: 1 | 2 | 3 | 4 | 5;
    riskAnalysis: string[];
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
        targetProfileImage?: string;
        mutualFollows: number;
        genderRatio: GenderRatio;
    };
    femaleAccounts: FemaleAccount[];
    privateAccounts: PrivateAccount[];
}

export default function ShareResultPage({ params }: PageProps) {
    const { token } = use(params);
    const [data, setData] = useState<ResultData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [tab, setTab] = useState<'public' | 'private'>('public');
    const resultViewTrackedRef = useRef(false);

    useEffect(() => {
        const fetchResult = async () => {
            try {
                const response = await fetch(`/api/share/${token}`);
                const result = await response.json();

                if (!response.ok) {
                    throw new Error(result.error || '결과를 불러올 수 없습니다.');
                }

                // V2 shares return the owner result page shape plus isShared, so
                // the same mapper the result page uses turns it into this view's
                // DTO. Legacy v1 shares already arrive in that shape.
                const isV2 = result?.schemaVersion === 1
                    && result.summary
                    && 'detectedMutuals' in result.summary;
                const display: ResultData = isV2
                    ? (() => {
                        const mapped = mapV2Result(result as AnalysisResultPageV1, false);
                        return {
                            requestId: mapped.requestId,
                            status: mapped.status,
                            isShared: true,
                            summary: {
                                targetInstagramId: mapped.summary.targetInstagramId,
                                targetProfileImage: mapped.summary.targetProfileImage,
                                mutualFollows: mapped.summary.mutualFollows,
                                genderRatio: mapped.summary.genderRatio ?? {
                                    male: { count: 0, percentage: 0 },
                                    female: { count: 0, percentage: 0 },
                                    unknown: { count: 0, percentage: 0 },
                                },
                            },
                            femaleAccounts: mapped.femaleAccounts.map(account => ({
                                ...account,
                                instagramUrl: account.instagramUrl ?? '',
                                bio: account.bio,
                            })),
                            privateAccounts: mapped.privateAccounts.map(account => ({
                                ...account,
                                instagramUrl: account.instagramUrl ?? '',
                            })),
                        };
                    })()
                    : result;

                setData(display);
                if (!resultViewTrackedRef.current) {
                    resultViewTrackedRef.current = true;
                    trackEvent(EVENTS.RESULT_VIEWED, {
                        request_id: display.requestId,
                        result_count: display.femaleAccounts.length + display.privateAccounts.length,
                        is_shared: true,
                    });
                }
            } catch (err) {
                setError(err instanceof Error ? err.message : '결과를 불러오는데 실패했습니다.');
            } finally {
                setLoading(false);
            }
        };

        fetchResult();
    }, [token]);

    const handleShare = async () => {
        if (!data) return;
        const url = window.location.href;
        const shareData = {
            title: 'AI 위장 여사친 판독기 분석 결과',
            text: `${data?.summary.targetInstagramId}님의 인스타 분석 결과를 확인해보세요!`,
            url: url,
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
                request_id: data.requestId,
                share_channel: shareChannel,
            });
            if (shareChannel === 'clipboard') {
                alert('링크가 클립보드에 복사되었습니다!');
            }
        } else {
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

            <main data-amp-block className="mx-auto max-w-[480px] px-5 pt-8">
                <Eyebrow>판독 리포트 · 공유본</Eyebrow>

                {/* Profile lockup — mirrors the owner result page. */}
                <div className="mt-5 flex items-start gap-3">
                    <div className="relative h-11 w-11 shrink-0 overflow-hidden border border-line-2 bg-panel">
                        <ProfileImage src={summary.targetProfileImage} variant="person" />
                    </div>
                    <div className="min-w-0">
                        <h1 className="text-[23px] font-extrabold leading-snug tracking-tight text-fg">
                            <span className="break-all">{summary.targetInstagramId}</span>
                            님의 위장 여사친
                        </h1>
                        <p className="num mt-1 truncate text-[12px] text-fg-dim">
                            @{summary.targetInstagramId}
                        </p>
                    </div>
                </div>

                {/* verdict — mirrors the owner result page hierarchy */}
                <div className={`mt-5 border-l-2 pl-4 ${highCount > 0 ? 'border-blood' : 'border-jade'}`}>
                    <div
                        className={`num text-[56px] font-extrabold leading-[0.85] tracking-[-0.045em] ${
                            highCount > 0 ? 'text-blood-2' : 'text-jade'
                        }`}
                    >
                        {highCount}
                    </div>
                    <p className="mt-3 text-[17px] font-extrabold tracking-tight text-fg">고위험 계정</p>
                    <p className="mt-1 text-[12.5px] text-fg-dim">
                        맞팔 <span className="num">{summary.mutualFollows.toLocaleString()}</span>명을 판독한 결과입니다.
                    </p>
                </div>

                {/* gender breakdown */}
                <div className="mt-6 border-t border-line pt-5">
                    <div className="flex items-baseline justify-between gap-3">
                        <span className="label-ko">맞팔 계정 성별 분석</span>
                        <span className="num text-[10.5px] text-fg-dim">
                            맞팔 {summary.mutualFollows.toLocaleString()}명
                        </span>
                    </div>
                    <div className="mt-2.5 flex h-1.5 w-full overflow-hidden bg-line">
                        <div className="h-full bg-fg-dim" style={{ width: `${gr.male.percentage}%` }} />
                        <div className="h-full bg-blood" style={{ width: `${gr.female.percentage}%` }} />
                        <div className="h-full bg-line-2" style={{ width: `${gr.unknown.percentage}%` }} />
                    </div>
                    {/* Centred under its own bar segment, so position carries the
                        proportion — same axis treatment as the owner result page. */}
                    <div className="mt-2 flex w-full">
                        {[
                            { label: OWNER_GENDER_LABELS.male, c: gr.male, dot: 'bg-fg-dim', txt: 'text-fg' },
                            { label: OWNER_GENDER_LABELS.female, c: gr.female, dot: 'bg-blood', txt: 'text-blood-2' },
                            { label: OWNER_GENDER_LABELS.unknown, c: gr.unknown, dot: 'bg-line-2', txt: 'text-fg-dim' },
                        ].map((row) => (
                            <div
                                key={row.label}
                                className="flex min-w-0 justify-center"
                                style={{ width: `${row.c.percentage}%` }}
                            >
                                <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
                                    <span className={`h-1.5 w-1.5 self-center ${row.dot}`} aria-hidden="true" />
                                    <span className="text-[11px] text-fg-dim">{row.label}</span>
                                    <span className={`num text-[13px] font-extrabold leading-tight ${row.txt}`}>
                                        {row.c.count}
                                    </span>
                                </span>
                            </div>
                        ))}
                    </div>
                </div>

                {/* public / private tabs */}
                <div className="mt-9 grid grid-cols-2 border border-line bg-ink-2">
                    {([
                        { key: 'public', label: '공개 계정(여성)', count: femaleAccounts.length },
                        { key: 'private', label: '비공개 계정', count: privateAccounts.length },
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
                        <div className="mt-5">
                            {femaleAccounts.map((account, i) => (
                                /* Anyone holding the link can open this page, and the
                                   accounts listed here never agreed to appear on it,
                                   so their handles are masked. */
                                <SuspectRow
                                    key={account.instagramId}
                                    account={account}
                                    rank={i + 1}
                                    avatar={<ProfileImage src={account.profileImage} variant="person" />}
                                    externalProfileLinks={false}
                                    maskHandle
                                />
                            ))}
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
                        <div className="mt-5">
                            {privateAccounts.map((account) => (
                                <div key={account.instagramId} className="flex items-center gap-3.5 border-b border-line py-3.5">
                                    <div className="relative h-10 w-10 shrink-0 overflow-hidden border border-line bg-panel">
                                        <ProfileImage src={account.profileImage} variant="private" />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        {/* Masked for the same reason as the public list. */}
                                        <span
                                            aria-hidden="true"
                                            className="block select-none truncate text-[14px] font-bold text-fg/90 blur-[5px]"
                                        >
                                            @{account.instagramId}
                                        </span>
                                        {(account.fullName || account.bio) && (
                                            <p className="mt-0.5 truncate text-[12px] text-fg-dim">
                                                {account.fullName && <span>{account.fullName}</span>}
                                                {account.fullName && account.bio && ' · '}
                                                {account.bio}
                                            </p>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                    <p className="mt-3 text-[11px] text-fg-mute">비공개 계정은 이름 텍스트의 여성형 가능성 순이며, 이 추정은 틀릴 수 있어요.</p>
                </section>
                )}

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
