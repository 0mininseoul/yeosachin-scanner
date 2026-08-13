import { createServerClient } from '@supabase/ssr';
import { createClient as createAccessTokenClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { after, NextResponse } from 'next/server';
import {
    appOriginForRequest,
    appRedirectUrlForRequest,
} from '@/lib/constants/app-url';
import { buildAuthProfilePatch } from '@/lib/services/identity/auth-profile';
import {
    AccountPrincipalPersistenceError,
    loadAccountClassification,
    upsertKakaoAccountProfile,
    type KakaoAccountProfile,
} from '@/lib/services/identity/account-principal-store';
import {
    deliverKakaoSignupDiscordNotifications,
    stageKakaoSignupDiscordProfile,
} from '@/lib/services/identity/kakao-signup-discord';
import { KAKAO_ATTRIBUTION_COOKIE, readKakaoSignupAttribution } from '@/lib/services/identity/kakao-signup-attribution';
import {
    observeRoute,
    type OperationalRequestContext,
} from '@/lib/observability/request';
import { operationalLogger } from '@/lib/observability/server';
import {
    claimAnonymousAnalysisV2Preflight,
    type AnonymousPreflightClient,
} from '@/lib/services/analysis/anonymous-preflight';
import {
    AUTH_REDIRECT_INTENT_COOKIE,
    readAnonymousPreflightOAuthContinuation,
    readOAuthRedirectIntent,
    selectOAuthRedirectIntent,
} from '@/lib/services/auth/oauth-redirect-intent';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

async function stageUnavailableKakaoSignupProfile(
    userId: string,
    signedUpAt: Date,
    attribution: { label: string | null; origin: string | null },
): Promise<void> {
    await stageKakaoSignupDiscordProfile(userId, {
        name: null,
        birthyear: null,
        gender: null,
        signedUpAt,
        attributionLabel: attribution.label, attributionOrigin: attribution.origin,
    });
}

function scheduleKakaoSignupDiscordDelivery(userId: string): void {
    // `after` keeps this best-effort work outside the auth response. Return the
    // delivery lifecycle to Next so the runtime can keep it alive, while still
    // absorbing unexpected delivery failures.
    const deliver = async (): Promise<void> => {
        await deliverKakaoSignupDiscordNotifications({ userId }).catch(() => undefined);
    };

    try {
        after(deliver);
    } catch {
        // Local/test runtimes can reject `after`; still attempt delivery without
        // ever making the successful OAuth callback depend on it.
        void deliver();
    }
}

// 카카오 성별·출생연도·전화번호 등은 OIDC ID 토큰에 없고 REST API(/v2/user/me)에만 있으므로,
// 로그인 직후 확보한 provider_token(카카오 access token)으로 직접 조회해 users 테이블에 저장한다.
async function syncKakaoProfile(
    userId: string,
    email: string | undefined,
    providerToken: string,
    signedUpAt: Date,
    attribution: { label: string | null; origin: string | null },
): Promise<'PROVIDER_ERROR' | 'INTERNAL_ERROR' | 'ACCOUNT_RETIRED' | null> {
    const res = await fetch('https://kapi.kakao.com/v2/user/me', {
        headers: { Authorization: `Bearer ${providerToken}` },
        cache: 'no-store',
    });
    if (!res.ok) {
        console.error('Kakao /v2/user/me failed:', res.status);
        await stageUnavailableKakaoSignupProfile(userId, signedUpAt, attribution);
        return 'PROVIDER_ERROR';
    }
    const data: unknown = await res.json();
    const account = asRecord(asRecord(data).kakao_account);
    const profile = asRecord(account.profile);
    const profilePatch = buildAuthProfilePatch({
        name: [account.name, profile.nickname],
        nickname: [profile.nickname],
        profileImage: [profile.profile_image_url, profile.thumbnail_image_url],
        gender: [account.gender],
        birthyear: [account.birthyear],
        phone: {
            mode: 'synchronize',
            value: account.phone_number,
        },
    });
    const phoneProvenancePatch: Pick<
        KakaoAccountProfile,
        'phone_number_verification_source' | 'phone_number_verified_at'
    > = profilePatch.phone_number_normalized
        ? {
            phone_number_verification_source: 'kakao_rest_api',
            phone_number_verified_at: new Date().toISOString(),
        }
        : {
            phone_number_verification_source: null,
            phone_number_verified_at: null,
        };

    try {
        await upsertKakaoAccountProfile({
            userId,
            email: email ?? null,
            profile: {
                ...profilePatch,
                ...phoneProvenancePatch,
            },
        });
    } catch (error) {
        const databaseCode = error instanceof AccountPrincipalPersistenceError
            ? error.databaseCode
            : 'unknown';
        console.error('users upsert (kakao profile) failed:', databaseCode);
        if (error instanceof AccountPrincipalPersistenceError
            && error.code === 'ACCOUNT_RETIRED') {
            return 'ACCOUNT_RETIRED';
        }
        await stageUnavailableKakaoSignupProfile(userId, signedUpAt, attribution);
        return 'INTERNAL_ERROR';
    }
    await stageKakaoSignupDiscordProfile(userId, {
        name: account.name ?? profile.nickname,
        birthyear: account.birthyear,
        gender: account.gender,
        signedUpAt,
        attributionLabel: attribution.label, attributionOrigin: attribution.origin,
    });
    return null;
}

function authProvider(value: unknown): 'google' | 'kakao' | undefined {
    return value === 'google' || value === 'kakao' ? value : undefined;
}

function redirectAndClearOAuthIntent(url: URL): NextResponse {
    const response = NextResponse.redirect(url);
    response.cookies.delete(AUTH_REDIRECT_INTENT_COOKIE);
    return response;
}

async function redirectUnavailableAccount(
    signOut: () => Promise<unknown>,
    appOrigin: string,
): Promise<NextResponse> {
    await signOut().catch(() => undefined);
    const loginUrl = new URL('/login', appOrigin);
    loginUrl.searchParams.set('error', 'account_unavailable');
    return redirectAndClearOAuthIntent(loginUrl);
}

type AnonymousClaimRestoreErrorCode = 'UNAUTHORIZED' | 'PREFLIGHT_PERSISTENCE_ERROR';

interface AnonymousClaimRestoreResult {
    redirectUrl: URL;
    errorCode?: AnonymousClaimRestoreErrorCode;
}

function anonymousClaimRestoreErrorCode(error: unknown): AnonymousClaimRestoreErrorCode {
    if (
        error instanceof Error
        && (
            error.name === 'AnonymousPreflightClaimInvalidError'
            || error.message === 'ANONYMOUS_PREFLIGHT_CLAIM_INVALID'
            || error.message.startsWith('ANONYMOUS_PREFLIGHT_INVALID_')
        )
    ) return 'UNAUTHORIZED';
    return 'PREFLIGHT_PERSISTENCE_ERROR';
}

function anonymousClaimRpcCode(error: unknown): string {
    if (!error || typeof error !== 'object') return 'unknown';
    const code = (error as { rpcCode?: unknown }).rpcCode;
    return typeof code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(code)
        ? code
        : 'unknown';
}

async function restoreAnonymousPreflightClaim(
    requestUrl: string,
    rawNext: string | null,
    userId: string | undefined,
    client: AnonymousPreflightClient,
    browserClaimFallback: string | null = null,
): Promise<AnonymousClaimRestoreResult> {
    const candidates = [rawNext];
    if (
        browserClaimFallback
        && browserClaimFallback !== rawNext
        && rawNext
    ) {
        try {
            const primaryUrl = appRedirectUrlForRequest(requestUrl, rawNext);
            const fallbackUrl = appRedirectUrlForRequest(requestUrl, browserClaimFallback);
            const primaryPreflightId = primaryUrl.searchParams.get('preflight');
            const fallbackPreflightId = fallbackUrl.searchParams.get('preflight');
            // A browser cookie is a fallback only for the same bounded preflight.
            // This prevents a provider-supplied explicit destination from being
            // combined with a claim for another anonymous request.
            if (
                primaryUrl.pathname === '/analyze'
                && fallbackUrl.pathname === '/analyze'
                && primaryPreflightId
                && UUID_PATTERN.test(primaryPreflightId)
                && fallbackPreflightId
                && UUID_PATTERN.test(fallbackPreflightId)
                && primaryPreflightId.toLowerCase() === fallbackPreflightId.toLowerCase()
                && fallbackUrl.searchParams.get('claim')
            ) {
                candidates.push(browserClaimFallback);
            }
        } catch {
            // appRedirectUrlForRequest performs the final redirect validation.
        }
    }

    let errorCode: AnonymousClaimRestoreErrorCode | undefined;
    for (const candidate of candidates) {
        const redirectUrl = appRedirectUrlForRequest(requestUrl, candidate);
        const preflightId = redirectUrl.searchParams.get('preflight');
        const claimToken = redirectUrl.searchParams.get('claim');
        if (!preflightId && !claimToken) return { redirectUrl };
        if (
            redirectUrl.pathname !== '/analyze'
            || !userId
            || !preflightId
            || !UUID_PATTERN.test(preflightId)
            || !claimToken
        ) {
            errorCode = 'UNAUTHORIZED';
            continue;
        }
        try {
            const claimResult = await claimAnonymousAnalysisV2Preflight(
                preflightId,
                claimToken,
                userId,
                { client },
            );
            // Keep the boolean fallback for test/runtime adapters that still
            // expose the pre-migration claim result shape.
            const claimed = typeof claimResult === 'boolean'
                ? { claimed: claimResult, ownerPreflightId: null }
                : claimResult;
            if (!claimed.claimed) {
                if (claimed.ownerPreflightId) {
                    redirectUrl.searchParams.set(
                        'preflight',
                        claimed.ownerPreflightId,
                    );
                    redirectUrl.searchParams.delete('claim');
                    return { redirectUrl };
                }
                errorCode = 'UNAUTHORIZED';
                continue;
            }
            redirectUrl.searchParams.delete('claim');
            return { redirectUrl };
        } catch (error) {
            // A provider can preserve a malformed/stale continuation while the
            // same-browser signed claim remains valid in the fallback cookie.
            // Try that bounded, same-preflight capability before failing closed.
            console.warn('Auth callback anonymous preflight claim RPC failed', {
                operation: 'claim',
                rpc_code: anonymousClaimRpcCode(error),
            });
            errorCode = anonymousClaimRestoreErrorCode(error);
        }
    }

    return {
        redirectUrl: new URL('/analyze?claim=restore_failed', appOriginForRequest(requestUrl)),
        errorCode: errorCode ?? 'UNAUTHORIZED',
    };
}

async function handleGET(
    request: Request,
    context: OperationalRequestContext,
): Promise<NextResponse> {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');
    const appOrigin = appOriginForRequest(request.url);
    const cookieNext = readOAuthRedirectIntent(request.headers.get('cookie'));
    const callbackContinuation = readAnonymousPreflightOAuthContinuation(searchParams);

    if (!code) {
        operationalLogger.emit({
            event: 'auth.callback_completed',
            severity: 'warn',
            fields: {
                ...context,
                operation: 'callback',
                disposition: 'rejected',
                error_code: 'INVALID_REQUEST',
            },
        });
        return redirectAndClearOAuthIntent(new URL('/login?error=no_code', appOrigin));
    }

    const cookieStore = await cookies();

    // Supabase 클라이언트 생성 - cookieStore.set() 사용 (Next.js 네이티브 방식)
    const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {
                getAll() {
                    return cookieStore.getAll();
                },
                setAll(cookiesToSet) {
                    cookiesToSet.forEach(({ name, value, options }) => {
                        cookieStore.set(name, value, options);
                    });
                },
            },
        }
    );

    // 코드 교환 실행
    const exchangeResult = await supabase.auth.exchangeCodeForSession(code).catch(() => null);

    if (!exchangeResult || exchangeResult.error) {
        console.error('Auth callback exchange failed');
        operationalLogger.emit({
            event: 'auth.callback_completed',
            severity: 'warn',
            fields: {
                ...context,
                operation: 'callback',
                disposition: 'rejected',
                error_code: 'PROVIDER_ERROR',
            },
        });
        const loginUrl = new URL('/login', appOrigin);
        loginUrl.searchParams.set('error', 'exchange_failed');
        return redirectAndClearOAuthIntent(loginUrl);
    }
    const exchange = exchangeResult.data;

    // 세션 검증을 통해 쿠키 설정 강제 (setAll 트리거)
    await supabase.auth.getUser();

    // The claim RPC is SECURITY INVOKER and its UPDATE policy is granted only
    // to `authenticated`. The server cookie client has just exchanged the code,
    // but its PostgREST request must still carry that access token explicitly;
    // otherwise the claim is evaluated as the public anon role and fails before
    // the RLS boundary can transfer ownership. This client is still anon-key
    // backed, so the database policy—not the service role—remains authoritative.
    const claimAccessToken = exchange?.session?.access_token;
    const claimClient = claimAccessToken
        ? createAccessTokenClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            {
                auth: {
                    autoRefreshToken: false,
                    persistSession: false,
                },
                // Keep the authorization identity explicit on the request. The
                // accessToken callback is the normal Supabase path, while this
                // header also protects the RLS claim RPC from a server-runtime
                // client losing the exchanged session between requests.
                global: {
                    headers: {
                        Authorization: `Bearer ${claimAccessToken}`,
                    },
                },
                accessToken: async () => claimAccessToken,
            },
        )
        : supabase;

    const session = exchange?.session;
    const authedUser = exchange?.user;
    if (authedUser) {
        try {
            const classification = await loadAccountClassification(authedUser.id);
            if (classification?.lifecycle === 'retired') {
                return redirectUnavailableAccount(
                    () => supabase.auth.signOut({ scope: 'local' }),
                    appOrigin,
                );
            }
        } catch {
            // A lifecycle check must not fail open after a session exchange.
            return redirectUnavailableAccount(
                () => supabase.auth.signOut({ scope: 'local' }),
                appOrigin,
            );
        }
    }

    // 카카오: REST API로 성별·출생연도·전화번호 등 보강 저장
    const provider = authProvider(authedUser?.app_metadata?.provider);
    if (authedUser && provider === 'kakao') {
        const signedUpAt = new Date(authedUser.created_at ?? Date.now());
        // Some supported test/runtime cookie adapters expose only the Supabase
        // getAll/setAll surface; absence simply means no attribution label.
        const getAttributionCookie = (cookieStore as { get?: (name: string) => { value?: string } | undefined }).get;
        const attribution = readKakaoSignupAttribution(
            typeof getAttributionCookie === 'function' ? getAttributionCookie(KAKAO_ATTRIBUTION_COOKIE)?.value : undefined,
        );
        let errorCode:
            | 'PROVIDER_ERROR'
            | 'INTERNAL_ERROR'
            | 'ACCOUNT_RETIRED'
            | null;
        if (!session?.provider_token) {
            await stageUnavailableKakaoSignupProfile(authedUser.id, signedUpAt, attribution);
            errorCode = 'PROVIDER_ERROR';
        } else {
            try {
                errorCode = await syncKakaoProfile(
                    authedUser.id,
                    authedUser.email ?? undefined,
                    session.provider_token,
                    signedUpAt,
                    attribution,
                );
            } catch {
                console.error('Kakao profile sync failed');
                await stageUnavailableKakaoSignupProfile(authedUser.id, signedUpAt, attribution);
                errorCode = 'INTERNAL_ERROR';
            }
        }
        if (errorCode) {
            if (errorCode === 'ACCOUNT_RETIRED') {
                return redirectUnavailableAccount(
                    () => supabase.auth.signOut({ scope: 'local' }),
                    appOrigin,
                );
            }
            operationalLogger.emit({
                event: 'auth.profile_sync_failed',
                severity: 'warn',
                fields: {
                    ...context,
                    user_id: authedUser.id,
                    provider,
                    operation: 'profile_sync',
                    disposition: 'failed',
                    error_code: errorCode,
                },
            });
        }
        // The first-signup DB trigger is the only enqueue authority. Delivery runs
        // asynchronously so Discord cannot delay or fail a completed login.
        scheduleKakaoSignupDiscordDelivery(authedUser.id);
        const deleteAttributionCookie = (cookieStore as { delete?: (name: string) => void }).delete;
        if (typeof deleteAttributionCookie === 'function') deleteAttributionCookie(KAKAO_ATTRIBUTION_COOKIE);
    }

    const selectedRedirectIntent = selectOAuthRedirectIntent(
        callbackContinuation ?? searchParams.get('next'),
        cookieNext,
    );
    const claimRestore = await restoreAnonymousPreflightClaim(
        request.url,
        selectedRedirectIntent,
        authedUser?.id,
        claimClient,
        selectedRedirectIntent !== cookieNext ? cookieNext : null,
    );
    const redirectUrl = claimRestore.redirectUrl;
    redirectUrl.searchParams.set('verified', 'true');

    operationalLogger.emit({
        event: 'auth.callback_completed',
        severity: claimRestore.errorCode ? 'warn' : 'info',
        fields: {
            ...context,
            ...(authedUser ? { user_id: authedUser.id } : {}),
            ...(provider ? { provider } : {}),
            operation: 'callback',
            disposition: 'completed',
            ...(claimRestore.errorCode ? { error_code: claimRestore.errorCode } : {}),
        },
    });

    return redirectAndClearOAuthIntent(redirectUrl);
}

export async function GET(request: Request): Promise<NextResponse> {
    return observeRoute(request, '/auth/callback', context => handleGET(request, context));
}
