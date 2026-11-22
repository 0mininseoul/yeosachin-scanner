import { supabaseAdmin } from '@/lib/supabase/admin';

export interface CherryRpcClient {
    rpc(name: string, params?: Record<string, unknown>): PromiseLike<{
        data: unknown; error: { code?: string; message?: string } | null;
    }>;
}

/** Database errors can echo row values, so only the code is kept. */
export class CherryDatabaseError extends Error {
    constructor(readonly operation: string, readonly databaseCode: string) {
        super(`CHERRY_DATABASE_ERROR: ${operation}`);
        this.name = 'CherryDatabaseError';
    }
}

export function assertNoDatabaseError(operation: string, error: { code?: string; message?: string } | null): void {
    if (!error) return;
    const fenced = error.message === 'CHERRY_CHECK_FENCE';
    throw new CherryDatabaseError(operation, fenced ? 'CHERRY_CHECK_FENCE' : String(error.code ?? 'unknown').slice(0, 16));
}

export async function cherryRpc<T>(
    name: string,
    params: Record<string, unknown> = {},
    client: CherryRpcClient = supabaseAdmin as unknown as CherryRpcClient,
): Promise<T> {
    const { data, error } = await client.rpc(name, params);
    assertNoDatabaseError(name, error);
    return data as T;
}
