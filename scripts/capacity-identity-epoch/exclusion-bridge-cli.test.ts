import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalDigest } from './contracts';
import {
    legacyServiceLockPayloadDigest,
    type ExclusionResource,
    type LegacyServiceSelector,
} from './exclusion-bridge';
import { reservationResourceDigest, reservationResourceKey } from './exclusion';

type BridgeResult = Readonly<{ code: number | null; stdout: string; stderr: string }>;

function runBridge(command: 'acquire' | 'assert' | 'renew' | 'release', descriptor: unknown): Promise<BridgeResult> {
    const script = resolve(fileURLToPath(new URL('../check-capacity-identity-epoch-exclusion.ts', import.meta.url)));
    const child = spawn(process.execPath, ['--import', 'tsx', script, command, '--descriptor-fd', '0'], {
        cwd: resolve(fileURLToPath(new URL('../..', import.meta.url))),
        env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.stdin.end(JSON.stringify(descriptor));
    return new Promise(resolveResult => {
        child.once('close', code => resolveResult({ code, stdout, stderr }));
    });
}

describe('ordinary exclusion CLI bridge', () => {
    it('invokes the real script and rejects a direct queue without an explicit role before provider construction', async () => {
        const result = await runBridge('acquire', {
            bucket: 'fixture-bucket',
            entryPoint: 'capacity-queue',
            role: null,
            resources: [
                { kind: 'service', resource: 'fixture-service' },
                { kind: 'queue', resource: 'fixture-queue' },
            ],
            legacyServices: [],
            epochDigest: 'a'.repeat(64),
            ownerDigest: 'b'.repeat(64),
            leaseMs: 1_000,
            lease: null,
        });
        expect(result.code).toBe(2);
        expect(result.stdout).toBe('');
        expect(result.stderr.trim()).toBe('ADAPTER_REQUEST_INVALID');
    });

    it('rejects a lease whose outer owner digest does not bind to the descriptor', async () => {
        const epochDigest = canonicalDigest('epoch');
        const ownerDigest = canonicalDigest('owner');
        const foreignOwner = canonicalDigest('foreign-owner');
        const resources: ExclusionResource[] = [
            { kind: 'service', resource: 'fixture-service' },
            { kind: 'queue', resource: 'fixture-queue' },
        ];
        const ordered = ['service:fixture-service', 'queue:fixture-queue'].sort();
        const members = ordered.map((resource, index) => ({
            key: reservationResourceKey(resource),
            generation: String(index + 1),
            record: {
                scopeDigest: reservationResourceDigest(resource),
                epochDigest,
                ownerDigest: foreignOwner,
                lockFence: '1',
                lockExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
        }));
        const result = await runBridge('assert', {
            bucket: 'fixture-bucket',
            entryPoint: 'capacity-queue',
            role: 'preflight',
            resources,
            legacyServices: [],
            epochDigest,
            ownerDigest,
            leaseMs: 1_000,
            lease: {
                reservationLease: { generation: members[0]!.generation, record: members[0]!.record, members },
                legacyLeases: [],
            },
        });
        expect(result.code).toBe(2);
        expect(result.stdout).toBe('');
        expect(result.stderr.trim()).toBe('CAPABILITY_BINDING_MISMATCH');
    });

    it('rejects a member key that is valid-looking but not the descriptor resource', async () => {
        const epochDigest = canonicalDigest('epoch-member');
        const ownerDigest = canonicalDigest('owner-member');
        const resources: ExclusionResource[] = [
            { kind: 'service', resource: 'fixture-service' },
            { kind: 'queue', resource: 'fixture-queue' },
        ];
        const ordered = ['service:fixture-service', 'queue:fixture-queue'].sort();
        const members = ordered.map((resource, index) => ({
            key: reservationResourceKey(resource),
            generation: String(index + 1),
            record: {
                scopeDigest: reservationResourceDigest(resource),
                epochDigest,
                ownerDigest,
                lockFence: '1',
                lockExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
        }));
        members[1] = { ...members[1]!, key: reservationResourceKey('queue:foreign') };
        const result = await runBridge('assert', {
            bucket: 'fixture-bucket',
            entryPoint: 'capacity-queue',
            role: 'preflight',
            resources,
            legacyServices: [],
            epochDigest,
            ownerDigest,
            leaseMs: 1_000,
            lease: {
                reservationLease: { generation: members[0]!.generation, record: members[0]!.record, members },
                legacyLeases: [],
            },
        });
        expect(result.code).toBe(2);
        expect(result.stdout).toBe('');
        expect(result.stderr.trim()).toBe('CAPABILITY_BINDING_MISMATCH');
    });

    it('rejects a legacy lease payload that is not bound to the descriptor owner', async () => {
        const epochDigest = canonicalDigest('epoch-legacy');
        const ownerDigest = canonicalDigest('owner-legacy');
        const selector: LegacyServiceSelector = {
            bucket: 'fixture-bucket',
            project: 'fixture-project',
            region: 'fixture-region',
            service: 'fixture-service',
        };
        const resource = 'service:fixture-service';
        const record = {
            scopeDigest: reservationResourceDigest(resource),
            epochDigest,
            ownerDigest,
            lockFence: '1',
            lockExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
        const result = await runBridge('assert', {
            bucket: selector.bucket,
            entryPoint: 'role-deployer',
            role: null,
            resources: [{ kind: 'service', resource: 'fixture-service' }],
            legacyServices: [selector],
            epochDigest,
            ownerDigest,
            leaseMs: 1_000,
            lease: {
                reservationLease: {
                    generation: '1',
                    record,
                    members: null,
                },
                legacyLeases: [{
                    generation: '1',
                    payloadDigest: legacyServiceLockPayloadDigest(selector, canonicalDigest('foreign-owner')),
                }],
            },
        });
        expect(result.code).toBe(2);
        expect(result.stdout).toBe('');
        expect(result.stderr.trim()).toBe('CAPABILITY_BINDING_MISMATCH');
    });
});
