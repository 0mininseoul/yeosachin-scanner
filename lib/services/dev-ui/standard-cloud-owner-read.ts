import 'server-only';

import type { User } from '@supabase/supabase-js';
import { z } from 'zod';
import { verifyAnalysisV2ResultImageProxyToken } from '@/lib/services/media/image-proxy-token';
import { devUiRequestBoundary } from './deployment';

type ReadUser = Pick<User, 'email' | 'email_confirmed_at' | 'app_metadata' | 'identities'>;
type OwnerClient = {
    rpc(name: 'dev_cloud_six_result_owner_v1', args: { p_wave: string; p_request_id: string }):
        PromiseLike<{ data: unknown; error: unknown }>;
};

function cloudWave(user: ReadUser): string | null {
    const wave = user.app_metadata?.dev_cloud_six_v1;
    const slot = user.app_metadata?.dev_cloud_six_slot;
    if (typeof wave !== 'string' || !/^[a-f0-9]{64}$/.test(wave) || !Number.isInteger(slot) || slot < 1 || slot > 6
        || user.app_metadata?.provider !== 'email') return null;
    const email = `dev-six-${wave.slice(0, 16)}-${slot}@example.invalid`;
    const identity = user.identities?.length === 1 ? user.identities[0] : undefined;
    return user.email === email && Boolean(user.email_confirmed_at) && identity?.provider === 'email'
        && identity.identity_data?.email === email ? wave : null;
}

function readRequestId(url: URL): string | null {
    const params = url.searchParams;
    if (url.pathname === '/api/image-proxy') {
        const result = params.get('result');
        const expires = params.get('expires');
        if (!result || !expires || new URLSearchParams({ result, expires }).toString() !== url.search.slice(1)) return null;
        return verifyAnalysisV2ResultImageProxyToken(result, expires)?.requestId ?? null;
    }
    const matched = /^\/(result|progress|api\/analysis\/v2\/result|api\/analysis\/progress)\/([^/]+)$/.exec(url.pathname);
    if (!matched || !z.string().uuid().safeParse(matched[2]).success
        || params.getAll('devAnalysis').length !== 1 || params.get('devAnalysis') !== 'live') return null;
    const keys = matched[1] === 'api/analysis/v2/result' ? ['pageSize', 'femaleCursor', 'privateCursor']
        : matched[1] === 'api/analysis/progress' ? ['limit', 'afterSeq', 'reviewAfterDone'] : ['_rsc'];
    return Array.from(params.keys()).every(key => key === 'devAnalysis' || (keys.includes(key) && params.getAll(key).length === 1))
        ? matched[2] : null;
}

/** The client is the same authenticated SSR client that verified this user with getUser. */
export async function isDevCloudSixOwnerRead(
    user: ReadUser | null, request: Pick<Request, 'url' | 'method'>, client: OwnerClient,
): Promise<boolean> {
    if (!user || request.method !== 'GET' || devUiRequestBoundary(request) !== 'dev') return false;
    const wave = cloudWave(user);
    if (!wave) return false;
    const requestId = readRequestId(new URL(request.url));
    if (!requestId) return false;
    const { data, error } = await client.rpc('dev_cloud_six_result_owner_v1', { p_wave: wave, p_request_id: requestId });
    if (error) throw new Error('DEV_CLOUD_SIX_READ_UNAVAILABLE');
    return data === true;
}
