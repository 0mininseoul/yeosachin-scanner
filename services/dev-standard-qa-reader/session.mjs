import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { buyerIdentity } from '../../scripts/dev-standard-cloud-six/identity.mjs';

export const web = 'https://dev.yeosachin.com';
const supabase = 'https://bgamojfpkxnnumfvkron.supabase.co';
const cookieNames = /^sb-bgamojfpkxnnumfvkron-auth-token(?:\.\d+)?$/;
export class ReaderError extends Error {}
export function requireReader(ok, code) { if (!ok) throw new ReaderError(code); }
export function publicKey(key) {
    if (typeof key !== 'string') return false;
    if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return true;
    try { return JSON.parse(Buffer.from(key.split('.')[1], 'base64url')).role === 'anon'; }
    catch { return false; }
}

const authFetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requireReader(url.origin === supabase && (
        ['/auth/v1/admin/generate_link', '/auth/v1/verify', '/auth/v1/user'].includes(url.pathname)
        || /^\/rest\/v1\/rpc\/dev_cloud_six_(?:scope|order_state)_v1$/.test(url.pathname)
    ), 'AUTH_OR_DB_SCOPE');
    return fetch(input, { ...init, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(45_000), ...(init?.signal ? [init.signal] : [])]) });
};
const global = { fetch: authFetch };
export function readerAdmin(env) {
    requireReader(env.CLOUD_RUN_JOB === 'dev-standard-six-reader' && env.CLOUD_RUN_TASK_INDEX === '0'
        && env.CLOUD_RUN_TASK_COUNT === '1' && env.GOOGLE_CLOUD_PROJECT === 'gen-lang-client-0311522474'
        && env.NEXT_PUBLIC_SUPABASE_URL === supabase && /^[0-9a-f]{64}$/.test(env.DEV_STANDARD_QA_WAVE ?? '')
        && publicKey(env.NEXT_PUBLIC_SUPABASE_ANON_KEY) && !!env.SUPABASE_SERVICE_ROLE_KEY
        && env.SUPABASE_SERVICE_ROLE_KEY !== env.NEXT_PUBLIC_SUPABASE_ANON_KEY, 'INVALID_READER_CONFIG');
    return createClient(supabase, env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global,
    });
}

export async function assertReaderRegion() {
    const response = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/region', {
        headers: { 'Metadata-Flavor': 'Google' }, redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    requireReader(response.ok && (await response.text()).trim().endsWith('/regions/asia-northeast1'), 'READER_REGION');
}

export async function createOwnerCookies(admin, wave, slot, requestId, anon) {
    const lookup = await admin.rpc('dev_cloud_six_scope_v1', { p_wave: wave, p_request_id: requestId });
    requireReader(!lookup.error && lookup.data === slot, 'NOT_REGISTERED');
    const { email } = buyerIdentity(wave, slot);
    const link = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    const member = link.data.user;
    requireReader(!link.error && member?.email === email && member.email_confirmed_at
        && member.app_metadata?.dev_cloud_six_v1 === wave && member.app_metadata.dev_cloud_six_slot === slot
        && link.data.properties?.verification_type === 'magiclink', 'LINK');
    const principal = await admin.rpc('dev_cloud_six_scope_v1', { p_wave: wave, p_owner_id: member.id, p_request_id: requestId });
    requireReader(!principal.error && principal.data === slot, 'LINK_OWNER');
    const jar = new Map();
    const client = createServerClient(supabase, anon, {
        global, cookies: {
            getAll: () => [...jar].map(([name, value]) => ({ name, value })),
            setAll: list => { for (const { name, value } of list) {
                requireReader(cookieNames.test(name), 'COOKIE_NAME');
                if (value) jar.set(name, value); else jar.delete(name);
            } },
        },
    });
    const result = await client.auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: 'magiclink' });
    const verified = await client.auth.getUser();
    requireReader(!result.error && !verified.error && verified.data.user?.id === member.id
        && verified.data.user.email === email && jar.size > 0, 'OWNER_SESSION');
    return [...jar].map(([name, value]) => ({ name, value, url: web + '/', secure: true, httpOnly: true, sameSite: 'Lax' }));
}

export async function readerContext(browser, cookies = []) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
        // The renderer may request static chunks and result images. Keep credentials host-only.
        await context.route('**/*', route => {
            const request = route.request();
            return new URL(request.url()).origin === web && ['GET', 'HEAD'].includes(request.method())
                ? route.continue() : route.abort();
        });
        if (cookies.length) await context.addCookies(cookies);
        return context;
    } catch (error) {
        await context.close();
        throw error;
    }
}

export function contextGet(context) {
    return async (href, policy) => {
        const url = new URL(href);
        requireReader(url.origin === web && !url.username && !url.password && !url.hash
            && policy.redirect === 'manual' && policy.cache === 'no-store'
            && (url.pathname === '/api/image-proxy' || /^\/api\/analysis\/v2\/result\/[0-9a-f-]+$/.test(url.pathname)), 'GET_SCOPE');
        const reply = await context.request.get(href, { maxRedirects: 0, timeout: 60_000, headers: { 'Cache-Control': 'no-store' } });
        try {
            const bytes = await reply.body();
            return new Response(new Uint8Array(bytes), { status: reply.status(), headers: reply.headers() });
        } finally { await reply.dispose(); }
    };
}
