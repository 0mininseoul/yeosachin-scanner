import {
    EpochError,
    canonicalJson,
    epochFail,
    type EpochErrorCode,
} from './contracts';
import type { JournalStorage, StoredObject } from './journal';
import { GoogleAuth } from 'google-auth-library';

export type GcsHttpRequest = Readonly<{
    method: 'GET' | 'PUT' | 'DELETE';
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

export interface GcsTransport {
    request(request: GcsHttpRequest, signal?: AbortSignal): Promise<GcsHttpResponse>;
}

/** Production transport: authenticated control-plane requests only. */
export class FetchGcsTransport implements GcsTransport {
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
        let body: string;
        try {
            body = await response.text();
        } catch {
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
        transport: options.transport ?? new FetchGcsTransport(),
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

export class GcsJournalStorage implements JournalStorage {
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

    async get(key: string): Promise<StoredObject | null> {
        const encoded = this.objectUrl(key);
        const metadataResponse = await this.request({ method: 'GET', url: `${encoded}?alt=json` });
        if (metadataResponse.status === 404) return null;
        this.assertSuccess(metadataResponse.status);
        const metadata = parseJson(metadataResponse.body, this.maxResponseBytes);
        const metadataGeneration = metadata.generation;
        assertGeneration(metadataGeneration);
        const mediaResponse = await this.request({ method: 'GET', url: `${encoded}?alt=media` });
        this.assertSuccess(mediaResponse.status);
        const generation = header(mediaResponse.headers, 'x-goog-generation') ?? metadataGeneration;
        assertGeneration(generation);
        assertBodySize(mediaResponse.body, this.maxResponseBytes);
        let value: unknown;
        try {
            value = JSON.parse(mediaResponse.body);
        } catch {
            fail('ADAPTER_RESPONSE_INVALID');
        }
        return { generation, value };
    }

    async put(key: string, value: unknown, options: { ifGenerationMatch: '0' | string }): Promise<StoredObject> {
        this.assertPrecondition(options.ifGenerationMatch);
        const body = canonicalJson(value);
        assertBodySize(body, this.maxResponseBytes);
        const encoded = this.objectUrl(key);
        const url = `${encoded}?uploadType=media&name=${encodeURIComponent(key)}&ifGenerationMatch=${encodeURIComponent(options.ifGenerationMatch)}`;
        const response = await this.request({ method: 'PUT', url, body });
        if (response.status === 412) fail('GENERATION_PRECONDITION_FAILED');
        this.assertSuccess(response.status);
        const metadata = parseJson(response.body, this.maxResponseBytes);
        const generation = header(response.headers, 'x-goog-generation') ?? metadata.generation;
        assertGeneration(generation);
        return { generation, value };
    }

    async list(prefix: string): Promise<ReadonlyArray<StoredObject & { key: string }>> {
        if (!PREFIX.test(prefix)) fail('ADAPTER_REQUEST_INVALID');
        const entries: Array<StoredObject & { key: string }> = [];
        let pageToken: string | undefined;
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
                if (typeof row.name !== 'string' || !KEY.test(row.name)) fail('ADAPTER_RESPONSE_INVALID');
                assertGeneration(row.generation);
                const mediaResponse = await this.request({ method: 'GET', url: `${this.objectUrl(row.name)}?alt=media` });
                this.assertSuccess(mediaResponse.status);
                assertBodySize(mediaResponse.body, this.maxResponseBytes);
                let value: unknown;
                try {
                    value = JSON.parse(mediaResponse.body);
                } catch {
                    fail('ADAPTER_RESPONSE_INVALID');
                }
                const generation = header(mediaResponse.headers, 'x-goog-generation') ?? row.generation;
                assertGeneration(generation);
                entries.push({ key: row.name, generation, value });
            }
            if (typeof body.nextPageToken !== 'string' || body.nextPageToken.length === 0) return entries;
            if (body.nextPageToken.length > 2048 || /[\u0000-\u001f\u007f]/.test(body.nextPageToken)) fail('ADAPTER_RESPONSE_INVALID');
            pageToken = body.nextPageToken;
        }
        fail('ADAPTER_RESPONSE_INVALID');
    }

    async delete(key: string, options: { ifGenerationMatch: string }): Promise<void> {
        this.assertPrecondition(options.ifGenerationMatch);
        const response = await this.request({
            method: 'DELETE',
            url: `${this.objectUrl(key)}?ifGenerationMatch=${encodeURIComponent(options.ifGenerationMatch)}`,
        });
        if (response.status === 404) return;
        if (response.status === 412) fail('GENERATION_PRECONDITION_FAILED');
        this.assertSuccess(response.status);
    }

    private async request(input: { method: 'GET' | 'PUT' | 'DELETE'; url: string; body?: string }): Promise<GcsHttpResponse> {
        let token: string;
        try {
            token = await this.tokenProvider();
        } catch {
            fail('ADAPTER_REQUEST_INVALID');
        }
        if (typeof token !== 'string' || token.length === 0 || token.length > 8192 || /[\u0000-\u001f\u007f]/.test(token)) fail('ADAPTER_REQUEST_INVALID');
        const url = new URL(input.url);
        if (url.protocol !== 'https:' || url.hostname !== HOST || !url.pathname.startsWith('/storage/v1/b/')) fail('ADAPTER_NOT_ALLOWED');
        const request: GcsHttpRequest = {
            method: input.method,
            url: url.toString(),
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            ...(input.body === undefined ? {} : { body: input.body }),
        };
        let response: GcsHttpResponse;
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
            try {
                response = await this.transport.request(request, controller.signal);
            } finally {
                clearTimeout(timeout);
            }
        } catch (error) {
            if (error instanceof EpochError) throw error;
            fail('ADAPTER_TIMEOUT');
        }
        if (response.url) {
            const finalUrl = new URL(response.url);
            if (finalUrl.toString() !== request.url) fail('ADAPTER_REDIRECT');
        }
        if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599
            || typeof response.body !== 'string') fail('ADAPTER_RESPONSE_INVALID');
        assertBodySize(response.body, this.maxResponseBytes);
        return response;
    }

    private objectUrl(key: string): string {
        if (!KEY.test(key) || key.includes('..') || key.startsWith('/')) fail('ADAPTER_REQUEST_INVALID');
        return `https://${HOST}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(key)}`;
    }

    private bucketUrl(): string {
        return `https://${HOST}/storage/v1/b/${encodeURIComponent(this.bucket)}/o`;
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
