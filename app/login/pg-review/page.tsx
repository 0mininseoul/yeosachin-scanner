import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { TopBar } from '@/components/case-ui';
import { NOINDEX_METADATA } from '@/lib/services/seo/discovery';
import { isPgReviewSession, pgReviewCredential, PG_REVIEW_COOKIE } from './account';
import { signOutFromPgReview } from './actions';
import { PurchasePreview } from './purchase-preview';

export const metadata: Metadata = {
    ...NOINDEX_METADATA,
    title: 'PG 심사 · AI 위장 여사친 판독기',
};

export default async function PgReviewPage() {
    const credential = pgReviewCredential();
    const cookieStore = await cookies();
    if (!credential || !isPgReviewSession(cookieStore.get(PG_REVIEW_COOKIE)?.value, credential.sessionKey)) {
        redirect('/login');
    }

    return (
        <>
            <TopBar right={
                <form action={signOutFromPgReview}>
                    <button type="submit" className="text-sm text-fg-dim">로그아웃</button>
                </form>
            } />
            <main className="mx-auto max-w-[500px] px-5 pb-16 pt-10">
                <h1 className="text-[26px] font-extrabold text-fg">서비스 구매 화면</h1>
                <PurchasePreview />
            </main>
        </>
    );
}
