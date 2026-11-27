import type { Metadata } from 'next';
import Image from 'next/image';
import { cookies } from 'next/headers';
import { isPgReviewSession, pgReviewCredential, PG_REVIEW_COOKIE } from '@/app/login/pg-review/account';
import { signOutFromCherryReview } from '@/app/login/pg-review/actions';
import { TossReviewButton } from '@/app/login/pg-review/toss-review-button';
import { EmailLogin } from '@/components/email-login';
import { CHERRY_PUBLIC_URL, CHERRY_REVIEW_CHECKOUT_URL } from '@/lib/constants/cherry-public-url';
import { CANONICAL_APP_ORIGIN } from '@/lib/constants/app-url';
import { CHERRY_LIST_PRICE_KRW } from '@/lib/services/cherry/contracts';
import { NOINDEX_METADATA } from '@/lib/services/seo/discovery';
import '../cherry/cherry.css';
import './checkout.css';

export const metadata: Metadata = {
    ...NOINDEX_METADATA,
    title: '월간 구독 · 체리',
    alternates: { canonical: CHERRY_REVIEW_CHECKOUT_URL },
    referrer: 'same-origin',
    openGraph: null,
    twitter: null,
    manifest: null,
    icons: { icon: '/cherry/logo.png' },
};

export default async function CherryReviewCheckout({ searchParams }: {
    searchParams: Promise<{ result?: string | string[] }>;
}) {
    const credential = pgReviewCredential();
    const cookieStore = await cookies();
    const signedIn = credential !== null && isPgReviewSession(cookieStore.get(PG_REVIEW_COOKIE)?.value, credential.sessionKey);
    const { result } = await searchParams;
    const clientKey = signedIn ? process.env.PG_REVIEW_TOSS_BILLING_CLIENT_KEY?.trim() : null;

    return (
        <div className="ch-app ch-checkout">
            <header className="ch-bar ch-checkout-bar">
                <a href={CHERRY_PUBLIC_URL} className="ch-brand">
                    <Image src="/cherry/logo.png" alt="" width={30} height={30} unoptimized />
                    체리
                </a>
                {signedIn && (
                    <form action={signOutFromCherryReview}>
                        <button type="submit" className="ch-bar-link">로그아웃</button>
                    </form>
                )}
            </header>
            <main className="ch-column ch-checkout-main">
                {signedIn ? (
                    <>
                        <h1 className="ch-checkout-title">체리 구독</h1>
                        <section aria-labelledby="ch-plan-title" className="ch-checkout-card">
                            <div className="ch-checkout-plan">
                                <h2 id="ch-plan-title">월간 플랜</h2>
                                <div className="ch-checkout-price">
                                    <strong>{CHERRY_LIST_PRICE_KRW.toLocaleString('ko-KR')}</strong><span>원 / 월</span>
                                </div>
                                <p>등록한 인스타그램 계정의 새 맞팔을 알려드려요.</p>
                            </div>

                            <ul className="ch-checkout-features">
                                <li>인스타그램 계정 1개 등록</li>
                                <li>새 맞팔이 확인되면 카카오톡 등으로 알림</li>
                                <li>새 맞팔 계정은 리포트에서 확인</li>
                            </ul>

                            <div className="ch-checkout-actions">
                                <p className="ch-checkout-renewal">매월 자동 갱신 · 언제든 해지 가능</p>
                                {result === 'authorized' && <p className="ch-note" role="status">토스 테스트 인증 화면에서 돌아왔어요.</p>}
                                {result === 'failed' && <p className="ch-note" role="status">카드 인증을 완료하지 않았어요. 다시 시도할 수 있어요.</p>}
                                <TossReviewButton product="cherry" clientKey={clientKey?.startsWith('test_ck_') ? clientKey : null} />
                                <p className="ch-checkout-sandbox">PG 심사용 테스트 결제 · 실제 금액은 청구되지 않아요.</p>
                            </div>
                        </section>
                        <a className="ch-checkout-terms" href={`${CANONICAL_APP_ORIGIN}/cherry/refund`}>구독 해지 및 환불 안내</a>
                    </>
                ) : (
                    <>
                        <h1 className="ch-checkout-title">체리 구독 확인</h1>
                        <section className="ch-checkout-card ch-checkout-login" aria-label="PG 심사 로그인">
                            <p className="ch-note">PG 심사 계정으로 로그인해 주세요.</p>
                            {credential
                                ? <EmailLogin product="cherry" initiallyExpanded />
                                : <p className="ch-note">현재 심사 로그인을 이용할 수 없어요.</p>}
                        </section>
                    </>
                )}
            </main>
        </div>
    );
}
