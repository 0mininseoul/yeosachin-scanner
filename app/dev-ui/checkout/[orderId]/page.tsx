import { notFound } from 'next/navigation';
import { AuthButtons } from '@/components/auth-buttons';
import { createClient } from '@/lib/supabase/server';
import { classifyOperatorAuthError } from '@/lib/services/analysis/score-audit';
import { isDevUiDeploymentContext } from '@/lib/constants/dev-ui';
import { assertDevUiDeployment } from '@/lib/services/dev-ui/deployment';
import { assertDevUiTester } from '@/lib/services/dev-ui/access';
import { DevUiCheckout } from './checkout';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Dev 모의 결제', robots: { index: false, follow: false } };

export default async function DevUiCheckoutPage({ params }: { params: Promise<{ orderId: string }> }) {
    if (!isDevUiDeploymentContext()) notFound();
    try { assertDevUiDeployment(); } catch { notFound(); }
    const { orderId } = await params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId)) notFound();
    let user: { id: string } | null = null;
    try {
        const supabase = await createClient();
        const auth = await supabase.auth.getUser();
        if (auth.error && classifyOperatorAuthError(auth.error) !== 'unauthorized') throw new Error('DEV_UI_AUTH_UNAVAILABLE');
        if (!auth.error) user = auth.data.user;
    } catch {
        return <main className="mx-auto max-w-[500px] p-6"><p role="alert">테스트 인증 서비스를 잠시 후 다시 확인해주세요.</p></main>;
    }
    if (!user) return <main className="mx-auto max-w-[500px] p-6">
        <h1 className="mb-5 text-[24px] font-extrabold">모의 결제 로그인</h1>
        <p className="mb-5 text-[13px] text-fg-dim">카카오 로그인 후 이 테스트 주문으로 돌아옵니다.</p>
        <AuthButtons redirectTo={`/dev-ui/checkout/${orderId.toLowerCase()}`} />
    </main>;
    try { assertDevUiTester(user.id); }
    catch { return <main className="mx-auto max-w-[500px] p-6"><p role="alert">등록된 테스트 계정만 모의 결제를 이용할 수 있습니다.</p></main>; }
    return <DevUiCheckout orderId={orderId.toLowerCase()} />;
}
