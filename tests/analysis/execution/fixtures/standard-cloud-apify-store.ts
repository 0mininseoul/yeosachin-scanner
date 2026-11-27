import { GoogleAuth } from 'google-auth-library';
import { z } from 'zod';

const runId = z.string().regex(/^CloudQa[a-f0-9]{48}$/);
const nonce = z.uuidv4();
const wave = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.number().int().positive().max(8_640_000_000_000_000);
const count = z.number().int().min(1).max(20_000);
const indexes = (maximum: number) => z.array(z.number().int().min(0).max(maximum)).min(1).max(602);
const cost = z.number().min(0).max(0.001);
export const syntheticCloudBucket = 'gen-lang-client-0311522474-dev-standard-cloud-qa';

const selector = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('profiles'), indexes: indexes(601) }),
    z.strictObject({ kind: z.enum(['followers', 'followings']), limit: count }),
    z.strictObject({ kind: z.enum(['likes', 'comments']), indexes: indexes(603), limit: count }),
]);
const start = z.strictObject({
    version: z.literal(2), id: runId, selector, startedAtMs: timestamp,
    delayMs: z.number().int().min(0).max(300_000), usageUsd: cost,
});
const finish = z.strictObject({
    version: z.literal(2), id: runId, status: z.enum(['SUCCEEDED', 'ABORTED']), finishedAtMs: timestamp, usageUsd: cost,
});
const invocation = z.strictObject({ version: z.literal(2), id: runId.nullable(), nonce });

export type SyntheticCloudStart = z.infer<typeof start>;
export type SyntheticCloudFinish = z.infer<typeof finish>;
export type SyntheticCloudSelector = SyntheticCloudStart['selector'];
export type SyntheticCloudInvocationCounts = {
    sdkEntries: number; rejectedEntries: number; distinctAcceptedRuns: number;
    duplicateAcceptedEntries: number; runsCreated: number; acceptedWithoutRun: number; runsWithoutEntry: number;
};
export interface SyntheticCloudStore {
    readonly waveDigest: string;
    getStart(id: string): Promise<SyntheticCloudStart>;
    startOnce(record: SyntheticCloudStart): Promise<SyntheticCloudStart>;
    getFinish(id: string): Promise<SyntheticCloudFinish | null>;
    finishOnce(record: SyntheticCloudFinish): Promise<SyntheticCloudFinish>;
    recordInvocation(id: string | null, nonce: string): Promise<void>;
    invocationCounts(): Promise<SyntheticCloudInvocationCounts>;
}
interface ObjectRequest {
    url: string; method: 'POST' | 'GET'; params: Record<string, string>;
    timeout: number; data?: Buffer; headers?: Record<string, string>; responseType: 'json';
}
export interface SyntheticCloudStorageRequester {
    request(options: ObjectRequest): Promise<{ data: unknown }>;
}
const invalid = () => new Error('CLOUD_SYNTHETIC_APIFY_INVALID');
const unavailable = () => new Error('CLOUD_SYNTHETIC_APIFY_OBJECT_UNAVAILABLE');

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw invalid();
    return result.data;
}

function httpStatus(error: unknown) {
    const e = error as { response?: { status?: unknown }; status?: unknown; statusCode?: unknown; code?: unknown } | null;
    for (const value of [e?.response?.status, e?.status, e?.statusCode, e?.code]) {
        if ((typeof value === 'number' || typeof value === 'string') && /^[1-5][0-9]{2}$/.test(String(value))) return Number(value);
    }
    return null;
}

function transient(error: unknown, status: number | null) {
    if (status !== null) return status === 408 || status === 429 || status >= 500;
    const e = error as { name?: string; code?: string; cause?: { code?: string } } | null;
    if (e?.name === 'TimeoutError') return true;
    return ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED',
        'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(e?.cause?.code ?? e?.code ?? '');
}

function gcsRequester(): SyntheticCloudStorageRequester {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/devstorage.read_write'] });
    return { async request(options) {
        const url = new URL(options.url);
        for (const [key, value] of Object.entries(options.params)) url.searchParams.set(key, value);
        // ADC supplies credentials only. Control the HTTP request directly to keep
        // an auth refresh or the SDK transport from replaying an application POST.
        const headers = new Headers(await auth.getRequestHeaders(url.href));
        for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value);
        const response = await fetch(url, {
            method: options.method, headers, body: options.data?.toString('utf8'),
            redirect: 'error', signal: AbortSignal.timeout(options.timeout),
        });
        if (!response.ok || options.method === 'POST') {
            await response.body?.cancel().catch(() => undefined);
            if (!response.ok) throw Object.assign(new Error('CLOUD_SYNTHETIC_APIFY_HTTP'), { status: response.status });
            return { data: null };
        }
        return { data: await response.json() };
    } };
}

export function createGcsSyntheticApifyStore(input: {
    bucket: string; waveDigest: string; requester?: SyntheticCloudStorageRequester;
}): SyntheticCloudStore {
    if (input.bucket !== syntheticCloudBucket || !wave.safeParse(input.waveDigest).success) throw invalid();
    const prefix = 'standard-six/v2/' + input.waveDigest + '/apify/';
    const requester = input.requester ?? gcsRequester();
    const base = 'https://storage.googleapis.com';
    const path = '/storage/v1/b/' + syntheticCloudBucket + '/o';

    async function read<T>(key: string, schema: z.ZodType<T>) {
        let data: unknown;
        try {
            const response = await requester.request({
                url: base + '/download' + path + '/' + encodeURIComponent(prefix + key), method: 'GET',
                params: { alt: 'media' }, timeout: 15_000, responseType: 'json',
            });
            data = response.data;
        } catch (error) {
            if (httpStatus(error) === 404) return null;
            throw unavailable();
        }
        return parse(schema, data);
    }
    async function once<T>(key: string, schema: z.ZodType<T>, value: T) {
        const receipt = parse(schema, value);
        const upload: ObjectRequest = {
            url: base + '/upload' + path, method: 'POST', params: { uploadType: 'media', name: prefix + key, ifGenerationMatch: '0' },
            data: Buffer.from(JSON.stringify(receipt)), headers: { 'Content-Type': 'application/json' }, timeout: 15_000, responseType: 'json',
        };
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                await requester.request(upload);
                return receipt;
            } catch (error) {
                const status = httpStatus(error);
                if (status !== 412 && !transient(error, status)) throw unavailable();
                const winner = await read(key, schema);
                if (winner) return winner;
                // Retry once only after a transient POST and a confirmed 404 for
                // this exact object, retaining the same bytes, nonce and create precondition.
                if (status === 412 || attempt > 0) throw unavailable();
            }
        }
        throw unavailable();
    }
    function checkedId<T extends { id: string }>(receipt: T, id: string): T {
        if (receipt.id !== id) throw invalid();
        return receipt;
    }
    async function invocationCounts(): Promise<SyntheticCloudInvocationCounts> {
        const entries = new Set<string>();
        const starts = new Set<string>();
        const invoked = new Set<string>();
        const cursors = new Set<string>();
        const pageSchema = z.object({ items: z.array(z.object({ name: z.string() })).optional(), nextPageToken: z.string().min(1).optional() });
        let rejected = 0;
        let cursor: string | undefined;
        do {
            const params = { prefix, fields: 'items(name),nextPageToken', ...(cursor ? { pageToken: cursor } : {}) };
            let response: { data: unknown };
            try {
                response = await requester.request({ url: base + path, method: 'GET', params, responseType: 'json', timeout: 15_000 });
            } catch { throw unavailable(); }
            const page = parse(pageSchema, response.data);
            for (const { name } of page.items ?? []) {
                if (!name.startsWith(prefix)) throw invalid();
                const [group, key, file, extra] = name.slice(prefix.length).split('/');
                if (group === 'entries' && file?.endsWith('.json') && !extra) {
                    const id = parse(nonce, file.slice(0, -5));
                    if (entries.has(id)) throw invalid();
                    entries.add(id);
                    if (key === 'rejected') rejected++;
                    else invoked.add(parse(runId, key));
                } else if (runId.safeParse(group).success && file === undefined && ['start.json', 'finish.json'].includes(key)) {
                    if (key === 'start.json') starts.add(group!);
                } else throw invalid();
            }
            cursor = page.nextPageToken;
            if (cursor) {
                if (cursors.has(cursor)) throw invalid();
                cursors.add(cursor);
            }
        } while (cursor);
        return { sdkEntries: entries.size, rejectedEntries: rejected, distinctAcceptedRuns: invoked.size,
            duplicateAcceptedEntries: entries.size - rejected - invoked.size, runsCreated: starts.size,
            acceptedWithoutRun: [...invoked].filter(id => !starts.has(id)).length,
            runsWithoutEntry: [...starts].filter(id => !invoked.has(id)).length };
    }
    return {
        waveDigest: input.waveDigest, invocationCounts,
        async recordInvocation(id, entryNonce) {
            const body = parse(invocation, { version: 2, id, nonce: entryNonce });
            const key = 'entries/' + (id ?? 'rejected') + '/' + body.nonce + '.json';
            const winner = await once(key, invocation, body);
            if (winner.id !== id || winner.nonce !== entryNonce) throw invalid();
        },
        async getStart(id) {
            const receipt = await read(parse(runId, id) + '/start.json', start);
            if (!receipt) throw unavailable();
            return checkedId(receipt, id);
        },
        async startOnce(record) {
            const receipt = await once(parse(runId, record.id) + '/start.json', start, record);
            return checkedId(receipt, record.id);
        },
        async getFinish(id) {
            const receipt = await read(parse(runId, id) + '/finish.json', finish);
            return receipt ? checkedId(receipt, id) : null;
        },
        async finishOnce(record) {
            const receipt = await once(parse(runId, record.id) + '/finish.json', finish, record);
            return checkedId(receipt, record.id);
        },
    };
}
