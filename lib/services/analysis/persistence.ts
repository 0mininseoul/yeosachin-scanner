interface MutationResult<T> {
    data: T | null;
    error: unknown;
}

function persistenceError(operation: string): Error {
    return new Error(`ANALYSIS_PERSISTENCE_ERROR: ${operation} failed.`);
}

export function requireSingleMutationRow<T>(
    result: MutationResult<T>,
    operation: string
): T {
    if (result.error || result.data === null) {
        throw persistenceError(operation);
    }
    return result.data;
}

export function requireInsertedMutationRows<T>(
    result: MutationResult<T[]>,
    expectedCount: number,
    operation: string
): T[] {
    if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) {
        throw new Error('ANALYSIS_PERSISTENCE_CONFIG_ERROR: expected insert count is invalid.');
    }
    if (result.error || !Array.isArray(result.data) || result.data.length !== expectedCount) {
        throw persistenceError(operation);
    }
    return result.data;
}
