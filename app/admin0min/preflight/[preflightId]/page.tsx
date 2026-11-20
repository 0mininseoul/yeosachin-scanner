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

    const [live, archived] = await Promise.all([
        supabaseAdmin.from('analysis_preflights').select('*').eq('id', preflightId).maybeSingle(),
        supabaseAdmin.from('admin_preflight_screen_archive').select('*').eq('preflight_id', preflightId).maybeSingle(),
    ]);
    if (live.error && archived.error) {
        return <Shell title="불러오지 못했습니다"><p className="mt-4 text-[14px] text-fg-dim">잠시 후 다시 시도해 주세요.</p></Shell>;
    }
    const row = live.data as Record<string, unknown> | null;
    const archive = archived.data as Record<string, unknown> | null;

    let screen: Extract<PreflightStatusV1, { status: 'ready' }> | null = null;
    let source: 'live' | 'archive' | null = null;
    let reason = row ? '이 preflight는 완료 상태가 아닙니다.' : '이 preflight는 보관 기간이 지나 정리됐고, 운영자 보관본도 없습니다.';
    const replay = (input: Record<string, unknown>) => {
        const stored = storedPreflightFromRow(input);
        if (!stored.readySnapshot) return null;
        // Replay the ready state as the user saw it, regardless of later expiry or checkout.
        const dto = publicPreflightStatusDto({ ...stored, status: 'ready', expiresAt: FAR_FUTURE });
        return dto.status === 'ready' ? dto : null;
    };
    try {
        if (row && row.pii_scrubbed_at == null) {
            screen = replay(row);
            if (screen) source = 'live';
        }
        if (!screen && archive) {
            screen = replay({ ...archive, id: archive.preflight_id, status: 'ready', error_code: null });
            if (screen) source = 'archive';
        }
        if (!screen && row && (row.ready_at || row.pii_scrubbed_at)) {
            reason = '대상 프로필이 정리됐고, 운영자 보관본이 만들어지기 전의 preflight입니다.';
        }
    } catch {
        reason = '저장된 스냅샷 형식을 읽을 수 없습니다.';
    }

    if (!screen) return <Shell title="화면을 다시 만들 수 없습니다"><p className="mt-4 text-[14px] text-fg-dim">{reason}</p></Shell>;
    return <Shell title={`@${screen.target.username}`}>
        {source === 'archive'
            ? <p className="mt-2 text-[12px] text-fg-dim">운영자 보관본 · 유저 화면은 만료됐습니다{archive?.captured_at ? ` · 보관 ${new Date(String(archive.captured_at)).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}` : ''} · 프로필 사진은 인스타그램 링크 만료로 안 보일 수 있습니다</p>
            : null}
        <PreflightScreen preflight={screen} />
    </Shell>;
}
