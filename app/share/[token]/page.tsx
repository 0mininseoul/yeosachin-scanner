'use client';

import { useEffect, useRef, useState, use } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { trackEvent, EVENTS } from '@/lib/services/analytics';
import {
    genderBreakdownFromStats,
    OWNER_GENDER_LABELS,
} from '@/lib/services/analysis/owner-view-presentation';
import {
    TopBar,
    Eyebrow,
    CaseCard,
    MaskedAvatar,
    MaskedHandle,
    ProfileFallback,
    primaryCls,
} from '@/components/case-ui';
import { SuspectRow } from '@/components/suspect-row';
import type { V2SharedResultPage } from '@/lib/services/share/v2-result-share';

interface PageProps {
    params: Promise<{ token: string }>;
}

/* v2 results sign their images to /api/share/<token>/image, which is the route
   built to serve a share viewer who is not logged in. Only /api/image-proxy was
   accepted here, so every v2 avatar failed this check and fell back to the grey
   placeholder — the whole page looked like it had no photos at all. */
const SHARE_IMAGE_PATH = /^\/api\/share\/[0-9a-f]{64}\/image\?/;

const getProxyImageUrl = (url: string | undefined): string | undefined => {
    if (!url) return undefined;
    return url.startsWith('/api/image-proxy?') || SHARE_IMAGE_PATH.test(url)
        ? url
        : undefined;
};

/* The shared payload is its own shape, not the owner's with fields removed:
   handles arrive pre-truncated as `handleMasked`, names blanked as
   `fullNameMasked`, and identity is carried by an opaque `accountKey` that is
   only valid within this share token. Reusing the owner mapper here read
   `instagramId` off rows that no longer have one. */
function mapV2SharedResult(result: V2SharedResultPage): ResultData {
    const stats = result.summary.genderStats;
    return {
        requestId: result.requestId,
        status: 'completed',
        isShared: true,
        maskedByClient: false,
        summary: {
            targetInstagramId: result.summary.targetInstagramId,
            targetProfileImage: result.summary.targetProfileImage ?? undefined,
            mutualFollows: result.summary.detectedMutuals,
            genderRatio: stats
                ? genderBreakdownFromStats(stats)
                : {
                    male: { count: 0, percentage: 0 },
                    female: { count: 0, percentage: 0 },
                    unknown: { count: 0, percentage: 0 },
                },
        },
        femaleAccounts: result.femaleAccounts.map(account => ({
            accountKey: account.accountKey,
            instagramId: account.handleMasked,
            /* Name and bio are dropped rather than masked. A row of bullets is
               noise, and a bio names workplaces, schools and other handles —
               it identifies at least as readily as the name does. */
            profileImage: account.profileImage ?? undefined,
            instagramUrl: '',
            riskGrade: account.riskBand,
            bio: '',
            recentMutualRank: account.recentMutualRank !== null && account.recentMutualRank <= 5
                ? account.recentMutualRank as 1 | 2 | 3 | 4 | 5
                : undefined,
            riskAnalysis: account.highRiskNarrative ? [...account.highRiskNarrative] : [],
            oneLineOverview: account.oneLineOverview ?? undefined,
            displayScore: account.displayScore,
        })),
        privateAccounts: result.privateAccounts.map(account => ({
            accountKey: account.accountKey,
            instagramId: account.handleMasked,
            profileImage: account.profileImage ?? undefined,
            instagramUrl: '',
        })),
    };
}

/* Legacy v1 shares still arrive with real names and bios on them. The server
   cannot be fixed retroactively for those, so the view refuses to carry the
   fields at all rather than relying on a blur to hide them. */
function stripLegacyIdentityText(result: ResultData): ResultData {
    return {
        ...result,
        maskedByClient: true,
        femaleAccounts: result.femaleAccounts.map(account => ({
            ...account,
            fullName: undefined,
            bio: '',
        })),
        privateAccounts: result.privateAccounts.map(account => ({
            ...account,
            fullName: undefined,
            bio: undefined,
        })),
    };
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
    /** Stable within this share token only; never derived from the handle. */
    accountKey?: string;
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
    accountKey?: string;
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
    /* v2 arrives already masked by the server — handles truncated, names blanked,
       avatars downsampled — so blurring it again would only smear characters that
       are already bullets. Legacy v1 shares still carry the real values and have
       nothing but this page between them and the reader. */
    maskedByClient: boolean;
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

                // v2 shares carry their own masked shape; legacy v1 shares still
                // arrive as this view's DTO with real identities in it.
                const isV2 = result?.schemaVersion === 1
                    && result.summary
                    && 'detectedMutuals' in result.summary;
                const display: ResultData = isV2
                    ? mapV2SharedResult(result as V2SharedResultPage)
                    : stripLegacyIdentityText(result as ResultData);

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
                <p data-amp-mask className="mb-5 text-[14px] text-blood">{error}</p>
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
                <Eyebrow>판독 리포트 · 공유본</Eyebrow>

                {/* Profile lockup — mirrors the owner result page. */}
                <div data-amp-block className="mt-5 flex items-start gap-3">
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
                                <div data-amp-block key={account.accountKey ?? account.instagramId}>
                                    <SuspectRow
                                        account={account}
                                        rank={i + 1}
                                        avatar={
                                            <MaskedAvatar>
                                                <ProfileImage src={account.profileImage} variant="person" />
                                            </MaskedAvatar>
                                        }
                                        externalProfileLinks={false}
                                        maskHandle={data.maskedByClient}
                                    />
                                </div>
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
                                <div data-amp-block key={account.accountKey ?? account.instagramId} className="flex items-center gap-3.5 border-b border-line py-3.5">
                                    <div className="relative h-10 w-10 shrink-0 overflow-hidden border border-line bg-panel">
                                        <MaskedAvatar>
                                            <ProfileImage src={account.profileImage} variant="private" />
                                        </MaskedAvatar>
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        {/* Masked for the same reason as the public list. */}
                                        {data.maskedByClient ? (
                                            <MaskedHandle
                                                value={account.instagramId}
                                                className="text-[14px] font-bold text-fg/90"
                                            />
                                        ) : (
                                            <span className="block truncate text-[14px] font-bold text-fg/90">
                                                @{account.instagramId}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </section>
                )}

                {/* The reader of a shared report is at the end of the chain —
                    there is nothing here for them to pass on, so the only action
                    is the one that starts a reading of their own. */}
                <div className="mt-9">
                    <Link href="/" className={primaryCls}>
                        나도 판독해보기
                    </Link>
                </div>

                <p className="mt-5 text-center text-[11px] leading-relaxed text-fg-mute">
                    공유본에는 일부 계정만 표시되며, 계정 정보는 가려져 있어요.
                    <br />
                    AI 판독 결과는 100% 정확하지 않으며, 참고용으로만 사용해 주세요.
                </p>
            </main>
        </div>
    );
}
