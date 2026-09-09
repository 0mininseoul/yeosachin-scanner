import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createFixturePacket } from './fixtures';
import { canonicalDigest } from './contracts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = join(root, 'scripts/run-capacity-identity-epoch.ts');
const PROTECTED_DEADLINE_MS = 5_000;
const DEADLINE_TOLERANCE_MS = 100;

type ChildResult = Readonly<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; elapsedMs: number }>;

async function runHeldOpenPipeCase(packet: string, endPacket: boolean, bootstrap = '', endBootstrap = false, command: 'check' | 'apply' = 'check'): Promise<ChildResult> {
    const startedAt = Date.now();
    // Run one Node process with the normal TS loader so no wrapper process can
    // retain the inherited writers after the deadline fires.
    const child = spawn(process.execPath, ['--import', 'tsx', script, command, '--packet-fd', '3', '--bootstrap-fd', '4'], {
        cwd: root,
        env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', value => { stdout += String(value); });
    child.stderr?.on('data', value => { stderr += String(value); });
    const packetWriter = child.stdio[3] as Writable;
    const bootstrapWriter = child.stdio[4] as Writable;
    packetWriter.on('error', () => undefined);
    bootstrapWriter.on('error', () => undefined);
    if (packet.length > 0) packetWriter.write(packet);
    if (endPacket) packetWriter.end();
    if (bootstrap.length > 0) bootstrapWriter.write(bootstrap);
    if (endBootstrap) bootstrapWriter.end();
    // Deliberately keep both inherited writers open. A deadline must cancel
    // the stream and terminate the process rather than waiting for EOF.
    return await new Promise<ChildResult>(resolve => {
        const deadline = setTimeout(() => {
            child.kill('SIGKILL');
        }, 8_000);
        child.once('close', (code, signal) => {
            clearTimeout(deadline);
            packetWriter.destroy();
            bootstrapWriter.destroy();
            resolve({ code, signal, stdout, stderr, elapsedMs: Date.now() - startedAt });
        });
    });
}

describe('inherited protected descriptor deadlines', () => {
    it('rejects structurally incomplete service bodies over both inherited IPC channels', async () => {
        const packet = createFixturePacket();
        const scope = packet.providerScope;
        const bootstrap = {
            packetDigest: canonicalDigest(packet),
            ownerDigest: canonicalDigest('provider-free-bootstrap-owner'),
            lockNamespace: packet.lockNamespace,
            ...scope,
            scopeDigest: canonicalDigest(scope),
            vercelToken: 'fixture-vercel-token',
            serviceBodies: { preflight: { spec: {} }, paid: { spec: {} } }, zeroWorkEvidence: null,
        } as const;
        const result = await runHeldOpenPipeCase(JSON.stringify(packet), true, JSON.stringify(bootstrap), true);
        expect(result.code).toBe(2);
        expect(result.signal).toBeNull();
        // The inherited streams are complete, but service bodies are not a
        // reviewed Cloud Run packet. Reject before any bootstrap/evidence
        // construction rather than treating non-empty JSON as sufficient.
        expect(result.stderr).toBe('PROTECTED_INPUT_UNAVAILABLE\n');
        expect(result.stdout).toBe('');
        expect(result.elapsedMs).toBeLessThan(PROTECTED_DEADLINE_MS);
    }, 8_000);

    it('terminates with a fixed code when a pipe has no bytes and no EOF', async () => {
        const result = await runHeldOpenPipeCase('', false);
        expect(result.code).toBe(2);
        expect(result.signal).toBeNull();
        expect(result.stderr).toBe('PROTECTED_INPUT_UNAVAILABLE\n');
        expect(result.stdout).toBe('');
        expect(result.elapsedMs).toBeGreaterThanOrEqual(PROTECTED_DEADLINE_MS - DEADLINE_TOLERANCE_MS);
        expect(result.elapsedMs).toBeLessThan(8_000);
    }, 12_000);

    it('terminates with a fixed code when partial JSON has no EOF', async () => {
        const result = await runHeldOpenPipeCase('{', false);
        expect(result.code).toBe(2);
        expect(result.signal).toBeNull();
        expect(result.stderr).toBe('PROTECTED_INPUT_UNAVAILABLE\n');
        expect(result.stdout).toBe('');
        expect(result.elapsedMs).toBeGreaterThanOrEqual(PROTECTED_DEADLINE_MS - DEADLINE_TOLERANCE_MS);
        expect(result.elapsedMs).toBeLessThan(8_000);
    }, 12_000);

    it('rejects an oversized inherited stream before the deadline', async () => {
        const result = await runHeldOpenPipeCase('x'.repeat(1_048_577), false);
        expect(result.code).toBe(2);
        expect(result.signal).toBeNull();
        expect(result.stderr).toBe('PROTECTED_INPUT_UNAVAILABLE\n');
        expect(result.stdout).toBe('');
        expect(result.elapsedMs).toBeLessThan(5_000);
    }, 8_000);

    it('rejects a decoded duplicate inside an otherwise valid packet', async () => {
        const packet = createFixturePacket();
        const serialized = JSON.stringify(packet);
        const duplicate = serialized.replace(
            '"epochId":"epoch-fixture"',
            '"epochId":"epoch-fixture","\\u0065pochId":"epoch-fixture"',
        );
        expect(duplicate).not.toBe(serialized);
        expect(JSON.parse(duplicate)).toEqual(JSON.parse(serialized));
        const result = await runHeldOpenPipeCase(duplicate, true);
        expect(result.code).toBe(2);
        expect(result.signal).toBeNull();
        expect(result.stderr).toBe('INVALID_PACKET\n');
        expect(result.stdout).toBe('');
        expect(result.elapsedMs).toBeLessThan(5_000);
    }, 8_000);

    it('rejects apply without its explicit VERIFIED boundary before bootstrap/GCS access', async () => {
        const packet = createFixturePacket();
        const scope = packet.providerScope;
        const bootstrap = {
            packetDigest: canonicalDigest(packet),
            ownerDigest: canonicalDigest('provider-free-bootstrap-owner'),
            lockNamespace: packet.lockNamespace,
            ...scope,
            scopeDigest: canonicalDigest(scope),
            vercelToken: 'fixture-vercel-token',
            serviceBodies: { preflight: { spec: {} }, paid: { spec: {} } }, zeroWorkEvidence: null,
        } as const;
        const result = await runHeldOpenPipeCase(JSON.stringify(packet), true, JSON.stringify(bootstrap), true, 'apply');
        expect(result.code).toBe(2);
        expect(result.signal).toBeNull();
        expect(result.stderr).toBe('ADAPTER_REQUEST_INVALID\n');
        expect(result.stdout).toBe('');
        expect(result.elapsedMs).toBeLessThan(PROTECTED_DEADLINE_MS);
    }, 8_000);
});
