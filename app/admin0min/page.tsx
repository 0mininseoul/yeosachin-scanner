import Image from 'next/image';
import Link from 'next/link';
import { adminConsolePath, CHERRY_THREADS_CONSOLE_PATH, NAMCHIN_ADMIN_CONSOLE_PATH } from '@/lib/contracts/admin-console';
import { AuthButtons } from '@/components/auth-buttons';
import { createClient } from '@/lib/supabase/server';
import {
    classifyOperatorAuthError,
    getAnalysisAuditOperatorDecision,
} from '@/lib/services/analysis/score-audit';
import { AdminConsole } from '../admin/console/admin-console';
import { CherryServiceConsole } from '../admin/console/cherry-service-console';
import { CherryThreadsConsole } from '../admin/console/cherry-threads-console';
import { NamchinWaitlistConsole } from '../admin/console/namchin-waitlist-console';
import { buildPipelineMap } from '@/lib/services/admin/pipeline-map';
import { isDevUiDeploymentContext } from '@/lib/constants/dev-ui';
import { assertDevUiDeployment } from '@/lib/services/dev-ui/deployment';
import { assertDevUiAdministrator } from '@/lib/services/dev-ui/access';
import { DevUiOrderList } from '@/components/dev-ui/order-list';
import { NOINDEX_METADATA } from '@/lib/services/seo/discovery';
import '../admin/analysis-audit/console.css';
import '../admin/console/admin-console.css';

export const dynamic = 'force-dynamic';
export const metadata = { ...NOINDEX_METADATA, title: '판독 운영 콘솔 — 운영' };

const ACCESS_COPY = {
    login: {
        title: '관리자 콘솔 로그인',
        description: '등록된 운영자 카카오 계정으로 로그인하면 바로 운영 콘솔로 이동합니다.',
    },
    forbidden: {
        title: '관리자 콘솔 접근 권한이 없습니다',
        description: '로그인은 완료됐지만 현재 계정은 운영자로 등록되어 있지 않습니다. 등록된 운영자 계정으로 다시 로그인해 주세요.',
    },
    unavailable: {
        title: '관리자 콘솔을 일시적으로 이용할 수 없습니다',
        description: '인증 서비스 또는 운영자 설정을 확인할 수 없습니다. 잠시 후 다시 확인해 주세요.',
    },
} as const;

function AccessIcon({ state }: { state: 'login' | 'forbidden' | 'unavailable' }) {
    const common = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
    if (state === 'login') return <svg {...common}><rect x="4" y="10" width="16" height="11" rx="2.5" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>;
    if (state === 'forbidden') return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" /></svg>;
    return <svg {...common}><path d="M12 3 2 20h20L12 3z" /><path d="M12 10v4M12 17h.01" /></svg>;
}

function ConsoleAccessState({
    state,
    destination,
    loginFailed,
}: {
    state: 'login' | 'forbidden' | 'unavailable';
    destination: string;
    loginFailed?: boolean;
}) {
    const copy = ACCESS_COPY[state];
    return <div className="ac-app ac-gate">
        <main className="ac-gate-card" aria-labelledby="console-access-title">
            <div className="ac-gate-brand">
                <Image src="/logo.png" alt="" width={44} height={44} priority />
                <div><b>위장여사친 <em>판독기</em></b><small><i aria-hidden="true" />운영 콘솔</small></div>
            </div>
            <span className={`ac-gate-icon is-${state}`}><AccessIcon state={state} /></span>
            <h1 id="console-access-title">{copy.title}</h1>
            <p className="ac-gate-desc">{copy.description}</p>
            {state === 'login' && loginFailed ? <p className="ac-alert" role="alert">
                카카오 로그인을 완료하지 못했습니다. 아래 버튼을 눌러 새 로그인을 시작해 주세요.
            </p> : null}
            <div className="ac-gate-action">
                {state === 'unavailable'
                    ? <a className="ac-btn ac-btn--primary" href={destination}>다시 확인</a>
                    : <AuthButtons
                        redirectTo={destination}
                        promptKakaoLogin={state === 'forbidden'}
                        kakaoLabel={state === 'forbidden' ? '다른 카카오 계정으로 로그인' : '카카오 계정으로 로그인'}
                    />}
            </div>
            <p className="ac-gate-note">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3z" /></svg>
                <span>운영자로 등록된 계정만 접근할 수 있습니다. 모든 응답은 캐시되지 않습니다.</span>
            </p>
            <div className="ac-gate-foot">
                <span>yeosachin · production</span>
                <Link href="/">홈으로</Link>
            </div>
        </main>
    </div>;
}

export default async function AnalysisAuditPage({
    searchParams,
}: { searchParams: Promise<{ requestId?: string | string[]; error?: string | string[]; view?: string | string[]; tab?: string | string[]; workspace?: string | string[]; threads?: string | string[] }> }) {
    const params = await searchParams;
    const namchinWorkspace = params.workspace === 'namchin';
    const destination = namchinWorkspace
        ? (params.view === 'threads' ? CHERRY_THREADS_CONSOLE_PATH : NAMCHIN_ADMIN_CONSOLE_PATH)
        : adminConsolePath(params.requestId);
    const loginFailed = typeof params.error === 'string'
        && ['bad_oauth_state', 'no_code', 'exchange_failed'].includes(params.error);

    const devContext = isDevUiDeploymentContext();
    if (devContext) {
        try { assertDevUiDeployment(); }
        catch { return <ConsoleAccessState state="unavailable" destination={destination} />; }
    }

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
    if (authState) return <ConsoleAccessState state={authState} destination={destination} loginFailed={loginFailed} />;
    if (!user) return <ConsoleAccessState state="login" destination={destination} loginFailed={loginFailed} />;

    if (devContext) {
        try { assertDevUiAdministrator(user.id); }
        catch { return <ConsoleAccessState state="forbidden" destination={destination} />; }
        return <div className="operator-console"><main className="oc-wrap"><section className="oc-section">
            <header className="oc-masthead"><div><p className="oc-kicker">Dev · 읽기 전용</p><h1>모의 주문 감사</h1><p>테스트 결제와 합성 분석의 연결을 확인하세요.</p></div></header>
            <nav className="my-5 flex gap-5"><Link className="oc-link" href="/analyze">새 테스트</Link><Link className="oc-link" href="/mypage">보관함</Link></nav>
            <DevUiOrderList administrator />
        </section></main></div>;
    }

    let decision: ReturnType<typeof getAnalysisAuditOperatorDecision>;
    try {
        decision = getAnalysisAuditOperatorDecision(user.id);
    } catch {
        decision = 'unavailable';
    }
    if (decision !== 'authorized') return <ConsoleAccessState state={decision} destination={destination} />;

    if (namchinWorkspace) {
        if (params.view === 'threads') return <CherryThreadsConsole authResult={params.threads === 'failed' ? 'failed' : undefined} />;
        if (params.view === 'service') return <CherryServiceConsole />;
        return <NamchinWaitlistConsole />;
    }

    return <AdminConsole
        initialRequestId={new URL(destination, 'https://admin-console.invalid').searchParams.get('requestId') ?? ''}
        initialView={typeof params.view === 'string' ? params.view : undefined}
        initialTab={typeof params.tab === 'string' ? params.tab : undefined}
        pipelineMap={buildPipelineMap()}
    />;
}
