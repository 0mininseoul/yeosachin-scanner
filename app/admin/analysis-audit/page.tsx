import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { isAnalysisAuditOperator } from '@/lib/services/analysis/score-audit';
import { AnalysisAuditWorkbench } from './workbench';
import './console.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: '판독 운영 콘솔 — 운영' };

export default async function AnalysisAuditPage({
    searchParams,
}: { searchParams: Promise<{ requestId?: string }> }) {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) redirect('/login');
    if (!isAnalysisAuditOperator(user.id)) redirect('/');
    const params = await searchParams;
    return <div className="operator-console"><main className="oc-wrap"><AnalysisAuditWorkbench initialRequestId={params.requestId ?? ''} /></main></div>;
}
