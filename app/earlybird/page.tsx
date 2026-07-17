import Link from 'next/link';
import { redirect } from 'next/navigation';
import { TopBar, CaseCard, Eyebrow } from '@/components/case-ui';
import { createClient } from '@/lib/supabase/server';
import { loadLatestEarlybirdOrder } from '@/lib/services/earlybird/order-status';
import { EarlybirdStatus } from './earlybird-status';

export const dynamic = 'force-dynamic';

export const metadata = {
    title: '얼리버드 사전 구매 현황 - AI 위장 여사친 판독기',
};

export default async function EarlybirdPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) redirect('/login?redirectTo=%2Fearlybird');

    const params = await searchParams;
    const requestedPlan = params.plan;
    const planId = requestedPlan === 'basic' || requestedPlan === 'standard'
        ? requestedPlan
        : undefined;

    let order = null;
    try {
        order = await loadLatestEarlybirdOrder(user.id, planId);
    } catch {
        order = null;
    }

    return (
        <div className="min-h-dvh">
            <TopBar />
            <main className="mx-auto max-w-[500px] px-5 pb-16 pt-10">
                {order ? (
                    <EarlybirdStatus order={order} />
                ) : (
                    <>
                        <Eyebrow>얼리버드 사전 구매 현황</Eyebrow>
                        <h1 className="mt-3 text-[26px] font-extrabold tracking-tight text-fg">
                            확인할 내역이 없습니다
                        </h1>
                        <CaseCard className="mt-8 p-5">
                            <p className="text-[13px] leading-relaxed text-fg-dim">
                                결제 직후라면 잠시 뒤 다시 확인해주세요.
                            </p>
                        </CaseCard>
                        <Link
                            href="/analyze"
                            className="mt-5 block text-center text-[13px] font-semibold text-blood"
                        >
                            사전 구매 페이지로 이동
                        </Link>
                    </>
                )}
            </main>
        </div>
    );
}
