export const DEFAULT_DATABASE_PAGE_SIZE = 500;

export interface DatabasePage<T> {
    data: T[] | null;
    error: unknown;
}

/** Read a stable ordered query without relying on the Data API's server row limit. */
export async function readBoundedDatabasePages<T>(
    fetchPage: (from: number, to: number) => PromiseLike<DatabasePage<T>>,
    options: { pageSize?: number; maximumRows: number }
): Promise<T[]> {
    const pageSize = options.pageSize ?? DEFAULT_DATABASE_PAGE_SIZE;
    if (
        !Number.isSafeInteger(pageSize)
        || pageSize < 1
        || !Number.isSafeInteger(options.maximumRows)
        || options.maximumRows < pageSize
    ) {
        throw new Error('ANALYSIS_PERSISTENCE_ERROR: invalid database pagination bounds.');
    }

    const rows: T[] = [];
    while (rows.length < options.maximumRows) {
        const from = rows.length;
        const requestedCount = Math.min(pageSize, options.maximumRows - from);
        const page = await fetchPage(from, from + requestedCount - 1);
        if (page.error || !Array.isArray(page.data)) {
            throw new Error('ANALYSIS_PERSISTENCE_ERROR: paginated database read failed.');
        }
        if (page.data.length > requestedCount) {
            throw new Error('ANALYSIS_PERSISTENCE_ERROR: database page exceeded its requested range.');
        }

        rows.push(...page.data);
        if (page.data.length < requestedCount) return rows;
    }

    throw new Error('ANALYSIS_PERSISTENCE_ERROR: paginated database read exceeded its row cap.');
}
