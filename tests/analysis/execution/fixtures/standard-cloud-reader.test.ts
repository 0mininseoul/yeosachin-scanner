import { afterEach, expect, it, vi } from 'vitest';
import { readerAdmin, createOwnerCookies, publicKey } from '../../../../services/dev-standard-qa-reader/session.mjs';
import { monitorReaders } from '../../../../services/dev-standard-qa-reader/monitor.mjs';

const wave = 'a'.repeat(64);
const origin = 'https://bgamojfpkxnnumfvkron.supabase.co';
const anon = 'sb_publishable_syntheticfixture';
const adminKey = 'fixture-admin';
const requestId = '13333333-3333-4333-8333-333333333333';
const userId = '23333333-3333-4333-8333-333333333333';
function admin() { return readerAdmin({
    CLOUD_RUN_JOB: 'dev-standard-six-reader', CLOUD_RUN_TASK_INDEX: '0', CLOUD_RUN_TASK_COUNT: '1',
    GOOGLE_CLOUD_PROJECT: 'gen-lang-client-0311522474', NEXT_PUBLIC_SUPABASE_URL: origin,
    DEV_STANDARD_QA_WAVE: wave, NEXT_PUBLIC_SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_ROLE_KEY: adminKey,
}); }
afterEach(() => vi.unstubAllGlobals());

it('uses the official SSR cookie writer with an owner session and never emails a link', async () => {
    const user = { id: userId, email: 'dev-six-' + wave.slice(0, 16) + '-2@example.invalid',
        email_confirmed_at: '2026-11-01T00:00:00Z', app_metadata: { provider: 'email', dev_cloud_six_v1: wave, dev_cloud_six_slot: 2 } };
    const token = ['header', Buffer.from(JSON.stringify({ sub: userId, role: 'authenticated' })).toString('base64url'), 'signature'].join('.');
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        expect(url.origin).toBe(origin);
        const headers = new Headers(init?.headers);
        paths.push(url.pathname);
        if (url.pathname === '/rest/v1/rpc/dev_cloud_six_scope_v1') {
            expect(headers.get('apikey')).toBe(adminKey);
            expect(JSON.parse(init.body)).toMatchObject({ p_wave: wave, p_request_id: requestId });
            return Response.json(2);
        }
        if (url.pathname === '/auth/v1/admin/generate_link') {
            expect(headers.get('apikey')).toBe(adminKey);
            expect(JSON.parse(init.body)).toMatchObject({ type: 'magiclink', email: user.email });
            return Response.json({ ...user, action_link: 'fixture', email_otp: '000000', hashed_token: 'fixture-hash', verification_type: 'magiclink' });
        }
        expect(headers.get('apikey')).toBe(anon);
        if (url.pathname === '/auth/v1/verify') {
            expect(JSON.parse(init.body)).toMatchObject({ token_hash: 'fixture-hash', type: 'magiclink' });
            return Response.json({ user, access_token: token, refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer' });
        }
        expect(url.pathname).toBe('/auth/v1/user');
        expect(headers.get('authorization')).toBe('Bearer ' + token);
        return Response.json(user);
    }));
    const cookies = await createOwnerCookies(admin(), wave, 2, requestId, anon);
    expect(paths).toEqual(['/rest/v1/rpc/dev_cloud_six_scope_v1', '/auth/v1/admin/generate_link',
        '/rest/v1/rpc/dev_cloud_six_scope_v1', '/auth/v1/verify', '/auth/v1/user']);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({ name: 'sb-bgamojfpkxnnumfvkron-auth-token', url: 'https://dev.yeosachin.com/', httpOnly: true, secure: true });
    expect(cookies[0]?.value).toBeTruthy();
    expect(publicKey('sb_secret_fixture')).toBe(false);
});

it('requires registered wave and slot before generating a link', async () => {
    const fetch = vi.fn(async () => Response.json(null));
    vi.stubGlobal('fetch', fetch);
    await expect(createOwnerCookies(admin(), wave, 2, requestId, anon)).rejects.toThrow('NOT_REGISTERED');
    expect(fetch).toHaveBeenCalledTimes(1);
});

it('starts each published owner without waiting for the rest and measures from its own seat timestamp', async () => {
    let tick = 0;
    const events: Array<Record<string, unknown>> = [];
    const base = Date.parse('2026-11-27T00:00:00Z');
    const iso = (ms: number) => new Date(base + ms).toISOString();
    const read = vi.fn(async (slot: number) => ({ get: () => {}, browser: { completedAt: iso(slot * 1_000 + 3_000), hydrated: true, candidateImageDecoded: true },
        http: { pages: 12, images: 602, completedAt: iso(slot * 1_000 + (slot === 2 ? 3_600_001 : 8_000)) } }));
    const slots = await monitorReaders(async () => Array.from({ length: 6 }, (_, i) => ({
        slot: i+1, requestId, startedAt: iso((i+1)*1_000), publishedAt: i <= tick ? iso((i+1)*1_000+2_000) : null,
        status: i === 5 ? 'failed' : 'open',
    })), read, (event: Record<string, unknown>) => events.push(event), async () => {
        expect(read).toHaveBeenCalledTimes(tick + 1); tick++;
    });
    expect(slots).toHaveLength(6);
    expect(events.filter(e => e.event === 'owner_positive')).toHaveLength(5);
    expect(events.find(e => e.event === 'owner_positive' && e.slot === 2)).toMatchObject({ withinHour: false, allImagesMs: 3_600_001 });
    expect(events.find(e => e.event === 'analysis_failure')).toMatchObject({ slot: 6 });
    expect(JSON.stringify(events)).not.toContain(requestId);
});
