import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { EmailLogin } from '@/components/email-login';
import { CaseCard, TopBar } from '@/components/case-ui';
import { CHERRY_REVIEW_CHECKOUT_URL } from '@/lib/constants/cherry-public-url';
import { NOINDEX_METADATA } from '@/lib/services/seo/discovery';
import { isPgReviewSession, pgReviewCredential, PG_REVIEW_COOKIE } from './account';
import { signOutFromPgReview } from './actions';
import { PurchasePreview } from './purchase-preview';

export const metadata: Metadata = {
    ...NOINDEX_METADATA,
    title: '토스페이먼츠 결제 심사 · 어센텀',
    referrer: 'no-referrer',
};

// Toss Payments' public sample key for one-time checkout.
const DOCS_PAYMENT_CLIENT_KEY = 'test_gck_docs_Ovk5rk1EwkEbP0W43n07xlzm';

export default async function PgReviewPage({ searchParams }: {
    searchParams: Promise<{ product?: string | string[]; result?: string | string[] }>;
}) {
    const { product, result } = await searchParams;
    if (product === 'cherry') redirect(CHERRY_REVIEW_CHECKOUT_URL);
    const credential = pgReviewCredential();
    const cookieStore = await cookies();
    if (!credential || !isPgReviewSession(cookieStore.get(PG_REVIEW_COOKIE)?.value, credential.sessionKey)) {
        return (
            <>
                <TopBar />
                <main className="mx-auto max-w-[500px] px-5 pb-16 pt-10">
                    <h1 className="text-[26px] font-extrabold text-fg">위장여사친 판독기 결제 심사</h1>
                    <CaseCard className="mt-5 p-5">
                        {credential
                            ? <EmailLogin initiallyExpanded />
                            : <p className="text-sm text-fg-dim">현재 심사 로그인을 사용할 수 없습니다.</p>}
                    </CaseCard>
                </main>
            </>
        );
    }
    const paymentKey = process.env.PG_REVIEW_TOSS_PAYMENT_CLIENT_KEY?.trim() || DOCS_PAYMENT_CLIENT_KEY;

    return (
        <>
            <TopBar right={
                <form action={signOutFromPgReview}>
                    <button type="submit" className="text-sm text-fg-dim">로그아웃</button>
                </form>
            } />
            <main className="mx-auto max-w-[500px] px-5 pb-16 pt-10">
                <h1 className="text-[26px] font-extrabold text-fg">위장여사친 판독기</h1>
                <p className="mt-2 text-sm text-fg-dim">PG 심사용 테스트 화면입니다. 실제 청구는 발생하지 않습니다.</p>
                {result === 'authorized' && (
                    <p role="status" className="mt-4 text-sm text-fg">토스 테스트 인증 화면에서 돌아왔습니다.</p>
                )}
                {result === 'failed' && (
                    <p role="status" className="mt-4 text-sm text-fg">토스 테스트 창에서 인증을 완료하지 않았습니다.</p>
                )}
                <PurchasePreview clientKey={paymentKey.startsWith('test_gck_') ? paymentKey : null} />
            </main>
        </>
    );
}
