import { GoogleAuth } from 'google-auth-library';
import { EpochError, epochFail, isObject, canonicalDigest, type CapacityEpochPacket, type EpochErrorCode, type Role } from './contracts';
import { assertLeaseBinding, type BoundLeaseCheck } from './lease-capability';

export type ProtectedHttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type ProtectedHttpRequest = Readonly<{
    method: ProtectedHttpMethod;
    url: string;
    headers: Readonly<Record<string, string>>;
    body?: string;
}>;

export type ProtectedHttpResponse = Readonly<{
    status: number;
    headers: Readonly<Record<string, string>>;
    body: string;
    url?: string;
}>;

export interface ProtectedTransport {
    request(request: ProtectedHttpRequest, signal?: AbortSignal): Promise<ProtectedHttpResponse>;
}

export type ProtectedTokenProvider = () => Promise<string>;

const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const CONTROL_PLANE_HOSTS = new Set([
    'api.vercel.com',
    'cloudbuild.googleapis.com',
    'cloudscheduler.googleapis.com',
    'cloudtasks.googleapis.com',
    'iam.googleapis.com',
    'run.googleapis.com',
]);

function fail(code: EpochErrorCode): never {
    epochFail(code);
}

function assertBoundedString(value: unknown, max: number): asserts value is string {
    if (typeof value !== 'string' || value.length === 0 || value.length > max
        || /[\u0000-\u001f\u007f]/.test(value)) fail('ADAPTER_REQUEST_INVALID');
}

function assertHttpStatus(value: unknown): asserts value is number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 599) fail('ADAPTER_RESPONSE_INVALID');
}

function responseHeader(headers: Readonly<Record<string, string>>, name: string): string | undefined {
    const wanted = name.toLowerCase();
    return Object.entries(headers).find(([key]) => key.toLowerCase() === wanted)?.[1];
}

export function parseProtectedJson(body: string, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES): unknown {
    if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > maxResponseBytes) fail('ADAPTER_RESPONSE_INVALID');
    try {
        return JSON.parse(body) as unknown;
    } catch {
        fail('ADAPTER_RESPONSE_INVALID');
    }
}

export function parseProtectedObject(body: string, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES): Record<string, unknown> {
    const value = parseProtectedJson(body, maxResponseBytes);
    if (!isObject(value)) fail('ADAPTER_RESPONSE_INVALID');
    return value;
}

/**
 * Production transport.  The caller supplies an already-authenticated token
 * provider (GoogleAuth in the live constructor); tests inject a fixed token
 * and never reach a provider endpoint.
 */
export class FetchProtectedTransport implements ProtectedTransport {
    private readonly maxResponseBytes: number;

    constructor(maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES) {
        if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0 || maxResponseBytes > MAX_RESPONSE_BYTES) {
            fail('ADAPTER_REQUEST_INVALID');
        }
        this.maxResponseBytes = maxResponseBytes;
    }

    async request(request: ProtectedHttpRequest, signal?: AbortSignal): Promise<ProtectedHttpResponse> {
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
                let total = 0;
                while (true) {
                    const next = await reader.read();
                    if (next.done) break;
                    total += next.value.byteLength;
                    if (total > this.maxResponseBytes) {
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
        if (Buffer.byteLength(body, 'utf8') > this.maxResponseBytes) fail('ADAPTER_RESPONSE_INVALID');
        return {
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            body,
            url: response.url,
        };
    }
}

export function createGoogleProtectedTransport(options: Readonly<{
    scopes?: readonly string[];
    transport?: ProtectedTransport;
    tokenProvider?: ProtectedTokenProvider;
    maxResponseBytes?: number;
    timeoutMs?: number;
}> = {}): AuthenticatedProtectedTransport {
    const auth = options.tokenProvider ? undefined : new GoogleAuth({
        scopes: [...(options.scopes ?? ['https://www.googleapis.com/auth/cloud-platform'])],
    });
    return new AuthenticatedProtectedTransport({
        transport: options.transport ?? new FetchProtectedTransport(options.maxResponseBytes),
        tokenProvider: options.tokenProvider ?? (async () => {
            const token = await auth!.getAccessToken();
            if (!token) fail('ADAPTER_REQUEST_INVALID');
            return token;
        }),
        timeoutMs: options.timeoutMs,
        maxResponseBytes: options.maxResponseBytes,
    });
}

export type AuthenticatedProtectedTransportOptions = Readonly<{
    transport: ProtectedTransport;
    tokenProvider: ProtectedTokenProvider;
    timeoutMs?: number;
    maxResponseBytes?: number;
}>;

/** Adds auth, endpoint allowlisting, timeout and bounded JSON handling. */
export class AuthenticatedProtectedTransport {
    private readonly transport: ProtectedTransport;
    private readonly tokenProvider: ProtectedTokenProvider;
    private readonly timeoutMs: number;
    readonly maxResponseBytes: number;

    constructor(options: AuthenticatedProtectedTransportOptions) {
        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS
            || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0 || maxResponseBytes > MAX_RESPONSE_BYTES) {
            fail('ADAPTER_REQUEST_INVALID');
        }
        this.transport = options.transport;
        this.tokenProvider = options.tokenProvider;
        this.timeoutMs = timeoutMs;
        this.maxResponseBytes = maxResponseBytes;
    }

    async request(options: Readonly<{
        method: ProtectedHttpMethod;
        url: string;
        allowedHosts: ReadonlySet<string>;
        allowedPath: (path: string) => boolean;
        allowedMethods?: readonly ProtectedHttpMethod[];
        allowedQueryKeys?: readonly string[];
        body?: string;
        acceptedStatuses?: readonly number[];
        /** Runs after token acquisition and immediately before dispatch. */
        beforeDispatch?: () => Promise<void>;
    }>): Promise<ProtectedHttpResponse> {
        const url = this.parseAllowedUrl(options.url, options.allowedHosts, options.allowedPath, options.allowedMethods, options.allowedQueryKeys);
        if (options.allowedMethods === undefined || !options.allowedMethods.includes(options.method)) fail('ADAPTER_NOT_ALLOWED');
        if (options.body !== undefined) {
            if (typeof options.body !== 'string' || Buffer.byteLength(options.body, 'utf8') > this.maxResponseBytes) {
                fail('ADAPTER_REQUEST_INVALID');
            }
        }
        let token: string;
        try {
            token = await this.withTimeout(this.tokenProvider(), 'ADAPTER_TIMEOUT');
        } catch (error) {
            if (error instanceof EpochError) throw error;
            fail('ADAPTER_REQUEST_INVALID');
        }
        assertBoundedString(token, 8192);
        const request: ProtectedHttpRequest = {
            method: options.method,
            url: url.toString(),
            headers: {
                authorization: `Bearer ${token}`,
                accept: 'application/json',
                ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(options.body === undefined ? {} : { body: options.body }),
        };
        if (options.beforeDispatch) await options.beforeDispatch();
        let response: ProtectedHttpResponse;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            response = await this.withTimeout(this.transport.request(request, controller.signal), 'ADAPTER_TIMEOUT');
        } catch (error) {
            if (error instanceof EpochError) throw error;
            fail('ADAPTER_TIMEOUT');
        } finally {
            clearTimeout(timer);
        }
        if (response.url !== undefined && response.url !== request.url) fail('ADAPTER_REDIRECT');
        assertHttpStatus(response.status);
        if (typeof response.body !== 'string' || Buffer.byteLength(response.body, 'utf8') > this.maxResponseBytes) {
            fail('ADAPTER_RESPONSE_INVALID');
        }
        const accepted = options.acceptedStatuses ?? [200];
        if (!accepted.includes(response.status)) {
            if (response.status === 401 || response.status === 403) fail('ADAPTER_NOT_ALLOWED');
            if (response.status === 408 || response.status === 429 || response.status >= 500) fail('ADAPTER_RESPONSE_INVALID');
            fail('ADAPTER_RESPONSE_INVALID');
        }
        return response;
    }

    async json(options: Readonly<{
        method: ProtectedHttpMethod;
        url: string;
        allowedHosts: ReadonlySet<string>;
        allowedPath: (path: string) => boolean;
        allowedMethods?: readonly ProtectedHttpMethod[];
        allowedQueryKeys?: readonly string[];
        body?: unknown;
        acceptedStatuses?: readonly number[];
        beforeDispatch?: () => Promise<void>;
    }>): Promise<{ response: ProtectedHttpResponse; value: unknown }> {
        const body = options.body === undefined ? undefined : JSON.stringify(options.body);
        const response = await this.request({
            method: options.method,
            url: options.url,
            allowedHosts: options.allowedHosts,
            allowedPath: options.allowedPath,
            ...(options.allowedMethods === undefined ? {} : { allowedMethods: options.allowedMethods }),
            ...(options.allowedQueryKeys === undefined ? {} : { allowedQueryKeys: options.allowedQueryKeys }),
            ...(body === undefined ? {} : { body }),
            ...(options.acceptedStatuses === undefined ? {} : { acceptedStatuses: options.acceptedStatuses }),
            ...(options.beforeDispatch === undefined ? {} : { beforeDispatch: options.beforeDispatch }),
        });
        return { response, value: parseProtectedJson(response.body, this.maxResponseBytes) };
    }

    private parseAllowedUrl(raw: string, allowedHosts: ReadonlySet<string>, allowedPath: (path: string) => boolean, allowedMethods?: readonly ProtectedHttpMethod[], allowedQueryKeys?: readonly string[]): URL {
        let url: URL;
        try {
            url = new URL(raw);
        } catch {
            fail('ADAPTER_REQUEST_INVALID');
        }
        if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
            || !allowedHosts.has(url.hostname)
            || (!CONTROL_PLANE_HOSTS.has(url.hostname) && !/^[a-z0-9-]+-run\.googleapis\.com$/.test(url.hostname))
            || !allowedPath(url.pathname)) fail('ADAPTER_NOT_ALLOWED');
        if (allowedQueryKeys === undefined) fail('ADAPTER_NOT_ALLOWED');
        const actual = [...url.searchParams.keys()].sort();
        const expected = [...allowedQueryKeys].sort();
        if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail('ADAPTER_NOT_ALLOWED');
        return url;
    }

    private async withTimeout<T>(promise: Promise<T>, code: EpochErrorCode): Promise<T> {
        const marker = Symbol('protected-timeout');
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const result = await Promise.race([
                promise,
                new Promise<T | typeof marker>(resolve => {
                    timer = setTimeout(() => resolve(marker), this.timeoutMs);
                }),
            ]);
            if (result === marker) fail(code);
            return result as T;
        } finally {
            if (timer !== undefined) clearTimeout(timer);
        }
    }
}

export function getResponseHeader(headers: Readonly<Record<string, string>>, name: string): string | undefined {
    return responseHeader(headers, name);
}

export type ReviewedReceiverTarget = Readonly<{
    url: string;
    audience: string;
    callerIdentity: string;
}>;

export type ReceiverTokenProvider = (input: Readonly<{
    audience: string;
    callerIdentity: string;
}>) => Promise<string>;

/**
 * A receiver probe authority is deliberately opaque.  The packet-bound
 * target, caller, malformed-body contract and live lease check are retained
 * in a private registry rather than being reconstructed from a plain target
 * object supplied by an adapter caller.
 */
export type ReceiverProbeAuthority = object;

type ReceiverProbeBinding = Readonly<{
    packetDigest: string;
    role: Role;
    ownerDigest: string;
    serviceResource: string;
    target: Readonly<{ url: string; audience: string; callerIdentity: string }>;
    expectedStatus: 400;
    expectedCode: 'INVALID_REQUEST';
    body: '{';
    leaseCheck: BoundLeaseCheck;
}>;

const receiverProbeAuthorities = new WeakMap<object, ReceiverProbeBinding>();
const RECEIVER_PROBE_BODY = '{' as const;

function receiverServiceResource(packet: CapacityEpochPacket, role: Role): string {
    const runtime = packet.protectedInputs.desired.runtime[role];
    return `projects/${runtime.project}/locations/${runtime.location}/services/${runtime.service}`;
}

/**
 * Issue the only authority accepted by AuthenticatedReceiverProbe.  The
 * caller must already hold a coordinator-issued lease check for the exact
 * probe action and desired role service.  No URL, expected response, or
 * caller identity is accepted from the probe adapter itself.
 */
export function issueReceiverProbeAuthority(input: Readonly<{
    packet: CapacityEpochPacket;
    role: Role;
    ownerDigest: string;
    lease: Readonly<{ lock: Readonly<{ lockFence: string }> }>;
    leaseCheck: BoundLeaseCheck;
}>): ReceiverProbeAuthority {
    const runtime = input.packet.protectedInputs.desired.runtime[input.role];
    const queue = input.packet.protectedInputs.desired.queues[input.role];
    const resource = receiverServiceResource(input.packet, input.role);
    assertLeaseBinding(input.leaseCheck, {
        packet: input.packet,
        ownerDigest: input.ownerDigest,
        operation: 'probe.malformed',
        resource,
        lockFence: input.lease.lock.lockFence,
    });
    if (input.packet.probe.bodyDigest !== canonicalDigest(RECEIVER_PROBE_BODY)
        || input.packet.probe.expectedStatuses[input.role] !== 400
        || input.packet.probe.expectedCodes[input.role] !== 'INVALID_REQUEST') epochFail('PROBE_FAILED');
    const authority = Object.freeze(Object.create(null)) as ReceiverProbeAuthority;
    receiverProbeAuthorities.set(authority, {
        packetDigest: canonicalDigest(input.packet),
        role: input.role,
        ownerDigest: input.ownerDigest,
        serviceResource: resource,
        target: Object.freeze({
            url: runtime.target.url,
            audience: runtime.target.audience,
            callerIdentity: queue.target.callerIdentity.identity,
        }),
        expectedStatus: 400,
        expectedCode: 'INVALID_REQUEST',
        body: RECEIVER_PROBE_BODY,
        leaseCheck: input.leaseCheck,
    });
    return authority;
}

function receiverProbeBinding(value: unknown): ReceiverProbeBinding {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) epochFail('CAPABILITY_INVALID');
    const binding = receiverProbeAuthorities.get(value as object);
    if (!binding) epochFail('CAPABILITY_INVALID');
    return binding;
}

/**
 * Narrow receiver-probe transport.  The general protected transport keeps a
 * control-plane-only host allowlist; probes use this separate adapter because
 * their reviewed destination is a worker URL rather than a Google API.  The
 * destination is fixed at construction from the reviewed packet target and
 * cannot be selected per request.  The token provider receives the exact
 * reviewed caller/audience binding, keeping an ID-token implementation honest
 * without exposing credentials or accepting a caller-selected host.
 */
export class AuthenticatedReceiverProbe {
    private readonly transport: ProtectedTransport;
    private readonly tokenProvider: ReceiverTokenProvider;
    private readonly authority: ReceiverProbeAuthority;
    private readonly binding: ReceiverProbeBinding;
    private readonly target: ReviewedReceiverTarget;
    private readonly url: URL;
    private readonly timeoutMs: number;

    constructor(options: Readonly<{
        transport: ProtectedTransport;
        tokenProvider: ReceiverTokenProvider;
        authority: ReceiverProbeAuthority;
        timeoutMs?: number;
    }>) {
        this.transport = options.transport;
        this.tokenProvider = options.tokenProvider;
        this.authority = options.authority;
        this.binding = receiverProbeBinding(options.authority);
        this.target = Object.freeze({ ...this.binding.target });
        this.url = this.parseTarget(this.target);
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > MAX_TIMEOUT_MS) fail('ADAPTER_REQUEST_INVALID');
    }

    async malformedBody(): Promise<Readonly<{ status: number; code: string }>> {
        // The first check is useful for an early rejection before ID-token
        // acquisition. The second check below is the final mutation barrier:
        // a lost owner, fence, or durable ABORTED marker while token minting
        // awaits must result in zero POSTs.
        const binding = receiverProbeBinding(this.authority);
        await binding.leaseCheck();
        let token: string;
        try {
            token = await this.withTimeout(this.tokenProvider({ audience: this.target.audience, callerIdentity: this.target.callerIdentity }), 'ADAPTER_TIMEOUT');
        } catch (error) {
            if (error instanceof EpochError) throw error;
            fail('ADAPTER_REQUEST_INVALID');
        }
        assertBoundedString(token, 8192);
        await binding.leaseCheck();
        const request: ProtectedHttpRequest = {
            method: 'POST',
            url: this.url.toString(),
            headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
            body: binding.body,
        };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let response: ProtectedHttpResponse;
        try {
            response = await this.withTimeout(this.transport.request(request, controller.signal), 'ADAPTER_TIMEOUT');
        } catch (error) {
            if (error instanceof EpochError) throw error;
            fail('ADAPTER_TIMEOUT');
        } finally {
            clearTimeout(timer);
        }
        if (response.url !== undefined && response.url !== request.url) fail('ADAPTER_REDIRECT');
        assertHttpStatus(response.status);
        if (response.status !== binding.expectedStatus || typeof response.body !== 'string' || Buffer.byteLength(response.body, 'utf8') > DEFAULT_MAX_RESPONSE_BYTES) fail('PROBE_FAILED');
        const body = parseProtectedObject(response.body);
        if (Object.keys(body).sort().join(',') !== 'code' || body.code !== binding.expectedCode) fail('PROBE_FAILED');
        return { status: response.status, code: binding.expectedCode };
    }

    private parseTarget(target: ReviewedReceiverTarget): URL {
        if (typeof target.callerIdentity !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/.test(target.callerIdentity)) fail('ADAPTER_REQUEST_INVALID');
        let url: URL;
        let audience: URL;
        try {
            url = new URL(target.url);
            audience = new URL(target.audience);
        } catch {
            fail('ADAPTER_REQUEST_INVALID');
        }
        if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
            || audience.protocol !== 'https:' || audience.username || audience.password || audience.port || audience.pathname !== '/' || audience.search || audience.hash
            || audience.origin !== url.origin) fail('ADAPTER_REQUEST_INVALID');
        return url;
    }

    private async withTimeout<T>(promise: Promise<T>, code: EpochErrorCode): Promise<T> {
        const marker = Symbol('receiver-probe-timeout');
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const result = await Promise.race([
                promise,
                new Promise<T | typeof marker>(resolve => { timer = setTimeout(() => resolve(marker), this.timeoutMs); }),
            ]);
            if (result === marker) fail(code);
            return result as T;
        } finally {
            if (timer !== undefined) clearTimeout(timer);
        }
    }
}

export { EpochError };
