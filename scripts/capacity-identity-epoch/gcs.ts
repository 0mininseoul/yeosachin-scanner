import {
    EpochError,
    canonicalJson,
    epochFail,
    type EpochErrorCode,
} from './contracts';
import type { JournalStorage, StoredObject } from './journal';
import { GoogleAuth } from 'google-auth-library';

export type GcsHttpRequest = Readonly<{
    method: 'GET' | 'POST' | 'DELETE';
    url: string;
    headers: Readonly<Record<string, string>>;
    body?: string;
}>;

export type GcsHttpResponse = Readonly<{
    status: number;
    headers: Readonly<Record<string, string>>;
    body: string;
    url?: string;
}>;

export type RawStoredObject = Readonly<{ generation: string; body: string }>;

/** Raw object access is restricted to the legacy text lock bridge. */
export interface GcsRawStorage {
    getRaw(key: string): Promise<RawStoredObject | null>;
    putRaw(key: string, body: string, options: { ifGenerationMatch: '0' | string }): Promise<RawStoredObject>;
    deleteRaw(key: string, options: { ifGenerationMatch: string }): Promise<void>;
}

export interface GuardedJournalStorage {
    putWithDispatchGuard(
        key: string,
        value: unknown,
        options: { ifGenerationMatch: '0' | string },
        beforeDispatch: () => Promise<void>,
    ): Promise<StoredObject>;
}

export interface GcsTransport {
    request(request: GcsHttpRequest, signal?: AbortSignal): Promise<GcsHttpResponse>;
}

/** Production transport: authenticated control-plane requests only. */
export class FetchGcsTransport implements GcsTransport {
    private readonly maxResponseBytes: number;

    constructor(maxResponseBytes = 4 * 1024 * 1024) {
        if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0 || maxResponseBytes > 16 * 1024 * 1024) {
            fail('ADAPTER_REQUEST_INVALID');
        }
        this.maxResponseBytes = maxResponseBytes;
    }

    async request(request: GcsHttpRequest, signal?: AbortSignal): Promise<GcsHttpResponse> {
        let response: Response;
        try {
            response = await fetch(request.url, {
                method: request.method,
                headers: request.headers,
                body: request.body,
                redirect: 'error',
                signal,
            });
        } catch {
            fail('ADAPTER_TIMEOUT');
        }
        const contentLength = response.headers.get('content-length');
        if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > this.maxResponseBytes)) {
            fail('ADAPTER_RESPONSE_INVALID');
        }
        let body: string;
        try {
            if (!response.body) {
                body = await response.text();
            } else {
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                const chunks: string[] = [];
                let totalBytes = 0;
                while (true) {
                    const next = await reader.read();
                    if (next.done) break;
                    totalBytes += next.value.byteLength;
                    if (totalBytes > this.maxResponseBytes) {
                        await reader.cancel();
                        fail('ADAPTER_RESPONSE_INVALID');
                    }
                    chunks.push(decoder.decode(next.value, { stream: true }));
                }
                chunks.push(decoder.decode());
                body = chunks.join('');
            }
        } catch (error) {
            if (error instanceof EpochError) throw error;
            fail('ADAPTER_RESPONSE_INVALID');
        }
        return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body, url: response.url };
    }
}

export function createAuthenticatedGcsJournalStorage(options: Readonly<{
    bucket: string;
    auth?: GoogleAuth;
    transport?: GcsTransport;
    maxResponseBytes?: number;
    timeoutMs?: number;
}>): GcsJournalStorage {
    const auth = options.auth ?? new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/devstorage.read_write'] });
    return new GcsJournalStorage({
        bucket: options.bucket,
        transport: options.transport ?? new FetchGcsTransport(options.maxResponseBytes),
        tokenProvider: async () => {
            const token = await auth.getAccessToken();
            if (!token) fail('ADAPTER_REQUEST_INVALID');
            return token;
        },
        maxResponseBytes: options.maxResponseBytes,
        timeoutMs: options.timeoutMs,
    });
}

export type GcsJournalStorageOptions = Readonly<{
    bucket: string;
    transport: GcsTransport;
    tokenProvider: () => Promise<string>;
    maxResponseBytes?: number;
    timeoutMs?: number;
}>;

const HOST = 'storage.googleapis.com';
const BUCKET = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;
const GENERATION = /^[1-9][0-9]*$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/;
const PREFIX = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/;

function fail(code: EpochErrorCode): never {
    epochFail(code);
}

function assertGeneration(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !GENERATION.test(value)) fail('ADAPTER_RESPONSE_INVALID');
}

function assertBodySize(body: string, maxBytes: number): void {
    if (Buffer.byteLength(body, 'utf8') > maxBytes) fail('ADAPTER_RESPONSE_INVALID');
}

function parseJson(body: string, maxBytes: number): Record<string, unknown> {
    assertBodySize(body, maxBytes);
    try {
        const parsed: unknown = JSON.parse(body);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail('ADAPTER_RESPONSE_INVALID');
        return parsed as Record<string, unknown>;
    } catch (error) {
        if (error instanceof EpochError) throw error;
        fail('ADAPTER_RESPONSE_INVALID');
    }
}

function header(headers: Readonly<Record<string, string>>, name: string): string | undefined {
    const wanted = name.toLowerCase();
    const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted);
    return entry?.[1];
}

export class GcsJournalStorage implements JournalStorage, GcsRawStorage {
    private readonly bucket: string;
    private readonly transport: GcsTransport;
    private readonly tokenProvider: () => Promise<string>;
    private readonly maxResponseBytes: number;
    private readonly timeoutMs: number;

    constructor(options: GcsJournalStorageOptions) {
        if (!BUCKET.test(options.bucket)) fail('ADAPTER_REQUEST_INVALID');
        if (!Number.isSafeInteger(options.maxResponseBytes ?? 4 * 1024 * 1024)
            || (options.maxResponseBytes ?? 4 * 1024 * 1024) <= 0
            || (options.maxResponseBytes ?? 4 * 1024 * 1024) > 16 * 1024 * 1024) fail('ADAPTER_REQUEST_INVALID');
        if (!Number.isSafeInteger(options.timeoutMs ?? 30_000)
            || (options.timeoutMs ?? 30_000) <= 0 || (options.timeoutMs ?? 30_000) > 120_000) fail('ADAPTER_REQUEST_INVALID');
        this.bucket = options.bucket;
        this.transport = options.transport;
        this.tokenProvider = options.tokenProvider;
        this.maxResponseBytes = options.maxResponseBytes ?? 4 * 1024 * 1024;
        this.timeoutMs = options.timeoutMs ?? 30_000;
    }

    /** Validate the private GCS credential boundary without a read/write. */
    async preflight(): Promise<void> {
        let token: string;
        try {
            token = await this.withTimeout(this.tokenProvider(), this.timeoutMs, 'ADAPTER_TIMEOUT');
        } catch (error) {
            if (error instanceof EpochError) throw error;
            fail('ADAPTER_REQUEST_INVALID');
        }
        if (typeof token !== 'string' || token.length === 0 || token.length > 8192 || /[\u0000-\u001f\u007f]/.test(token)) fail('ADAPTER_REQUEST_INVALID');
    }

    async get(key: string): Promise<StoredObject | null> {
        this.assertKey(key);
        const encoded = this.objectUrl(key);
        const metadataResponse = await this.request({ method: 'GET', url: `${encoded}?alt=json` });
        if (metadataResponse.status === 404) return null;
        this.assertSuccess(metadataResponse.status);
        const metadata = parseJson(metadataResponse.body, this.maxResponseBytes);
        const metadataGeneration = metadata.generation;
        assertGeneration(metadataGeneration);
        if (metadata.name !== key) fail('ADAPTER_RESPONSE_INVALID');
        const mediaResponse = await this.request({ method: 'GET', url: `${encoded}?alt=media&generation=${encodeURIComponent(metadataGeneration)}` });
        this.assertSuccess(mediaResponse.status);
        const generation = header(mediaResponse.headers, 'x-goog-generation');
        assertGeneration(generation);
        if (generation !== metadataGeneration) fail('ADAPTER_RESPONSE_INVALID');
        assertBodySize(mediaResponse.body, this.maxResponseBytes);
        let value: unknown;
        try {
            value = JSON.parse(mediaResponse.body);
        } catch {
            fail('ADAPTER_RESPONSE_INVALID');
        }
        return { generation, value };
    }

    async getRaw(key: string): Promise<RawStoredObject | null> {
        this.assertKey(key);
        const encoded = this.objectUrl(key);
        const metadataResponse = await this.request({ method: 'GET', url: `${encoded}?alt=json` });
        if (metadataResponse.status === 404) return null;
        this.assertSuccess(metadataResponse.status);
        const metadata = parseJson(metadataResponse.body, this.maxResponseBytes);
        const metadataGeneration = metadata.generation;
        assertGeneration(metadataGeneration);
        if (metadata.name !== key) fail('ADAPTER_RESPONSE_INVALID');
        const mediaResponse = await this.request({ method: 'GET', url: `${encoded}?alt=media&generation=${encodeURIComponent(metadataGeneration)}` });
        this.assertSuccess(mediaResponse.status);
        const generation = header(mediaResponse.headers, 'x-goog-generation');
        assertGeneration(generation);
        if (generation !== metadataGeneration) fail('ADAPTER_RESPONSE_INVALID');
        assertBodySize(mediaResponse.body, this.maxResponseBytes);
        return { generation, body: mediaResponse.body };
    }

    async put(key: string, value: unknown, options: { ifGenerationMatch: '0' | string }): Promise<StoredObject> {
        return this.putInternal(key, value, options);
    }

    async putWithDispatchGuard(
        key: string,
        value: unknown,
        options: { ifGenerationMatch: '0' | string },
        beforeDispatch: () => Promise<void>,
    ): Promise<StoredObject> {
        return this.putInternal(key, value, options, beforeDispatch);
    }

    private async putInternal(
        key: string,
        value: unknown,
        options: { ifGenerationMatch: '0' | string },
        beforeDispatch?: () => Promise<void>,
    ): Promise<StoredObject> {
        this.assertKey(key);
        this.assertPrecondition(options.ifGenerationMatch);
        const body = canonicalJson(value);
        assertBodySize(body, this.maxResponseBytes);
        const url = `${this.uploadBucketUrl()}?uploadType=media&name=${encodeURIComponent(key)}&ifGenerationMatch=${encodeURIComponent(options.ifGenerationMatch)}`;
        const response = await this.request({ method: 'POST', url, body }, beforeDispatch);
        if (response.status === 412) fail('GENERATION_PRECONDITION_FAILED');
        this.assertSuccess(response.status);
        const metadata = parseJson(response.body, this.maxResponseBytes);
        const generation = header(response.headers, 'x-goog-generation') ?? metadata.generation;
        assertGeneration(generation);
        if (metadata.name !== key || metadata.generation !== generation) fail('ADAPTER_RESPONSE_INVALID');
        const readback = await this.get(key);
        if (!readback || readback.generation !== generation || canonicalJson(readback.value) !== body) fail('ADAPTER_RESPONSE_INVALID');
        return readback;
    }

    async putRaw(key: string, body: string, options: { ifGenerationMatch: '0' | string }): Promise<RawStoredObject> {
        this.assertKey(key);
        this.assertPrecondition(options.ifGenerationMatch);
        if (typeof body !== 'string') fail('ADAPTER_REQUEST_INVALID');
        assertBodySize(body, this.maxResponseBytes);
        const url = `${this.uploadBucketUrl()}?uploadType=media&name=${encodeURIComponent(key)}&ifGenerationMatch=${encodeURIComponent(options.ifGenerationMatch)}`;
        const response = await this.request({ method: 'POST', url, body });
        if (response.status === 412) fail('GENERATION_PRECONDITION_FAILED');
        this.assertSuccess(response.status);
        const metadata = parseJson(response.body, this.maxResponseBytes);
        const generation = header(response.headers, 'x-goog-generation') ?? metadata.generation;
        assertGeneration(generation);
        if (metadata.name !== key || metadata.generation !== generation) fail('ADAPTER_RESPONSE_INVALID');
        const readback = await this.getRaw(key);
        if (!readback || readback.generation !== generation || readback.body !== body) fail('ADAPTER_RESPONSE_INVALID');
        return readback;
    }

    async list(prefix: string): Promise<ReadonlyArray<StoredObject & { key: string }>> {
        if (!PREFIX.test(prefix)) fail('ADAPTER_REQUEST_INVALID');
        const entries: Array<StoredObject & { key: string }> = [];
        let pageToken: string | undefined;
        const seenPageTokens = new Set<string>();
        const seenKeys = new Set<string>();
        for (let page = 0; page < 100; page += 1) {
            const params = new URLSearchParams({ prefix, maxResults: '1000' });
            if (pageToken) params.set('pageToken', pageToken);
            const response = await this.request({ method: 'GET', url: `${this.bucketUrl()}?${params.toString()}` });
            this.assertSuccess(response.status);
            const body = parseJson(response.body, this.maxResponseBytes);
            if (body.items !== undefined && !Array.isArray(body.items)) fail('ADAPTER_RESPONSE_INVALID');
            for (const item of (body.items ?? []) as unknown[]) {
                if (typeof item !== 'object' || item === null || Array.isArray(item)) fail('ADAPTER_RESPONSE_INVALID');
                const row = item as Record<string, unknown>;
                if (typeof row.name !== 'string' || !KEY.test(row.name) || !row.name.startsWith(prefix)
                    || seenKeys.has(row.name)) fail('ADAPTER_RESPONSE_INVALID');
                assertGeneration(row.generation);
                seenKeys.add(row.name);
                const mediaResponse = await this.request({ method: 'GET', url: `${this.objectUrl(row.name)}?alt=media&generation=${encodeURIComponent(row.generation)}` });
                this.assertSuccess(mediaResponse.status);
                assertBodySize(mediaResponse.body, this.maxResponseBytes);
                let value: unknown;
                try {
                    value = JSON.parse(mediaResponse.body);
                } catch {
                    fail('ADAPTER_RESPONSE_INVALID');
                }
                const generation = header(mediaResponse.headers, 'x-goog-generation');
                assertGeneration(generation);
                if (generation !== row.generation) fail('ADAPTER_RESPONSE_INVALID');
                entries.push({ key: row.name, generation, value });
            }
            if (body.nextPageToken === undefined) return entries;
            if (typeof body.nextPageToken !== 'string' || body.nextPageToken.length === 0) fail('ADAPTER_RESPONSE_INVALID');
            if (body.nextPageToken.length > 2048 || /[\u0000-\u001f\u007f]/.test(body.nextPageToken)) fail('ADAPTER_RESPONSE_INVALID');
            if (seenPageTokens.has(body.nextPageToken)) fail('ADAPTER_RESPONSE_INVALID');
            seenPageTokens.add(body.nextPageToken);
            pageToken = body.nextPageToken;
        }
        fail('ADAPTER_RESPONSE_INVALID');
    }

    async delete(key: string, options: { ifGenerationMatch: string }): Promise<void> {
        this.assertKey(key);
        this.assertPrecondition(options.ifGenerationMatch);
        const response = await this.request({
            method: 'DELETE',
            url: `${this.objectUrl(key)}?ifGenerationMatch=${encodeURIComponent(options.ifGenerationMatch)}`,
        });
        if (response.status === 404) return;
        if (response.status === 412) fail('GENERATION_PRECONDITION_FAILED');
        this.assertSuccess(response.status);
    }

    async deleteRaw(key: string, options: { ifGenerationMatch: string }): Promise<void> {
        return this.delete(key, options);
    }

    private async request(
        input: { method: 'GET' | 'POST' | 'DELETE'; url: string; body?: string },
        beforeDispatch?: () => Promise<void>,
    ): Promise<GcsHttpResponse> {
        let url: URL;
        try {
            url = new URL(input.url);
        } catch {
            fail('ADAPTER_NOT_ALLOWED');
        }
        this.assertAllowedRequest(input, url);
        let token: string;
        try {
            token = await this.withTimeout(this.tokenProvider(), this.timeoutMs, 'ADAPTER_TIMEOUT');
        } catch (error) {
            if (error instanceof EpochError) throw error;
            fail('ADAPTER_REQUEST_INVALID');
        }
        if (typeof token !== 'string' || token.length === 0 || token.length > 8192 || /[\u0000-\u001f\u007f]/.test(token)) fail('ADAPTER_REQUEST_INVALID');
        const request: GcsHttpRequest = {
            method: input.method,
            url: url.toString(),
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            ...(input.body === undefined ? {} : { body: input.body }),
        };
        if (beforeDispatch) await beforeDispatch();
        let response: GcsHttpResponse;
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
            try {
                response = await this.withTimeout(this.transport.request(request, controller.signal), this.timeoutMs, 'ADAPTER_TIMEOUT');
            } finally {
                clearTimeout(timeout);
            }
        } catch (error) {
            if (error instanceof EpochError) throw error;
            fail('ADAPTER_TIMEOUT');
        }
        if (response.url) {
            let finalUrl: URL;
            try {
                finalUrl = new URL(response.url);
            } catch {
                fail('ADAPTER_REDIRECT');
            }
            if (finalUrl.toString() !== request.url) fail('ADAPTER_REDIRECT');
        }
        if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599
            || typeof response.body !== 'string') fail('ADAPTER_RESPONSE_INVALID');
        assertBodySize(response.body, this.maxResponseBytes);
        return response;
    }

    private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: EpochErrorCode): Promise<T> {
        const timeout = Symbol('gcs-timeout');
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const result = await Promise.race([
                promise,
                new Promise<T | typeof timeout>(resolve => {
                    timer = setTimeout(() => resolve(timeout), timeoutMs);
                }),
            ]);
            if (result === timeout) fail(code);
            return result as T;
        } finally {
            if (timer !== undefined) clearTimeout(timer);
        }
    }

    private objectUrl(key: string): string {
        this.assertKey(key);
        return `https://${HOST}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(key)}`;
    }

    private bucketUrl(): string {
        return `https://${HOST}/storage/v1/b/${encodeURIComponent(this.bucket)}/o`;
    }

    private uploadBucketUrl(): string {
        return `https://${HOST}/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o`;
    }

    private assertKey(key: string): void {
        if (!KEY.test(key) || key.includes('..') || key.startsWith('/')) fail('ADAPTER_REQUEST_INVALID');
    }

    private assertAllowedRequest(input: { method: 'GET' | 'POST' | 'DELETE'; url: string; body?: string }, url: URL): void {
        if (url.protocol !== 'https:' || url.hostname !== HOST) fail('ADAPTER_NOT_ALLOWED');
        const bucket = encodeURIComponent(this.bucket);
        const collection = `/storage/v1/b/${bucket}/o`;
        const uploadCollection = `/upload/storage/v1/b/${bucket}/o`;
        const objectPrefix = `${collection}/`;
        const isObject = url.pathname.startsWith(objectPrefix) && url.pathname.length > objectPrefix.length;
        if (input.method === 'POST') {
            if (url.pathname !== uploadCollection
                || [...url.searchParams.keys()].sort().join(',') !== 'ifGenerationMatch,name,uploadType'
                || url.searchParams.get('uploadType') !== 'media'
                || url.searchParams.get('name') === null
                || url.searchParams.get('ifGenerationMatch') === null) fail('ADAPTER_NOT_ALLOWED');
            this.assertKey(url.searchParams.get('name')!);
            this.assertPrecondition(url.searchParams.get('ifGenerationMatch')!);
            return;
        }
        if (url.pathname === collection) {
            const queryKeys = [...url.searchParams.keys()].sort();
            if (input.method !== 'GET' || (queryKeys.join(',') !== 'maxResults,prefix' && queryKeys.join(',') !== 'maxResults,pageToken,prefix')
                || url.searchParams.get('prefix') === null || url.searchParams.get('maxResults') !== '1000') fail('ADAPTER_NOT_ALLOWED');
            return;
        }
        if (!isObject || (input.method !== 'GET' && input.method !== 'DELETE')) fail('ADAPTER_NOT_ALLOWED');
        let decodedKey: string;
        try {
            decodedKey = decodeURIComponent(url.pathname.slice(objectPrefix.length));
        } catch {
            fail('ADAPTER_NOT_ALLOWED');
        }
        this.assertKey(decodedKey);
        if (encodeURIComponent(decodedKey) !== url.pathname.slice(objectPrefix.length)) fail('ADAPTER_NOT_ALLOWED');
        if (input.method === 'DELETE') {
            if ([...url.searchParams.keys()].join(',') !== 'ifGenerationMatch' || url.searchParams.get('ifGenerationMatch') === null) fail('ADAPTER_NOT_ALLOWED');
            this.assertPrecondition(url.searchParams.get('ifGenerationMatch')!);
            return;
        }
        const alt = url.searchParams.get('alt');
        if (alt === 'json') {
            if ([...url.searchParams.keys()].join(',') !== 'alt') fail('ADAPTER_NOT_ALLOWED');
        } else if (alt === 'media') {
            if ([...url.searchParams.keys()].sort().join(',') !== 'alt,generation') fail('ADAPTER_NOT_ALLOWED');
            const generation = url.searchParams.get('generation');
            if (generation === null) fail('ADAPTER_NOT_ALLOWED');
            assertGeneration(generation);
        } else {
            fail('ADAPTER_NOT_ALLOWED');
        }
    }

    private assertPrecondition(value: string): void {
        if (value !== '0' && !GENERATION.test(value)) fail('ADAPTER_REQUEST_INVALID');
    }

    private assertSuccess(status: number): void {
        if (status < 200 || status >= 300) {
            if (status === 401 || status === 403) fail('ADAPTER_NOT_ALLOWED');
            if (status >= 500) fail('ADAPTER_RESPONSE_INVALID');
            fail('ADAPTER_RESPONSE_INVALID');
        }
    }
}

export { EpochError };
