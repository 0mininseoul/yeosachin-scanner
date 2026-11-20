import Link from 'next/link';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getAnalysisAuditOperatorDecision } from '@/lib/services/analysis/score-audit';
import { publicPreflightStatusDto, storedPreflightFromRow } from '@/lib/services/analysis/preflight';
import type { PreflightStatusV1 } from '@/lib/contracts/analysis-v2';
import { NOINDEX_METADATA } from '@/lib/services/seo/discovery';
import { PreflightScreen } from './preflight-screen';

export const dynamic = 'force-dynamic';
export const metadata = { ...NOINDEX_METADATA, title: 'Preflight 화면 — 운영' };

const FAR_FUTURE = '2999-01-01T00:00:00.000Z';

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
    return <div className="min-h-dvh bg-ink text-fg">
        <main className="mx-auto max-w-[500px] px-5 pb-16 pt-7">
            <p className="text-[12px] text-fg-dim">운영 콘솔 · 유저가 본 preflight 화면 (읽기 전용)</p>
            <h1 className="mt-1 text-[18px] font-bold">{title}</h1>
            {children}
            <p className="mt-8 text-[13px]"><Link className="underline" href="/admin0min?view=preflight">← Preflight 목록</Link></p>
        </main>
    </div>;
}

async function isOperator(): Promise<boolean> {
    try {
        const supabase = await createClient();
        const { data, error } = await supabase.auth.getUser();
        if (error || !data.user) return false;
        return getAnalysisAuditOperatorDecision(data.user.id) === 'authorized';
    } catch {
        return false;
    }
}

export default async function OperatorPreflightScreenPage({ params }: { params: Promise<{ preflightId: string }> }) {
    const { preflightId } = await params;
    if (!await isOperator()) {
        return <Shell title="접근할 수 없습니다"><p className="mt-4 text-[14px] text-fg-dim">운영자 계정으로 로그인해야 볼 수 있습니다.</p></Shell>;
    }
    if (!z.string().uuid().safeParse(preflightId).success) {
        return <Shell title="잘못된 preflight ID"><p className="mt-4 text-[14px] text-fg-dim">주소를 확인해 주세요.</p></Shell>;
    }

    const { data: row, error } = await supabaseAdmin.from('analysis_preflights').select('*').eq('id', preflightId).maybeSingle();
    if (error) {
        return <Shell title="불러오지 못했습니다"><p className="mt-4 text-[14px] text-fg-dim">잠시 후 다시 시도해 주세요.</p></Shell>;
    }
    if (!row) {
        return <Shell title="화면을 다시 만들 수 없습니다"><p className="mt-4 text-[14px] text-fg-dim">이 preflight는 보관 기간이 지나 정리됐습니다. 콘솔 목록의 상태와 수치만 남아 있습니다.</p></Shell>;
    }

    let screen: Extract<PreflightStatusV1, { status: 'ready' }> | null = null;
    let reason = '이 preflight는 완료 상태가 아닙니다.';
    try {
        const stored = storedPreflightFromRow(row as Record<string, unknown>);
        if (stored.readySnapshot && (row as { pii_scrubbed_at?: string | null }).pii_scrubbed_at == null) {
            // Replay the ready state as the user saw it, regardless of later expiry or checkout.
            const dto = publicPreflightStatusDto({ ...stored, status: 'ready', expiresAt: FAR_FUTURE });
            if (dto.status === 'ready') screen = dto;
        } else if (stored.readySnapshot || (row as { ready_at?: string | null }).ready_at) {
            reason = '개인정보 보관 기간이 지나 대상 프로필이 정리됐습니다. 콘솔 목록의 수치만 남아 있습니다.';
        }
    } catch {
        reason = '저장된 스냅샷 형식을 읽을 수 없습니다.';
    }

    if (!screen) return <Shell title="화면을 다시 만들 수 없습니다"><p className="mt-4 text-[14px] text-fg-dim">{reason}</p></Shell>;
    return <Shell title={`@${screen.target.username}`}><PreflightScreen preflight={screen} /></Shell>;
}
