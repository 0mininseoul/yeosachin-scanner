import { supabaseAdmin } from '@/lib/supabase/admin';

interface ResultPublicationAuthorityClient {
    rpc(
        functionName: 'analysis_result_publication_authorized',
        args: { p_request_id: string },
    ): PromiseLike<{ data: unknown; error: unknown }>;
}

/**
 * The request status is an execution state, not the paid-result publication
 * authority. Paid results are readable only after the database has confirmed
 * the matching order/fulfillment publication contract.
 */
export async function isAnalysisResultAuthoritativelyPublished(
    requestId: string,
    client: ResultPublicationAuthorityClient = supabaseAdmin as unknown as ResultPublicationAuthorityClient,
): Promise<boolean> {
    const { data, error } = await client.rpc(
        'analysis_result_publication_authorized',
        { p_request_id: requestId },
    );
    // An unavailable authority must preserve the waiting UX rather than
    // falling through to any result payload.  Callers intentionally treat
    // false as not-yet-published.
    if (error) return false;
    return data === true;
}
