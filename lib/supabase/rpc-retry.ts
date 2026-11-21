/** Repeat the same database statement after a confirmed PostgreSQL timeout rollback. */
export async function retryPostgresStatementTimeout<
    T extends { error: { code?: string; message?: string } | null }
>(execute: () => PromiseLike<T>): Promise<T> {
    const result = await execute();
    if (
        result.error?.code === '57014'
        && result.error.message === 'canceling statement due to statement timeout'
    ) {
        return execute();
    }
    return result;
}
