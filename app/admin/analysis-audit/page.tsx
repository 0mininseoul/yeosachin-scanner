import { redirect } from 'next/navigation';
import { adminConsolePath } from '@/lib/contracts/admin-console';

export const dynamic = 'force-dynamic';

export default async function LegacyAnalysisAuditPage({
    searchParams,
}: { searchParams: Promise<{ requestId?: string | string[] }> }) {
    const params = await searchParams;
    redirect(adminConsolePath(params.requestId));
}
