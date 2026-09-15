import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EpochError, epochFail, isObject } from './contracts';

const STORAGE_HOST = 'storage.googleapis.com';
const STORAGE_PATH_PREFIX = '/download/storage/v1/b/';
const PYTHON_COMMAND = 'python3';
const PYTHON_HELPER = fileURLToPath(new URL('./verify-source-archive.py', import.meta.url));
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BUCKET = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;
const GENERATION = /^[1-9][0-9]*$/;
const OBJECT = /^[^\u0000-\u001f\u007f]{1,1024}$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]{1,4096}$/;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
const MAX_HELPER_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_DECOMPRESSED_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_MS = 15_000;
const GIT_ENV: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
};

function fail(code: 'ADAPTER_REQUEST_INVALID' | 'ADAPTER_RESPONSE_INVALID' | 'ADAPTER_TIMEOUT' | 'ADAPTER_REDIRECT' | 'ADAPTER_NOT_ALLOWED' | 'EVIDENCE_UNAVAILABLE'): never {
    epochFail(code);
}

export type StorageSourceReferenceInput = Readonly<{
    bucket: string;
    object: string;
    generation: string | number;
}>;

export type StorageSourceReference = Readonly<{
    bucket: string;
    object: string;
    generation: string;
}>;

export type StorageSourceProof = Readonly<{
    reviewedSha: string;
    archiveSha256: string;
    sourceContext: string;
    sourceBucket: string;
    sourceObject: string;
    sourceGeneration: string;
}>;

export type StorageSourceVerifier = (input: Readonly<{
    source: StorageSourceReferenceInput;
    reviewedSha: string;
}>) => Promise<StorageSourceProof | null>;

export type StorageSourceBinaryRequest = Readonly<{
    method: 'GET';
    url: string;
    headers: Readonly<Record<string, string>>;
}>;

export type StorageSourceBinaryResponse = Readonly<{
    status: number;
    headers: Readonly<Record<string, string>>;
    body: Uint8Array;
    url?: string;
}>;

export interface StorageSourceBinaryTransport {
    request(request: StorageSourceBinaryRequest, signal?: AbortSignal): Promise<StorageSourceBinaryResponse>;
}

function generationString(value: unknown): string | null {
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value) || value <= 0) return null;
        return String(value);
    }
    return typeof value === 'string' && GENERATION.test(value) ? value : null;
}

export function normalizeStorageSource(value: unknown): StorageSourceReference | null {
    if (!isObject(value)
        || typeof value.bucket !== 'string'
        || typeof value.object !== 'string') return null;
    const generation = generationString(value.generation);
    if (!BUCKET.test(value.bucket) || !OBJECT.test(value.object) || generation === null) return null;
    try {
        encodeURIComponent(value.object);
    } catch {
        return null;
    }
    return Object.freeze({ bucket: value.bucket, object: value.object, generation });
}

export function storageSourceContext(value: StorageSourceReferenceInput): string {
    const source = normalizeStorageSource(value);
    if (!source) fail('ADAPTER_REQUEST_INVALID');
    return source.bucket + '/' + source.object + '#' + source.generation;
}

function sourceUrl(source: StorageSourceReference): string {
    return 'https://' + STORAGE_HOST + STORAGE_PATH_PREFIX + source.bucket + '/o/'
        + encodeURIComponent(source.object) + '?alt=media&generation='
        + encodeURIComponent(source.generation);
}

function header(headers: Readonly<Record<string, string>>, name: string): string | undefined {
    const wanted = name.toLowerCase();
    return Object.entries(headers).find(([key]) => key.toLowerCase() === wanted)?.[1];
}

function assertStorageUrl(raw: string): URL {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        fail('ADAPTER_REQUEST_INVALID');
    }
    if (url.protocol !== 'https:' || url.hostname !== STORAGE_HOST
        || url.port || url.username || url.password || url.hash
        || [...url.searchParams.keys()].sort().join(',') !== 'alt,generation'
        || url.searchParams.get('alt') !== 'media'
        || !GENERATION.test(url.searchParams.get('generation') ?? '')) {
        fail('ADAPTER_NOT_ALLOWED');
    }
    const rest = url.pathname.startsWith(STORAGE_PATH_PREFIX)
        ? url.pathname.slice(STORAGE_PATH_PREFIX.length) : '';
    const objectMarker = '/o/';
    const marker = rest.indexOf(objectMarker);
    if (marker <= 0 || rest.indexOf(objectMarker, marker + objectMarker.length) >= 0) fail('ADAPTER_NOT_ALLOWED');
    const bucket = rest.slice(0, marker);
    const encodedObject = rest.slice(marker + objectMarker.length);
    if (!BUCKET.test(bucket) || encodedObject.length === 0 || encodedObject.includes('/')) fail('ADAPTER_NOT_ALLOWED');
    let object: string;
    try {
        object = decodeURIComponent(encodedObject);
    } catch {
        fail('ADAPTER_NOT_ALLOWED');
    }
    if (!OBJECT.test(object) || encodeURIComponent(object) !== encodedObject) fail('ADAPTER_NOT_ALLOWED');
    return url;
}

function responseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null
        && (!/^[0-9]+$/.test(contentLength) || !Number.isSafeInteger(Number(contentLength))
            || Number(contentLength) > maxBytes)) fail('ADAPTER_RESPONSE_INVALID');
    if (!response.body) {
        return response.arrayBuffer().then(value => {
            const bytes = new Uint8Array(value);
            if (bytes.byteLength > maxBytes) fail('ADAPTER_RESPONSE_INVALID');
            return bytes;
        });
    }
    return (async () => {
        const reader = response.body!.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
            while (true) {
                const next = await reader.read();
                if (next.done) break;
                total += next.value.byteLength;
                if (total > maxBytes) {
                    await reader.cancel();
                    fail('ADAPTER_RESPONSE_INVALID');
                }
                chunks.push(new Uint8Array(next.value));
            }
        } catch (error) {
            if (error instanceof EpochError) throw error;
            fail('ADAPTER_RESPONSE_INVALID');
        }
        const body = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return body;
    })();
}

/** Production binary transport for the exact generation-pinned GCS media URL. */
export class FetchStorageSourceTransport implements StorageSourceBinaryTransport {
    private readonly maxResponseBytes: number;

    constructor(maxResponseBytes = DEFAULT_MAX_ARCHIVE_BYTES) {
        if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0 || maxResponseBytes > MAX_ARCHIVE_BYTES) {
            fail('ADAPTER_REQUEST_INVALID');
        }
        this.maxResponseBytes = maxResponseBytes;
    }

    async request(request: StorageSourceBinaryRequest, signal?: AbortSignal): Promise<StorageSourceBinaryResponse> {
        if (request.method !== 'GET') fail('ADAPTER_NOT_ALLOWED');
        const url = assertStorageUrl(request.url);
        let response: Response;
        try {
            response = await fetch(url.toString(), {
                method: 'GET',
                headers: request.headers,
                redirect: 'error',
                signal,
            });
        } catch {
            fail('ADAPTER_TIMEOUT');
        }
        if (response.url !== url.toString()) fail('ADAPTER_REDIRECT');
        let body: Uint8Array;
        try {
            body = await responseBytes(response, this.maxResponseBytes);
        } catch (error) {
            if (error instanceof EpochError) throw error;
            fail('ADAPTER_RESPONSE_INVALID');
        }
        return {
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            body,
            url: response.url,
        };
    }
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
    const limit = value ?? fallback;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > maximum) fail('ADAPTER_REQUEST_INVALID');
    return limit;
}

function boundedTimeout(value: number | undefined): number {
    return boundedLimit(value, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
}

function assertTrustedRepoCwd(value: unknown): string {
    if (typeof value !== 'string' || !SAFE_TEXT.test(value)) fail('ADAPTER_REQUEST_INVALID');
    try {
        const resolved = realpathSync(value);
        if (!statSync(resolved).isDirectory()) fail('ADAPTER_REQUEST_INVALID');
        return resolved;
    } catch (error) {
        if (error instanceof EpochError) throw error;
        fail('ADAPTER_REQUEST_INVALID');
    }
}

function runGit(repoCwd: string, args: readonly string[]): Buffer {
    try {
        const output = execFileSync('git', [...args], {
            cwd: repoCwd,
            env: GIT_ENV,
            shell: false,
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: MAX_GIT_OUTPUT_BYTES,
        });
        if (!Buffer.isBuffer(output)) fail('EVIDENCE_UNAVAILABLE');
        return output;
    } catch (error) {
        if (error instanceof EpochError) throw error;
        fail('EVIDENCE_UNAVAILABLE');
    }
}

function safeArchivePath(value: unknown): value is string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 2048
        || value.startsWith('/') || value.endsWith('/') || value.includes('\\')
        || /[\u0000-\u001f\u007f]/.test(value)
        || (value.length >= 2 && /^[A-Za-z]:/.test(value))) return false;
    const parts = value.split('/');
    return parts.every(part => part.length > 0 && part !== '.' && part !== '..');
}

function reviewedGitManifest(repoCwdInput: string, reviewedSha: string): Map<string, string> {
    if (!SHA1.test(reviewedSha)) fail('ADAPTER_REQUEST_INVALID');
    const repoCwd = assertTrustedRepoCwd(repoCwdInput);
    const resolved = runGit(repoCwd, ['rev-parse', '--verify', reviewedSha + '^{commit}']).toString('utf8');
    if (resolved !== reviewedSha + '\n') fail('EVIDENCE_UNAVAILABLE');
    const tree = runGit(repoCwd, ['ls-tree', '-r', '-z', '--full-tree', reviewedSha, '--']);
    let output: string;
    try {
        output = new TextDecoder('utf-8', { fatal: true }).decode(tree);
    } catch {
        fail('EVIDENCE_UNAVAILABLE');
    }
    if (!output.endsWith('\0')) fail('EVIDENCE_UNAVAILABLE');
    const files = new Map<string, string>();
    for (const record of output.slice(0, -1).split('\0')) {
        const tab = record.indexOf('\t');
        if (tab <= 0) fail('EVIDENCE_UNAVAILABLE');
        const treeHeader = record.slice(0, tab).split(' ');
        const path = record.slice(tab + 1);
        if (treeHeader.length !== 3 || treeHeader[1] !== 'blob'
            || (treeHeader[0] !== '100644' && treeHeader[0] !== '100755')
            || !SHA1.test(treeHeader[2] ?? '') || !safeArchivePath(path) || files.has(path)) {
            fail('EVIDENCE_UNAVAILABLE');
        }
        files.set(path, treeHeader[2]!);
    }
    if (files.size === 0) fail('EVIDENCE_UNAVAILABLE');
    return files;
}

type ArchiveManifest = Readonly<{
    archiveSha256: string;
    files: readonly Readonly<{ path: string; blobSha1: string }>[];
    directories: readonly string[];
    decompressedBytes: number;
}>;

function parseArchiveManifest(
    repoCwd: string,
    archive: Uint8Array,
    limits: Readonly<{ maxArchiveBytes: number; maxDecompressedBytes: number; maxEntries: number; timeoutMs: number }>,
): ArchiveManifest {
    let raw: string;
    try {
        raw = execFileSync(PYTHON_COMMAND, [
            PYTHON_HELPER,
            '--max-archive-bytes', String(limits.maxArchiveBytes),
            '--max-decompressed-bytes', String(limits.maxDecompressedBytes),
            '--max-entries', String(limits.maxEntries),
        ], {
            cwd: repoCwd,
            env: GIT_ENV,
            shell: false,
            input: Buffer.from(archive),
            stdio: ['pipe', 'pipe', 'ignore'],
            encoding: 'utf8',
            timeout: limits.timeoutMs,
            maxBuffer: MAX_HELPER_OUTPUT_BYTES,
        }) as string;
    } catch (error) {
        if (error instanceof EpochError) throw error;
        fail('EVIDENCE_UNAVAILABLE');
    }
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        fail('EVIDENCE_UNAVAILABLE');
    }
    if (!isObject(value)
        || Object.keys(value).sort().join(',') !== 'archiveSha256,decompressedBytes,directories,files'
        || typeof value.archiveSha256 !== 'string' || !SHA256.test(value.archiveSha256)
        || typeof value.decompressedBytes !== 'number' || !Number.isSafeInteger(value.decompressedBytes)
        || value.decompressedBytes < 0
        || value.decompressedBytes > limits.maxDecompressedBytes
        || !Array.isArray(value.files) || !Array.isArray(value.directories)
        || value.files.length > limits.maxEntries || value.directories.length > limits.maxEntries
        || value.files.length + value.directories.length > limits.maxEntries) {
        fail('EVIDENCE_UNAVAILABLE');
    }
    const files: Array<{ path: string; blobSha1: string }> = [];
    const filePaths = new Set<string>();
    for (const entry of value.files) {
        if (!isObject(entry) || Object.keys(entry).sort().join(',') !== 'blobSha1,path'
            || typeof entry.path !== 'string' || typeof entry.blobSha1 !== 'string'
            || !safeArchivePath(entry.path) || !SHA1.test(entry.blobSha1) || filePaths.has(entry.path)) {
            fail('EVIDENCE_UNAVAILABLE');
        }
        filePaths.add(entry.path);
        files.push({ path: entry.path, blobSha1: entry.blobSha1 });
    }
    const directories: string[] = [];
    const directoryPaths = new Set<string>();
    for (const entry of value.directories) {
        if (typeof entry !== 'string' || !safeArchivePath(entry) || directoryPaths.has(entry)) {
            fail('EVIDENCE_UNAVAILABLE');
        }
        directoryPaths.add(entry);
        directories.push(entry);
    }
    const archiveSha256 = createHash('sha256').update(Buffer.from(archive)).digest('hex');
    if (archiveSha256 !== value.archiveSha256) fail('EVIDENCE_UNAVAILABLE');
    return { archiveSha256, files, directories, decompressedBytes: value.decompressedBytes };
}

function archiveLimits(options: Readonly<{
    maxArchiveBytes?: number;
    maxDecompressedBytes?: number;
    maxEntries?: number;
    timeoutMs?: number;
}>): Readonly<{ maxArchiveBytes: number; maxDecompressedBytes: number; maxEntries: number; timeoutMs: number }> {
    return Object.freeze({
        maxArchiveBytes: boundedLimit(options.maxArchiveBytes, DEFAULT_MAX_ARCHIVE_BYTES, MAX_ARCHIVE_BYTES),
        maxDecompressedBytes: boundedLimit(options.maxDecompressedBytes, DEFAULT_MAX_DECOMPRESSED_BYTES, MAX_DECOMPRESSED_BYTES),
        maxEntries: boundedLimit(options.maxEntries, DEFAULT_MAX_ENTRIES, MAX_ENTRIES),
        timeoutMs: boundedTimeout(options.timeoutMs),
    });
}

function expectedDirectories(files: ReadonlyMap<string, string>): Set<string> {
    const directories = new Set<string>();
    for (const path of files.keys()) {
        const parts = path.split('/');
        for (let index = 1; index < parts.length; index += 1) {
            directories.add(parts.slice(0, index).join('/'));
        }
    }
    return directories;
}

export type StorageSourceArchiveVerificationInput = Readonly<{
    repoCwd: string;
    reviewedSha: string;
    source: StorageSourceReferenceInput;
    archive: Uint8Array;
    allowLegacyGitignoreOmission?: boolean;
    maxArchiveBytes?: number;
    maxDecompressedBytes?: number;
    maxEntries?: number;
    timeoutMs?: number;
}>;

/**
 * Prove that a generation-pinned source ZIP is exactly the reviewed Git tree.
 * The only accepted legacy omission is a tracked root .gitignore, matching
 * gcloudignore's documented default exclusion; no archive or file content is
 * returned.
 */
export function verifyStorageSourceArchive(input: StorageSourceArchiveVerificationInput): StorageSourceProof | null {
    const source = normalizeStorageSource(input.source);
    if (!source || !SHA1.test(input.reviewedSha) || !(input.archive instanceof Uint8Array)) {
        fail('ADAPTER_REQUEST_INVALID');
    }
    const limits = archiveLimits(input);
    if (input.archive.byteLength > limits.maxArchiveBytes) return null;
    const repoCwd = assertTrustedRepoCwd(input.repoCwd);
    const expected = reviewedGitManifest(repoCwd, input.reviewedSha);
    const manifest = parseArchiveManifest(repoCwd, input.archive, limits);
    const actual = new Map(manifest.files.map(entry => [entry.path, entry.blobSha1]));
    const missing = [...expected.keys()].filter(path => !actual.has(path));
    const allowGitignore = input.allowLegacyGitignoreOmission ?? true;
    if (missing.length > 0
        && (!allowGitignore || missing.length !== 1 || missing[0] !== '.gitignore')) return null;
    for (const [path, blobSha1] of actual) {
        if (!expected.has(path) || expected.get(path) !== blobSha1) return null;
    }
    const knownDirectories = expectedDirectories(expected);
    if (manifest.directories.some(path => !knownDirectories.has(path))) return null;
    return Object.freeze({
        reviewedSha: input.reviewedSha,
        archiveSha256: manifest.archiveSha256,
        sourceContext: storageSourceContext(source),
        sourceBucket: source.bucket,
        sourceObject: source.object,
        sourceGeneration: source.generation,
    });
}

class AuthenticatedStorageSourceReader {
    private readonly transport: StorageSourceBinaryTransport;
    private readonly tokenProvider: () => Promise<string>;
    private readonly maxArchiveBytes: number;
    private readonly timeoutMs: number;

    constructor(options: Readonly<{
        transport: StorageSourceBinaryTransport;
        tokenProvider: () => Promise<string>;
        maxArchiveBytes: number;
        timeoutMs: number;
    }>) {
        this.transport = options.transport;
        this.tokenProvider = options.tokenProvider;
        this.maxArchiveBytes = options.maxArchiveBytes;
        this.timeoutMs = options.timeoutMs;
    }

    async read(value: StorageSourceReferenceInput): Promise<Uint8Array> {
        const source = normalizeStorageSource(value);
        if (!source) fail('ADAPTER_REQUEST_INVALID');
        const url = sourceUrl(source);
        let token: string;
        try {
            token = await this.withTimeout(this.tokenProvider(), 'ADAPTER_TIMEOUT');
        } catch (error) {
            if (error instanceof EpochError) throw error;
            fail('ADAPTER_REQUEST_INVALID');
        }
        if (typeof token !== 'string' || token.length === 0 || token.length > 8192
            || /[\u0000-\u001f\u007f]/.test(token)) fail('ADAPTER_REQUEST_INVALID');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let response: StorageSourceBinaryResponse;
        try {
            response = await this.withTimeout(this.transport.request({
                method: 'GET',
                url,
                headers: {
                    authorization: 'Bearer ' + token,
                    accept: 'application/zip, application/octet-stream',
                },
            }, controller.signal), 'ADAPTER_TIMEOUT');
        } catch (error) {
            if (error instanceof EpochError) throw error;
            fail('ADAPTER_TIMEOUT');
        } finally {
            clearTimeout(timer);
        }
        if (response.url !== undefined && response.url !== url) fail('ADAPTER_REDIRECT');
        if (!Number.isSafeInteger(response.status) || response.status < 100 || response.status > 599
            || !isObject(response.headers) || !(response.body instanceof Uint8Array)) {
            fail('ADAPTER_RESPONSE_INVALID');
        }
        if (response.status !== 200) {
            if (response.status === 401 || response.status === 403) fail('ADAPTER_NOT_ALLOWED');
            fail('ADAPTER_RESPONSE_INVALID');
        }
        if (header(response.headers, 'x-goog-generation') !== source.generation
            || response.body.byteLength > this.maxArchiveBytes) fail('ADAPTER_RESPONSE_INVALID');
        return new Uint8Array(response.body);
    }

    private async withTimeout<T>(promise: Promise<T>, code: 'ADAPTER_TIMEOUT'): Promise<T> {
        const marker = Symbol('storage-source-timeout');
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

export type StorageSourceVerifierOptions = Readonly<{
    repoCwd: string;
    tokenProvider: () => Promise<string>;
    transport?: StorageSourceBinaryTransport;
    allowLegacyGitignoreOmission?: boolean;
    maxArchiveBytes?: number;
    maxDecompressedBytes?: number;
    maxEntries?: number;
    timeoutMs?: number;
}>;

/** Build a verifier closure that keeps credentials in memory and returns proof only on a full match. */
export function createStorageSourceVerifier(options: StorageSourceVerifierOptions): StorageSourceVerifier {
    const limits = archiveLimits(options);
    const repoCwd = assertTrustedRepoCwd(options.repoCwd);
    const reader = new AuthenticatedStorageSourceReader({
        transport: options.transport ?? new FetchStorageSourceTransport(limits.maxArchiveBytes),
        tokenProvider: options.tokenProvider,
        maxArchiveBytes: limits.maxArchiveBytes,
        timeoutMs: limits.timeoutMs,
    });
    return async ({ source: sourceInput, reviewedSha }) => {
        const source = normalizeStorageSource(sourceInput);
        if (!source || !SHA1.test(reviewedSha)) fail('ADAPTER_REQUEST_INVALID');
        const archive = await reader.read(source);
        return verifyStorageSourceArchive({
            repoCwd,
            reviewedSha,
            source,
            archive,
            allowLegacyGitignoreOmission: options.allowLegacyGitignoreOmission,
            maxArchiveBytes: limits.maxArchiveBytes,
            maxDecompressedBytes: limits.maxDecompressedBytes,
            maxEntries: limits.maxEntries,
            timeoutMs: limits.timeoutMs,
        });
    };
}
