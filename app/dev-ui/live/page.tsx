import { notFound } from 'next/navigation';
import { isDevUiDeployment } from '@/lib/services/dev-ui/deployment';
import { DevLiveAnalysis } from './live-form';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Dev 실제 분석', robots: { index: false, follow: false } };

export default async function DevLivePage({ searchParams }: {
    searchParams: Promise<{ preflight?: string }>;
}) {
    if (!isDevUiDeployment()) notFound();
    const { preflight } = await searchParams;
    return <DevLiveAnalysis initialPreflightId={typeof preflight === 'string' ? preflight : ''} />;
}
