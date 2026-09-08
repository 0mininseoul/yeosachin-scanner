/**
 * Portable mapped child lifecycle for ordinary mutation entry points.
 *
 * The shell entry point re-enters itself under this fixed launcher when it
 * lacks an inherited control channel.  This Node process owns the supervisor,
 * maps its anonymous pipes to fixed child descriptors, and releases the lease
 * after the allowlisted child exits.  No arbitrary command or script path is
 * accepted from argv.
 */
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Writable } from 'node:stream';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EpochError, epochFail, isObject, type EpochErrorCode, type Role } from './contracts';
import { rejectDuplicateJsonKeys } from './packet';
import { validateDescriptor, type BridgeDescriptor } from '../check-capacity-identity-epoch-exclusion';
import { deriveLegacyServices, deriveResources } from './exclusion-ipc';
import type { ExclusionEntryPoint } from './exclusion-bridge';

const ENTRY_POINTS = ['role-deployer', 'capacity-queue', 'preflight-maintenance', 'paid-maintenance'] as const;
const ROLES = ['preflight', 'paid'] as const;
const SCRIPT_TOKENS = [
    'capacity-queues',
    'tasks-queue',
    'v2-tasks-queue',
    'preflight-tasks-queue',
    'preflight-maintenance',
    'v2-maintenance',
    'capacity-workers',
] as const;
const CONTROL_READ_FD = 4;
const CONTROL_WRITE_FD = 5;
const MAPPED_OPERATION_TIMEOUT_MS = 120_000;
const MAPPED_TERM_GRACE_MS = 1_000;
const MAPPED_KILL_GRACE_MS = 1_000;
const MAX_LINE = 4096;
const CHANNEL_NONCE = /^[0-9a-f]{64}$/;

type ScriptToken = typeof SCRIPT_TOKENS[number];
type LauncherOptions = Readonly<{
    entryPoint: ExclusionEntryPoint;
    role: Role;
    scriptToken: ScriptToken;
    scriptArgs: readonly string[];
}>;

function fail(): never {
    epochFail('ADAPTER_REQUEST_INVALID');
}

function parseArguments(argv: readonly string[]): LauncherOptions {
    let entryPoint: ExclusionEntryPoint | undefined;
    let role: Role | undefined;
    let scriptToken: ScriptToken | undefined;
    const scriptArgs: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        if (flag === '--entry-point' && entryPoint === undefined) {
            const value = argv[++index];
            if (value === undefined || !ENTRY_POINTS.includes(value as (typeof ENTRY_POINTS)[number])) fail();
            entryPoint = value as ExclusionEntryPoint;
        } else if (flag === '--role' && role === undefined) {
            const value = argv[++index];
            if (value === undefined || !ROLES.includes(value as Role)) fail();
            role = value as Role;
        } else if (flag === '--script-token' && scriptToken === undefined) {
            const value = argv[++index];
            if (value === undefined || !SCRIPT_TOKENS.includes(value as ScriptToken)) fail();
            scriptToken = value as ScriptToken;
        } else if (flag === '--script-arg') {
            const value = argv[++index];
            if (value === undefined || value.length > 128) fail();
            scriptArgs.push(value);
        } else {
            fail();
        }
    }
    if (entryPoint === undefined || role === undefined || scriptToken === undefined) fail();
    validateScriptArgs(scriptToken, scriptArgs);
    return Object.freeze({ entryPoint, role, scriptToken, scriptArgs: Object.freeze(scriptArgs) });
}

function validateScriptArgs(token: ScriptToken, args: readonly string[]): void {
    const allowed = new Set<string>();
    const add = (...values: string[]): void => values.forEach(value => allowed.add(value));
    add('--dry-run', '--check', '--apply', '--reconcile-iam', '--reconcile-jobs', '--help', '-h');
    if (token === 'capacity-queues') add('--role=preflight', '--role=paid');
    if (token === 'capacity-workers') {
        add('--role=preflight', '--role=paid', '--allow-bootstrap-initial-transition', '--allow-initial-identity-roll-forward');
    }
    for (const arg of args) if (!allowed.has(arg)) fail();
    const modes = args.filter(arg => arg === '--dry-run' || arg === '--check' || arg === '--apply');
    if (modes.length > 1) fail();
    if (token === 'capacity-workers' && args.filter(arg => arg === '--role=preflight' || arg === '--role=paid').length > 1) fail();
}

function buildDescriptor(options: LauncherOptions): BridgeDescriptor {
    const bucket = process.env.ANALYSIS_CAPACITY_DEPLOY_LOCK_BUCKET;
    if (typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(bucket)) fail();
    const selectorSource = options.scriptToken === 'tasks-queue' ? 'generic' : 'role';
    const primaryResources = deriveResources(options.entryPoint, options.role, selectorSource);
    const nestedResources = options.scriptToken === 'capacity-workers' && options.role === 'preflight'
        ? deriveResources('preflight-maintenance', 'preflight')
        : [];
    const resources = [...new Map(
        [...primaryResources, ...nestedResources]
            .map(resource => [resource.kind + ':' + resource.resource, resource] as const),
    ).values()];
    const descriptor = {
        bucket,
        entryPoint: options.entryPoint,
        role: options.role,
        resources,
        legacyServices: deriveLegacyServices(options.entryPoint, options.role),
        epochDigest: randomBytes(32).toString('hex'),
        ownerDigest: randomBytes(32).toString('hex'),
        leaseMs: 60_000,
        lease: null,
    };
    return validateDescriptor(descriptor);
}

function scriptPath(token: ScriptToken): string {
    const scripts = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const relative = {
        'capacity-queues': 'configure-analysis-capacity-queues.sh',
        'tasks-queue': 'configure-analysis-tasks-queue.sh',
        'v2-tasks-queue': 'configure-analysis-v2-tasks-queue.sh',
        'preflight-tasks-queue': 'configure-preflight-tasks-queue.sh',
        'preflight-maintenance': 'configure-analysis-preflight-maintenance.sh',
        'v2-maintenance': 'configure-analysis-v2-maintenance.sh',
        'capacity-workers': 'deploy-analysis-capacity-workers.sh',
    } satisfies Record<ScriptToken, string>;
    return resolve(scripts, relative[token]);
}

const RESPONSE_CODES = new Set([
    'ASSERT_OK', 'ADOPTED', 'BOUND', 'RENEWED', 'RELEASED',
    'ADAPTER_REQUEST_INVALID', 'ADAPTER_RESPONSE_INVALID', 'ABORTED_EPOCH',
    'CAPABILITY_BINDING_MISMATCH', 'CAPABILITY_INVALID', 'GENERATION_PRECONDITION_FAILED',
    'JOURNAL_INVALID', 'LOCK_LOST', 'PROTECTED_INPUT_UNAVAILABLE', 'RESOURCE_INVALID',
    'ADAPTER_TIMEOUT',
]);

function requestId(): string {
    return randomBytes(16).toString('hex');
}

type SupervisorResponse = Readonly<{ id: string; code: string }>;
type DispatcherFailureHandler = (error: unknown) => void;

function parseSupervisorResponse(line: string, nonce: string): SupervisorResponse {
    if (line.length > MAX_LINE) fail();
    const match = /^([0-9a-f]{32}) ([0-9a-f]{64}) (ASSERT_OK|ADOPTED|BOUND|RENEWED|RELEASED|ERR [A-Z_]+)(?: [A-Za-z0-9_-]{1,32768})?$/.exec(line);
    if (!match || match[2] !== nonce) fail();
    const code = match[3]!;
    if (code.startsWith('ERR ') && !RESPONSE_CODES.has(code.slice(4))) fail();
    if (!code.startsWith('ERR ') && !RESPONSE_CODES.has(code)) fail();
    if ((code === 'RELEASED' && line.split(' ').length !== 3)
        || (!code.startsWith('ERR ') && code !== 'RELEASED' && line.split(' ').length !== 4)) fail();
    return { id: match[1]!, code };
}

export function parseChildRequest(line: string, nonce: string): string {
    if (line.length === 0 || line.length > MAX_LINE) fail();
    let value: unknown;
    try {
        rejectDuplicateJsonKeys(line);
        value = JSON.parse(line) as unknown;
    } catch {
        fail();
    }
    if (!isObject(value) || typeof value.id !== 'string' || !/^[0-9a-f]{32}$/.test(value.id)
        || value.nonce !== nonce || !['assert', 'adopt'].includes(String(value.op))) fail();
    return value.id as string;
}

type PendingControlRequest = Readonly<{
    expected?: string;
    target?: Writable;
    resolve: (code: string) => void;
    reject: (error: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
}>;

/**
 * The supervisor stdout stream has exactly one owner: this dispatcher. Child
 * requests are proxied through it, while release uses the same response
 * reader after the child exits. This prevents two readline consumers from
 * racing and losing a response line.
 */
export class ControlChannelDispatcher {
    private readonly supervisor: ChildProcess;
    private nonce: string | undefined;
    private readonly input: ReturnType<typeof createInterface>;
    private readonly pending = new Map<string, PendingControlRequest>();
    private readonly readyPromise: Promise<string>;
    private readyResolve!: (nonce: string) => void;
    private readyReject!: (error: unknown) => void;
    private readyNonce: string | undefined;
    private closed = false;
    private failureNotified = false;
    private readonly onFailure?: DispatcherFailureHandler;

    constructor(supervisor: ChildProcess, nonce?: string, onFailure?: DispatcherFailureHandler) {
        if (!supervisor.stdout || !supervisor.stdin || (nonce !== undefined && !CHANNEL_NONCE.test(nonce))) fail();
        this.supervisor = supervisor;
        this.nonce = nonce;
        this.onFailure = onFailure;
        this.input = createInterface({ input: supervisor.stdout, crlfDelay: Infinity });
        this.readyPromise = new Promise<string>((resolvePromise, rejectPromise) => {
            this.readyResolve = resolvePromise;
            this.readyReject = rejectPromise;
        });
        this.input.on('line', line => this.handleSupervisorLine(line));
        supervisor.once('error', error => this.failAll(error));
        supervisor.once('exit', () => this.failAll(new EpochError('LOCK_LOST')));
    }

    async waitForReady(timeoutMs = 10_000): Promise<string> {
        if (this.readyNonce !== undefined) return this.readyNonce;
        return await this.withTimeout(this.readyPromise, timeoutMs);
    }

    async sendSupervisorRequest(op: 'release' | 'renew' | 'assert' | 'bind', childPid?: number): Promise<string> {
        if (this.nonce === undefined) throw new EpochError('LOCK_LOST');
        if (op === 'bind' && (!Number.isSafeInteger(childPid) || childPid! <= 0)) throw new EpochError('ADAPTER_REQUEST_INVALID');
        const id = requestId();
        const expected = op === 'release' ? 'RELEASED' : op === 'renew' ? 'RENEWED' : op === 'assert' ? 'ASSERT_OK' : 'BOUND';
        const response = this.register(id, expected);
        this.writeSupervisor(JSON.stringify({ id, nonce: this.nonce, op, ...(op === 'bind' ? { childPid } : {}) }) + '\n');
        return await response;
    }

    async forwardChildRequest(line: string, target: Writable): Promise<void> {
        if (this.nonce === undefined) throw new EpochError('LOCK_LOST');
        const id = parseChildRequest(line, this.nonce);
        const response = this.register(id, undefined, target);
        this.writeSupervisor(line + (line.endsWith('\n') ? '' : '\n'));
        await response;
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.input.close();
        this.failAll(new EpochError('LOCK_LOST'));
    }

    private register(id: string, expected?: string, target?: Writable): Promise<string> {
        if (this.closed || this.pending.has(id)) throw new EpochError('ADAPTER_REQUEST_INVALID');
        let resolvePromise!: (code: string) => void;
        let rejectPromise!: (error: unknown) => void;
        const response = new Promise<string>((resolveResponse, rejectResponse) => {
            resolvePromise = resolveResponse;
            rejectPromise = rejectResponse;
        });
        const timer = setTimeout(() => {
            const pending = this.pending.get(id);
            if (!pending) return;
            this.pending.delete(id);
            pending.reject(new EpochError('ADAPTER_TIMEOUT'));
        }, 30_000);
        this.pending.set(id, { expected, target, resolve: resolvePromise, reject: rejectPromise, timer });
        return response;
    }

    private writeSupervisor(line: string): void {
        if (this.closed || !this.supervisor.stdin || this.supervisor.stdin.destroyed) throw new EpochError('LOCK_LOST');
        this.supervisor.stdin.write(line);
    }

    private handleSupervisorLine(line: string): void {
        try {
            if (this.readyNonce === undefined) {
                const ready = /^READY ([0-9a-f]{64})$/.exec(line);
                if (!ready || (this.nonce !== undefined && ready[1] !== this.nonce)) throw new EpochError('ADAPTER_REQUEST_INVALID');
                this.readyNonce = ready[1];
                this.nonce = ready[1];
                this.readyResolve(this.readyNonce);
                return;
            }
            if (this.nonce === undefined) throw new EpochError('ADAPTER_REQUEST_INVALID');
            const fatal = /^FATAL ([0-9a-f]{64}) ([A-Z_]+)$/.exec(line);
            if (fatal) {
                const fatalCode = fatal[2]!;
                if (fatal[1] !== this.nonce || !RESPONSE_CODES.has(fatalCode) || fatalCode === 'ASSERT_OK'
                    || fatalCode === 'ADOPTED' || fatalCode === 'BOUND' || fatalCode === 'RENEWED' || fatalCode === 'RELEASED') {
                    throw new EpochError('ADAPTER_RESPONSE_INVALID');
                }
                throw new EpochError(fatalCode as EpochErrorCode);
            }
            const response = parseSupervisorResponse(line, this.nonce);
            const pending = this.pending.get(response.id);
            if (!pending) throw new EpochError('ADAPTER_RESPONSE_INVALID');
            this.pending.delete(response.id);
            clearTimeout(pending.timer);
            if (pending.expected !== undefined && response.code !== pending.expected) {
                const errorCode = response.code.startsWith('ERR ')
                    ? response.code.slice(4) as EpochErrorCode
                    : 'ADAPTER_RESPONSE_INVALID';
                throw new EpochError(errorCode);
            }
            if (pending.target) pending.target.write(line + '\n');
            pending.resolve(response.code);
        } catch (error) {
            this.failAll(error);
        }
    }

    private failAll(error: unknown): void {
        if (!this.failureNotified) {
            this.failureNotified = true;
            this.closed = true;
            this.input.close();
            try { this.onFailure?.(error); } catch { /* child termination remains best effort */ }
        }
        if (this.readyNonce === undefined) this.readyReject(error);
        for (const [id, pending] of this.pending) {
            this.pending.delete(id);
            clearTimeout(pending.timer);
            pending.reject(error);
        }
    }

    private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                promise,
                new Promise<T>((_, reject) => {
                    timer = setTimeout(() => reject(new EpochError('ADAPTER_TIMEOUT')), timeoutMs);
                }),
            ]);
        } finally {
            if (timer !== undefined) clearTimeout(timer);
        }
    }
}

async function waitForExit(child: ChildProcess): Promise<number> {
    return await new Promise<number>((resolvePromise, reject) => {
        child.once('error', reject);
        child.once('exit', code => resolvePromise(code ?? 2));
    });
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return await new Promise<boolean>(resolvePromise => {
        const timer = setTimeout(() => done(false), timeoutMs);
        const done = (exited: boolean): void => {
            clearTimeout(timer);
            resolvePromise(exited);
        };
        child.once('exit', () => done(true));
        child.once('error', () => done(true));
    });
}

async function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new EpochError('ADAPTER_TIMEOUT');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => reject(new EpochError('ADAPTER_TIMEOUT')), remainingMs);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

export async function waitForMappedChild(
    child: ChildProcess,
    options: Readonly<{ operationTimeoutMs?: number; termGraceMs?: number; killGraceMs?: number }> = {},
): Promise<number> {
    const operationTimeoutMs = options.operationTimeoutMs ?? MAPPED_OPERATION_TIMEOUT_MS;
    const termGraceMs = options.termGraceMs ?? MAPPED_TERM_GRACE_MS;
    const killGraceMs = options.killGraceMs ?? MAPPED_KILL_GRACE_MS;
    if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs <= 0
        || !Number.isSafeInteger(termGraceMs) || termGraceMs < 0
        || !Number.isSafeInteger(killGraceMs) || killGraceMs < 0) {
        throw new EpochError('ADAPTER_REQUEST_INVALID');
    }
    const deadline = Date.now() + operationTimeoutMs;
    const remaining = (): number => Math.max(0, deadline - Date.now());
    const waitForExitBeforeDeadline = async (): Promise<number> => {
        const timeoutMs = remaining();
        if (timeoutMs <= 0) throw new EpochError('ADAPTER_TIMEOUT');
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                waitForExit(child),
                new Promise<number>((_, reject) => {
                    timer = setTimeout(() => reject(new EpochError('ADAPTER_TIMEOUT')), timeoutMs);
                }),
            ]);
        } finally {
            if (timer !== undefined) clearTimeout(timer);
        }
    };
    try {
        const status = await waitForExitBeforeDeadline();
        const joinTimeoutMs = remaining();
        if (joinTimeoutMs <= 0) throw new EpochError('ADAPTER_TIMEOUT');
        try {
            await waitForProcessGroup(child, joinTimeoutMs);
        } catch (error) {
            if (!(error instanceof EpochError) || error.code !== 'ADAPTER_TIMEOUT') throw error;
            throw error;
        }
        return status;
    } catch (error) {
        if (!(error instanceof EpochError) || error.code !== 'ADAPTER_TIMEOUT') throw error;
        // A timeout is authority loss.  Escalate the complete detached group
        // before reporting it so callers can never release a live lease.
        await terminateProcessGroupBounded(child, { termGraceMs, killGraceMs });
        throw error;
    }
}

export async function waitForProcessGroup(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
    if (process.platform === 'win32' || child.pid === undefined) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            process.kill(-child.pid, 0);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
            if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
        }
        await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    }
    throw new EpochError('ADAPTER_TIMEOUT');
}

export function terminateProcessGroup(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
    if (child.pid !== undefined && process.platform !== 'win32') {
        try { process.kill(-child.pid, signal); } catch { /* already gone */ }
    }
    if (child.exitCode === null) child.kill(signal);
}

/**
 * Stop a detached mapped child within a bounded interval. Cooperative
 * SIGTERM gets a short grace period; stubborn descendants are escalated to
 * SIGKILL before the caller can release the shared reservation.
 */
export async function terminateProcessGroupBounded(
    child: ChildProcess,
    options: Readonly<{ termGraceMs?: number; killGraceMs?: number }> = {},
): Promise<void> {
    const termGraceMs = options.termGraceMs ?? 1_000;
    const killGraceMs = options.killGraceMs ?? 1_000;
    if (!Number.isSafeInteger(termGraceMs) || termGraceMs < 0
        || !Number.isSafeInteger(killGraceMs) || killGraceMs < 0) throw new EpochError('ADAPTER_REQUEST_INVALID');
    terminateProcessGroup(child, 'SIGTERM');
    try {
        await waitForProcessGroup(child, termGraceMs);
        return;
    } catch (error) {
        if (!(error instanceof EpochError) || error.code !== 'ADAPTER_TIMEOUT') throw error;
    }
    terminateProcessGroup(child, 'SIGKILL');
    await waitForProcessGroup(child, killGraceMs);
}

async function run(options: LauncherOptions): Promise<void> {
    const supervisorPath = resolve(dirname(fileURLToPath(import.meta.url)), 'exclusion-supervisor.ts');
    const descriptor = buildDescriptor(options);
    const operationDeadline = Date.now() + MAPPED_OPERATION_TIMEOUT_MS;
    const supervisor = spawn(process.execPath, [
        '--import', 'tsx', supervisorPath,
        '--entry-point', options.entryPoint,
        '--descriptor-fd', '3',
    ], {
        env: process.env,
        stdio: ['pipe', 'pipe', 'inherit', 'pipe'],
    });
    let child: ChildProcess | undefined;
    let childStatus = 2;
    let dispatcher: ControlChannelDispatcher | undefined;
    let childInput: ReturnType<typeof createInterface> | undefined;
    let authorityLost = false;
    let childTermination: Promise<void> | undefined;
    let childTerminationError: unknown;
    const stopChild = (target: ChildProcess): Promise<void> => {
        childTermination ??= terminateProcessGroupBounded(target);
        return childTermination;
    };
    try {
        const descriptorPipe = supervisor.stdio[3];
        if (!descriptorPipe || typeof descriptorPipe === 'string' || !('write' in descriptorPipe)) fail();
        descriptorPipe.write(JSON.stringify(descriptor));
        descriptorPipe.end();
        // Keep the supervisor streams private to the parent. The child gets
        // two independent anonymous pipes; this parent remains the only
        // reader of supervisor stdout and forwards responses to the child.
        dispatcher = new ControlChannelDispatcher(supervisor, undefined, () => {
            // A supervisor heartbeat loss invalidates child authority for the
            // rest of the mutation interval. Kill the whole detached group
            // before the launcher can attempt final release.
            authorityLost = true;
            if (child) void stopChild(child).catch(() => undefined);
        });
        const nonce = await withDeadline(dispatcher.waitForReady(), operationDeadline);
        if (authorityLost) throw new EpochError('LOCK_LOST');
        const childStdio = ['inherit', 'inherit', 'inherit', 'ignore', 'pipe', 'pipe', 'pipe'] as unknown as StdioOptions;
        const environment = {
            ...process.env,
            ANALYSIS_CAPACITY_EXCLUSION_CONTROL_READ_FD: String(CONTROL_READ_FD),
            ANALYSIS_CAPACITY_EXCLUSION_CONTROL_WRITE_FD: String(CONTROL_WRITE_FD),
            ANALYSIS_CAPACITY_EXCLUSION_CONTROL_NONCE: nonce,
        };
        // Keep the mapped command inert until the supervisor has bound its
        // PID.  If the launcher dies in this window, FD6 reaches EOF and the
        // gate exits without ever exec'ing the mutation script.
        const gateScript = 'IFS= read -r gate <&6 || exit 2; [ "$gate" = BOUND ] || exit 2; exec /bin/bash "$@"';
        const mappedChild = spawn('/bin/bash', ['-c', gateScript, 'capacity-identity-epoch-child', scriptPath(options.scriptToken), ...options.scriptArgs], {
            env: environment,
            stdio: childStdio,
            detached: process.platform !== 'win32',
        }) as ChildProcess;
        child = mappedChild;
        const mappedStdio = mappedChild.stdio as unknown as Array<NodeJS.ReadableStream | Writable | null | undefined>;
        const childRequestPipe = mappedStdio[CONTROL_WRITE_FD];
        const childResponsePipe = mappedStdio[CONTROL_READ_FD];
        const gatePipe = mappedStdio[6];
        if (!childRequestPipe || typeof childRequestPipe === 'string'
            || !childResponsePipe || typeof childResponsePipe === 'string'
            || !('write' in childResponsePipe)
            || !gatePipe || typeof gatePipe === 'string' || !('write' in gatePipe)) fail();
        childInput = createInterface({ input: childRequestPipe as NodeJS.ReadableStream, crlfDelay: Infinity });
        childInput.on('line', line => {
            void dispatcher!.forwardChildRequest(line, childResponsePipe as Writable).catch(() => {
                void stopChild(mappedChild).catch(() => undefined);
            });
        });
        // Bind the detached process group before forwarding any child
        // request. If this launcher dies, supervisor stdin EOF can terminate
        // this exact authority rather than merely releasing the lease.
        await withDeadline(dispatcher.sendSupervisorRequest('bind', mappedChild.pid), operationDeadline);
        if (authorityLost) throw new EpochError('LOCK_LOST');
        (gatePipe as Writable).write('BOUND\n');
        const remainingOperationMs = operationDeadline - Date.now();
        if (remainingOperationMs <= 0) throw new EpochError('ADAPTER_TIMEOUT');
        childStatus = await waitForMappedChild(mappedChild, { operationTimeoutMs: remainingOperationMs });
        childInput.close();
        await withDeadline(dispatcher.sendSupervisorRequest('release'), operationDeadline);
    } finally {
        childInput?.close();
        if (child) {
            try { await stopChild(child); }
            catch (error) { childTerminationError = childTerminationError ?? error; }
        }
        dispatcher?.close();
        if (supervisor.stdin && !supervisor.stdin.destroyed) supervisor.stdin.end();
        if (supervisor.exitCode === null) {
            const exitedAfterTerm = await waitForChildExit(supervisor, 5_000);
            if (!exitedAfterTerm && supervisor.exitCode === null) {
                supervisor.kill('SIGTERM');
                const exitedAfterGrace = await waitForChildExit(supervisor, 1_000);
                if (!exitedAfterGrace && supervisor.exitCode === null) {
                    supervisor.kill('SIGKILL');
                    if (!(await waitForChildExit(supervisor, 1_000))) throw new EpochError('ADAPTER_TIMEOUT');
                }
            }
        }
        if (childTerminationError !== undefined) throw childTerminationError;
    }
    process.exitCode = childStatus;
}

const invokedScript = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedScript) {
    void run(parseArguments(process.argv.slice(2))).catch((error: unknown) => {
        if (error instanceof EpochError) {
            process.stderr.write(error.code + '\n');
        } else {
            process.stderr.write('ADAPTER_REQUEST_INVALID\n');
        }
        process.exitCode = 2;
    });
}
