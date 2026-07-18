import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routeMocks = vi.hoisted(() => ({
    cookies: vi.fn(),
    createServerClient: vi.fn(),
    createClient: vi.fn(),
    createBrowserClient: vi.fn(),
    exchangeCodeForSession: vi.fn(),
    getCallbackUser: vi.fn(),
    getMeUser: vi.fn(),
    fetch: vi.fn(),
    from: vi.fn(),
    upsert: vi.fn(),
    select: vi.fn(),
    eq: vi.fn(),
    single: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    emit: vi.fn(),
    observeRoute: vi.fn((
        _request: Request,
        _route: string,
        operation: (context: Record<string, unknown>) => Promise<Response>,
    ) => operation({
        request_id: '423e4567-e89b-42d3-a456-426614174011',
        trace_id: null,
        route: '/auth/callback',
        method: 'GET',
    })),
}));

vi.mock('next/headers', () => ({ cookies: routeMocks.cookies }));
vi.mock('@supabase/ssr', () => ({
    createServerClient: routeMocks.createServerClient,
}));
vi.mock('@/lib/supabase/server', () => ({
    createClient: routeMocks.createClient,
}));
vi.mock('@/lib/supabase/client', () => ({
    createClient: routeMocks.createBrowserClient,
}));
vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { from: routeMocks.from },
}));
vi.mock('@/lib/observability/request', () => ({
    observeRoute: routeMocks.observeRoute,
}));
vi.mock('@/lib/observability/server', () => ({
    operationalLogger: { emit: routeMocks.emit },
}));

import {
    buildAuthProfilePatch,
    type AuthProfileSource,
} from './auth-profile';
import { GET as authCallback } from '@/app/auth/callback/route';
import { GET as getCurrentUser } from '@/app/api/user/me/route';
import { AuthButtons } from '@/components/auth-buttons';

const USER_ID = '123e4567-e89b-42d3-a456-426614174000';
const USER_RESPONSE_COLUMNS = 'id, email, provider, analysis_count, is_paid_user, is_unlimited, created_at, updated_at';
const USER_INTERNAL_COLUMNS = `${USER_RESPONSE_COLUMNS}, name, nickname, profile_image, gender, birthyear, phone_number, phone_number_normalized`;
const SAFE_USER_DTO = {
    id: USER_ID,
    email: 'user@example.com',
    provider: 'kakao',
    analysis_count: 3,
    is_paid_user: true,
    is_unlimited: false,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-18T00:00:00.000Z',
};
const PRIVATE_PHONE = '010-9999-8888';

function privateUserRow(overrides: Record<string, unknown> = {}) {
    return {
        ...SAFE_USER_DTO,
        name: 'Private Name',
        nickname: 'Private Nickname',
        profile_image: 'https://example.com/private.jpg',
        gender: 'female',
        birthyear: '1994',
        phone_number: PRIVATE_PHONE,
        phone_number_normalized: '+821099998888',
        ...overrides,
    };
}

function installCallbackSession(
    provider: 'kakao' | 'google',
    providerToken: string
) {
    routeMocks.exchangeCodeForSession.mockResolvedValue({
        data: {
            session: { provider_token: providerToken },
            user: {
                id: USER_ID,
                email: 'user@example.com',
                app_metadata: { provider },
            },
        },
        error: null,
    });
    routeMocks.getCallbackUser.mockResolvedValue({
        data: { user: { id: USER_ID } },
        error: null,
    });
    routeMocks.createServerClient.mockReturnValue({
        auth: {
            exchangeCodeForSession: routeMocks.exchangeCodeForSession,
            getUser: routeMocks.getCallbackUser,
        },
    });
}

function installCallbackProfileFetch(options: {
    phoneNumber?: unknown;
    omitPhone?: boolean;
} = {}) {
    const account: Record<string, unknown> = {
            name: '  Account Name  ',
            gender: '  female  ',
            birthyear: 1997,
            profile: {
                nickname: '  Kakao Nickname  ',
                profile_image_url: '  https://example.com/kakao.jpg  ',
            },
    };
    if (!options.omitPhone) {
        account.phone_number = 'phoneNumber' in options
            ? options.phoneNumber
            : '  +82 10-1234-5678  ';
    }
    routeMocks.fetch.mockImplementation(async () => new Response(JSON.stringify({
        kakao_account: account,
    }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    }));
}

function callbackRequest(code: string) {
    return new Request(
        `http://localhost:3000/auth/callback?code=${code}&next=%2Fanalyze`
    );
}

describe('OAuth callback profile persistence', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        vi.stubGlobal('fetch', routeMocks.fetch);
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key');
        routeMocks.cookies.mockResolvedValue({
            getAll: vi.fn(() => []),
            set: vi.fn(),
        });
        routeMocks.from.mockImplementation((table: string) => {
            if (table !== 'users') throw new Error(`unexpected table: ${table}`);
            return { upsert: routeMocks.upsert };
        });
        routeMocks.upsert.mockResolvedValue({ error: null });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('upserts the current helper-derived Kakao profile on every login', async () => {
        const providerToken = 'kakao-provider-token';
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        installCallbackSession('kakao', providerToken);
        installCallbackProfileFetch();

        await authCallback(callbackRequest('first-code'));
        await authCallback(callbackRequest('second-code'));

        const expectedProfile = {
            id: USER_ID,
            email: 'user@example.com',
            provider: 'kakao',
            name: 'Account Name',
            nickname: 'Kakao Nickname',
            profile_image: 'https://example.com/kakao.jpg',
            gender: 'female',
            birthyear: '1997',
            phone_number: '+82 10-1234-5678',
            phone_number_normalized: '+821012345678',
        };
        expect(routeMocks.exchangeCodeForSession).toHaveBeenNthCalledWith(1, 'first-code');
        expect(routeMocks.exchangeCodeForSession).toHaveBeenNthCalledWith(2, 'second-code');
        expect(routeMocks.fetch).toHaveBeenCalledTimes(2);
        expect(routeMocks.fetch).toHaveBeenNthCalledWith(
            1,
            'https://kapi.kakao.com/v2/user/me',
            {
                headers: { Authorization: `Bearer ${providerToken}` },
                cache: 'no-store',
            }
        );
        expect(routeMocks.upsert).toHaveBeenNthCalledWith(
            1,
            expectedProfile,
            { onConflict: 'id' }
        );
        expect(routeMocks.upsert).toHaveBeenNthCalledWith(
            2,
            expectedProfile,
            { onConflict: 'id' }
        );
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it.each([
        ['withdrawn', { omitPhone: true }],
        ['invalid', { phoneNumber: 'not-a-phone' }],
    ])('clears both stale Kakao phone fields when phone consent is %s', async (
        _label,
        phoneOptions
    ) => {
        const storedPhone: Record<string, unknown> = {
            phone_number: PRIVATE_PHONE,
            phone_number_normalized: '+821099998888',
        };
        installCallbackSession('kakao', 'kakao-provider-token');
        installCallbackProfileFetch(phoneOptions);
        routeMocks.upsert.mockImplementation(async (
            patch: Record<string, unknown>
        ) => {
            Object.assign(storedPhone, patch);
            return { error: null };
        });

        await authCallback(callbackRequest('stale-phone-code'));

        expect(storedPhone).toEqual(expect.objectContaining({
            phone_number: null,
            phone_number_normalized: null,
        }));
        expect(routeMocks.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                phone_number: null,
                phone_number_normalized: null,
            }),
            { onConflict: 'id' }
        );
    });

    it('keeps Google callback exchange and redirect behavior without Kakao work', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        installCallbackSession('google', 'google-provider-token');

        const response = await authCallback(callbackRequest('google-code'));

        expect(response.headers.get('location')).toBe(
            'http://localhost:3000/analyze?verified=true'
        );
        expect(routeMocks.exchangeCodeForSession).toHaveBeenCalledWith('google-code');
        expect(routeMocks.getCallbackUser).toHaveBeenCalledOnce();
        expect(routeMocks.fetch).not.toHaveBeenCalled();
        expect(routeMocks.from).not.toHaveBeenCalled();
        expect(routeMocks.upsert).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('logs only a non-PII code when the Kakao profile upsert fails', async () => {
        const providerToken = 'private-provider-token';
        const rawPhone = '+82 10-1234-5678';
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        installCallbackSession('kakao', providerToken);
        installCallbackProfileFetch();
        routeMocks.upsert.mockResolvedValue({
            error: {
                code: '23505',
                message: `duplicate ${rawPhone} for Kakao Nickname using ${providerToken}`,
            },
        });

        await authCallback(callbackRequest('error-code'));

        expect(errorSpy).toHaveBeenCalledWith(
            'users upsert (kakao profile) failed:',
            '23505'
        );
        const logged = errorSpy.mock.calls.flat().map(String).join(' ');
        expect(logged).not.toContain(providerToken);
        expect(logged).not.toContain(rawPhone);
        expect(logged).not.toContain('Kakao Nickname');
    });

    it('does not log a thrown Kakao response error containing token or profile PII', async () => {
        const providerToken = 'private-provider-token';
        const rawPhone = '+82 10-1234-5678';
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        installCallbackSession('kakao', providerToken);
        routeMocks.fetch.mockRejectedValue(new Error(
            `failed for ${rawPhone}, Kakao Nickname, ${providerToken}`
        ));

        await authCallback(callbackRequest('fetch-error-code'));

        expect(errorSpy).toHaveBeenCalledWith('Kakao profile sync failed');
        const logged = errorSpy.mock.calls.flat().map(String).join(' ');
        expect(logged).not.toContain(providerToken);
        expect(logged).not.toContain(rawPhone);
        expect(logged).not.toContain('Kakao Nickname');
    });
});

function installAuthenticatedUser(user: Record<string, unknown>) {
    routeMocks.getMeUser.mockResolvedValue({
        data: { user },
        error: null,
    });
    routeMocks.createClient.mockResolvedValue({
        auth: { getUser: routeMocks.getMeUser },
    });
}

function installUserAdminResults(
    ...results: Array<{ data: unknown; error: unknown }>
) {
    const query = {
        select: routeMocks.select,
        eq: routeMocks.eq,
        single: routeMocks.single,
        insert: routeMocks.insert,
        update: routeMocks.update,
    };
    routeMocks.select.mockReturnValue(query);
    routeMocks.eq.mockReturnValue(query);
    routeMocks.insert.mockReturnValue(query);
    routeMocks.update.mockReturnValue(query);
    for (const result of results) {
        routeMocks.single.mockResolvedValueOnce(result);
    }
    routeMocks.from.mockImplementation((table: string) => {
        if (table !== 'users') throw new Error(`unexpected table: ${table}`);
        return query;
    });
}

function privateDatabaseError(code: string) {
    return {
        code,
        message: `database rejected ${PRIVATE_PHONE}`,
        details: `phone_number_normalized=+821099998888`,
        hint: 'Private Name',
    };
}

async function expectSafeUserResponse(
    response: Response,
    expectedUser: Record<string, unknown>
) {
    expect(response.status).toBe(200);
    const body = await response.json() as { user: Record<string, unknown> };
    expect(body).toEqual({ user: expectedUser });
    expect(Object.keys(body.user).sort()).toEqual(
        Object.keys(SAFE_USER_DTO).sort()
    );
    expect(body.user).not.toHaveProperty('phone_number');
    expect(body.user).not.toHaveProperty('phone_number_normalized');
}

function expectNoPrivateLog(calls: readonly unknown[][]) {
    const logged = calls.flat().map(String).join(' ');
    expect(logged).not.toContain(PRIVATE_PHONE);
    expect(logged).not.toContain('+821099998888');
    expect(logged).not.toContain('phone_number');
    expect(logged).not.toContain('Private Name');
    expect(logged).not.toContain('database rejected');
}

describe('/api/user/me profile persistence', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('inserts trusted user.phone as an atomic pair and returns only the safe DTO', async () => {
        installAuthenticatedUser({
            id: USER_ID,
            email: 'user@example.com',
            phone: '  010-9876-5432  ',
            phone_confirmed_at: '2026-07-18T00:00:00.000Z',
            app_metadata: { provider: 'kakao' },
            user_metadata: {
                full_name: '  Full Name  ',
                preferred_username: '  Preferred Nick  ',
                avatar_url: '  https://example.com/social.jpg  ',
                phone_number: '010-0000-0000',
                gender: '  female  ',
                birth_year: 1994,
            },
        });
        const createdDto = {
            ...SAFE_USER_DTO,
            analysis_count: 0,
            is_paid_user: false,
        };
        installUserAdminResults(
            { data: null, error: { code: 'PGRST116' } },
            { data: privateUserRow(createdDto), error: null }
        );

        const response = await getCurrentUser();

        await expectSafeUserResponse(response, createdDto);
        expect(routeMocks.insert).toHaveBeenCalledWith({
            id: USER_ID,
            email: 'user@example.com',
            provider: 'kakao',
            analysis_count: 0,
            is_paid_user: false,
            is_unlimited: false,
            name: 'Full Name',
            nickname: 'Preferred Nick',
            profile_image: 'https://example.com/social.jpg',
            phone_number: '010-9876-5432',
            phone_number_normalized: '+821098765432',
            gender: 'female',
            birthyear: '1994',
        });
        expect(routeMocks.select).toHaveBeenNthCalledWith(1, USER_INTERNAL_COLUMNS);
        expect(routeMocks.select).toHaveBeenNthCalledWith(2, USER_RESPONSE_COLUMNS);
        expect(routeMocks.update).not.toHaveBeenCalled();
    });

    it('ignores forged Kakao metadata phones when verified user.phone is absent', async () => {
        installAuthenticatedUser({
            id: USER_ID,
            email: 'user@example.com',
            phone: undefined,
            app_metadata: { provider: 'kakao' },
            user_metadata: {
                nickname: '  Kakao Nick  ',
                phone_number: '010-1234-5678',
                phone: '+82 10-1234-5678',
            },
        });
        const createdDto = {
            ...SAFE_USER_DTO,
            analysis_count: 0,
            is_paid_user: false,
        };
        installUserAdminResults(
            { data: null, error: { code: 'PGRST116' } },
            { data: privateUserRow(createdDto), error: null }
        );

        const response = await getCurrentUser();

        await expectSafeUserResponse(response, createdDto);
        const inserted = routeMocks.insert.mock.calls[0]?.[0];
        expect(inserted).toEqual(expect.objectContaining({
            provider: 'kakao',
            nickname: 'Kakao Nick',
        }));
        expect(inserted).not.toHaveProperty('phone_number');
        expect(inserted).not.toHaveProperty('phone_number_normalized');
    });

    it('ignores forged Google metadata phones and preserves a partial stored pair', async () => {
        installAuthenticatedUser({
            id: USER_ID,
            email: 'user@example.com',
            phone: undefined,
            app_metadata: { provider: 'google' },
            user_metadata: {
                nickname: '  Google Nick  ',
                phone_number: '010-1234-5678',
                phone: '+82 10-1234-5678',
            },
        });
        const googleDto = { ...SAFE_USER_DTO, provider: 'google' };
        const existingUser = privateUserRow({
            ...googleDto,
            nickname: null,
            phone_number: PRIVATE_PHONE,
            phone_number_normalized: null,
        });
        installUserAdminResults(
            { data: existingUser, error: null },
            { data: privateUserRow(googleDto), error: null }
        );

        const response = await getCurrentUser();

        await expectSafeUserResponse(response, googleDto);
        expect(routeMocks.update).toHaveBeenCalledWith({
            nickname: 'Google Nick',
        });
        const updated = routeMocks.update.mock.calls[0]?.[0];
        expect(updated).not.toHaveProperty('phone_number');
        expect(updated).not.toHaveProperty('phone_number_normalized');
    });

    it('synchronizes both fields over a partially populated row when user.phone is present', async () => {
        installAuthenticatedUser({
            id: USER_ID,
            email: 'user@example.com',
            phone: '  010-1111-2222  ',
            phone_confirmed_at: '2026-07-18T00:00:00.000Z',
            app_metadata: { provider: 'kakao' },
            user_metadata: {
                gender: '  male  ',
                birthyear: '  1996  ',
            },
        });
        const existingUser = privateUserRow({
            phone_number: PRIVATE_PHONE,
            phone_number_normalized: null,
            gender: null,
            birthyear: null,
        });
        installUserAdminResults(
            { data: existingUser, error: null },
            { data: privateUserRow(), error: null }
        );

        const response = await getCurrentUser();

        await expectSafeUserResponse(response, SAFE_USER_DTO);
        expect(routeMocks.update).toHaveBeenCalledWith({
            phone_number: '010-1111-2222',
            phone_number_normalized: '+821011112222',
            gender: 'male',
            birthyear: '1996',
        });
        expect(routeMocks.select).toHaveBeenNthCalledWith(2, USER_RESPONSE_COLUMNS);
        expect(routeMocks.insert).not.toHaveBeenCalled();
    });

    it('clears both stored fields atomically for a present but invalid user.phone', async () => {
        installAuthenticatedUser({
            id: USER_ID,
            email: 'user@example.com',
            phone: 'not-a-phone',
            phone_confirmed_at: '2026-07-18T00:00:00.000Z',
            app_metadata: { provider: 'kakao' },
            user_metadata: {},
        });
        installUserAdminResults(
            { data: privateUserRow(), error: null },
            { data: privateUserRow({
                phone_number: null,
                phone_number_normalized: null,
            }), error: null }
        );

        const response = await getCurrentUser();

        await expectSafeUserResponse(response, SAFE_USER_DTO);
        expect(routeMocks.update).toHaveBeenCalledWith({
            phone_number: null,
            phone_number_normalized: null,
        });
    });

    it('does not synchronize an unconfirmed user.phone value', async () => {
        installAuthenticatedUser({
            id: USER_ID,
            email: 'user@example.com',
            phone: '010-1111-2222',
            phone_confirmed_at: undefined,
            app_metadata: { provider: 'kakao' },
            user_metadata: {},
        });
        installUserAdminResults({
            data: privateUserRow({
                phone_number: PRIVATE_PHONE,
                phone_number_normalized: null,
            }),
            error: null,
        });

        const response = await getCurrentUser();

        await expectSafeUserResponse(response, SAFE_USER_DTO);
        expect(routeMocks.update).not.toHaveBeenCalled();
        expect(routeMocks.insert).not.toHaveBeenCalled();
    });

    it('returns only the safe DTO when no profile update is needed', async () => {
        installAuthenticatedUser({
            id: USER_ID,
            email: 'user@example.com',
            phone: undefined,
            app_metadata: { provider: 'kakao' },
            user_metadata: {},
        });
        installUserAdminResults({ data: privateUserRow(), error: null });

        const response = await getCurrentUser();

        await expectSafeUserResponse(response, SAFE_USER_DTO);
        expect(routeMocks.select).toHaveBeenCalledWith(USER_INTERNAL_COLUMNS);
        expect(routeMocks.update).not.toHaveBeenCalled();
        expect(routeMocks.insert).not.toHaveBeenCalled();
    });

    it('logs only a bounded code on read failure', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        installAuthenticatedUser({
            id: USER_ID,
            email: 'user@example.com',
            app_metadata: { provider: 'kakao' },
            user_metadata: {},
        });
        installUserAdminResults({
            data: null,
            error: privateDatabaseError('PGRST500'),
        });

        const response = await getCurrentUser();

        expect(response.status).toBe(500);
        expect(routeMocks.insert).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledWith(
            'user.me database failure',
            'read',
            'PGRST500'
        );
        expectNoPrivateLog(errorSpy.mock.calls);
    });

    it('logs only a bounded code on insert failure', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        installAuthenticatedUser({
            id: USER_ID,
            email: 'user@example.com',
            app_metadata: { provider: 'kakao' },
            user_metadata: {},
        });
        installUserAdminResults(
            { data: null, error: { code: 'PGRST116' } },
            { data: null, error: privateDatabaseError('23505') }
        );

        const response = await getCurrentUser();

        expect(response.status).toBe(500);
        expect(errorSpy).toHaveBeenCalledWith(
            'user.me database failure',
            'insert',
            '23505'
        );
        expectNoPrivateLog(errorSpy.mock.calls);
    });

    it('logs only a bounded code on update failure', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        installAuthenticatedUser({
            id: USER_ID,
            email: 'user@example.com',
            phone: '010-1111-2222',
            phone_confirmed_at: '2026-07-18T00:00:00.000Z',
            app_metadata: { provider: 'kakao' },
            user_metadata: {},
        });
        installUserAdminResults(
            { data: privateUserRow(), error: null },
            { data: null, error: privateDatabaseError('PGRST204') }
        );

        const response = await getCurrentUser();

        expect(response.status).toBe(500);
        expect(errorSpy).toHaveBeenCalledWith(
            'user.me database failure',
            'update',
            'PGRST204'
        );
        expectNoPrivateLog(errorSpy.mock.calls);
    });

    it('does not log caught error details', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        routeMocks.createClient.mockRejectedValue(new Error(
            `unexpected ${PRIVATE_PHONE} Private Name`
        ));

        const response = await getCurrentUser();

        expect(response.status).toBe(500);
        expect(errorSpy).toHaveBeenCalledWith(
            'user.me failure',
            'unexpected'
        );
        expectNoPrivateLog(errorSpy.mock.calls);
    });
});

describe('buildAuthProfilePatch', () => {
    it('stores trimmed raw and canonical phone numbers together', () => {
        expect(buildAuthProfilePatch({
            phone: {
                mode: 'synchronize',
                value: '  +82 10-1234-5678  ',
            },
        })).toEqual({
            phone_number: '+82 10-1234-5678',
            phone_number_normalized: '+821012345678',
        });
    });

    it.each([
        '010-12-34',
        '   ',
        undefined,
    ])('clears both phone fields when synchronized value %s is invalid or absent', value => {
        expect(buildAuthProfilePatch({
            phone: { mode: 'synchronize', value },
        })).toEqual({
            phone_number: null,
            phone_number_normalized: null,
        });
    });

    it.each([
        {},
        { phone: { mode: 'preserve' as const } },
    ] satisfies AuthProfileSource[])('omits both phone fields in preserve mode', source => {
        const patch = buildAuthProfilePatch(source);

        expect(patch).not.toHaveProperty('phone_number');
        expect(patch).not.toHaveProperty('phone_number_normalized');
    });

    it('uses ordered fallbacks, trims strings, and coerces a numeric birthyear', () => {
        expect(buildAuthProfilePatch({
            name: [null, '   ', '  Account Name  ', 'Ignored Name'],
            nickname: [undefined, '  Nickname  '],
            profileImage: ['', '  https://example.com/avatar.jpg  '],
            gender: [false, '  female  '],
            birthyear: [null, 1997],
            phone: {
                mode: 'synchronize',
                value: '  010-9876-5432  ',
            },
        })).toEqual({
            name: 'Account Name',
            nickname: 'Nickname',
            profile_image: 'https://example.com/avatar.jpg',
            gender: 'female',
            birthyear: '1997',
            phone_number: '010-9876-5432',
            phone_number_normalized: '+821098765432',
        });
    });

    it('never copies email or provider into the profile patch', () => {
        const sourceWithForbiddenKeys = {
            name: ['  Kakao User  '],
            email: 'private@example.com',
            provider: 'kakao',
        } as AuthProfileSource & Record<'email' | 'provider', unknown>;

        const patch = buildAuthProfilePatch(sourceWithForbiddenKeys);

        expect(patch).toEqual({ name: 'Kakao User' });
        expect(patch).not.toHaveProperty('email');
        expect(patch).not.toHaveProperty('provider');
    });
});

describe('auth button provider compatibility contract', () => {
    const source = readFileSync(
        new URL('../../../components/auth-buttons.tsx', import.meta.url),
        'utf8'
    );
    it.each([
        ['login', '\uce74\uce74\uc624\ub85c 3\ucd08 \ub9cc\uc5d0 \uc2dc\uc791\ud558\uae30'],
        ['signup', '\uce74\uce74\uc624\ub85c \ud68c\uc6d0\uac00\uc785'],
    ] as const)('renders only the Kakao %s action and copy', (label, copy) => {
        const markup = renderToStaticMarkup(createElement(AuthButtons, { label }));

        expect(markup.match(/<button\b/g)).toHaveLength(1);
        expect(markup).toContain(copy);
        expect(markup).not.toMatch(/google|Google/);
    });

    it('keeps the internal Google OAuth branch for legacy compatibility', () => {
        expect(source).toContain("provider: 'kakao' | 'google'");
        expect(source).toMatch(
            /provider === 'kakao'[\s\S]*?: undefined/
        );
        expect(source).toMatch(/signInWithOAuth\(\{\s*provider,/);
    });
});

describe('auth profile integration contract', () => {
    const callbackSource = readFileSync(
        new URL('../../../app/auth/callback/route.ts', import.meta.url),
        'utf8'
    );
    const meRouteSource = readFileSync(
        new URL('../../../app/api/user/me/route.ts', import.meta.url),
        'utf8'
    );

    it('maps Kakao REST profile fallbacks through the shared helper', () => {
        expect(callbackSource).toContain('buildAuthProfilePatch({');
        expect(callbackSource).toMatch(
            /name:\s*\[account\.name,\s*profile\.nickname\]/
        );
        expect(callbackSource).toMatch(
            /profileImage:\s*\[profile\.profile_image_url,\s*profile\.thumbnail_image_url\]/
        );
        expect(callbackSource).toMatch(
            /phone:\s*\{\s*mode:\s*'synchronize',\s*value:\s*account\.phone_number/
        );
    });

    it('keeps Kakao profile values and the provider token out of logs', () => {
        const logCalls = callbackSource.match(
            /console\.(?:error|log|warn)\([^;]*\);/g
        ) ?? [];
        const consoleCallCount = callbackSource.match(
            /console\.(?:error|log|warn)\(/g
        )?.length ?? 0;

        expect(logCalls).toHaveLength(consoleCallCount);
        expect(logCalls.join('\n')).not.toMatch(
            /\b(?:providerToken|provider_token|data|account|profilePatch|phone_number|profile_image|nickname|gender|birthyear|email|name)\b|error\.message/
        );
    });

    it('maps Supabase social metadata fallbacks through the shared helper', () => {
        expect(meRouteSource).toContain('buildAuthProfilePatch({');
        expect(meRouteSource).toMatch(/name:\s*\[m\.name,\s*m\.full_name\]/);
        expect(meRouteSource).toMatch(
            /nickname:\s*\[m\.nickname,\s*m\.preferred_username,\s*m\.user_name,\s*m\.name\]/
        );
        expect(meRouteSource).toMatch(
            /profileImage:\s*\[m\.avatar_url,\s*m\.picture,\s*m\.profile_image\]/
        );
        expect(meRouteSource).toMatch(/value:\s*user\.phone/);
        expect(meRouteSource).not.toMatch(/m\.(?:phone_number|phone)\b/);
        expect(meRouteSource).toMatch(
            /birthyear:\s*\[m\.birthyear,\s*m\.birth_year\]/
        );
    });
});
