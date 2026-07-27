import { redirect } from 'next/navigation';
import { EyeOff } from 'lucide-react';
import { CaseCard, Eyebrow, TopBar } from '@/components/case-ui';
import { createClient } from '@/lib/supabase/server';
import { isAnalysisAuditOperator } from '@/lib/services/analysis/score-audit';
import { AnalysisAuditWorkbench } from './workbench';

export const metadata = { title: '분석 점수 감사 — 운영' };

export default async function AnalysisAuditPage({
    searchParams,
}: { searchParams: Promise<{ requestId?: string }> }) {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) redirect('/login');
    if (!isAnalysisAuditOperator(user.id)) redirect('/');
    const params = await searchParams;
    return (
        <div className="min-h-dvh">
            <TopBar right={<span className="eyebrow text-blood">OPERATIONS / READ ONLY</span>} />
            <main className="mx-auto max-w-6xl px-4 pb-16 pt-8 sm:px-7">
                <div className="grid gap-5 border-b border-line pb-6 lg:grid-cols-[1fr_auto] lg:items-end">
                    <div>
                        <Eyebrow>점수 산정 감사</Eyebrow>
                        <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-fg sm:text-4xl">Risk ledger</h1>
                        <p className="mt-2 max-w-2xl text-sm leading-6 text-fg-dim">
                            완료된 공개 계정의 저장된 신호와 점수만 읽습니다. 원본 미디어·캡션·공급자 응답은 이 화면에 없습니다.
                        </p>
                    </div>
                    <div className="flex items-center gap-2 border border-line bg-panel/50 px-3 py-2 text-[11px] text-fg-dim">
                        <EyeOff className="h-3.5 w-3.5 text-blood" aria-hidden="true" />
                        private / no-store
                    </div>
                </div>
                <CaseCard className="mt-6">
                    <AnalysisAuditWorkbench initialRequestId={params.requestId ?? ''} />
                </CaseCard>
            </main>
        </div>
    );
}
