import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync,
    readlinkSync, readSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
    type BigIntStats,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';
import { resolvePrimaryRepositoryRootForOwner } from './capacity-identity-epoch/owner-production';
import { rejectDuplicateJsonKeys } from './capacity-identity-epoch/packet';

/** This attestation verifier never parses, applies, or reserializes SQL. */
export const PRIVATE_SOURCE_TOOL_VERSION = 'private-migration-source-v1';
const CLI_VERSION = '2.114.0';
const CLI_PATH = '/opt/homebrew/bin/supabase';
const MAX_SOURCES = 2_048;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_ENV_BYTES = 1024 * 1024;
const MAX_METADATA_BYTES = 4 * 1024;
const MAX_CLI_STATE_BYTES = 1024;
const MAX_CHILD_BYTES = 512 * 1024;
const MAX_GIT_BYTES = 1024 * 1024;
const CHILD_TIMEOUT_MS = 30_000;
const VERSION = /^(?:00[1-9]|010|[0-9]{14})$/;
const MODERN_VERSION = /^[0-9]{14}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SHA1 = /^[0-9a-f]{40}$/;
const MD5 = /^[0-9a-f]{32}$/;
const SAFE_PATH = /^[^\u0000-\u001f\u007f]{1,4096}$/;
const GIT_ENV = Object.freeze({
    PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
});

export const PRIVATE_SOURCE_ERROR_CODES = [
    'INVALID_ARGUMENTS', 'ROOT_UNAVAILABLE', 'MANIFEST_INVALID', 'PATH_UNSAFE',
    'SOURCE_MISMATCH', 'BASE_GIT_MISMATCH', 'PROJECT_INVALID', 'ENV_INVALID',
    'CLI_UNAVAILABLE', 'CLI_VERSION_MISMATCH', 'CLI_CAPABILITY_MISMATCH',
    'CHILD_FAILED', 'CHILD_TIMEOUT', 'CHILD_OUTPUT_LIMIT', 'CHILD_TERMINATION_UNCONFIRMED', 'REMOTE_INVALID',
    'REMOTE_MISMATCH', 'DRY_RUN_FAILED', 'PENDING_MIGRATIONS', 'ORIGINALS_CHANGED',
    'CLEANUP_FAILED', 'INTERNAL_FAILURE',
] as const;
export type PrivateSourceErrorCode = typeof PRIVATE_SOURCE_ERROR_CODES[number];
export class PrivateSourceError extends Error {
    constructor(public readonly code: PrivateSourceErrorCode) { super(code); this.name = 'PrivateSourceError'; }
}
function fail(code: PrivateSourceErrorCode): never { throw new PrivateSourceError(code); }
export function privateSourceErrorCode(error: unknown): PrivateSourceErrorCode {
    return error instanceof PrivateSourceError && PRIVATE_SOURCE_ERROR_CODES.includes(error.code)
        ? error.code : 'INTERNAL_FAILURE';
}

export interface LocalSource {
    version: string; filename: string; bytes: number; sha256: string;
}
export interface PrivateSource extends LocalSource {
    path: string; statementCount: number; canonicalLength: number; canonicalMd5: string;
}
export interface PrivateSourceManifest {
    schemaVersion: 1; attestationBaseGitSha: string; localSources: LocalSource[];
    excludedLocalSources: LocalSource[]; privateSources: PrivateSource[];
}
export type PrivateSourceOptions = Readonly<{
    mode: 'local-only' | 'dry-run'; manifestPath: string; auth: 'keychain' | 'root-env';
}>;
export type PrivateSourceArgs = PrivateSourceOptions | Readonly<{ help: true }>;

export function parsePrivateSourceArgs(args: readonly string[]): PrivateSourceArgs {
    if (args.length === 1 && args[0] === '--help') return { help: true };
    if (args[0] !== 'verify' || args.length > 6) fail('INVALID_ARGUMENTS');
    let manifestPath: string | undefined;
    let mode: PrivateSourceOptions['mode'] | undefined;
    let auth: PrivateSourceOptions['auth'] = 'keychain';
    let authSeen = false;
    for (let index = 1; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--manifest') {
            if (manifestPath !== undefined) fail('INVALID_ARGUMENTS');
            const value = args[++index];
            if (!value || value.startsWith('-') || !SAFE_PATH.test(value)) fail('INVALID_ARGUMENTS');
            manifestPath = value;
        } else if (arg === '--local-only' || arg === '--dry-run') {
            if (mode !== undefined) fail('INVALID_ARGUMENTS');
            mode = arg === '--local-only' ? 'local-only' : 'dry-run';
        } else if (arg === '--auth=root-env') {
            if (authSeen) fail('INVALID_ARGUMENTS');
            auth = 'root-env'; authSeen = true;
        } else fail('INVALID_ARGUMENTS');
    }
    if (!manifestPath || !mode || (authSeen && mode !== 'dry-run')) fail('INVALID_ARGUMENTS');
    return { mode, manifestPath, auth };
}

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    return object(value) && Object.keys(value).length === keys.length
        && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function positive(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}
function absolutePath(value: unknown): value is string {
    return typeof value === 'string' && SAFE_PATH.test(value) && isAbsolute(value) && resolve(value) === value;
}
function source(value: unknown, privateSource: boolean): LocalSource | PrivateSource {
    const keys = ['version', 'filename', 'bytes', 'sha256'];
    if (privateSource) keys.push('path', 'statementCount', 'canonicalLength', 'canonicalMd5');
    if (!exactKeys(value, keys) || typeof value.version !== 'string'
        || !(privateSource ? MODERN_VERSION : VERSION).test(value.version)
        || typeof value.filename !== 'string'
        || !new RegExp(`^${value.version}_[A-Za-z0-9][A-Za-z0-9_-]*\\.sql$`).test(value.filename)
        || value.filename.length > 240 || !positive(value.bytes, MAX_SOURCE_BYTES)
        || typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) fail('MANIFEST_INVALID');
    const local: LocalSource = { version: value.version, filename: value.filename, bytes: value.bytes, sha256: value.sha256 };
    if (!privateSource) return local;
    if (!absolutePath(value.path) || !positive(value.statementCount) || !positive(value.canonicalLength)
        || typeof value.canonicalMd5 !== 'string' || !MD5.test(value.canonicalMd5)) fail('MANIFEST_INVALID');
    return { ...local, path: value.path, statementCount: value.statementCount,
        canonicalLength: value.canonicalLength, canonicalMd5: value.canonicalMd5 };
}
function localIdentity(value: LocalSource): string {
    return [value.version, value.filename, value.bytes, value.sha256].join(':');
}
function strictJson(raw: string, error: PrivateSourceErrorCode): unknown {
    try { rejectDuplicateJsonKeys(raw); return JSON.parse(raw) as unknown; } catch { fail(error); }
}
export function parsePrivateSourceManifest(raw: string): PrivateSourceManifest {
    if (Buffer.byteLength(raw) > MAX_MANIFEST_BYTES) fail('MANIFEST_INVALID');
    const value = strictJson(raw, 'MANIFEST_INVALID');
    if (!exactKeys(value, ['schemaVersion', 'attestationBaseGitSha', 'localSources', 'excludedLocalSources', 'privateSources'])
        || value.schemaVersion !== 1 || typeof value.attestationBaseGitSha !== 'string'
        || !SHA1.test(value.attestationBaseGitSha) || !Array.isArray(value.localSources)
        || value.localSources.length < 6 || value.localSources.length > MAX_SOURCES
        || !Array.isArray(value.excludedLocalSources) || value.excludedLocalSources.length !== 6
        || !Array.isArray(value.privateSources) || value.privateSources.length !== 6) fail('MANIFEST_INVALID');
    const locals = value.localSources.map(item => source(item, false) as LocalSource);
    const excluded = value.excludedLocalSources.map(item => source(item, false) as LocalSource);
    const privateSources = value.privateSources.map(item => source(item, true) as PrivateSource);
    const identities = new Map(locals.map(item => [item.version, localIdentity(item)]));
    if (identities.size !== locals.length || new Set(excluded.map(item => item.version)).size !== 6
        || excluded.some(item => !MODERN_VERSION.test(item.version) || identities.get(item.version) !== localIdentity(item))
        || new Set(privateSources.map(item => item.version)).size !== 6
        || new Set(privateSources.map(item => item.path)).size !== 6
        || privateSources.some(item => identities.has(item.version))
        || [...locals, ...privateSources].reduce((total, item) => total + item.bytes, 0) > MAX_TOTAL_SOURCE_BYTES) fail('MANIFEST_INVALID');
    return { schemaVersion: 1, attestationBaseGitSha: value.attestationBaseGitSha,
        localSources: locals, excludedLocalSources: excluded, privateSources };
}

export interface PrivateSourceChildRequest {
    command: string; args: readonly string[]; cwd: string; env: Readonly<Record<string, string>>;
    timeoutMs: number; maxOutputBytes: number; signal: AbortSignal;
}
export interface PrivateSourceChildResult { stdout: string; stderr: string; exitCode: number; }
/** Injection is for owner tests only; CLI arguments cannot override any of these boundaries. */
export interface PrivateSourceDependencies {
    cwd?: string; uid?: number; homeDir?: string; tempDir?: string; cliPath?: string;
    resolveRoot?: (cwd: string) => string | Promise<string>;
    runChild?: (request: PrivateSourceChildRequest) => Promise<PrivateSourceChildResult>;
    runGit?: (request: PrivateSourceChildRequest) => Promise<PrivateSourceChildResult>;
    removeTemp?: (path: string) => void | Promise<void>;
    childTimeoutMs?: number; now?: () => Date;
}
export interface PrivateSourceReceipt {
    observedAt: string; toolVersion: string; cliVersion: string | null; status: 'verified' | 'failed';
    localCount: number | null; privateCount: number | null; remoteCount: number | null;
    hashesMatch: boolean; parityMatch: boolean | null; plannedMigrationCount: 0 | null;
    originalsUnchanged: boolean; cleanupSucceeded: boolean; errorCode: PrivateSourceErrorCode | null;
}
export function emptyPrivateSourceReceipt(now: () => Date = () => new Date()): PrivateSourceReceipt {
    let observedAt: string;
    try { observedAt = now().toISOString(); } catch { observedAt = new Date().toISOString(); }
    return { observedAt, toolVersion: PRIVATE_SOURCE_TOOL_VERSION, cliVersion: null, status: 'failed',
        localCount: null, privateCount: null, remoteCount: null, hashesMatch: false, parityMatch: null,
        plannedMigrationCount: null, originalsUnchanged: false, cleanupSucceeded: true, errorCode: null };
}

function fileIdentity(stat: BigIntStats): string {
    return [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}
function directoryIdentity(stat: BigIntStats): string {
    // Reading files and creating our workdir can change directory times; identity and permissions cannot change.
    return [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode].join(':');
}
type FileMode = 'private' | 'public' | 'env';
interface FileSnapshot { path: string; identity: string; hash: string; maximum: number; mode: FileMode; }
export function isSafePrivateSourceAncestorDirectory(
    path: string, stat: Readonly<{ uid: number; mode: number; directory: boolean; symlink: boolean }>, expectedUid: number,
): boolean {
    if (!stat.directory || stat.symlink || (stat.uid !== 0 && stat.uid !== expectedUid)) return false;
    if ((stat.mode & 0o022) === 0) return true;
    return stat.uid === 0 && ['/tmp', '/private/tmp'].includes(path) && (stat.mode & 0o7777) === 0o1777;
}
class SourceBoundary {
    readonly files = new Map<string, FileSnapshot>();
    readonly directories = new Map<string, string>();
    migrationDirectory?: string;
    migrationNames?: string[];
    constructor(readonly uid: number) {}

    directoriesFor(path: string): void {
        if (!absolutePath(path)) fail('PATH_UNSAFE');
        let current: string = sep;
        const parts = dirname(path).split(sep).filter(Boolean);
        for (const part of [undefined, ...parts]) {
            if (part !== undefined) current = join(current, part);
            let stat: BigIntStats;
            try { stat = lstatSync(current, { bigint: true }); } catch { fail('PATH_UNSAFE'); }
            if (!isSafePrivateSourceAncestorDirectory(current, { uid: Number(stat.uid), mode: Number(stat.mode),
                directory: stat.isDirectory(), symlink: stat.isSymbolicLink() }, this.uid)) fail('PATH_UNSAFE');
            const identity = directoryIdentity(stat);
            const previous = this.directories.get(current);
            if (previous !== undefined && previous !== identity) fail('ORIGINALS_CHANGED');
            this.directories.set(current, identity);
        }
    }
    directory(path: string, privateDirectory = false): void {
        this.directoriesFor(join(path, 'placeholder'));
        const stat = lstatSync(path, { bigint: true });
        if (privateDirectory && (stat.uid !== BigInt(this.uid) || (stat.mode & BigInt(0o7777)) !== BigInt(0o700))) fail('PATH_UNSAFE');
    }
    read(path: string, mode: FileMode, maximum: number): Buffer {
        this.directoriesFor(path);
        if (mode === 'private') this.directory(dirname(path), true);
        let initial: BigIntStats;
        try { initial = lstatSync(path, { bigint: true }); } catch { fail('PATH_UNSAFE'); }
        if (!initial.isFile() || initial.isSymbolicLink() || initial.uid !== BigInt(this.uid)
            || (mode !== 'public' ? (initial.mode & BigInt(0o7777)) !== BigInt(0o600) : (initial.mode & BigInt(0o022)) !== BigInt(0))
            || initial.size <= BigInt(0) || initial.size > BigInt(maximum)) fail('PATH_UNSAFE');
        let fd: number | undefined;
        let bytes: Buffer;
        try {
            fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
            if (fileIdentity(fstatSync(fd, { bigint: true })) !== fileIdentity(initial)) fail('ORIGINALS_CHANGED');
            this.directoriesFor(path);
            const buffer = Buffer.alloc(Number(initial.size) + 1);
            let length = 0;
            while (length < buffer.length) {
                const count = readSync(fd, buffer, length, buffer.length - length, null);
                if (count === 0) break;
                length += count;
            }
            if (length !== Number(initial.size)
                || fileIdentity(fstatSync(fd, { bigint: true })) !== fileIdentity(initial)
                || fileIdentity(lstatSync(path, { bigint: true })) !== fileIdentity(initial)) fail('ORIGINALS_CHANGED');
            this.directoriesFor(path);
            bytes = buffer.subarray(0, length);
        } catch (error) { if (error instanceof PrivateSourceError) throw error; fail('PATH_UNSAFE'); }
        finally { if (fd !== undefined) { try { closeSync(fd); } catch { fail('PATH_UNSAFE'); } } }
        const snapshot: FileSnapshot = { path, identity: fileIdentity(initial), hash: digest(bytes!), maximum, mode };
        const prior = this.files.get(path);
        if (prior && (prior.identity !== snapshot.identity || prior.hash !== snapshot.hash)) fail('ORIGINALS_CHANGED');
        this.files.set(path, snapshot);
        return bytes!;
    }
    unchanged(): boolean {
        try {
            for (const [path, identity] of this.directories) {
                const stat = lstatSync(path, { bigint: true });
                if (!stat.isDirectory() || stat.isSymbolicLink() || directoryIdentity(stat) !== identity) return false;
            }
            for (const snapshot of [...this.files.values()]) {
                const bytes = this.read(snapshot.path, snapshot.mode, snapshot.maximum);
                if (digest(bytes) !== snapshot.hash || this.files.get(snapshot.path)?.identity !== snapshot.identity) return false;
            }
            if (this.migrationDirectory && this.migrationNames
                && JSON.stringify(readdirSync(this.migrationDirectory).sort()) !== JSON.stringify(this.migrationNames)) return false;
            return true;
        } catch { return false; }
    }
}
function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function text(bytes: Buffer, error: PrivateSourceErrorCode): string {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail(error); }
}
function outsideRepository(path: string, root: string): void {
    const rel = relative(root, path);
    if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) fail('PATH_UNSAFE');
}

/** Private pipes, no shell, no inherited env, fixed timeout and aggregate output cap. */
async function nativeChild(request: PrivateSourceChildRequest): Promise<PrivateSourceChildResult> {
    return new Promise((resolveResult, reject) => {
        if (process.platform !== 'darwin' && process.platform !== 'linux') { reject(new PrivateSourceError('CHILD_FAILED')); return; }
        const stdout: Buffer[] = [], stderr: Buffer[] = [];
        let size = 0; let settled = false; let failure: PrivateSourceErrorCode | undefined;
        let spawned = false; let leaderExited = false; let leaderClosed = false;
        let stdoutClosed = false; let stderrClosed = false; let exitCode: number | null = null;
        let killRequested = false;
        let probeUncertain = false;
        let requestTimer: ReturnType<typeof setTimeout> | undefined;
        let terminationTimer: ReturnType<typeof setTimeout> | undefined;
        let pollTimer: ReturnType<typeof setTimeout> | undefined;
        // POSIX detached creates a new session and process group whose leader is this exact child.
        // Never derive a kill target from argv, env, returned output, or the parent's process group.
        const child = spawn(request.command, [...request.args], { cwd: request.cwd, env: { ...request.env } as NodeJS.ProcessEnv,
            shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const groupId = child.pid;
        const groupAlive = (): boolean | undefined => {
            if (!spawned) return false;
            if (!Number.isSafeInteger(groupId) || groupId! <= 0 || groupId === process.pid) return undefined;
            try { process.kill(-groupId!, 0); return true; }
            catch (error) { return object(error) && error.code === 'ESRCH' ? false : undefined; }
        };
        const settle = (error?: PrivateSourceErrorCode): void => {
            if (settled) return;
            settled = true;
            request.signal.removeEventListener('abort', abort);
            if (requestTimer !== undefined) clearTimeout(requestTimer);
            if (terminationTimer !== undefined) clearTimeout(terminationTimer);
            if (pollTimer !== undefined) clearTimeout(pollTimer);
            if (error === 'CHILD_TERMINATION_UNCONFIRMED') {
                // Lifetime could not be established. Drop references without claiming cleanup
                // or allowing source/workdir finalization while a process might still use them.
                child.stdout.destroy(); child.stderr.destroy(); child.unref();
            }
            if (error) { reject(new PrivateSourceError(error)); return; }
            try { resolveResult({ stdout: text(Buffer.concat(stdout), 'CHILD_FAILED'),
                stderr: text(Buffer.concat(stderr), 'CHILD_FAILED'), exitCode: exitCode! }); }
            catch { reject(new PrivateSourceError('CHILD_FAILED')); }
        };
        const killGroup = (): void => {
            if (!spawned || settled) return;
            if (!Number.isSafeInteger(groupId) || groupId! <= 0 || groupId === process.pid) { settle('CHILD_TERMINATION_UNCONFIRMED'); return; }
            try { process.kill(-groupId!, 'SIGKILL'); }
            catch (error) { if (!object(error) || error.code !== 'ESRCH') settle('CHILD_TERMINATION_UNCONFIRMED'); }
        };
        const checkTermination = (): void => {
            if (settled) return;
            const alive = groupAlive();
            if (alive === undefined) {
                // Darwin can transiently deny a group probe while the last member is reaped.
                // Observe within the same fixed grace; never equate denial with termination.
                if (terminationTimer === undefined) {
                    probeUncertain = true;
                    terminationTimer = setTimeout(() => settle('CHILD_TERMINATION_UNCONFIRMED'), 1_000);
                }
                if (pollTimer === undefined) pollTimer = setTimeout(() => { pollTimer = undefined; checkTermination(); }, 25);
                return;
            }
            if (probeUncertain && !killRequested) {
                if (terminationTimer !== undefined) clearTimeout(terminationTimer);
                terminationTimer = undefined; probeUncertain = false;
            }
            if (alive) {
                if (leaderExited && !killRequested) { finishError('CHILD_FAILED'); return; }
                if (killRequested && pollTimer === undefined) pollTimer = setTimeout(() => {
                    pollTimer = undefined; checkTermination();
                }, 25);
                return;
            }
            if (leaderClosed && stdoutClosed && stderrClosed) settle(failure ?? (exitCode === 0 ? undefined : 'CHILD_FAILED'));
        };
        const finishError = (code: PrivateSourceErrorCode): void => {
            if (settled) return;
            failure ??= code;
            if (!killRequested) {
                killRequested = true;
                if (requestTimer !== undefined) clearTimeout(requestTimer);
                if (terminationTimer !== undefined) clearTimeout(terminationTimer);
                probeUncertain = false;
                // Bounded failure never means the child was closed: an unconfirmed lifetime
                // has its own enum and prevents original checks and workdir cleanup.
                terminationTimer = setTimeout(() => settle('CHILD_TERMINATION_UNCONFIRMED'), 1_000);
                killGroup();
            }
            checkTermination();
        };
        const abort = (): void => finishError('CHILD_TIMEOUT');
        const collect = (target: Buffer[], chunk: Buffer): void => {
            if (settled || failure) return;
            size += chunk.byteLength;
            if (size > request.maxOutputBytes) { finishError('CHILD_OUTPUT_LIMIT'); return; }
            target.push(chunk);
        };
        child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
        child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
        child.stdout.on('close', () => { stdoutClosed = true; checkTermination(); });
        child.stderr.on('close', () => { stderrClosed = true; checkTermination(); });
        child.stdout.on('error', () => finishError('CHILD_FAILED'));
        child.stderr.on('error', () => finishError('CHILD_FAILED'));
        child.on('spawn', () => { spawned = true; if (killRequested) killGroup(); checkTermination(); });
        child.on('error', () => finishError('CHILD_FAILED'));
        child.on('exit', code => {
            leaderExited = true; exitCode = code;
            if (code !== 0) finishError('CHILD_FAILED'); else checkTermination();
        });
        child.on('close', code => {
            leaderClosed = true; leaderExited = true; exitCode = code;
            if (code !== 0) finishError('CHILD_FAILED'); else checkTermination();
        });
        request.signal.addEventListener('abort', abort, { once: true });
        requestTimer = setTimeout(abort, request.timeoutMs);
        if (request.signal.aborted) abort();
    });
}
async function boundedChild(
    transport: (request: PrivateSourceChildRequest) => Promise<PrivateSourceChildResult>,
    input: Omit<PrivateSourceChildRequest, 'signal'>,
): Promise<PrivateSourceChildResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
        const request = { ...input, signal: controller.signal };
        // Native transport owns timeout, process-group termination, and pipe closure as one
        // lifetime boundary; a wrapper race must never outrun its close confirmation.
        if (transport === nativeChild) return await nativeChild(request);
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                timedOut = true; controller.abort();
                // An injected transport must also settle after abort. A promise that stays
                // pending cannot establish lifetime, even though it is only a test seam.
                terminationTimer = setTimeout(() => reject(new PrivateSourceError('CHILD_TERMINATION_UNCONFIRMED')), 1_000);
            }, input.timeoutMs);
        });
        const result = await Promise.race([transport(request), timeout]);
        if (timedOut) fail('CHILD_TIMEOUT');
        if (!exactKeys(result, ['stdout', 'stderr', 'exitCode']) || typeof result.stdout !== 'string'
            || typeof result.stderr !== 'string' || !Number.isInteger(result.exitCode)) fail('CHILD_FAILED');
        if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > input.maxOutputBytes) fail('CHILD_OUTPUT_LIMIT');
        return result as unknown as PrivateSourceChildResult;
    } catch (error) {
        if (error instanceof PrivateSourceError && error.code === 'CHILD_TERMINATION_UNCONFIRMED') throw error;
        if (timedOut) fail('CHILD_TIMEOUT');
        if (error instanceof PrivateSourceError) throw error;
        return fail('CHILD_FAILED');
    }
    finally { if (timer !== undefined) clearTimeout(timer); if (terminationTimer !== undefined) clearTimeout(terminationTimer); }
}

function gitChild(root: string, args: readonly string[], deps: PrivateSourceDependencies): Promise<PrivateSourceChildResult> {
    return boundedChild(deps.runGit ?? nativeChild, {
        command: '/usr/bin/git', args: ['-C', root, ...args], cwd: root, env: GIT_ENV,
        timeoutMs: 5_000, maxOutputBytes: MAX_GIT_BYTES,
    });
}
async function repositoryCheckouts(root: string, deps: PrivateSourceDependencies): Promise<string[]> {
    const result = await gitChild(root, ['worktree', 'list', '--porcelain', '-z'], deps);
    if (result.exitCode !== 0 || result.stderr !== '' || !result.stdout.endsWith('\0')) fail('ROOT_UNAVAILABLE');
    const roots = result.stdout.split('\0').filter(field => field.startsWith('worktree ')).map(field => field.slice(9));
    if (roots.length === 0 || roots.length > MAX_SOURCES || !roots.includes(root) || roots.some(path => !absolutePath(path))) fail('ROOT_UNAVAILABLE');
    return roots;
}
async function verifyGitBase(root: string, manifest: PrivateSourceManifest, buffers: Map<string, Buffer>, deps: PrivateSourceDependencies): Promise<void> {
    const ancestry = await gitChild(root, ['merge-base', '--is-ancestor', manifest.attestationBaseGitSha, 'HEAD'], deps);
    if (ancestry.exitCode !== 0 || ancestry.stdout !== '' || ancestry.stderr !== '') fail('BASE_GIT_MISMATCH');
    const tree = await gitChild(root, ['ls-tree', '-rz', '--full-tree', manifest.attestationBaseGitSha, '--', 'supabase/migrations'], deps);
    if (tree.exitCode !== 0 || tree.stderr !== '' || !tree.stdout.endsWith('\0')) fail('BASE_GIT_MISMATCH');
    const records = tree.stdout.slice(0, -1).split('\0');
    if (records.length !== manifest.localSources.length) fail('BASE_GIT_MISMATCH');
    const expected = new Map(manifest.localSources.map(item => [item.filename, item]));
    const seen = new Set<string>();
    for (const record of records) {
        const match = /^(100644|100755) blob ([0-9a-f]{40})\tsupabase\/migrations\/([^/]+)$/.exec(record);
        if (!match || !expected.has(match[3]) || seen.has(match[3])) fail('BASE_GIT_MISMATCH');
        seen.add(match[3]);
        const bytes = buffers.get(match[3]);
        if (!bytes || createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== match[2]) fail('BASE_GIT_MISMATCH');
    }
}

export function isSafeSupabaseExecutableDirectory(
    path: string, stat: Readonly<{ uid: number; gid: number; mode: number; directory: boolean; symlink: boolean }>,
    expectedUid: number, platform: NodeJS.Platform = process.platform,
): boolean {
    if (!stat.directory || stat.symlink || (stat.uid !== 0 && stat.uid !== expectedUid)) return false;
    if ((stat.mode & 0o022) === 0) return true;
    // Root-owned sticky temp ancestors preserve owner entries; user-owned writable ancestors do not.
    if (stat.uid === 0 && ['/tmp', '/private/tmp'].includes(path) && (stat.mode & 0o7777) === 0o1777) return true;
    return platform === 'darwin' && ['/opt/homebrew/bin', '/opt/homebrew/Cellar'].includes(path)
        && stat.gid === 80 && (stat.mode & 0o7777) === 0o775;
}
function executableAncestors(path: string, uid: number): void {
    let current: string = sep;
    for (const part of [undefined, ...dirname(path).split(sep).filter(Boolean)]) {
        if (part !== undefined) current = join(current, part);
        const stat = lstatSync(current, { bigint: true });
        if (!isSafeSupabaseExecutableDirectory(current, { uid: Number(stat.uid), gid: Number(stat.gid),
            mode: Number(stat.mode), directory: stat.isDirectory(), symlink: stat.isSymbolicLink() }, uid)) fail('CLI_UNAVAILABLE');
    }
}
function validatedExecutable(path: string, uid: number): string {
    if (!absolutePath(path)) fail('CLI_UNAVAILABLE');
    let current = path;
    const visited = new Set<string>();
    try {
        for (let depth = 0; depth < 16; depth += 1) {
            if (visited.has(current)) fail('CLI_UNAVAILABLE');
            visited.add(current); executableAncestors(current, uid);
            const stat = lstatSync(current, { bigint: true });
            if (stat.uid !== BigInt(0) && stat.uid !== BigInt(uid)) fail('CLI_UNAVAILABLE');
            if (stat.isSymbolicLink()) {
                // Homebrew's fixed binary path is a symlink. Its chain and target are verified,
                // and children receive the resolved regular executable, never a PATH lookup.
                const target = readlinkSync(current);
                if (!SAFE_PATH.test(target)) fail('CLI_UNAVAILABLE');
                current = resolve(dirname(current), target); continue;
            }
            if (!stat.isFile() || (stat.mode & BigInt(0o022)) !== BigInt(0) || (stat.mode & BigInt(0o111)) === BigInt(0)
                || realpathSync(current) !== current) fail('CLI_UNAVAILABLE');
            return current;
        }
    } catch { fail('CLI_UNAVAILABLE'); }
    fail('CLI_UNAVAILABLE');
}

function oneLine(bytes: Buffer): string {
    const raw = text(bytes, 'PROJECT_INVALID');
    const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    if (!line || /[\s\u0000-\u001f\u007f]/.test(line)) fail('PROJECT_INVALID');
    return line;
}
function rootIdentity(root: string, boundary: SourceBoundary, auth: PrivateSourceOptions['auth']): {
    ref: string; metadata: { ref: Buffer; pooler: Buffer }; token?: string;
} {
    const refBytes = boundary.read(join(root, 'supabase', '.temp', 'project-ref'), 'public', MAX_METADATA_BYTES);
    const poolerBytes = boundary.read(join(root, 'supabase', '.temp', 'pooler-url'), 'public', MAX_METADATA_BYTES);
    const ref = oneLine(refBytes), pooler = oneLine(poolerBytes);
    if (!/^[a-z]{20}$/.test(ref)) fail('PROJECT_INVALID');
    let url: URL;
    try { url = new URL(pooler); } catch { fail('PROJECT_INVALID'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.username !== `postgres.${ref}`
        || url.password !== '' || !/^aws-[0-9]+-[a-z0-9]+(?:-[a-z0-9]+)*\.pooler\.supabase\.com$/.test(url.hostname)
        || !['5432', '6543'].includes(url.port) || url.pathname !== '/postgres' || url.search !== '' || url.hash !== '') fail('PROJECT_INVALID');
    const envBytes = boundary.read(join(root, '.env.local'), 'env', MAX_ENV_BYTES);
    let env: NodeJS.Dict<string>;
    try { env = parseEnv(text(envBytes, 'ENV_INVALID')); } catch { fail('ENV_INVALID'); }
    const origins = [env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_URL].filter(value => value !== undefined);
    if (origins.length === 0 || origins.some(value => value !== `https://${ref}.supabase.co` && value !== `https://${ref}.supabase.co/`)) fail('PROJECT_INVALID');
    let token: string | undefined;
    if (auth === 'root-env') {
        token = env.SUPABASE_ACCESS_TOKEN;
        if (typeof token !== 'string' || token.length === 0 || token.length > 8192 || /[\s\u0000-\u001f\u007f]/.test(token)) fail('ENV_INVALID');
    }
    return { ref, metadata: { ref: refBytes, pooler: poolerBytes }, ...(token === undefined ? {} : { token }) };
}

/** Interpolation is limited to validated 14-digit migration versions; no caller-supplied SQL exists. */
function remoteProjection(manifest: PrivateSourceManifest): string {
    const versions = manifest.privateSources.map(source => `'${source.version}'`).sort().join(',');
    const select = (expression: string, alias: string) => `CASE WHEN version IN (${versions}) THEN ${expression} ELSE NULL END AS ${alias}`;
    return 'SELECT version, ' + [select('cardinality(statements)', 'statement_count'),
        select("character_length(array_to_string(statements, E'\\n'))", 'canonical_length'),
        select("md5(array_to_string(statements, E'\\n'))", 'canonical_md5')].join(', ')
        + ' FROM supabase_migrations.schema_migrations ORDER BY version;';
}
function remoteParity(raw: string, manifest: PrivateSourceManifest): number {
    const value = strictJson(raw, 'REMOTE_INVALID');
    if (!Array.isArray(value) || value.length > MAX_SOURCES) fail('REMOTE_INVALID');
    const excluded = new Set(manifest.excludedLocalSources.map(source => source.version));
    const expected = new Set([...manifest.localSources.filter(source => !excluded.has(source.version)), ...manifest.privateSources].map(source => source.version));
    const privateSources = new Map(manifest.privateSources.map(source => [source.version, source]));
    const seen = new Set<string>();
    for (const row of value) {
        if (!exactKeys(row, ['version', 'statement_count', 'canonical_length', 'canonical_md5'])
            || typeof row.version !== 'string' || !VERSION.test(row.version) || seen.has(row.version)) fail('REMOTE_INVALID');
        seen.add(row.version);
        if (!expected.has(row.version)) fail('REMOTE_MISMATCH');
        const source = privateSources.get(row.version);
        if (source) {
            if (!positive(row.statement_count) || !positive(row.canonical_length) || typeof row.canonical_md5 !== 'string'
                || !MD5.test(row.canonical_md5)) fail('REMOTE_INVALID');
            if (row.statement_count !== source.statementCount || row.canonical_length !== source.canonicalLength
                || row.canonical_md5 !== source.canonicalMd5) fail('REMOTE_MISMATCH');
        } else if (row.statement_count !== null || row.canonical_length !== null || row.canonical_md5 !== null) fail('REMOTE_INVALID');
    }
    if (seen.size !== expected.size) fail('REMOTE_MISMATCH');
    return seen.size;
}

const NATIVE_STATUS_LINES = new Set([
    'Initialising login role...', 'Initializing login role...', 'Connecting to remote database...',
    'DRY RUN: migrations will *not* be pushed to the database.',
]);
function lines(raw: string): string[] {
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) fail('CHILD_FAILED');
    return raw.replace(/\r\n/g, '\n').split('\n').filter(line => line !== '');
}
function nativeStatus(raw: string, workdir: string, allowSuccess = false): number {
    let success = 0;
    for (const line of lines(raw)) {
        if (allowSuccess && line === 'Remote database is up to date.') { success += 1; continue; }
        if (NATIVE_STATUS_LINES.has(line) || line === `Using workdir ${workdir}`) continue;
        fail(allowSuccess ? 'DRY_RUN_FAILED' : 'CHILD_FAILED');
    }
    return success;
}
function capabilities(raw: string, flags: readonly string[]): boolean {
    return flags.every(flag => new RegExp(`(?:^|\\s)${flag}(?=[\\s=,]|$)`, 'm').test(raw));
}

function verifyTemporarySourceSet(
    workdir: string, identity: string, cliStateIdentity: string, uid: number,
    targets: ReadonlyMap<string, string>, metadata: { ref: Buffer; pooler: Buffer },
): void {
    const boundary = new SourceBoundary(uid);
    const cliState = join(workdir, 'cli-state');
    const supabase = join(workdir, 'supabase');
    const migrations = join(supabase, 'migrations');
    const temporaryMetadata = join(supabase, '.temp');
    for (const path of [workdir, cliState, supabase, migrations, temporaryMetadata]) boundary.directory(path, true);
    const metadataNames = readdirSync(temporaryMetadata).sort();
    const expectedMetadataNames = ['pooler-url', 'project-ref'];
    if (metadataNames.includes('linked-project.json')) expectedMetadataNames.push('linked-project.json');
    expectedMetadataNames.sort();
    if (directoryIdentity(lstatSync(workdir, { bigint: true })) !== identity
        || directoryIdentity(lstatSync(cliState, { bigint: true })) !== cliStateIdentity
        || JSON.stringify(readdirSync(workdir).sort()) !== JSON.stringify(['cli-state', 'supabase'])
        || JSON.stringify(readdirSync(supabase).sort()) !== JSON.stringify(['.temp', 'migrations'])
        || JSON.stringify(metadataNames) !== JSON.stringify(expectedMetadataNames)
        || JSON.stringify(readdirSync(migrations).sort()) !== JSON.stringify([...targets.keys()].sort())) fail('SOURCE_MISMATCH');
    const stateNames = readdirSync(cliState);
    if (stateNames.length > 1 || (stateNames.length === 1 && stateNames[0] !== 'telemetry.json')) fail('SOURCE_MISMATCH');
    if (stateNames.length === 1) {
        // DO_NOT_TRACK permits a best-effort compact denied-consent state write. Inspect only
        // file metadata; never read, parse, retain, or emit anonymous state contents.
        const path = join(cliState, 'telemetry.json');
        try {
            const initial = lstatSync(path, { bigint: true });
            if (!initial.isFile() || initial.isSymbolicLink() || initial.uid !== BigInt(uid)
                || (initial.mode & BigInt(0o022)) !== BigInt(0) || initial.size > BigInt(MAX_CLI_STATE_BYTES)) fail('SOURCE_MISMATCH');
            // lstat never dereferences the file or requires body-read permission.
            if (fileIdentity(lstatSync(path, { bigint: true })) !== fileIdentity(initial)
                || directoryIdentity(lstatSync(cliState, { bigint: true })) !== cliStateIdentity) fail('SOURCE_MISMATCH');
        } catch { fail('SOURCE_MISMATCH'); }
    }
    for (const [filename, target] of targets) {
        const path = join(migrations, filename);
        const stat = lstatSync(path, { bigint: true });
        if (!stat.isSymbolicLink() || stat.uid !== BigInt(uid) || readlinkSync(path) !== target) fail('SOURCE_MISMATCH');
    }
    if (!boundary.read(join(temporaryMetadata, 'project-ref'), 'private', MAX_METADATA_BYTES).equals(metadata.ref)
        || !boundary.read(join(temporaryMetadata, 'pooler-url'), 'private', MAX_METADATA_BYTES).equals(metadata.pooler)) fail('SOURCE_MISMATCH');
    if (metadataNames.includes('linked-project.json')) {
        // Native 2.114.0 generates only this noncredential cache after a linked query.
        // It is validated, never copied or emitted, and never selects the connection.
        const linked = strictJson(text(boundary.read(join(temporaryMetadata, 'linked-project.json'), 'public', MAX_METADATA_BYTES),
            'SOURCE_MISMATCH'), 'SOURCE_MISMATCH');
        if (!exactKeys(linked, ['ref', 'name', 'organization_id', 'organization_slug'])
            || linked.ref !== oneLine(metadata.ref)
            || ['name', 'organization_id', 'organization_slug'].some(key => typeof linked[key] !== 'string'
                || linked[key].length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(linked[key]))) fail('SOURCE_MISMATCH');
    }
}

export async function verifyPrivateSources(options: PrivateSourceOptions, deps: PrivateSourceDependencies = {}): Promise<PrivateSourceReceipt> {
    const receipt = emptyPrivateSourceReceipt(deps.now);
    const uid = deps.uid ?? process.getuid?.() ?? -1;
    const boundary = new SourceBoundary(uid);
    let workdir: string | undefined;
    let temporaryIdentity: string | undefined;
    let sourcesVerified = false;
    let verifiedRoot: string | undefined;
    let verifiedBase: string | undefined;
    try {
        if (!Number.isSafeInteger(uid) || uid < 0) fail('ROOT_UNAVAILABLE');
        let root: string;
        try { root = await (deps.resolveRoot ?? resolvePrimaryRepositoryRootForOwner)(deps.cwd ?? process.cwd()); }
        catch { fail('ROOT_UNAVAILABLE'); }
        if (!absolutePath(root)) fail('ROOT_UNAVAILABLE');
        boundary.directory(root);
        const checkouts = await repositoryCheckouts(root, deps);
        // Relative CLI manifest inputs resolve once; manifest/private paths never traverse symlinks or '..'.
        const manifestPath = isAbsolute(options.manifestPath) ? options.manifestPath : resolve(deps.cwd ?? process.cwd(), options.manifestPath);
        if (!absolutePath(manifestPath)) fail('PATH_UNSAFE');
        for (const checkout of checkouts) outsideRepository(manifestPath, checkout);
        const manifest = parsePrivateSourceManifest(text(boundary.read(manifestPath, 'private', MAX_MANIFEST_BYTES), 'MANIFEST_INVALID'));
        receipt.localCount = manifest.localSources.length; receipt.privateCount = 6;
        const migrationDirectory = join(root, 'supabase', 'migrations');
        boundary.directory(migrationDirectory);
        const names = readdirSync(migrationDirectory).sort();
        if (names.length > MAX_SOURCES || JSON.stringify(names) !== JSON.stringify(manifest.localSources.map(source => source.filename).sort())) fail('SOURCE_MISMATCH');
        boundary.migrationDirectory = migrationDirectory; boundary.migrationNames = names;
        const buffers = new Map<string, Buffer>();
        for (const source of manifest.localSources) {
            const bytes = boundary.read(join(migrationDirectory, source.filename), 'public', MAX_SOURCE_BYTES);
            if (bytes.length !== source.bytes || digest(bytes) !== source.sha256) fail('SOURCE_MISMATCH');
            buffers.set(source.filename, bytes);
        }
        for (const source of manifest.privateSources) {
            for (const checkout of checkouts) outsideRepository(source.path, checkout);
            if (source.path === manifestPath || source.path.split(sep).at(-1) !== source.filename) fail('PATH_UNSAFE');
            const bytes = boundary.read(source.path, 'private', MAX_SOURCE_BYTES);
            if (bytes.length !== source.bytes || digest(bytes) !== source.sha256) fail('SOURCE_MISMATCH');
        }
        await verifyGitBase(root, manifest, buffers, deps);
        buffers.clear(); receipt.hashesMatch = true;
        if (!boundary.unchanged()) fail('ORIGINALS_CHANGED');
        sourcesVerified = true;
        verifiedRoot = root; verifiedBase = manifest.attestationBaseGitSha;
        if (options.mode === 'dry-run') {
            const identity = rootIdentity(root, boundary, options.auth);
            const commandPath = deps.cliPath ?? CLI_PATH;
            const command = validatedExecutable(commandPath, uid);
            const executableIdentity = fileIdentity(lstatSync(command, { bigint: true }));
            const tempBase = realpathSync(deps.tempDir ?? tmpdir());
            boundary.directory(tempBase);
            workdir = mkdtempSync(join(tempBase, 'supabase-private-source-'));
            // mkdtemp creates mode 700; never chmod any input directory or file.
            const created = lstatSync(workdir, { bigint: true });
            if (!created.isDirectory() || created.uid !== BigInt(uid) || (created.mode & BigInt(0o777)) !== BigInt(0o700)) fail('PATH_UNSAFE');
            temporaryIdentity = directoryIdentity(created);
            const cliState = join(workdir, 'cli-state');
            mkdirSync(cliState, { mode: 0o700 });
            const cliStateIdentity = directoryIdentity(lstatSync(cliState, { bigint: true }));
            const supabase = join(workdir, 'supabase');
            mkdirSync(supabase, { mode: 0o700 });
            mkdirSync(join(supabase, '.temp'), { mode: 0o700 });
            mkdirSync(join(supabase, 'migrations'), { mode: 0o700 });
            writeFileSync(join(supabase, '.temp', 'project-ref'), identity.metadata.ref, { mode: 0o600, flag: 'wx' });
            writeFileSync(join(supabase, '.temp', 'pooler-url'), identity.metadata.pooler, { mode: 0o600, flag: 'wx' });
            const excluded = new Set(manifest.excludedLocalSources.map(source => source.version));
            const targets = new Map<string, string>();
            for (const source of manifest.localSources.filter(source => !excluded.has(source.version))) {
                targets.set(source.filename, join(migrationDirectory, source.filename));
            }
            for (const source of manifest.privateSources) targets.set(source.filename, source.path);
            for (const [filename, target] of targets) symlinkSync(target, join(supabase, 'migrations', filename));
            const home = realpathSync(deps.homeDir ?? homedir());
            boundary.directory(home);
            const env = Object.freeze({ PATH: '/usr/bin:/bin:/opt/homebrew/bin', HOME: home, TMPDIR: workdir, LANG: 'C', LC_ALL: 'C',
                DO_NOT_TRACK: '1', SUPABASE_HOME: cliState,
                ...(identity.token === undefined ? {} : { SUPABASE_ACCESS_TOKEN: identity.token }) });
            const timeoutMs = deps.childTimeoutMs ?? CHILD_TIMEOUT_MS;
            if (!positive(timeoutMs, CHILD_TIMEOUT_MS)) fail('INVALID_ARGUMENTS');
            const child = async (args: readonly string[]): Promise<PrivateSourceChildResult> => {
                if (!boundary.unchanged()) fail('ORIGINALS_CHANGED');
                verifyTemporarySourceSet(workdir!, temporaryIdentity!, cliStateIdentity, uid, targets, identity.metadata);
                if (validatedExecutable(commandPath, uid) !== command
                    || fileIdentity(lstatSync(command, { bigint: true })) !== executableIdentity) fail('CLI_UNAVAILABLE');
                return boundedChild(deps.runChild ?? nativeChild, { command, args, cwd: workdir!, env, timeoutMs, maxOutputBytes: MAX_CHILD_BYTES });
            };
            const version = await child(['--version']);
            if (version.exitCode !== 0 || version.stderr !== '' || !/^2\.114\.0\n?$/.test(version.stdout)) fail('CLI_VERSION_MISMATCH');
            receipt.cliVersion = CLI_VERSION;
            for (const subcommand of ['query', 'push']) {
                const help = await child(['db', subcommand, '--help']);
                if (help.exitCode !== 0 || help.stderr !== '' || !capabilities(help.stdout,
                    subcommand === 'query' ? ['--linked', '--project-ref', '--workdir', '--output', '--agent', '--profile']
                        : ['--linked', '--project-ref', '--workdir', '--dry-run', '--skip-vault', '--profile'])) fail('CLI_CAPABILITY_MISMATCH');
            }
            const query = await child(['db', 'query', '--linked', '--project-ref', identity.ref, '--workdir', workdir,
                '--output', 'json', '--agent=no', '--profile=supabase', remoteProjection(manifest)]);
            if (query.exitCode !== 0) fail('CHILD_FAILED');
            nativeStatus(query.stderr, workdir);
            receipt.remoteCount = remoteParity(query.stdout, manifest); receipt.parityMatch = true;
            const dryRun = await child(['db', 'push', '--dry-run', '--skip-vault', '--linked', '--project-ref', identity.ref,
                '--workdir', workdir, '--profile=supabase']);
            if (dryRun.exitCode !== 0) fail('DRY_RUN_FAILED');
            if (/Would push these migrations:|Do you want to push these migrations|Applying migration|Finished supabase db push\./.test(dryRun.stdout + '\n' + dryRun.stderr)) fail('PENDING_MIGRATIONS');
            if (nativeStatus(dryRun.stdout, workdir, true) + nativeStatus(dryRun.stderr, workdir, true) !== 1) fail('DRY_RUN_FAILED');
            verifyTemporarySourceSet(workdir, temporaryIdentity, cliStateIdentity, uid, targets, identity.metadata);
            receipt.plannedMigrationCount = 0;
        }
        receipt.status = 'verified';
    } catch (error) { receipt.errorCode = privateSourceErrorCode(error); }
    finally {
        let lifetimeEstablished = receipt.errorCode !== 'CHILD_TERMINATION_UNCONFIRMED';
        receipt.originalsUnchanged = lifetimeEstablished && sourcesVerified && boundary.unchanged();
        if (receipt.originalsUnchanged && verifiedRoot && verifiedBase) {
            try {
                const currentRoot = await (deps.resolveRoot ?? resolvePrimaryRepositoryRootForOwner)(deps.cwd ?? process.cwd());
                const ancestry = await gitChild(verifiedRoot, ['merge-base', '--is-ancestor', verifiedBase, 'HEAD'], deps);
                if (currentRoot !== verifiedRoot || ancestry.exitCode !== 0 || ancestry.stdout !== '' || ancestry.stderr !== '') receipt.originalsUnchanged = false;
            } catch (error) {
                receipt.originalsUnchanged = false;
                if (privateSourceErrorCode(error) === 'CHILD_TERMINATION_UNCONFIRMED') lifetimeEstablished = false;
            }
        }
        if (!lifetimeEstablished) {
            receipt.status = 'failed'; receipt.errorCode = 'CHILD_TERMINATION_UNCONFIRMED';
            receipt.originalsUnchanged = false; receipt.cleanupSucceeded = false; receipt.plannedMigrationCount = null;
        } else if (sourcesVerified && !receipt.originalsUnchanged) { receipt.status = 'failed'; receipt.errorCode = 'ORIGINALS_CHANGED'; }
        if (lifetimeEstablished && workdir !== undefined) {
            try {
                const current = lstatSync(workdir, { bigint: true });
                if (!temporaryIdentity || !current.isDirectory() || current.isSymbolicLink()
                    || directoryIdentity(current) !== temporaryIdentity) fail('CLEANUP_FAILED');
                if (deps.removeTemp) await deps.removeTemp(workdir); else rmSync(workdir, { recursive: true, force: false });
                try { lstatSync(workdir); fail('CLEANUP_FAILED'); }
                catch (error) { if (!object(error) || error.code !== 'ENOENT') fail('CLEANUP_FAILED'); }
            } catch { receipt.cleanupSucceeded = false; receipt.status = 'failed'; receipt.errorCode = 'CLEANUP_FAILED'; }
        }
        if (receipt.errorCode !== null) receipt.status = 'failed';
    }
    return receipt;
}
