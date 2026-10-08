import Link from 'next/link';
import { AuthButtons } from '@/components/auth-buttons';
import { createClient } from '@/lib/supabase/server';
import {
    classifyOperatorAuthError,
    getAnalysisAuditOperatorDecision,
} from '@/lib/services/analysis/score-audit';
import { AnalysisAuditWorkbench } from './workbench';
import './console.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: '판독 운영 콘솔 — 운영' };

const CONSOLE_PATH = '/admin/analysis-audit';
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function ConsoleAccessState({
    state,
    destination,
}: {
    state: 'login' | 'forbidden' | 'unavailable';
    destination: string;
}) {
    const title = state === 'login'
        ? '관리자 콘솔 로그인'
        : state === 'forbidden'
            ? '관리자 콘솔 접근 권한이 없습니다'
            : '관리자 콘솔을 일시적으로 이용할 수 없습니다';
    const description = state === 'login'
        ? '카카오로 로그인해 운영자 권한을 확인하세요. 등록된 운영자 계정만 이용할 수 있습니다.'
        : state === 'forbidden'
            ? '로그인은 완료됐지만 현재 계정은 운영자로 등록되어 있지 않습니다. 등록된 운영자 계정으로 로그인해 주세요.'
            : '인증 서비스 또는 운영자 설정을 확인할 수 없습니다. 잠시 후 다시 확인해 주세요.';

    return <div className="operator-console"><main className="oc-wrap">
        <section className="oc-section" aria-labelledby="console-access-title">
            <header className="oc-masthead"><div>
                <p className="oc-kicker">운영자 전용</p>
                <h1 id="console-access-title">{title}</h1>
                <p>{description}</p>
            </div></header>
            <div className="mt-6 max-w-[400px]">
                {state === 'unavailable'
                    ? <a className="oc-link" href={destination}>다시 확인</a>
                    : <AuthButtons redirectTo={destination} />}
            </div>
            <p className="mt-6"><Link className="oc-link" href="/">홈으로 돌아가기</Link></p>
        </section>
    </main></div>;
}

export default async function AnalysisAuditPage({
    searchParams,
}: { searchParams: Promise<{ requestId?: string | string[] }> }) {
    const params = await searchParams;
    const requestId = typeof params.requestId === 'string' && REQUEST_ID.test(params.requestId)
        ? params.requestId
        : '';
    const destination = requestId
        ? `${CONSOLE_PATH}?${new URLSearchParams({ requestId })}`
        : CONSOLE_PATH;

    let user: { id: string } | null = null;
    let authState: 'login' | 'unavailable' | null = null;
    try {
        const supabase = await createClient();
        const auth = await supabase.auth.getUser();
        if (auth.error) {
            authState = classifyOperatorAuthError(auth.error) === 'unauthorized' ? 'login' : 'unavailable';
        } else {
            user = auth.data.user;
        }
    } catch (caught) {
        authState = classifyOperatorAuthError(caught) === 'unauthorized' ? 'login' : 'unavailable';
    }
    if (authState) return <ConsoleAccessState state={authState} destination={destination} />;
    if (!user) return <ConsoleAccessState state="login" destination={destination} />;

    let decision: ReturnType<typeof getAnalysisAuditOperatorDecision>;
    try {
        decision = getAnalysisAuditOperatorDecision(user.id);
    } catch {
        decision = 'unavailable';
    }
    if (decision !== 'authorized') return <ConsoleAccessState state={decision} destination={destination} />;

    return <div className="operator-console"><main className="oc-wrap"><AnalysisAuditWorkbench initialRequestId={requestId} /></main></div>;
}
