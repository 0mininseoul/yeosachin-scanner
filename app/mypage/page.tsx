import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { TopBar, Eyebrow } from '@/components/case-ui';
import { LogoutButton } from '@/components/logout-button';
import { ownerAnalysisHistoryV1Schema } from '@/lib/services/analysis/owner-history';
import { buildArchiveEntries } from '@/lib/services/analysis/archive-entries';
import AnalysisList from './analysis-list';
import { isDemoOperator } from '@/lib/services/demo-analysis/demo-analysis';
import { demoAnalysisStore } from '@/lib/services/demo-analysis/store';
import { demoArchiveItems } from '@/lib/services/demo-analysis/archive';
import { NOINDEX_METADATA } from '@/lib/services/seo/discovery';
import {
    loadAccountPrincipal,
    requireActiveAccountSession,
} from '@/lib/services/identity/account-principal-store';
import {
    delayNoticeEnabledFromEnv,
    hasPendingDelivery,
    shouldShowArchiveDelayNotice,
} from '@/lib/services/analysis/archive-delay-notice';
import { ArchiveDelayNotice } from '@/components/archive-delay-notice';
import {
    type AwaitingEarlybirdDelivery,
    listAwaitingEarlybirdDeliveries,
} from '@/lib/services/earlybird/awaiting-delivery';
import { AccountDeletionPanel } from './account-deletion-panel';

export const metadata: Metadata = {
    ...NOINDEX_METADATA,
    title: '보관함 - 위장여사친 판독기',
};

export default async function MyPage() {
    const supabase = await createClient();

    // 1. 사용자 인증 확인
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
        redirect('/login');
    }

    let accountClassification;
    try {
        accountClassification = await requireActiveAccountSession(user);
    } catch {
        redirect('/login?error=account_unavailable');
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
    const productionAnalyses = parsedHistory.success ? parsedHistory.data.items : [];
    const demoAnalyses = isDemoOperator(user.id)
        ? demoArchiveItems(await demoAnalysisStore.listForOwner(user.id), new Date())
        : [];
    const analyses = [...demoAnalyses, ...productionAnalyses].sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? ''));

    // earlybird_orders is looked up separately from analysis_requests: right after
    // payment only the order row exists, and fulfillment creates the analysis row
    // later. A lookup failure here must not break the archive for a paying user.
    let awaitingDeliveries: readonly AwaitingEarlybirdDelivery[] = [];
    try {
        awaitingDeliveries = await listAwaitingEarlybirdDeliveries(user.id);
    } catch (error) {
        console.error('Error fetching awaiting earlybird deliveries:', error);
    }
    const entries = buildArchiveEntries(analyses, awaitingDeliveries);

    // is_paid_user is not part of the classification returned above, so the
    // paid state is read from the service-owned principal rather than trusted
    // from the browser. A lookup failure only costs the delay notice.
    let isPaidUser = false;
    try {
        isPaidUser = (await loadAccountPrincipal(user.id))?.is_paid_user ?? false;
    } catch (error) {
        console.error('Error fetching account principal for delay notice:', error);
    }

    const showDelayNotice = shouldShowArchiveDelayNotice({
        enabled: delayNoticeEnabledFromEnv(process.env.ARCHIVE_DELAY_NOTICE_ENABLED),
        accountClass: accountClassification.accountClass,
        trafficClass: accountClassification.trafficClass,
        isPaidUser,
        hasPendingDelivery: hasPendingDelivery(entries),
    });

    return (
        <div className="min-h-dvh">
            <TopBar
                right={
                    <>
                        <span data-amp-mask className="hidden max-w-[140px] truncate text-[12px] text-fg-mute sm:inline">
                            {user.email}
                        </span>
                        <LogoutButton />
                    </>
                }
            />

            <main className="mx-auto max-w-[480px] px-5 pt-7">
                <Eyebrow>판독 기록</Eyebrow>
                <h1 className="mt-3 text-[26px] font-extrabold tracking-tight text-fg">보관함</h1>
                <p className="mt-2 text-[13px] text-fg-dim">지난 판독 기록을 확인하고 관리하세요.</p>

                <div className="mt-8">
                    <AnalysisList initialEntries={entries} />
                </div>

                {accountClassification.accountClass === 'production'
                    && accountClassification.trafficClass === 'external'
                    && <AccountDeletionPanel />}
            </main>

            {showDelayNotice && <ArchiveDelayNotice />}
        </div>
    );
}
