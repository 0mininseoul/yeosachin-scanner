import { canonicalizeImageProxyUrl } from './image-proxy-token';
import type { AnalysisV2ResultImageLocator } from './image-proxy-token';

export const ANALYSIS_V2_RESULT_IMAGE_RPC = 'load_analysis_v2_result_image_url';

export async function resolveAnalysisV2ResultImageLocator(
    locator: AnalysisV2ResultImageLocator,
    userId: string
): Promise<string | null> {
    // Keep the service-role client out of the image route's module-load path. This
    // also lets malformed tokens fail before any database configuration is read.
    const { supabaseAdmin } = await import('@/lib/supabase/admin');
    const { data, error } = await supabaseAdmin.rpc(ANALYSIS_V2_RESULT_IMAGE_RPC, {
        p_request_id: locator.requestId,
        p_user_id: userId,
        p_kind: locator.kind,
        p_candidate_id: locator.candidateId,
    });
    if (error || typeof data !== 'string') return null;
    try {
        return canonicalizeImageProxyUrl(data);
    } catch {
        return null;
    }
}
