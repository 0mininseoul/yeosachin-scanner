import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { canonicalDigest, epochFail, EpochError, type CapacityEpochPacket, type EpochErrorCode } from './contracts';
import { validateEpochPacket } from './packet';
import { serializeProtectedDescriptor, type OwnerDescriptors } from './owner-descriptors';
import type { ProtectedLiveBootstrapDescriptor } from './bootstrap';

const PACKET_FD = 3;
const BOOTSTRAP_FD = 4;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const MAX_TIMEOUT_MS = 15 * 60_000;
const MAX_OUTPUT_BYTES = 32 * 1024;
const TERM_GRACE_MS = 250;
const KILL_GRACE_MS = 250;

const FIXED_CODES = new Set<string>([
    'INVALID_PACKET', 'INVALID_SCHEMA', 'IDENTITY_INVALID', 'IDENTITY_CONFLICT',
    'PROJECT_MISMATCH', 'CAPABILITY_INVALID', 'CAPABILITY_BINDING_MISMATCH',
    'LOCK_NAMESPACE_MISMATCH', 'PROTECTED_INPUT_UNAVAILABLE', 'SOURCE_INVALID',
    'READINESS_INVALID', 'RESOURCE_INVALID', 'ACTIVATION_INVALID', 'EVIDENCE_UNAVAILABLE',
    'LOCK_LOST', 'JOURNAL_INVALID', 'GENERATION_PRECONDITION_FAILED', 'OBSERVATION_RACE',
    'PROBE_FAILED', 'OBSERVATION_INVALID', 'SCHEDULER_NOT_QUIESCENT', 'QUEUE_NOT_EMPTY',
    'RUNTIME_MISMATCH', 'IAM_ETAG_REQUIRED', 'PAGINATION_INCOMPLETE', 'ZERO_WORK_INCOMPLETE',
    'PRODUCER_INVALID', 'ABORTED_EPOCH', 'NOT_VERIFIED', 'ACTIVATION_AUTH_REQUIRED',
    'ADAPTER_REQUEST_INVALID', 'ADAPTER_RESPONSE_INVALID', 'ADAPTER_TIMEOUT',
    'ADAPTER_REDIRECT', 'ADAPTER_NOT_ALLOWED', 'PROVIDER_NETWORK_FORBIDDEN',
    'OWNER_AUTH_UNAVAILABLE', 'DISCOVERY_AMBIGUOUS', 'PROPOSAL_STALE', 'QUIESCENCE_PENDING',
    'PROTECTED_PIPE_FAILED',
]);

type Stage = 'check' | 'apply' | 'verify';

type StageResult = Readonly<{
    stage: Stage;
    code: 0;
    stdout: string;
}>;

export type OwnerFdBridgeSpawn = (
    command: string,
    args: string[],
    options: SpawnOptions,
) => ChildProcess;

export type OwnerFdBridgeOptions = Readonly<{
    /** Provider-free seam; production uses node's direct child process API. */
    spawn?: OwnerFdBridgeSpawn;
    /** Test-only script overrides. Production paths are fixed below. */
    scripts?: Partial<Record<Stage, string>>;
    /** The child receives only this reviewed, non-secret environment. */
    environment?: Readonly<Record<string, string>>;
    cwd?: string;
    nodePath?: string;
    timeoutMs?: number;
}>;

export type OwnerFdBridgeInput = Readonly<{
    packet: CapacityEpochPacket;
    bootstrap: ProtectedLiveBootstrapDescriptor;
    options?: OwnerFdBridgeOptions;
}>;

export type OwnerFdBridgeResult = Readonly<{
    status: 'VERIFIED_OK';
    stages: readonly Stage[];
    packetDigest: string;
}>;

function fail(code: EpochErrorCode): never {
    epochFail(code);
}

function bridgeFail(): never {
    fail('PROTECTED_PIPE_FAILED');
}

function validateOptions(options: OwnerFdBridgeOptions): Readonly<{
    timeoutMs: number;
    environment: Readonly<Record<string, string>>;
}> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) bridgeFail();
    const environment = options.environment ?? { NODE_ENV: 'production' };
    for (const [name, value] of Object.entries(environment)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)
            || typeof value !== 'string'
            || value.length > 4096
            || /[\u0000\u000d\u000a]/.test(value)) bridgeFail();
    }
    return Object.freeze({ timeoutMs, environment: Object.freeze({ ...environment }) });
}

function validateDescriptorPair(packet: CapacityEpochPacket, bootstrap: ProtectedLiveBootstrapDescriptor): void {
    try { validateEpochPacket(packet); } catch { bridgeFail(); }
    if (!bootstrap
        || bootstrap.packetDigest !== canonicalDigest(packet)
        || bootstrap.lockNamespace !== packet.lockNamespace
        || bootstrap.scopeDigest !== canonicalDigest(packet.providerScope)) bridgeFail();
}

function scriptPath(stage: Stage): string {
    const script = stage === 'verify' ? '../verify-capacity-identity-epoch.ts' : '../run-capacity-identity-epoch.ts';
    return fileURLToPath(new URL(script, import.meta.url));
}

function stageArguments(stage: Stage): string[] {
    if (stage === 'verify') return ['--packet-fd', String(PACKET_FD), '--bootstrap-fd', String(BOOTSTRAP_FD)];
    const command = stage === 'check' ? 'check' : 'apply';
    return [command, '--packet-fd', String(PACKET_FD), '--bootstrap-fd', String(BOOTSTRAP_FD), ...(stage === 'apply' ? ['--through', 'VERIFIED'] : [])];
}

function captureOutput(stream: NodeJS.ReadableStream | null | undefined): Readonly<{
    text: () => string;
    exceeded: () => boolean;
}> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let exceeded = false;
    stream?.on('data', value => {
        const chunk = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value as Uint8Array);
        bytes += chunk.byteLength;
        if (bytes <= MAX_OUTPUT_BYTES) chunks.push(chunk);
        else exceeded = true;
    });
    stream?.on('error', () => { exceeded = true; });
    return {
        text: () => Buffer.concat(chunks).toString('utf8'),
        exceeded: () => exceeded,
    };
}

function safeKill(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
        if (child.pid !== undefined && child.pid > 0 && process.platform !== 'win32') {
            process.kill(-child.pid, signal);
            return;
        }
    } catch { /* fall through to the direct child handle */ }
    try { child.kill(signal); } catch { /* fixed-code failure is reported by the caller */ }
}

function waitForPipeFinish(pipe: Writable, raw: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (): void => {
            if (settled) return;
            settled = true;
            resolve();
        };
        const error = (): void => {
            if (settled) return;
            settled = true;
            reject(new EpochError('PROTECTED_PIPE_FAILED'));
        };
        pipe.once('finish', finish);
        pipe.once('error', error);
        try {
            // Exactly one write is followed by an immediate close. No
            // descriptor is retained in a file, environment, or journal.
            pipe.write(raw);
            pipe.end();
        } catch {
            error();
        }
    });
}

function allowedErrorCode(stderr: string): EpochErrorCode | undefined {
    const line = stderr.trim();
    return FIXED_CODES.has(line) ? line as EpochErrorCode : undefined;
}

function expectedOutput(stage: Stage, stdout: string): boolean {
    const value = stdout.trim();
    if (stage === 'check') return /^CHECK_OK(?: packetDigest=[0-9a-f]{64})?$/.test(value);
    if (stage === 'apply') return value === '';
    return value === 'VERIFIED_OK';
}

async function terminateBounded(child: ChildProcess): Promise<void> {
    safeKill(child, 'SIGTERM');
    await new Promise(resolve => setTimeout(resolve, TERM_GRACE_MS));
    if (child.exitCode === null && child.signalCode === null) {
        safeKill(child, 'SIGKILL');
        await new Promise(resolve => setTimeout(resolve, KILL_GRACE_MS));
    }
}

async function runStage(
    stage: Stage,
    input: OwnerFdBridgeInput,
    options: Readonly<{ timeoutMs: number; environment: Readonly<Record<string, string>>; setActiveChild: (child: ChildProcess | undefined) => void }>,
): Promise<StageResult> {
    const spawn = input.options?.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions));
    const command = input.options?.nodePath ?? process.execPath;
    const script = input.options?.scripts?.[stage] ?? scriptPath(stage);
    const args = ['--import', 'tsx', script, ...stageArguments(stage)];
    let child: ChildProcess;
    try {
        child = spawn(command, args, {
            cwd: input.options?.cwd,
            env: { ...options.environment } as SpawnOptions['env'],
            stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
            shell: false,
            detached: process.platform !== 'win32',
            windowsHide: true,
        });
    } catch {
        bridgeFail();
    }
    options.setActiveChild(child);

    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>(resolve => {
        timeoutHandle = setTimeout(() => {
            timedOut = true;
            safeKill(child, 'SIGTERM');
            resolve();
        }, options.timeoutMs);
    });

    try {
        const packetPipe = child.stdio[PACKET_FD];
        const bootstrapPipe = child.stdio[BOOTSTRAP_FD];
        if (!packetPipe || typeof packetPipe === 'string' || !bootstrapPipe || typeof bootstrapPipe === 'string'
            || !('write' in packetPipe) || !('write' in bootstrapPipe)) bridgeFail();
        const stdout = captureOutput(child.stdout);
        const stderr = captureOutput(child.stderr);
        const close = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null; error: boolean }>>(resolve => {
            let settled = false;
            const finish = (result: Readonly<{ code: number | null; signal: NodeJS.Signals | null; error: boolean }>): void => {
                if (settled) return;
                settled = true;
                resolve(result);
            };
            child.once('error', () => finish({ code: null, signal: null, error: true }));
            child.once('close', (code, signal) => finish({ code, signal, error: false }));
        });

        const packetRaw = serializeProtectedDescriptor(input.packet);
        const bootstrapRaw = serializeProtectedDescriptor(input.bootstrap);
        try {
            await Promise.all([
                Promise.race([waitForPipeFinish(packetPipe as Writable, packetRaw), timeout]),
                Promise.race([waitForPipeFinish(bootstrapPipe as Writable, bootstrapRaw), timeout]),
            ]);
        } catch {
            bridgeFail();
        }
        if (timedOut) bridgeFail();
        const result = await Promise.race([close, timeout]);
        if (timedOut) bridgeFail();
        const childResult = result as Readonly<{ code: number | null; signal: NodeJS.Signals | null; error: boolean }>;
        if (stdout.exceeded() || stderr.exceeded()) bridgeFail();
        if (childResult.error || childResult.signal !== null || childResult.code !== 0 || !expectedOutput(stage, stdout.text())) {
            const known = allowedErrorCode(stderr.text());
            fail(known ?? 'PROTECTED_PIPE_FAILED');
        }
        return Object.freeze({ stage, code: 0, stdout: stage === 'check' ? 'CHECK_OK' : stage === 'verify' ? 'VERIFIED_OK' : '' });
    } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        await terminateBounded(child);
        options.setActiveChild(undefined);
    }
}

/**
 * Run the existing coordinator check, VERIFIED-bounded apply, and independent
 * verifier in sequence. The bridge has no activation, resume, or canary map.
 */
export async function runOwnerEpochThroughVerified(input: OwnerFdBridgeInput): Promise<OwnerFdBridgeResult> {
    validateDescriptorPair(input.packet, input.bootstrap);
    const options = validateOptions(input.options ?? {});
    const stages: Stage[] = [];
    let activeChild: ChildProcess | undefined;
    let parentSignal: NodeJS.Signals | undefined;
    const onParentSignal = (signal: NodeJS.Signals) => (): void => {
        parentSignal = signal;
        if (activeChild !== undefined) safeKill(activeChild, 'SIGTERM');
    };
    const onSigterm = onParentSignal('SIGTERM');
    const onSigint = onParentSignal('SIGINT');
    const onSighup = onParentSignal('SIGHUP');
    process.on('SIGTERM', onSigterm);
    process.on('SIGINT', onSigint);
    process.on('SIGHUP', onSighup);
    try {
        for (const stage of ['check', 'apply', 'verify'] as const) {
            if (parentSignal !== undefined) bridgeFail();
            await runStage(stage, input, { ...options, setActiveChild: child => { activeChild = child; } });
            if (parentSignal !== undefined) bridgeFail();
            stages.push(stage);
        }
        return Object.freeze({
            status: 'VERIFIED_OK',
            stages: Object.freeze(stages),
            packetDigest: canonicalDigest(input.packet),
        });
    } finally {
        if (activeChild !== undefined) await terminateBounded(activeChild);
        activeChild = undefined;
        process.off('SIGTERM', onSigterm);
        process.off('SIGINT', onSigint);
        process.off('SIGHUP', onSighup);
    }
}

export const runOwnerEpoch = runOwnerEpochThroughVerified;
