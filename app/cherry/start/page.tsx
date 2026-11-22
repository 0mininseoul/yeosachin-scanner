import { z } from 'zod';
import { CherryBar } from '@/components/cherry/shell';
import { CherryStartFlow } from '@/components/cherry/start-flow';
import { cherrySalesOpenFor, resolveCherryOffer, type CherryOffer } from '@/lib/services/cherry/checkout';
import { cherryUser } from '@/lib/services/cherry/session';

export const dynamic = 'force-dynamic';

export default async function CherryStartPage({ searchParams }: {
    searchParams: Promise<{ check?: string | string[]; pay?: string | string[] }>;
}) {
    const query = await searchParams;
    const check = z.string().uuid().safeParse(query.check);
    let user: Awaited<ReturnType<typeof cherryUser>> = null;
    let offer: CherryOffer | null = null;
    let salesOpen = false;
    try {
        user = await cherryUser();
        [salesOpen, offer] = await Promise.all([
            cherrySalesOpenFor(user?.id ?? null), user ? resolveCherryOffer(user.id) : Promise.resolve(null),
        ]);
    } catch {
        // Without settings nothing can be sold, so the closed screen is the safe answer.
        salesOpen = false;
    }
    return <main className="ch-column">
        <CherryBar link={user ? { href: '/cherry/home', label: '내 서비스' } : undefined} />
        <CherryStartFlow signedIn={user !== null} salesOpen={salesOpen} offer={offer} email={user?.email ?? null}
            initialCheckId={check.success ? check.data : null} paymentFailed={query.pay === 'failed'} />
    </main>;
}
