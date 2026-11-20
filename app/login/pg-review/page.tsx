import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { CaseCard, PrimaryButton, TopBar } from '@/components/case-ui';
import { NOINDEX_METADATA } from '@/lib/services/seo/discovery';
import { isPgReviewSession, pgReviewCredential, PG_REVIEW_COOKIE } from './account';
import { signInForPgReview, signOutFromPgReview } from './actions';
import { PurchasePreview } from './purchase-preview';

export const metadata: Metadata = {
    ...NOINDEX_METADATA,
    title: 'PG 심사 · AI 위장 여사친 판독기',
};

const inputClass = 'mt-1.5 min-h-11 w-full border border-line bg-ink px-3 text-sm text-fg';

export default async function PgReviewPage({ searchParams }: {
    searchParams: Promise<{ error?: string | string[] }>;
}) {
    const credential = pgReviewCredential();
    if (!credential) notFound();

    const cookieStore = await cookies();
    const signedIn = isPgReviewSession(cookieStore.get(PG_REVIEW_COOKIE)?.value, credential.sessionKey);
    const showError = (await searchParams).error === '1';

    return (
        <>
            <TopBar right={signedIn && (
                <form action={signOutFromPgReview}>
                    <button type="submit" className="text-sm text-fg-dim">로그아웃</button>
                </form>
            )} />
            <main className="mx-auto max-w-[500px] px-5 pb-16 pt-10">
                <h1 className="text-[26px] font-extrabold text-fg">
                    {signedIn ? '서비스 구매 화면' : 'PG 심사 계정 로그인'}
                </h1>
                {signedIn ? <PurchasePreview /> : (
                    <CaseCard className="mt-6 p-5">
                        <form action={signInForPgReview} className="space-y-4">
                            <label className="block text-sm text-fg">
                                아이디 (이메일)
                                <input name="email" type="email" autoComplete="username" maxLength={254}
                                    required className={inputClass} />
                            </label>
                            <label className="block text-sm text-fg">
                                비밀번호
                                <input name="password" type="password" autoComplete="current-password"
                                    maxLength={256} required className={inputClass} />
                            </label>
                            {showError && (
                                <p role="alert" className="text-sm text-blood">
                                    아이디와 비밀번호를 확인해 주세요.
                                </p>
                            )}
                            <PrimaryButton type="submit">로그인</PrimaryButton>
                        </form>
                    </CaseCard>
                )}
            </main>
        </>
    );
}
