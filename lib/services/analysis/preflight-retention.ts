import { supabaseAdmin } from '@/lib/supabase/admin';

export const PREFLIGHT_RETENTION_BATCH_LIMIT = 250;

interface RetentionRpcClient {
    rpc(
        name: string,
        params: { p_limit: number }
    ): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
}

export interface PreflightRetentionSummary {
    expiredPurged: number;
    terminalScrubbed: number;
}

function boundedCount(value: unknown, maximum: number, operation: string): number {
    if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
        throw new Error(`PREFLIGHT_RETENTION_ERROR: invalid ${operation} result.`);
    }
    return Number(value);
}

async function runRpc(
    client: RetentionRpcClient,
    name: string,
    maximum: number
): Promise<number> {
    const { data, error } = await client.rpc(name, {
        p_limit: PREFLIGHT_RETENTION_BATCH_LIMIT,
    });
    if (error) throw new Error(`PREFLIGHT_RETENTION_ERROR: ${name} failed.`);
    return boundedCount(data, maximum, name);
}

export async function runPreflightRetention(
    client: RetentionRpcClient = supabaseAdmin
): Promise<PreflightRetentionSummary> {
    const expiredPurged = await runRpc(
        client,
        'purge_expired_analysis_v2_preflights',
        PREFLIGHT_RETENTION_BATCH_LIMIT * 2
    );
    const terminalScrubbed = await runRpc(
        client,
        'scrub_terminal_analysis_v2_preflights',
        PREFLIGHT_RETENTION_BATCH_LIMIT
    );
    return { expiredPurged, terminalScrubbed };
}
