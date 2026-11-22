import { OAuth2Client } from 'google-auth-library';

const SERVICE_ACCOUNT = /^[a-z0-9-]{1,63}@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;

export interface CherryWorkerAuth { audience: string; callers: readonly string[] }
interface TokenVerifier {
    verifyIdToken(options: { idToken: string; audience: string }): PromiseLike<{
        getPayload(): { email?: string; email_verified?: boolean } | undefined;
    }>;
}

let sharedVerifier: OAuth2Client | undefined;

/** Null outside the dedicated worker, so the public site never runs worker code. */
export function readCherryWorkerAuth(env: Record<string, string | undefined> = process.env): CherryWorkerAuth | null {
    if (env.CHERRY_WORKER_ENABLED?.trim() !== 'true') return null;
    let audience: URL;
    try {
        audience = new URL(env.CHERRY_WORKER_AUDIENCE ?? '');
    } catch {
        return null;
    }
    const callers = (env.CHERRY_WORKER_CALLERS ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
    if (audience.protocol !== 'https:' || audience.pathname !== '/' || audience.search || callers.length === 0
        || !callers.every(caller => SERVICE_ACCOUNT.test(caller))) return null;
    return { audience: audience.origin, callers };
}

export async function verifyCherryWorkerCaller(
    authorization: string | null, auth: CherryWorkerAuth, verifier: TokenVerifier = (sharedVerifier ??= new OAuth2Client()),
): Promise<boolean> {
    const idToken = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!idToken) return false;
    try {
        const payload = (await verifier.verifyIdToken({ idToken, audience: auth.audience })).getPayload();
        return payload?.email_verified === true && auth.callers.includes(payload.email?.toLowerCase() ?? '');
    } catch {
        return false;
    }
}
