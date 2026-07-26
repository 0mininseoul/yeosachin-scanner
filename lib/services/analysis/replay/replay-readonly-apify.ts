export interface ReplayDatasetPage {
    offset: number;
    count: number;
    total: number;
    items: unknown[];
}

/** Deliberately has no actor(), start(), abort(), update(), or delete() capability. */
export interface ReplayReadonlyApifyClient {
    run(runId: string): { get(): Promise<{ status?: string; defaultDatasetId?: string | null }> };
    dataset(datasetId: string): { listItems(input: { offset: number; limit: number }): Promise<ReplayDatasetPage> };
}

export interface ReplayProviderLedgerIdentity {
    actorId: string;
    credentialSlot: string;
    runId: string | null;
}

export class AnalysisV2ReplayReadError extends Error {
    constructor(readonly code: string, _unsafeDetail?: string) {
        super(code);
        this.name = 'AnalysisV2ReplayReadError';
    }
}

function fail(code: string): never { throw new AnalysisV2ReplayReadError(code); }

export async function readCompletedApifyDatasetOnce(input: {
    client: ReplayReadonlyApifyClient;
    runId: string;
    expected: Required<ReplayProviderLedgerIdentity>;
    ledger: ReplayProviderLedgerIdentity;
    readState?: Set<string>;
    pageSize?: number;
    maxItems?: number;
    maxBytes?: number;
}): Promise<unknown[]> {
    const readState = input.readState ?? new Set<string>();
    const pageSize = input.pageSize ?? 500;
    const maxItems = input.maxItems ?? 20_000;
    const maxBytes = input.maxBytes ?? 64 * 1024 * 1024;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1_000 || !/^[A-Za-z0-9]{8,64}$/.test(input.runId)) fail('ANALYSIS_V2_REPLAY_APIFY_INPUT_INVALID');
    if (input.ledger.actorId !== input.expected.actorId || input.ledger.credentialSlot !== input.expected.credentialSlot || input.ledger.runId !== input.expected.runId || input.expected.runId !== input.runId) {
        fail('ANALYSIS_V2_REPLAY_PROVIDER_IDENTITY_MISMATCH');
    }
    const readKey = `${input.expected.credentialSlot}:${input.runId}`;
    if (readState.has(readKey)) fail('ANALYSIS_V2_REPLAY_DUPLICATE_DATASET_READ');
    readState.add(readKey);
    const run = await input.client.run(input.runId).get().catch(() => fail('ANALYSIS_V2_REPLAY_APIFY_RUN_UNAVAILABLE'));
    if (run.status !== 'SUCCEEDED') fail('ANALYSIS_V2_REPLAY_APIFY_RUN_NOT_SUCCEEDED');
    if (!run.defaultDatasetId || !/^[A-Za-z0-9]{1,64}$/.test(run.defaultDatasetId)) fail('ANALYSIS_V2_REPLAY_APIFY_DATASET_MISSING');
    const output: unknown[] = [];
    let offset = 0;
    let total: number | undefined;
    let byteCount = 0;
    while (total === undefined || offset < total) {
        const page = await input.client.dataset(run.defaultDatasetId).listItems({ offset, limit: Math.min(pageSize, maxItems - output.length) })
            .catch(() => fail('ANALYSIS_V2_REPLAY_APIFY_DATASET_UNAVAILABLE'));
        if (!Array.isArray(page.items) || !Number.isInteger(page.offset) || page.offset !== offset || !Number.isInteger(page.count) || page.count !== page.items.length || !Number.isInteger(page.total) || page.total < 0 || page.total > maxItems || (total !== undefined && total !== page.total) || offset + page.count > page.total || (page.count === 0 && offset < page.total)) {
            fail('ANALYSIS_V2_REPLAY_APIFY_DATASET_DRIFT');
        }
        total = page.total;
        for (const item of page.items) {
            const serialized = JSON.stringify(item);
            if (serialized === undefined) fail('ANALYSIS_V2_REPLAY_APIFY_DATASET_INVALID');
            byteCount += Buffer.byteLength(serialized, 'utf8');
            if (byteCount > maxBytes) fail('ANALYSIS_V2_REPLAY_APIFY_DATASET_LIMIT');
            output.push(item);
        }
        offset += page.count;
    }
    return output;
}
