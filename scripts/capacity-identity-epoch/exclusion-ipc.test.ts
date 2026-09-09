import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { deriveResources } from './exclusion-ipc';

const ipc = resolve('scripts/capacity-identity-epoch/exclusion-ipc.ts');
const nonce = 'c'.repeat(64);

async function runFakePeer(response: (id: string) => string): Promise<Readonly<{
    code: number | null;
    stdout: string;
    stderr: string;
}>> {
    const child = spawn(process.execPath, [
        '--import', 'tsx', ipc, 'assert',
        '--entry-point', 'capacity-queue', '--role', 'preflight',
        '--control-write-fd', '3', '--control-read-fd', '4',
    ], {
        env: {
            ...process.env,
            ANALYSIS_CAPACITY_EXCLUSION_CONTROL_NONCE: nonce,
            ANALYSIS_CAPACITY_DEPLOY_LOCK_BUCKET: 'fixture-bucket',
            PREFLIGHT_TASKS_PROJECT: 'fixture-project',
            PREFLIGHT_TASKS_LOCATION: 'fixture-location',
            PREFLIGHT_TASKS_QUEUE: 'fixture-queue',
            PREFLIGHT_TASKS_CLOUD_RUN_SERVICE: 'fixture-service',
            PREFLIGHT_TASKS_CLOUD_RUN_REGION: 'fixture-region',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    });
    let requestBytes = '';
    let stdout = '';
    let stderr = '';
    const stdoutPipe = child.stdout;
    const stderrPipe = child.stderr;
    const requestPipe = child.stdio[3];
    const responsePipe = child.stdio[4];
    if (!stdoutPipe || !stderrPipe || !requestPipe || typeof requestPipe === 'string'
        || !responsePipe || typeof responsePipe === 'string' || !('end' in responsePipe)) {
        throw new Error('missing fake peer pipes');
    }
    stdoutPipe.on('data', chunk => { stdout += String(chunk); });
    stderrPipe.on('data', chunk => { stderr += String(chunk); });
    requestPipe.on('data', chunk => {
        requestBytes += String(chunk);
        const newline = requestBytes.indexOf('\n');
        if (newline < 0) return;
        const request = JSON.parse(requestBytes.slice(0, newline)) as { id: string };
        responsePipe.end(response(request.id));
    });
    const code = await new Promise<number | null>((resolveExit, reject) => {
        child.once('error', reject);
        child.once('close', resolveExit);
    });
    return { code, stdout, stderr };
}

describe('exclusion IPC authority framing', () => {
    it('rejects a plain fake success without protected lease evidence', async () => {
        const result = await runFakePeer(id => id + ' ' + nonce + ' ASSERT_OK\n');
        expect(result.code).toBe(2);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('ADAPTER_REQUEST_INVALID\n');
    });

    it('rejects a wrong-operation success and arbitrary error text', async () => {
        const wrongOperation = await runFakePeer(id => id + ' ' + nonce + ' ADOPTED\n');
        expect(wrongOperation.code).toBe(2);
        expect(wrongOperation.stderr).toBe('ADAPTER_REQUEST_INVALID\n');

        const marker = 'SYNTHETIC_PROTECTED_MARKER';
        const arbitraryError = await runFakePeer(id => id + ' ' + nonce + ' ERR ' + marker + '\n');
        expect(arbitraryError.code).toBe(2);
        expect(arbitraryError.stderr).toBe('ADAPTER_REQUEST_INVALID\n');
        expect(arbitraryError.stderr).not.toContain(marker);
    });

    it('derives role, generic, maintenance, and shared-IAM selectors from the actual contract', () => {
        const names = [
            'ANALYSIS_TASKS_PROJECT', 'ANALYSIS_TASKS_LOCATION', 'ANALYSIS_TASKS_QUEUE',
            'ANALYSIS_TASKS_CLOUD_RUN_SERVICE', 'ANALYSIS_TASKS_CLOUD_RUN_REGION',
            'ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL', 'ANALYSIS_TASKS_IAM_SCOPE',
            'PREFLIGHT_TASKS_PROJECT', 'PREFLIGHT_TASKS_LOCATION', 'PREFLIGHT_TASKS_QUEUE',
            'PREFLIGHT_TASKS_CLOUD_RUN_SERVICE', 'PREFLIGHT_TASKS_CLOUD_RUN_REGION',
            'PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL', 'PREFLIGHT_TASKS_MAINTENANCE_LOCATION',
            'PREFLIGHT_TASKS_RECOVERY_SCHEDULER_JOB', 'ANALYSIS_V2_TASKS_PROJECT',
            'ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE', 'ANALYSIS_V2_TASKS_CLOUD_RUN_REGION',
            'ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL', 'ANALYSIS_V2_MAINTENANCE_LOCATION',
            'ANALYSIS_V2_RECOVERY_SCHEDULER_JOB', 'ANALYSIS_V2_RETENTION_SCHEDULER_JOB',
        ] as const;
        const previous = new Map(names.map(name => [name, process.env[name]]));
        try {
            Object.assign(process.env, {
                ANALYSIS_TASKS_PROJECT: 'generic-project', ANALYSIS_TASKS_LOCATION: 'generic-location',
                ANALYSIS_TASKS_QUEUE: 'generic-queue', ANALYSIS_TASKS_CLOUD_RUN_SERVICE: 'generic-service',
                ANALYSIS_TASKS_CLOUD_RUN_REGION: 'generic-region', ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL: 'shared@example.test',
                ANALYSIS_TASKS_IAM_SCOPE: 'queue', PREFLIGHT_TASKS_PROJECT: 'preflight-project',
                PREFLIGHT_TASKS_LOCATION: 'preflight-location', PREFLIGHT_TASKS_QUEUE: 'preflight-queue',
                PREFLIGHT_TASKS_CLOUD_RUN_SERVICE: 'preflight-service', PREFLIGHT_TASKS_CLOUD_RUN_REGION: 'preflight-region',
                PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL: 'preflight@example.test',
                PREFLIGHT_TASKS_MAINTENANCE_LOCATION: 'preflight-maintenance-location',
                PREFLIGHT_TASKS_RECOVERY_SCHEDULER_JOB: 'preflight-recovery', ANALYSIS_V2_TASKS_PROJECT: 'paid-project',
                ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE: 'paid-service', ANALYSIS_V2_TASKS_CLOUD_RUN_REGION: 'paid-region',
                ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL: 'paid@example.test', ANALYSIS_V2_MAINTENANCE_LOCATION: 'paid-maintenance-location',
                ANALYSIS_V2_RECOVERY_SCHEDULER_JOB: 'paid-recovery', ANALYSIS_V2_RETENTION_SCHEDULER_JOB: 'paid-retention',
            });
            const generic = deriveResources('capacity-queue', 'preflight', 'generic').map(resource => resource.resource);
            expect(generic.some(resource => resource.includes('generic-project'))).toBe(true);
            expect(generic.some(resource => resource.includes('preflight-project'))).toBe(false);
            expect(generic.some(resource => resource.includes('serviceAccounts/shared@example.test'))).toBe(true);

            const preflight = deriveResources('preflight-maintenance', 'preflight').map(resource => resource.resource);
            expect(preflight.some(resource => resource.includes('preflight-maintenance-location'))).toBe(true);
            expect(preflight.some(resource => resource.includes('paid-maintenance-location'))).toBe(false);
            const paid = deriveResources('paid-maintenance', 'paid').map(resource => resource.resource);
            expect(paid.some(resource => resource.includes('paid-maintenance-location'))).toBe(true);
            expect(paid.some(resource => resource.includes('paid-retention'))).toBe(true);
        } finally {
            for (const [name, value] of previous) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
        }
    });

    it('covers every selector atom, generic precedence, queue-absent maintenance, and SA overlap', () => {
        const names = [
            'ANALYSIS_TASKS_PROJECT', 'ANALYSIS_TASKS_LOCATION', 'ANALYSIS_TASKS_QUEUE',
            'ANALYSIS_TASKS_CLOUD_RUN_SERVICE', 'ANALYSIS_TASKS_CLOUD_RUN_REGION',
            'ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL', 'ANALYSIS_TASKS_IAM_SCOPE',
            'PREFLIGHT_TASKS_PROJECT', 'PREFLIGHT_TASKS_LOCATION', 'PREFLIGHT_TASKS_QUEUE',
            'PREFLIGHT_TASKS_CLOUD_RUN_SERVICE', 'PREFLIGHT_TASKS_CLOUD_RUN_REGION',
            'PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL', 'PREFLIGHT_TASKS_MAINTENANCE_LOCATION',
            'PREFLIGHT_TASKS_RECOVERY_SCHEDULER_JOB', 'ANALYSIS_V2_TASKS_PROJECT',
            'ANALYSIS_V2_TASKS_LOCATION', 'ANALYSIS_V2_TASKS_QUEUE', 'ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE',
            'ANALYSIS_V2_TASKS_CLOUD_RUN_REGION', 'ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL',
            'ANALYSIS_V2_MAINTENANCE_LOCATION', 'ANALYSIS_V2_RECOVERY_SCHEDULER_JOB',
            'ANALYSIS_V2_RETENTION_SCHEDULER_JOB',
        ] as const;
        const previous = new Map(names.map(name => [name, process.env[name]]));
        try {
            Object.assign(process.env, {
                ANALYSIS_TASKS_PROJECT: 'generic-project', ANALYSIS_TASKS_LOCATION: 'generic-location',
                ANALYSIS_TASKS_QUEUE: 'generic-queue', ANALYSIS_TASKS_CLOUD_RUN_SERVICE: 'generic-service',
                ANALYSIS_TASKS_CLOUD_RUN_REGION: 'generic-region', ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL: 'shared@example.test',
                ANALYSIS_TASKS_IAM_SCOPE: 'queue',
                PREFLIGHT_TASKS_PROJECT: 'preflight-project', PREFLIGHT_TASKS_LOCATION: 'preflight-location',
                PREFLIGHT_TASKS_QUEUE: 'preflight-queue', PREFLIGHT_TASKS_CLOUD_RUN_SERVICE: 'preflight-service',
                PREFLIGHT_TASKS_CLOUD_RUN_REGION: 'preflight-region', PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL: 'preflight@example.test',
                PREFLIGHT_TASKS_MAINTENANCE_LOCATION: 'preflight-maintenance', PREFLIGHT_TASKS_RECOVERY_SCHEDULER_JOB: 'preflight-recovery',
                ANALYSIS_V2_TASKS_PROJECT: 'paid-project', ANALYSIS_V2_TASKS_LOCATION: 'paid-location',
                ANALYSIS_V2_TASKS_QUEUE: 'paid-queue', ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE: 'paid-service',
                ANALYSIS_V2_TASKS_CLOUD_RUN_REGION: 'paid-region', ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL: 'paid@example.test',
                ANALYSIS_V2_MAINTENANCE_LOCATION: 'paid-maintenance', ANALYSIS_V2_RECOVERY_SCHEDULER_JOB: 'paid-recovery',
                ANALYSIS_V2_RETENTION_SCHEDULER_JOB: 'paid-retention',
            });
            const generic = deriveResources('capacity-queue', 'preflight', 'generic');
            expect(generic.map(resource => resource.kind)).toEqual(['service', 'iam', 'iam', 'queue']);
            expect(generic.some(resource => resource.resource.includes('generic-project'))).toBe(true);
            expect(generic.some(resource => resource.resource.includes('preflight-project'))).toBe(false);
            expect(generic.some(resource => resource.resource.includes('/serviceAccounts/shared@example.test'))).toBe(true);
            expect(generic.some(resource => resource.kind === 'scheduler' || resource.kind === 'retention')).toBe(false);

            const roleQueue = deriveResources('capacity-queue', 'preflight');
            expect(roleQueue.some(resource => resource.resource.endsWith('/queues/preflight-queue'))).toBe(true);
            expect(roleQueue.some(resource => resource.resource.endsWith('/serviceAccounts/preflight@example.test'))).toBe(true);
            const roleDeployer = deriveResources('role-deployer', 'preflight');
            expect(roleDeployer.some(resource => resource.kind === 'queue')).toBe(false);
            expect(roleDeployer.some(resource => resource.kind === 'scheduler')).toBe(false);
            expect(roleDeployer.some(resource => resource.kind === 'service')).toBe(true);

            delete process.env.ANALYSIS_V2_TASKS_LOCATION;
            delete process.env.ANALYSIS_V2_TASKS_QUEUE;
            const paidMaintenance = deriveResources('paid-maintenance', 'paid');
            expect(paidMaintenance.some(resource => resource.kind === 'scheduler' && resource.resource.endsWith('/jobs/paid-recovery'))).toBe(true);
            expect(paidMaintenance.some(resource => resource.kind === 'retention' && resource.resource.endsWith('/jobs/paid-retention'))).toBe(true);
            expect(paidMaintenance.some(resource => resource.kind === 'queue')).toBe(false);
            const preflightMaintenance = deriveResources('preflight-maintenance', 'preflight');
            expect(preflightMaintenance.some(resource => resource.kind === 'scheduler')).toBe(true);
            expect(preflightMaintenance.some(resource => resource.kind === 'retention')).toBe(false);
            expect(preflightMaintenance.some(resource => resource.kind === 'queue')).toBe(false);

            process.env.ANALYSIS_V2_TASKS_PROJECT = 'preflight-project';
            process.env.ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL = 'preflight@example.test';
            const overlapping = new Set(deriveResources('role-deployer', 'preflight').map(resource => resource.resource));
            expect(deriveResources('role-deployer', 'paid').some(resource => overlapping.has(resource.resource))).toBe(true);
            process.env.ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL = 'paid@example.test';
            const disjointPreflight = deriveResources('role-deployer', 'preflight').map(resource => resource.resource);
            const disjointPaid = deriveResources('role-deployer', 'paid').map(resource => resource.resource);
            expect(disjointPreflight.filter(resource => disjointPaid.includes(resource))).toEqual([]);
        } finally {
            for (const [name, value] of previous) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
        }
    });

    it('rejects selector atoms outside the provider resource grammar', () => {
        const names = ['PREFLIGHT_TASKS_PROJECT', 'PREFLIGHT_TASKS_LOCATION', 'PREFLIGHT_TASKS_QUEUE', 'PREFLIGHT_TASKS_CLOUD_RUN_SERVICE', 'PREFLIGHT_TASKS_CLOUD_RUN_REGION'] as const;
        const previous = new Map(names.map(name => [name, process.env[name]]));
        try {
            Object.assign(process.env, {
                PREFLIGHT_TASKS_PROJECT: 'fixture-project', PREFLIGHT_TASKS_LOCATION: 'fixture-location', PREFLIGHT_TASKS_QUEUE: 'fixture-queue',
                PREFLIGHT_TASKS_CLOUD_RUN_SERVICE: 'fixture-service', PREFLIGHT_TASKS_CLOUD_RUN_REGION: 'fixture-region',
            });
            process.env.PREFLIGHT_TASKS_QUEUE = 'queue/name';
            expect(() => deriveResources('capacity-queue', 'preflight')).toThrow('ADAPTER_REQUEST_INVALID');
            process.env.PREFLIGHT_TASKS_QUEUE = 'fixture-queue';
            process.env.PREFLIGHT_TASKS_PROJECT = 'fixture-project" OR true';
            expect(() => deriveResources('capacity-queue', 'preflight')).toThrow('ADAPTER_REQUEST_INVALID');
        } finally {
            for (const [name, value] of previous) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
        }
    });

    it('matches the distinct Cloud Tasks queue and Cloud Scheduler job grammars and limits', () => {
        const names = [
            'PREFLIGHT_TASKS_PROJECT', 'PREFLIGHT_TASKS_LOCATION', 'PREFLIGHT_TASKS_QUEUE',
            'PREFLIGHT_TASKS_CLOUD_RUN_SERVICE', 'PREFLIGHT_TASKS_CLOUD_RUN_REGION',
            'PREFLIGHT_TASKS_MAINTENANCE_LOCATION', 'PREFLIGHT_TASKS_RECOVERY_SCHEDULER_JOB',
        ] as const;
        const previous = new Map(names.map(name => [name, process.env[name]]));
        try {
            Object.assign(process.env, {
                PREFLIGHT_TASKS_PROJECT: 'fixture-project',
                PREFLIGHT_TASKS_LOCATION: 'fixture-location',
                PREFLIGHT_TASKS_QUEUE: 'Queue-1',
                PREFLIGHT_TASKS_CLOUD_RUN_SERVICE: 'fixture-service',
                PREFLIGHT_TASKS_CLOUD_RUN_REGION: 'fixture-region',
                PREFLIGHT_TASKS_MAINTENANCE_LOCATION: 'fixture-maintenance',
                PREFLIGHT_TASKS_RECOVERY_SCHEDULER_JOB: 'Job_Name-1',
            });
            expect(deriveResources('capacity-queue', 'preflight').some(resource => resource.resource.endsWith('/queues/Queue-1'))).toBe(true);
            expect(deriveResources('preflight-maintenance', 'preflight').some(resource => resource.resource.endsWith('/jobs/Job_Name-1'))).toBe(true);

            process.env.PREFLIGHT_TASKS_QUEUE = 'Q'.repeat(101);
            expect(() => deriveResources('capacity-queue', 'preflight')).toThrow('ADAPTER_REQUEST_INVALID');
            process.env.PREFLIGHT_TASKS_QUEUE = 'Queue_Name';
            expect(() => deriveResources('capacity-queue', 'preflight')).toThrow('ADAPTER_REQUEST_INVALID');
            process.env.PREFLIGHT_TASKS_QUEUE = 'Queue-1';

            process.env.PREFLIGHT_TASKS_RECOVERY_SCHEDULER_JOB = 'J'.repeat(501);
            expect(() => deriveResources('preflight-maintenance', 'preflight')).toThrow('ADAPTER_REQUEST_INVALID');
        } finally {
            for (const [name, value] of previous) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
        }
    });
});
