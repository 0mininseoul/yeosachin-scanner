/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import registry from '@/config/dev-ui-deployment.json';

const boundary = vi.hoisted(() => ({
    createClient: vi.fn(),
    getUser: vi.fn(),
    createBrowserClient: vi.fn(),
    signInWithOAuth: vi.fn(),
    redirect: vi.fn((destination: string): never => {
        throw new Error(`redirect:${destination}`);
    }),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: boundary.createClient }));
vi.mock('@/lib/supabase/client', () => ({ createClient: boundary.createBrowserClient }));
vi.mock('next/navigation', () => ({ redirect: boundary.redirect }));
vi.mock('@/lib/services/analytics', async () => ({
    ...await vi.importActual<typeof import('@/lib/services/analytics')>('@/lib/services/analytics'),
    trackEvent: vi.fn(),
}));

import AnalysisAuditPage, { metadata } from '../../../../../app/admin0min/page';
import LegacyAnalysisAuditPage from '../../../../../app/admin/analysis-audit/page';
import { NAMCHIN_ADMIN_CONSOLE_PATH, readAdminConsoleDestination } from '@/lib/contracts/admin-console';
import { readOAuthRedirectIntent } from '@/lib/services/auth/oauth-redirect-intent';

// Synthetic identifiers; no live account or analysis record is loaded by this suite.
const operatorId = '10000000-0000-4000-8000-000000000001';
const otherUserId = '10000000-0000-4000-8000-000000000002';
const requestId = '20000000-0000-4000-8000-000000000001';
const destination = '/admin0min';
let mountedRoot: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function page(request?: string | string[], error?: string | string[]) {
    // Next.js can supply repeated search parameters as arrays at runtime.
    return AnalysisAuditPage({
        searchParams: Promise.resolve({ requestId: request, error }) as Parameters<typeof AnalysisAuditPage>[0]['searchParams'],
    });
}

async function unavailablePage(request?: string) {
    const html = renderToStaticMarkup(await page(request));
    expect(html).toContain('관리자 콘솔을 일시적으로 이용할 수 없습니다');
    expect(html).toContain('다시 확인');
    expect(html).not.toContain('무료 계정 9개');
    expect(html).not.toContain('카카오 계정으로 로그인');
    expect(boundary.redirect).not.toHaveBeenCalled();
    return html;
}

async function loginPage(request?: string | string[]) {
    const result = await page(request);
    const html = renderToStaticMarkup(result);
    expect(html).toContain('관리자 콘솔 로그인');
    expect(html).toContain('카카오 계정으로 로그인');
    expect(html).not.toContain('무료 계정 9개');
    expect(boundary.redirect).not.toHaveBeenCalled();
    return result;
}

async function clickKakaoLogin(request?: string | string[]) {
    const result = await loginPage(request);
    const container = document.createElement('div');
    document.body.append(container);
    mountedRoot = createRoot(container);
    await act(async () => mountedRoot!.render(result));
    const button = [...container.querySelectorAll('button')].find(element => element.textContent?.includes('카카오'));
    expect(button).toBeDefined();
    await act(async () => button!.click());
    expect(boundary.signInWithOAuth).toHaveBeenCalledOnce();
    const [input] = boundary.signInWithOAuth.mock.calls[0];
    expect(input.provider).toBe('kakao');
    const callback = new URL(input.options.redirectTo);
    expect(callback.pathname).toBe('/auth/callback');
    expect(callback.origin).toBe(window.location.origin);
    return callback;
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('ANALYSIS_AUDIT_OPERATOR_USER_IDS', operatorId);
    boundary.createClient.mockResolvedValue({ auth: { getUser: boundary.getUser } });
    boundary.createBrowserClient.mockReturnValue({ auth: { signInWithOAuth: boundary.signInWithOAuth } });
    boundary.signInWithOAuth.mockResolvedValue({ error: null });
    boundary.getUser.mockResolvedValue({ data: { user: { id: operatorId } }, error: null });
    window.history.replaceState(null, '', destination);
    document.cookie = 'auth_redirect_intent=; Max-Age=0; Path=/';
});

afterEach(async () => {
    if (mountedRoot) await act(async () => mountedRoot!.unmount());
    mountedRoot = null;
    document.body.innerHTML = '';
    window.sessionStorage.clear();
    vi.unstubAllEnvs();
});

describe('operator console page authentication boundary', () => {
    it('keeps the canonical admin route out of search results', () => {
        expect(metadata).toMatchObject({
            robots: { index: false, follow: false },
            alternates: { canonical: null },
        });
    });

    it.each([
        [undefined, destination],
        [requestId, `${destination}?requestId=${requestId}`],
        [[requestId, requestId], destination],
        ['//untrusted.example', destination],
    ])('redirects legacy console links with only a bounded detail target', async (request, expected) => {
        await expect(LegacyAnalysisAuditPage({
            searchParams: Promise.resolve({ requestId: request }),
        })).rejects.toThrow(`redirect:${expected}`);
        expect(boundary.createClient).not.toHaveBeenCalled();
    });

    it('requires a matching actual Dev identity before opening any Auth client', async () => {
        vi.stubEnv('DEPLOYMENT_ROLE', 'dev'); vi.stubEnv('NEXT_PUBLIC_DEPLOYMENT_ROLE', 'dev');
        vi.stubEnv('VERCEL_PROJECT_ID', 'prj_wrong');
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', `https://${registry.deployments[0].supabaseProjectRef}.supabase.co`);
        await unavailablePage(); expect(boundary.createClient).not.toHaveBeenCalled();
    });

    it('renders only the mock read pane for a Dev admin and denies a non-tester operator', async () => {
        vi.stubEnv('DEPLOYMENT_ROLE', 'dev'); vi.stubEnv('NEXT_PUBLIC_DEPLOYMENT_ROLE', 'dev');
        vi.stubEnv('VERCEL_PROJECT_ID', registry.deployments[0].vercelProjectId);
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', `https://${registry.deployments[0].supabaseProjectRef}.supabase.co`);
        vi.stubEnv('DEV_UI_TEST_USER_IDS', operatorId); vi.stubEnv('DEV_UI_ADMIN_USER_IDS', operatorId);
        const html = renderToStaticMarkup(await page());
        expect(html).toContain('모의 주문 감사'); expect(html).not.toContain('Apify');
        vi.stubEnv('DEV_UI_TEST_USER_IDS', otherUserId);
        expect(renderToStaticMarkup(await page())).toContain('접근 권한이 없습니다');
    });
    it('offers Kakao login in the console and returns to the console after OAuth', async () => {
        boundary.getUser.mockResolvedValue({ data: { user: null }, error: null });

        const callback = await clickKakaoLogin();
        expect(callback.searchParams.get('next')).toBe(destination);
        expect(readOAuthRedirectIntent(document.cookie)).toBe(destination);
    });

    it('preserves a supported analysis detail destination through login', async () => {
        boundary.getUser.mockResolvedValue({ data: { user: null }, error: null });

        const callback = await clickKakaoLogin(requestId);
        expect(callback.searchParams.get('next')).toBe(`${destination}?requestId=${requestId}`);
        expect(readOAuthRedirectIntent(document.cookie)).toBe(`${destination}?requestId=${requestId}`);
    });

    it.each(['bad_oauth_state', 'no_code', 'exchange_failed'])(
        'renders a Korean manual login recovery message for %s',
        async error => {
            boundary.getUser.mockResolvedValue({ data: { user: null }, error: null });
            const result = await page(requestId, error);
            const html = renderToStaticMarkup(result);
            expect(html).toContain('카카오 로그인을 완료하지 못했습니다');
            expect(html).toContain('아래 버튼을 눌러 새 로그인을 시작해 주세요');
            expect(html).toContain('카카오 계정으로 로그인');
            expect(boundary.signInWithOAuth).not.toHaveBeenCalled();
        },
    );

    it.each(['private@example.test token=secret', ['bad_oauth_state', 'bad_oauth_state']])(
        'ignores unknown or repeated error details',
        async error => {
            boundary.getUser.mockResolvedValue({ data: { user: null }, error: null });
            const html = renderToStaticMarkup(await page(requestId, error));
            expect(html).not.toContain('카카오 로그인을 완료하지 못했습니다');
            expect(html).not.toContain('private@example');
            expect(html).not.toContain('token=secret');
        },
    );

    it('starts a fresh OAuth request on a recovery page without forwarding the old error', async () => {
        boundary.getUser.mockResolvedValue({ data: { user: null }, error: null });
        const result = await page(requestId, 'bad_oauth_state');
        const container = document.createElement('div');
        document.body.append(container);
        mountedRoot = createRoot(container);
        await act(async () => mountedRoot!.render(result));
        await act(async () => container.querySelector('button')!.click());
        const callback = new URL(boundary.signInWithOAuth.mock.calls[0][0].options.redirectTo);
        expect(callback.searchParams.get('next')).toBe(`${destination}?requestId=${requestId}`);
        expect(callback.searchParams.has('error')).toBe(false);
    });

    it('starts only one OAuth request when the login button is clicked twice before React rerenders', async () => {
        boundary.getUser.mockResolvedValue({ data: { user: null }, error: null });
        boundary.signInWithOAuth.mockReturnValue(new Promise(() => undefined));
        const result = await page();
        const container = document.createElement('div');
        document.body.append(container);
        mountedRoot = createRoot(container);
        await act(async () => mountedRoot!.render(result));
        await act(async () => {
            const button = container.querySelector('button')!;
            button.click();
            button.click();
        });
        expect(boundary.signInWithOAuth).toHaveBeenCalledOnce();
    });

    it.each(['returned', 'thrown'])('allows a manual retry after a %s OAuth startup error', async failure => {
        boundary.getUser.mockResolvedValue({ data: { user: null }, error: null });
        const expectedError = new Error('synthetic OAuth failure');
        if (failure === 'returned') boundary.signInWithOAuth.mockResolvedValueOnce({ error: expectedError });
        else boundary.signInWithOAuth.mockRejectedValueOnce(expectedError);
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            const result = await page();
            const container = document.createElement('div');
            document.body.append(container);
            mountedRoot = createRoot(container);
            await act(async () => mountedRoot!.render(result));
            const button = container.querySelector('button')!;
            await act(async () => button.click());
            expect(button.disabled).toBe(false);
            await act(async () => button.click());
            expect(boundary.signInWithOAuth).toHaveBeenCalledTimes(2);
        } finally {
            consoleError.mockRestore();
        }
    });

    it.each([
        ['an arbitrary URL', '//untrusted.example/path'],
        ['a query fragment', `${requestId}&redirectTo=https://untrusted.example`],
        ['a repeated query parameter', [requestId, requestId]],
        ['an oversized value', 'x'.repeat(8_192)],
    ])('ignores %s when building the bounded internal login destination', async (_label, request) => {
        boundary.getUser.mockResolvedValue({ data: { user: null }, error: null });

        const callback = await clickKakaoLogin(request);
        expect(callback.searchParams.get('next')).toBe(destination);
        expect(readOAuthRedirectIntent(document.cookie)).toBe(destination);
    });

    it.each([
        { name: 'AuthSessionMissingError' },
        { name: 'AuthApiError', status: 401, code: 'invalid_token' },
    ])('offers the console login gate for explicit missing or invalid sessions', async error => {
        boundary.getUser.mockResolvedValue({ data: { user: null }, error });

        await loginPage(requestId);
    });

    it('offers the console login gate when getUser throws an explicit invalid session', async () => {
        boundary.getUser.mockRejectedValue({ status: 401, code: 'jwt_expired' });

        await loginPage();
    });

    it.each([
        { status: 503, name: 'AuthSessionMissingError', code: 'invalid_token' },
        { status: 429, code: 'invalid_token' },
        { message: 'invalid token during a transport failure' },
    ])('shows an unavailable state for infrastructure errors returned by auth', async error => {
        boundary.getUser.mockResolvedValue({ data: { user: { id: operatorId } }, error });

        const html = await unavailablePage(requestId);
        expect(html).toContain(`href="${destination}?requestId=${requestId}"`);
    });

    it('shows an unavailable state when auth transport throws', async () => {
        boundary.getUser.mockRejectedValue(new Error('network unavailable'));

        await unavailablePage();
    });

    it('shows an unavailable state when the server client cannot be created', async () => {
        boundary.createClient.mockRejectedValue(new Error('configuration unavailable'));

        await unavailablePage();
        expect(boundary.getUser).not.toHaveBeenCalled();
    });

    it('renders the operator console for an authenticated allowlisted operator', async () => {
        const html = renderToStaticMarkup(await page());

        expect(html).toContain('위장여사친');
        expect(html).toContain('운영 콘솔 · production');
        expect(html).toContain('Apify 계정');
        expect(html).toContain(`href="${NAMCHIN_ADMIN_CONSOLE_PATH}"`);
        expect(html).not.toContain('접근 권한이 없습니다');
        expect(boundary.redirect).not.toHaveBeenCalled();
    });

    it('shows the reservation console only to allowlisted operators', async () => {
        const reservationsPage = () => AnalysisAuditPage({ searchParams: Promise.resolve({ workspace: 'namchin' }) });
        const authorized = renderToStaticMarkup(await reservationsPage());
        expect(authorized).toContain('사전 예약 명단');
        expect(authorized).toContain('휴대폰 번호');
        expect(authorized).toContain('1회 수신 동의 일시');
        expect(authorized).toContain(`href="${destination}"`);
        expect(authorized).not.toContain('Apify 계정');

        boundary.getUser.mockResolvedValue({ data: { user: { id: otherUserId } }, error: null });
        const forbidden = renderToStaticMarkup(await reservationsPage());
        expect(forbidden).toContain('관리자 콘솔 접근 권한이 없습니다');
        expect(forbidden).not.toContain('사전 예약 명단');
    });

    it('retains only the supported reservation workspace through OAuth', () => {
        expect(readAdminConsoleDestination(`${NAMCHIN_ADMIN_CONSOLE_PATH}&next=//untrusted.example`)).toBe(NAMCHIN_ADMIN_CONSOLE_PATH);
        expect(readAdminConsoleDestination(`${NAMCHIN_ADMIN_CONSOLE_PATH}&workspace=namchin`)).toBe(destination);
        expect(readAdminConsoleDestination('/admin/analysis-audit?workspace=namchin')).toBe(destination);
    });

    it('renders a forbidden state for an authenticated ordinary user without redirecting home', async () => {
        boundary.getUser.mockResolvedValue({ data: { user: { id: otherUserId } }, error: null });

        const html = renderToStaticMarkup(await page());
        expect(html).toContain('관리자 콘솔 접근 권한이 없습니다');
        expect(html).toContain('운영자 계정');
        expect(html).not.toContain('운영 콘솔 · production');
        expect(boundary.redirect).not.toHaveBeenCalled();
    });

    it.each(['', 'invalid-configuration', `${operatorId},${operatorId}`])(
        'fails closed with an unavailable state when the operator allowlist is absent or invalid',
        async configured => {
            vi.stubEnv('ANALYSIS_AUDIT_OPERATOR_USER_IDS', configured);

            await unavailablePage();
        },
    );
});
