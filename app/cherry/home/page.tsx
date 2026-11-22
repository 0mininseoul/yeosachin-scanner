import { CherryHomeView, type CherryHomeRefund } from '@/components/cherry/home-view';
import { CherryBar } from '@/components/cherry/shell';
import { CherrySignIn } from '@/components/cherry/sign-in';
import { loadMemberOverview } from '@/lib/services/cherry/member';
import { assertNoDatabaseError, cherryRpc } from '@/lib/services/cherry/rpc';
import { cherryUser } from '@/lib/services/cherry/session';
import { loadMemberSubscription } from '@/lib/services/cherry/store';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

async function loadRefund(subscriptionId: string): Promise<CherryHomeRefund | null> {
    const { data, error } = await supabaseAdmin.from('cherry_refunds').select('amount_krw, status').eq('subscription_id', subscriptionId)
        .order('requested_at', { ascending: false }).limit(1);
    assertNoDatabaseError('home_refund', error);
    return data?.[0] ? { amountKrw: data[0].amount_krw, status: data[0].status } : null;
}

async function loadHome(userId: string) {
    const subscription = await loadMemberSubscription(userId);
    const [overview, refund, renewalPriceKrw] = subscription ? await Promise.all([
        loadMemberOverview(subscription), loadRefund(subscription.id), cherryRpc<number>('cherry_renewal_price', { p_subscription: subscription.id }),
    ]) : [null, null, 0];
    return { subscription, overview, refund, renewalPriceKrw, nowMs: Date.now() };
}

export default async function CherryHomePage({ searchParams }: { searchParams: Promise<{ pay?: string | string[] }> }) {
    const user = await cherryUser();
    if (!user) {
        return <main className="ch-column">
            <CherryBar />
            <CherrySignIn title="내 서비스" lead="등록할 때 쓴 카카오 계정으로 로그인해 주세요." redirectTo="/cherry/home" />
        </main>;
    }
    const query = await searchParams;
    const home = await loadHome(user.id);
    return <main className="ch-column">
        <CherryBar />
        <CherryHomeView {...home} pay={typeof query.pay === 'string' ? query.pay : null} />
    </main>;
}
