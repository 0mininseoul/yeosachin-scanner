import type { Metadata } from 'next';
import { CherryBar } from '@/components/cherry/shell';
import { CHERRY_CONSENTS } from '@/lib/services/cherry/contracts';

export const metadata: Metadata = {
    title: '체리 구독 해지 및 환불 안내',
    alternates: { canonical: '/cherry/refund' },
};

export default function CherryRefundPage() {
    const paymentDetails = CHERRY_CONSENTS.find(consent => consent.id === 'price')?.detail;

    return (
        <main className="ch-column">
            <CherryBar />
            <h1 className="ch-title">체리 구독 해지 및 환불 안내</h1>
            <ul className="list-disc space-y-2 pl-5">
                {paymentDetails?.map(detail => <li key={detail}>{detail}</li>)}
            </ul>
        </main>
    );
}
