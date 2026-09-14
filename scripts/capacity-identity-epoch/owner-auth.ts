import { lstatSync, readFileSync } from 'node:fs';
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { basename, dirname, relative, resolve } from 'node:path';
import {
    AuthenticatedProtectedTransport,
    createGoogleProtectedTransport,
    FetchProtectedTransport,
    type ProtectedTokenProvider,
} from './platform';
import { EpochError, epochFail, hasExactKeys, isObject, PROJECT_ID_PATTERN } from './contracts';

const MAX_OWNER_FILE_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 8 * 1024;
const SAFE_PATH = /^[^\u0000-\u001f\u007f]{1,4096}$/;
const SAFE_TOKEN = /^[^\u0000-\u001f\u007f\s]{1,8192}$/;
const SAFE_VERCEL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_VERCEL_NAME = /^[^\u0000-\u001f\u007f]{1,256}$/;
const SAFE_REPO_DIRECTORY = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

function unavailable(): never {
    epochFail('OWNER_AUTH_UNAVAILABLE');
}

function safeToken(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_TOKEN_BYTES && SAFE_TOKEN.test(value);
}

function pathValue(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !SAFE_PATH.test(value)) unavailable();
}

function boundedFile(path: string, expectedUid: number): string {
    pathValue(path);
    let stat: ReturnType<typeof lstatSync>;
    try {
        // lstat intentionally rejects symlinked credential paths.  The owner
        // boundary must be attached to the actual file, not a mutable link.
        stat = lstatSync(path);
    } catch {
        unavailable();
    }
    if (!stat.isFile() || stat.uid !== expectedUid || (stat.mode & 0o022) !== 0) unavailable();
    if (stat.size < 0 || stat.size > MAX_OWNER_FILE_BYTES) unavailable();
    try {
        const value = readFileSync(path, 'utf8');
        if (Buffer.byteLength(value, 'utf8') > MAX_OWNER_FILE_BYTES) unavailable();
        return value;
    } catch {
        unavailable();
    }
}

function jsonFile(path: string, expectedUid: number): Record<string, unknown> {
    const raw = boundedFile(path, expectedUid);
    let value: unknown;
    try { value = JSON.parse(raw) as unknown; } catch { unavailable(); }
    if (!isObject(value)) unavailable();
    return value;
}

function currentUid(): number {
    if (typeof process.getuid !== 'function') unavailable();
    const uid = process.getuid();
    if (!Number.isSafeInteger(uid) || uid < 0) unavailable();
    return uid;
}

function normalizedRepoDirectory(value: unknown): string {
    if (value === '.') return '.';
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('/') || value.includes('\\')
        || !SAFE_REPO_DIRECTORY.test(value)) unavailable();
    const segments = value.split('/');
    if (segments.some(segment => segment === '.' || segment === '..')) unavailable();
    return segments.join('/');
}

function parseRepoLink(value: Record<string, unknown>, metadataPath: string, cwd: string): Readonly<{ projectId: string; teamId: string }> {
    const keys = Object.keys(value).sort();
    if (!keys.every(key => ['orgId', 'projects', 'remoteName'].includes(key))
        || !hasExactKeys(value, value.orgId === undefined ? ['projects', 'remoteName'] : ['orgId', 'projects', 'remoteName'])
        || typeof value.remoteName !== 'string' || !SAFE_VERCEL_NAME.test(value.remoteName)
        || !Array.isArray(value.projects) || value.projects.length === 0) unavailable();
    const topLevelOrgId = value.orgId;
    if (topLevelOrgId !== undefined && (typeof topLevelOrgId !== 'string' || !SAFE_VERCEL_ID.test(topLevelOrgId))) unavailable();
    const projects = value.projects.map(project => {
        if (!isObject(project)
            || !Object.keys(project).every(key => ['directory', 'id', 'name', 'orgId'].includes(key))
            || !['directory', 'id', 'name'].every(key => Object.prototype.hasOwnProperty.call(project, key))
            || typeof project.id !== 'string' || !SAFE_VERCEL_ID.test(project.id)
            || typeof project.name !== 'string' || !SAFE_VERCEL_NAME.test(project.name)
            || (project.orgId !== undefined && (typeof project.orgId !== 'string' || !SAFE_VERCEL_ID.test(project.orgId)))) unavailable();
        return {
            id: project.id,
            directory: normalizedRepoDirectory(project.directory),
            orgId: project.orgId as string | undefined,
        };
    });
    if (new Set(projects.map(project => project.id)).size !== projects.length) unavailable();
    const repoRoot = resolve(dirname(dirname(metadataPath)));
    const current = resolve(cwd);
    const relativePath = relative(repoRoot, current);
    if (relativePath === '..' || relativePath.startsWith('../') || relativePath.startsWith('..\\')) unavailable();
    const currentDirectory = relativePath === '' ? '.' : relativePath.split('\\').join('/');
    const matches = projects.filter(project => project.directory === '.'
        || currentDirectory === project.directory
        || currentDirectory.startsWith(`${project.directory}/`));
    if (matches.length === 0) unavailable();
    const mostSpecificLength = Math.max(...matches.map(project => project.directory === '.' ? 0 : project.directory.split('/').length));
    const mostSpecific = matches.filter(project => (project.directory === '.' ? 0 : project.directory.split('/').length) === mostSpecificLength);
    if (mostSpecific.length !== 1) unavailable();
    const selected = mostSpecific[0]!;
    const teamId = selected.orgId ?? topLevelOrgId;
    if (typeof teamId !== 'string' || !SAFE_VERCEL_ID.test(teamId)) unavailable();
    return { projectId: selected.id, teamId };
}

function parseLinkedMetadata(value: Record<string, unknown>, metadataPath?: string, cwd = process.cwd()): Readonly<{ projectId: string; teamId: string }> {
    if (Object.keys(value).every(key => ['orgId', 'projectId', 'projectName'].includes(key))
        && Object.prototype.hasOwnProperty.call(value, 'projectId')
        && Object.prototype.hasOwnProperty.call(value, 'orgId')
        && typeof value.projectId === 'string' && SAFE_VERCEL_ID.test(value.projectId)
        && typeof value.orgId === 'string' && SAFE_VERCEL_ID.test(value.orgId)
        && (value.projectName === undefined || (typeof value.projectName === 'string' && SAFE_VERCEL_NAME.test(value.projectName)))) {
        return { projectId: value.projectId, teamId: value.orgId };
    }
    if (metadataPath === undefined || basename(metadataPath) !== 'repo.json' || basename(dirname(metadataPath)) !== '.vercel') unavailable();
    pathValue(cwd);
    return parseRepoLink(value, metadataPath, cwd);
}

function parseVercelToken(value: Record<string, unknown>): string {
    // Vercel CLI auth stores the owner token under `token`.  A small legacy
    // `tokens` envelope is accepted without recursively searching arbitrary
    // JSON, which keeps an unrelated protected value from becoming a token.
    const direct = value.token;
    if (safeToken(direct)) return direct;
    const tokens = value.tokens;
    if (Array.isArray(tokens) && tokens.length === 1 && isObject(tokens[0]) && safeToken(tokens[0].token)) return tokens[0].token;
    unavailable();
}

export type GoogleTokenChild = Readonly<{
    stdout: Readonly<{ on(event: 'data' | 'end' | 'error', handler: (chunk?: Buffer | string) => void): unknown }>;
    stderr: Readonly<{ on(event: 'data' | 'end' | 'error', handler: (chunk?: Buffer | string) => void): unknown }>;
    once(event: 'close' | 'error', handler: (code: number | null, signal?: NodeJS.Signals | null) => void): unknown;
    kill(signal?: NodeJS.Signals): boolean;
}>;

export type CaptureGoogleAccessTokenOptions = Readonly<{
    command?: string;
    /** Test seam; production uses node's spawn with a private pipe. */
    spawn?: (command: string, args: readonly string[], options: SpawnOptions) => GoogleTokenChild;
    timeoutMs?: number;
}>;

function safeSpawnCommand(value: string): boolean {
    return /^[A-Za-z0-9._/-]{1,256}$/.test(value) && !value.includes('..');
}

/**
 * Capture exactly one gcloud access-token line.  stdout/stderr are consumed
 * in private memory and are never interpolated into an Error or output.
 */
export async function captureGoogleAccessToken(options: CaptureGoogleAccessTokenOptions = {}): Promise<string> {
    const command = options.command ?? 'gcloud';
    if (!safeSpawnCommand(command)) unavailable();
    const timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) unavailable();
    const spawn = options.spawn ?? ((name, args, spawnOptions) => {
        const child = nodeSpawn(name, [...args], spawnOptions);
        if (!child.stdout || !child.stderr) unavailable();
        return child as unknown as GoogleTokenChild;
    });
    let child: GoogleTokenChild;
    try {
        // Do not inherit the operator's environment.  gcloud may use its
        // credential store and a fixed PATH, but no dotenv/current secret is
        // allowed to cross this process boundary.
        child = spawn(command, ['auth', 'print-access-token'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin', LANG: 'C', NODE_ENV: 'production' },
        });
    } catch {
        unavailable();
    }
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const collectStdout = (chunk?: Buffer | string): void => {
        if (chunk === undefined) return;
        const value = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        stdoutBytes += value.byteLength;
        // Preserve only a bounded token-sized output; stderr is consumed and
        // discarded below so provider details cannot leak on failure.
        if (stdoutBytes <= MAX_TOKEN_BYTES) stdout.push(value);
        else {
            try { child.kill('SIGKILL'); } catch { /* best effort */ }
        }
    };
    const discard = (): void => undefined;
    child.stdout.on('data', collectStdout);
    child.stdout.on('end', discard);
    child.stdout.on('error', discard);
    child.stderr.on('data', discard);
    child.stderr.on('end', discard);
    child.stderr.on('error', discard);
    return await new Promise<string>((resolve, reject) => {
        const finish = (error?: EpochError): void => {
            if (settled) return;
            settled = true;
            if (timer !== undefined) clearTimeout(timer);
            if (error) reject(error);
            else {
                const raw = Buffer.concat(stdout).toString('utf8');
                const token = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
                if (!safeToken(token) || token.includes('\n') || stdoutBytes > MAX_TOKEN_BYTES) reject(new EpochError('OWNER_AUTH_UNAVAILABLE'));
                else resolve(token);
            }
        };
        timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* best effort */ }
            finish(new EpochError('OWNER_AUTH_UNAVAILABLE'));
        }, timeoutMs);
        child.once('error', () => finish(new EpochError('OWNER_AUTH_UNAVAILABLE')));
        child.once('close', (code) => finish(code === 0 ? undefined : new EpochError('OWNER_AUTH_UNAVAILABLE')));
    });
}

export type OwnerAuthBoundaryOptions = Readonly<{
    linkedMetadataPath: string;
    credentialStorePath: string;
    /** Current worktree path used to resolve an installed Vercel repo link. */
    cwd?: string;
    /** Defaults to the invoking uid; useful only for provider-free tests. */
    uid?: number;
    googleToken?: CaptureGoogleAccessTokenOptions;
}>;

export type OwnerAuthBoundary = Readonly<{
    vercelProjectId: string;
    vercelTeamId: string;
    vercelTokenProvider: ProtectedTokenProvider;
    googleTokenProvider: ProtectedTokenProvider;
}>;

/**
 * Validate owner-owned linked metadata and Vercel CLI auth once.  The token
 * itself is closed over by a provider and is never included in the returned
 * object shape or any error.
 */
export async function loadOwnerAuthBoundary(options: OwnerAuthBoundaryOptions): Promise<OwnerAuthBoundary> {
    const uid = options.uid ?? currentUid();
    if (!Number.isSafeInteger(uid) || uid < 0) unavailable();
    const metadata = parseLinkedMetadata(jsonFile(options.linkedMetadataPath, uid), options.linkedMetadataPath, options.cwd);
    const vercelToken = parseVercelToken(jsonFile(options.credentialStorePath, uid));
    const googleOptions = options.googleToken ?? {};
    const auth: OwnerAuthBoundary = {
        vercelProjectId: metadata.projectId,
        vercelTeamId: metadata.teamId,
        vercelTokenProvider: async () => vercelToken,
        googleTokenProvider: async () => captureGoogleAccessToken(googleOptions),
    };
    return Object.freeze(auth);
}

export type OwnerProtectedTransports = Readonly<{
    vercel: AuthenticatedProtectedTransport;
    google: AuthenticatedProtectedTransport;
    supabase?: AuthenticatedProtectedTransport;
}>;

export type OwnerProtectedTransportOptions = Readonly<{
    vercelTokenProvider: ProtectedTokenProvider;
    googleTokenProvider: ProtectedTokenProvider;
    supabaseTokenProvider?: ProtectedTokenProvider;
    supabaseHosts?: ReadonlySet<string>;
}>;

/** Create provider transports around in-memory token providers only. */
export function createOwnerProtectedTransports(options: OwnerProtectedTransportOptions): OwnerProtectedTransports {
    const vercel = new AuthenticatedProtectedTransport({
        transport: new FetchProtectedTransport(),
        tokenProvider: options.vercelTokenProvider,
    });
    const google = createGoogleProtectedTransport({
        transport: new FetchProtectedTransport(),
        tokenProvider: options.googleTokenProvider,
    });
    let supabase: AuthenticatedProtectedTransport | undefined;
    if (options.supabaseTokenProvider !== undefined) {
        const hosts = options.supabaseHosts;
        if (!(hosts instanceof Set) || hosts.size === 0
            || [...hosts].some(host => typeof host !== 'string' || !/^[a-z0-9.-]{1,253}$/.test(host))) unavailable();
        supabase = new AuthenticatedProtectedTransport({
            transport: new FetchProtectedTransport(),
            tokenProvider: options.supabaseTokenProvider,
            additionalAllowedHosts: hosts,
        });
    } else if (options.supabaseHosts !== undefined) {
        unavailable();
    }
    return Object.freeze({ vercel, google, ...(supabase === undefined ? {} : { supabase }) });
}

/** Collapse every unexpected auth/child error at the final owner boundary. */
export function scrubOwnerError(_error: unknown): EpochError {
    return new EpochError('OWNER_AUTH_UNAVAILABLE');
}

export function assertOwnerProject(project: string): void {
    if (!PROJECT_ID_PATTERN.test(project)) unavailable();
}
