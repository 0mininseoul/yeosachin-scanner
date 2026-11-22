export function isPostgresStatementTimeout(error: { code?: string; message?: string } | null): boolean {
    return error?.code === '57014' && error.message === 'canceling statement due to statement timeout';
}

/** Repeat the same database statement after a confirmed PostgreSQL rollback. */
export async function retryPostgresAbortedRpc<
    T extends { error: { code?: string; message?: string } | null }
>(execute: () => PromiseLike<T>, { retryDeadlock = true } = {}): Promise<T> {
    const result = await execute();
    if (
        isPostgresStatementTimeout(result.error)
        || (retryDeadlock && result.error?.code === '40P01' && result.error.message === 'deadlock detected')
    ) {
        return execute();
    }
    return result;
}
