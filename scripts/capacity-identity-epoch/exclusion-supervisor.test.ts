import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { deriveResources } from './exclusion-ipc';

const fixture = resolve('scripts/capacity-identity-epoch/exclusion-supervisor.fixture.ts');
const ipc = resolve('scripts/capacity-identity-epoch/exclusion-ipc.ts');

const resources = [
    { kind: 'service', resource: 'projects/fixture-project/locations/fixture-region/services/fixture-service' },
    { kind: 'iam', resource: 'projects/fixture-project/locations/fixture-region/services/fixture-service' },
    { kind: 'queue', resource: 'projects/fixture-project/locations/fixture-location/queues/fixture-queue' },
] as const;

function descriptor(overrides: Readonly<Record<string, unknown>> = {}): object {
    return {
        bucket: 'fixture-bucket',
        entryPoint: 'capacity-queue',
        role: 'preflight',
        resources,
        legacyServices: [],
        epochDigest: 'a'.repeat(64),
        ownerDigest: 'b'.repeat(64),
        leaseMs: 60_000,
        lease: null,
        ...overrides,
    };
}

function lineReader(child: ChildProcessWithoutNullStreams): () => Promise<string> {
    if (!child.stdout) throw new Error('missing stdout');
    const input = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const pending: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
    const lines: string[] = [];
    input.on('line', line => {
        const waiter = pending.shift();
        if (waiter) waiter.resolve(line);
        else lines.push(line);
    });
    input.on('close', () => {
        while (pending.length > 0) pending.shift()!.reject(new Error('unexpected EOF'));
    });
    return () => {
        const line = lines.shift();
        if (line !== undefined) return Promise.resolve(line);
        return new Promise<string>((resolveLine, reject) => pending.push({ resolve: resolveLine, reject }));
    };
}

function spawnSupervisor(): ChildProcessWithoutNullStreams {
    return spawn(process.execPath, ['--import', 'tsx', fixture, '--entry-point', 'capacity-queue', '--descriptor-fd', '3'], {
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        env: { ...process.env, NODE_ENV: 'test' },
    }) as ChildProcessWithoutNullStreams;
}

function spawnSupervisorAt(entryPoint: string): ChildProcessWithoutNullStreams {
    return spawn(process.execPath, ['--import', 'tsx', fixture, '--entry-point', entryPoint, '--descriptor-fd', '3'], {
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        env: { ...process.env, NODE_ENV: 'test' },
    }) as ChildProcessWithoutNullStreams;
}

function request(id: string, nonce: string, value: object): string {
    return JSON.stringify({ id, nonce, ...value }) + '\n';
}

describe('mapped exclusion supervisor boundary', () => {
    it('reads the private descriptor on FD3 and returns bound lease evidence', async () => {
        const child = spawnSupervisor();
        try {
            const descriptorPipe = child.stdio[3];
            if (!descriptorPipe || typeof descriptorPipe === 'string' || !('end' in descriptorPipe)) {
                throw new Error('missing descriptor pipe');
            }
            descriptorPipe.end(JSON.stringify(descriptor()));
            const nextLine = lineReader(child);
            const ready = await nextLine();
            const nonce = /^READY ([0-9a-f]{64})$/.exec(ready)?.[1];
            expect(nonce).toMatch(/^[0-9a-f]{64}$/);

            child.stdin.write(request('1'.repeat(32), nonce!, {
                op: 'assert',
                resources: resources.map(resource => resource.kind + ':' + resource.resource),
            }));
            const asserted = await nextLine();
            const match = new RegExp('^' + '1'.repeat(32) + ' ' + nonce + ' ASSERT_OK ([A-Za-z0-9_-]+)$').exec(asserted);
            expect(match).not.toBeNull();
            const evidence = JSON.parse(Buffer.from(match![1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
            expect(evidence).toHaveProperty('reservationLease');

            child.stdin.write(request('2'.repeat(32), nonce!, {
                op: 'adopt', entryPoint: 'capacity-queue', role: 'preflight', resources,
            }));
            await expect(nextLine()).resolves.toMatch(new RegExp('^' + '2'.repeat(32) + ' ' + nonce + ' ADOPTED '));

            child.stdin.write(request('3'.repeat(32), nonce!, { op: 'release' }));
            await expect(nextLine()).resolves.toBe('3'.repeat(32) + ' ' + nonce + ' RELEASED');
            await new Promise<void>((resolveExit, reject) => {
                child.once('error', reject);
                child.once('exit', code => code === 0 ? resolveExit() : reject(new Error('supervisor exit')));
            });
        } finally {
            if (child.exitCode === null) child.kill('SIGTERM');
        }
    });

    it('proves the actual role-deployer adapter admits its nested maintenance union only when bound', async () => {
        const names = [
            'ANALYSIS_CAPACITY_DEPLOY_LOCK_BUCKET', 'PREFLIGHT_TASKS_PROJECT', 'PREFLIGHT_TASKS_LOCATION',
            'PREFLIGHT_TASKS_CLOUD_RUN_SERVICE', 'PREFLIGHT_TASKS_CLOUD_RUN_REGION', 'PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL',
            'PREFLIGHT_TASKS_MAINTENANCE_LOCATION', 'PREFLIGHT_TASKS_RECOVERY_SCHEDULER_JOB', 'ANALYSIS_TASKS_IAM_SCOPE',
        ] as const;
        const previous = new Map(names.map(name => [name, process.env[name]]));
        Object.assign(process.env, {
            ANALYSIS_CAPACITY_DEPLOY_LOCK_BUCKET: 'fixture-bucket',
            PREFLIGHT_TASKS_PROJECT: 'fixture-project', PREFLIGHT_TASKS_LOCATION: 'fixture-location',
            PREFLIGHT_TASKS_CLOUD_RUN_SERVICE: 'fixture-service', PREFLIGHT_TASKS_CLOUD_RUN_REGION: 'fixture-region',
            PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL: 'preflight@example.test',
            PREFLIGHT_TASKS_MAINTENANCE_LOCATION: 'fixture-maintenance-location',
            PREFLIGHT_TASKS_RECOVERY_SCHEDULER_JOB: 'fixture-recovery', ANALYSIS_TASKS_IAM_SCOPE: 'project',
        });
        const parentResources = deriveResources('role-deployer', 'preflight');
        const nestedResources = deriveResources('preflight-maintenance', 'preflight');
        const union = [...new Map([...parentResources, ...nestedResources]
            .map(resource => [resource.kind + ':' + resource.resource, resource] as const)).values()];
        const run = async (resources: readonly typeof parentResources[number][], expectAdopted: boolean): Promise<void> => {
            const child = spawnSupervisorAt('role-deployer');
            try {
                const descriptorValue = descriptor({ entryPoint: 'role-deployer', role: 'preflight', resources });
                const descriptorPipe = child.stdio[3];
                if (!descriptorPipe || typeof descriptorPipe === 'string' || !('end' in descriptorPipe)) throw new Error('missing descriptor pipe');
                descriptorPipe.end(JSON.stringify(descriptorValue));
                const nextLine = lineReader(child);
                const ready = await nextLine();
                const nonce = /^READY ([0-9a-f]{64})$/.exec(ready)?.[1];
                expect(nonce).toMatch(/^[0-9a-f]{64}$/);
                child.stdin.write(request('4'.repeat(32), nonce!, {
                    op: 'adopt', entryPoint: 'preflight-maintenance', role: 'preflight', resources: nestedResources,
                }));
                const response = await nextLine();
                if (expectAdopted) expect(response).toMatch(new RegExp('^' + '4'.repeat(32) + ' ' + nonce + ' ADOPTED '));
                else expect(response).toBe('4'.repeat(32) + ' ' + nonce + ' ERR CAPABILITY_BINDING_MISMATCH');
                child.stdin.write(request('5'.repeat(32), nonce!, { op: 'release' }));
                await expect(nextLine()).resolves.toBe('5'.repeat(32) + ' ' + nonce + ' RELEASED');
                await new Promise<void>((resolveExit, reject) => {
                    child.once('error', reject);
                    child.once('exit', code => code === 0 ? resolveExit() : reject(new Error('supervisor exit')));
                });
            } finally {
                if (child.exitCode === null) child.kill('SIGTERM');
            }
        };
        try {
            await run(parentResources, false);
            await run(union, true);
        } finally {
            for (const [name, value] of previous) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
        }
    });
});
