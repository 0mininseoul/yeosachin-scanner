import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { EmailLogin } from '@/components/email-login';
import { CaseCard, TopBar } from '@/components/case-ui';
import { CHERRY_CONSENTS, CHERRY_LIST_PRICE_KRW } from '@/lib/services/cherry/contracts';
import { NOINDEX_METADATA } from '@/lib/services/seo/discovery';
import { isPgReviewSession, pgReviewCredential, PG_REVIEW_COOKIE } from './account';
import { signOutFromPgReview } from './actions';
import { PurchasePreview } from './purchase-preview';
import { TossReviewButton } from './toss-review-button';

export const metadata: Metadata = {
    ...NOINDEX_METADATA,
    title: '토스페이먼츠 결제 심사 · 어센텀',
    referrer: 'no-referrer',
};

// Toss Payments' public sample key for one-time checkout.
const DOCS_PAYMENT_CLIENT_KEY = 'test_gck_docs_Ovk5rk1EwkEbP0W43n07xlzm';
const cherryPaymentTerms = CHERRY_CONSENTS.find(consent => consent.id === 'price')?.detail;

export default async function PgReviewPage({ searchParams }: {
    searchParams: Promise<{ product?: string | string[]; result?: string | string[] }>;
}) {
    const { product, result } = await searchParams;
    const isCherry = product === 'cherry';
    const serviceName = isCherry ? '체리 · 맞팔 알리미' : '위장여사친 판독기';
    const credential = pgReviewCredential();
    const cookieStore = await cookies();
    if (!credential || !isPgReviewSession(cookieStore.get(PG_REVIEW_COOKIE)?.value, credential.sessionKey)) {
        return (
            <>
                <TopBar />
                <main className="mx-auto max-w-[500px] px-5 pb-16 pt-10">
                    <h1 className="text-[26px] font-extrabold text-fg">{serviceName} 결제 심사</h1>
                    <CaseCard className="mt-5 p-5">
                        {credential
                            ? <EmailLogin product={isCherry ? 'cherry' : 'analyzer'} initiallyExpanded />
                            : <p className="text-sm text-fg-dim">현재 심사 로그인을 사용할 수 없습니다.</p>}
                    </CaseCard>
                </main>
            </>
        );
    }
    const paymentKey = process.env.PG_REVIEW_TOSS_PAYMENT_CLIENT_KEY?.trim() || DOCS_PAYMENT_CLIENT_KEY;
    const billingKey = process.env.PG_REVIEW_TOSS_BILLING_CLIENT_KEY?.trim();

    return (
        <>
            <TopBar right={
                <form action={signOutFromPgReview}>
                    <button type="submit" className="text-sm text-fg-dim">로그아웃</button>
                </form>
            } />
            <main className="mx-auto max-w-[500px] px-5 pb-16 pt-10">
                <nav aria-label="심사 상품" className="mb-5 flex flex-wrap gap-x-4 gap-y-2 text-sm text-fg-dim">
                    <Link className="underline" href="/login/pg-review" aria-current={!isCherry ? 'page' : undefined}>
                        위장여사친 판독기 단건결제
                    </Link>
                    <Link className="underline" href="/login/pg-review?product=cherry" aria-current={isCherry ? 'page' : undefined}>
                        체리 자동결제
                    </Link>
                </nav>
                <h1 className="text-[26px] font-extrabold text-fg">
                    {serviceName}
                </h1>
                <p className="mt-2 text-sm text-fg-dim">PG 심사용 테스트 화면입니다. 실제 청구는 발생하지 않습니다.</p>
                {result === 'authorized' && (
                    <p role="status" className="mt-4 text-sm text-fg">토스 테스트 인증 화면에서 돌아왔습니다.</p>
                )}
                {result === 'failed' && (
                    <p role="status" className="mt-4 text-sm text-fg">토스 테스트 창에서 인증을 완료하지 않았습니다.</p>
                )}
                {isCherry ? (
                    <>
                        <CaseCard className="mt-5 p-5">
                            <h2 className="font-bold text-fg">체리 월간 구독</h2>
                            <p className="mt-2 text-sm text-fg-dim">등록한 인스타그램 계정의 새 맞팔을 확인해 알림으로 알려주는 서비스입니다.</p>
                            <p className="mt-4 text-sm font-bold text-fg">월 {CHERRY_LIST_PRICE_KRW.toLocaleString('ko-KR')}원 · 매월 자동 갱신</p>
                            <ul className="mt-2 list-disc space-y-1 pl-4 text-xs leading-relaxed text-fg-dim">
                                {cherryPaymentTerms?.map(term => <li key={term}>{term}</li>)}
                            </ul>
                            <TossReviewButton product="cherry" clientKey={billingKey?.startsWith('test_ck_') ? billingKey : null} />
                        </CaseCard>
                        <div className="mt-6 flex gap-4 text-xs text-fg-dim">
                            <Link className="underline" href="/cherry">체리 서비스 소개</Link>
                            <Link className="underline" href="/cherry/refund">구독 해지 및 환불 안내</Link>
                        </div>
                    </>
                ) : <PurchasePreview clientKey={paymentKey.startsWith('test_gck_') ? paymentKey : null} />}
            </main>
        </>
    );
}
