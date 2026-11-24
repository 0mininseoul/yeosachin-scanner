export function isPostgresStatementTimeout(error: { code?: string; message?: string } | null): boolean {
    return error?.code === '57014' && error.message === 'canceling statement due to statement timeout';
}

export function isPostgresLockTimeout(error: { code?: string; message?: string } | null): boolean {
    return error?.code === '55P03' && error.message === 'canceling statement due to lock timeout';
}

/** Repeat the same database statement after a confirmed PostgreSQL rollback. */
export async function retryPostgresAbortedRpc<
    T extends { error: { code?: string; message?: string } | null }
>(execute: () => PromiseLike<T>, { retryDeadlock = true, retryLockTimeout = false } = {}): Promise<T> {
    const result = await execute();
    if (
        isPostgresStatementTimeout(result.error)
        || (retryLockTimeout && isPostgresLockTimeout(result.error))
        || (retryDeadlock && result.error?.code === '40P01' && result.error.message === 'deadlock detected')
    ) {
        return execute();
    }
    return result;
}
