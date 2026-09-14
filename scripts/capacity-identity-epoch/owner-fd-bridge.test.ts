import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { canonicalDigest, EpochError, type CapacityEpochPacket } from './contracts';
import { createFixturePacket } from './fixtures';
import { assembleOwnerDescriptors, type OwnerDescriptors } from './owner-descriptors';
import {
    runOwnerEpochThroughVerified,
    type OwnerFdBridgeSpawn,
} from './owner-fd-bridge';

type FakeChild = ChildProcess & {
    packet: PassThrough;
    bootstrap: PassThrough;
    stdoutPipe: PassThrough;
    stderrPipe: PassThrough;
};

type FakeStage = Readonly<{
    stage: 'check' | 'apply' | 'verify';
    code?: number;
    signal?: NodeJS.Signals | null;
    stdout?: string;
    stderr?: string;
    close?: boolean;
}>;

function descriptors(packet = createFixturePacket()): OwnerDescriptors {
    const serviceBodies = Object.fromEntries((['preflight', 'paid'] as const).map(role => {
        const runtime = packet.protectedInputs.desired.runtime[role];
        const image = `region-docker.pkg.dev/${runtime.project}/workers/${role}@sha256:${'c'.repeat(64)}`;
        const env = [
            ...Object.entries(runtime.environment).map(([name, value]) => ({ name, value })),
            ...Object.entries(runtime.secretReferences).map(([name, ref]) => {
                const [secretName, key] = ref.split(':');
                return { name, valueFrom: { secretKeyRef: { name: secretName, key } } };
            }),
        ];
        const plan = packet.desiredManifest.source[role].revisionPlan;
        const revision = `${plan.prefix}${packet.desiredManifest.source[role].desiredRevisionId ?? `${packet.desiredManifest.source[role].desiredSha.slice(0, 12)}${plan.suffix}`}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63).replace(/-+$/, '');
        return [role, {
            metadata: { name: runtime.service, generation: 1, resourceVersion: packet.protectedObservations.old.runtime[role].resourceVersion, labels: {}, annotations: {} },
            spec: { template: { metadata: { name: revision, labels: {}, annotations: {
                'autoscaling.knative.dev/maxScale': String(runtime.settings.maxInstances),
                'capacity.identity-epoch/source-sha': runtime.sourceSha,
                'capacity.identity-epoch/build-digest': packet.desiredManifest.source[role].desiredBuildDigest,
                'capacity.identity-epoch/image-digest': canonicalDigest({ image }),
            } }, spec: { serviceAccountName: runtime.identity.identity, containerConcurrency: runtime.settings.concurrency, timeoutSeconds: runtime.settings.timeoutSeconds, containers: [{ image, env, resources: { limits: { cpu: runtime.settings.cpu, memory: runtime.settings.memory } } }] } }, traffic: [{ revisionName: packet.oldManifest.source[role].oldRevision, percent: 100, tag: null }, { revisionName: revision, percent: 0, tag: null }] },
        }];
    })) as never;
    return assembleOwnerDescriptors({
        packet,
        ownerDigest: canonicalDigest('fixture-bridge-owner'),
        vercelToken: 'fixture-bridge-token',
        serviceBodies,
        zeroWorkEvidence: null,
    });
}

function fakeSpawn(stages: FakeStage[], received: Array<Readonly<{ args: readonly string[]; env: Readonly<Record<string, string>>; packet: string; bootstrap: string; writes: number }>>): OwnerFdBridgeSpawn {
    let index = 0;
    return (_command, args, options) => {
        const behavior = stages[index++] ?? { stage: 'check', code: 2, stderr: 'PROTECTED_PIPE_FAILED' };
        const packet = new PassThrough();
        const bootstrap = new PassThrough();
        const stdoutPipe = new PassThrough();
        const stderrPipe = new PassThrough();
        const child = new EventEmitter() as FakeChild;
        const mutableChild = child as unknown as {
            stdout: PassThrough | null;
            stderr: PassThrough | null;
            stdio: readonly (PassThrough | null)[];
            exitCode: number | null;
            signalCode: NodeJS.Signals | null;
        };
        child.packet = packet;
        child.bootstrap = bootstrap;
        child.stdoutPipe = stdoutPipe;
        child.stderrPipe = stderrPipe;
        mutableChild.stdout = stdoutPipe;
        mutableChild.stderr = stderrPipe;
        mutableChild.stdio = [null, stdoutPipe, stderrPipe, packet, bootstrap];
        mutableChild.exitCode = null;
        mutableChild.signalCode = null;
        let packetRaw = '';
        let bootstrapRaw = '';
        let writes = 0;
        const packetWrite = packet.write.bind(packet);
        packet.write = ((chunk: unknown, ...rest: unknown[]) => { writes += 1; return packetWrite(chunk as never, ...(rest as never[])); }) as never;
        const bootstrapWrite = bootstrap.write.bind(bootstrap);
        bootstrap.write = ((chunk: unknown, ...rest: unknown[]) => { writes += 1; return bootstrapWrite(chunk as never, ...(rest as never[])); }) as never;
        packet.on('data', chunk => { packetRaw += String(chunk); });
        bootstrap.on('data', chunk => { bootstrapRaw += String(chunk); });
        const finish = (): void => {
            received.push({ args: [...args], env: (options.env ?? {}) as Readonly<Record<string, string>>, packet: packetRaw, bootstrap: bootstrapRaw, writes });
            if (behavior.close === false) return;
            if (behavior.stdout !== undefined) stdoutPipe.end(behavior.stdout);
            else stdoutPipe.end();
            if (behavior.stderr !== undefined) stderrPipe.end(behavior.stderr);
            else stderrPipe.end();
            mutableChild.exitCode = behavior.code ?? 0;
            mutableChild.signalCode = behavior.signal ?? null;
            queueMicrotask(() => child.emit('close', mutableChild.exitCode, mutableChild.signalCode));
        };
        let packetEnded = false;
        let bootstrapEnded = false;
        packet.once('end', () => { packetEnded = true; if (bootstrapEnded) finish(); });
        bootstrap.once('end', () => { bootstrapEnded = true; if (packetEnded) finish(); });
        child.kill = (signal?: NodeJS.Signals): boolean => {
            mutableChild.exitCode = null;
            mutableChild.signalCode = signal ?? 'SIGTERM';
            queueMicrotask(() => child.emit('close', null, mutableChild.signalCode));
            return true;
        };
        return child;
    };
}

describe('owner inherited-FD bridge', () => {
    it('sends each descriptor exactly once to check, apply, and verifier without protected argv/env output', async () => {
        const value = descriptors();
        const received: Array<Readonly<{ args: readonly string[]; env: Readonly<Record<string, string>>; packet: string; bootstrap: string; writes: number }>> = [];
        const result = await runOwnerEpochThroughVerified({
            packet: value.packet,
            bootstrap: value.bootstrap,
            options: { spawn: fakeSpawn([{ stage: 'check', stdout: 'CHECK_OK\n' }, { stage: 'apply' }, { stage: 'verify', stdout: 'VERIFIED_OK\n' }], received) },
        });
        expect(result.status).toBe('VERIFIED_OK');
        expect(result.stages).toEqual(['check', 'apply', 'verify']);
        expect(received).toHaveLength(3);
        for (const child of received) {
            expect(child.packet).toBe(JSON.stringify(value.packet));
            expect(child.bootstrap).toBe(JSON.stringify(value.bootstrap));
            expect(child.writes).toBe(2);
            expect(child.args).toContain('--packet-fd');
            expect(child.args).toContain('3');
            expect(child.args).toContain('--bootstrap-fd');
            expect(child.args).toContain('4');
            expect(child.args.join(' ')).not.toContain('fixture-bridge-token');
            expect(JSON.stringify(child.env)).not.toContain('fixture-bridge-token');
            expect(child.args.join(' ')).not.toMatch(/activation|resume|canary/i);
        }
        expect(received[0]!.args).toContain('check');
        expect(received[1]!.args).toContain('apply');
        expect(received[1]!.args).toContain('VERIFIED');
        expect(received[2]!.args).not.toContain('apply');
    });

    it('does not start the verifier after a fixed-code apply failure', async () => {
        const value = descriptors();
        const received: Array<Readonly<{ args: readonly string[]; env: Readonly<Record<string, string>>; packet: string; bootstrap: string; writes: number }>> = [];
        await expect(runOwnerEpochThroughVerified({
            packet: value.packet,
            bootstrap: value.bootstrap,
            options: { spawn: fakeSpawn([{ stage: 'check', stdout: 'CHECK_OK\n' }, { stage: 'apply', code: 2, stderr: 'EVIDENCE_UNAVAILABLE\n' }, { stage: 'verify', stdout: 'VERIFIED_OK\n' }], received) },
        })).rejects.toThrow('EVIDENCE_UNAVAILABLE');
        expect(received).toHaveLength(2);
    });

    it('collapses unallowlisted child output and signals to PROTECTED_PIPE_FAILED', async () => {
        const value = descriptors();
        const received: Array<Readonly<{ args: readonly string[]; env: Readonly<Record<string, string>>; packet: string; bootstrap: string; writes: number }>> = [];
        await expect(runOwnerEpochThroughVerified({
            packet: value.packet,
            bootstrap: value.bootstrap,
            options: { spawn: fakeSpawn([{ stage: 'check', stdout: 'CHECK_OK\n' }, { stage: 'apply', code: 1, stderr: 'fixture-bridge-token\n' }], received) },
        })).rejects.toThrow(new EpochError('PROTECTED_PIPE_FAILED'));
        expect(received).toHaveLength(2);
    });

    it('bounds a stalled child and does not run a later stage', async () => {
        const value = descriptors();
        const received: Array<Readonly<{ args: readonly string[]; env: Readonly<Record<string, string>>; packet: string; bootstrap: string; writes: number }>> = [];
        await expect(runOwnerEpochThroughVerified({
            packet: value.packet,
            bootstrap: value.bootstrap,
            options: { spawn: fakeSpawn([{ stage: 'check', close: false }], received), timeoutMs: 10 },
        })).rejects.toThrow('PROTECTED_PIPE_FAILED');
        expect(received).toHaveLength(1);
    }, 2_000);
});
