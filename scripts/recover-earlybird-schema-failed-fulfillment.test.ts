import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
    parseEarlybirdSchemaFailureRecoveryCliArgs,
    runEarlybirdSchemaFailureRecoveryCli,
} from './recover-earlybird-schema-failed-fulfillment';

const ORDER = '123e4567-e89b-42d3-a456-426614174001';
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

async function invokeDirectCli(args: readonly string[]) {
    return new Promise<{
        exitCode: number | null;
        stdout: string;
        stderr: string;
    }>((resolve, reject) => {
        const child = spawn(npmCommand, [
            'run',
            '--silent',
            'earlybird:recover-schema-failed',
            '--',
            ...args,
        ], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                SUPABASE_URL: '',
                SUPABASE_SERVICE_ROLE_KEY: '',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', reject);
        child.once('close', exitCode => resolve({ exitCode, stdout, stderr }));
    });
}

describe('earlybird schema-failure recovery operator CLI', () => {
    it('runs the npm/tsx entrypoint without a local env file and reports invalid input without calling production services', async () => {
        const result = await invokeDirectCli([]);
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe(`${JSON.stringify({
            status: 'failed',
            errorCode: 'EARLYBIRD_SCHEMA_FAILURE_RECOVERY_FAILED',
        })}\n`);
    });

    it('requires one order UUID and the exact schema-failure confirmation flag', () => {
        expect(parseEarlybirdSchemaFailureRecoveryCliArgs([
            '--order-id',
            ORDER,
            '--confirm-schema-failure-recovery',
        ])).toEqual({ orderId: ORDER });
        for (const args of [
            ['--order-id', ORDER],
            ['--confirm-schema-failure-recovery'],
            ['--order-id', ORDER, '--confirm-schema-failure-recovery', '--confirm-schema-failure-recovery'],
            ['--order-id', ORDER, '--confirm-schema-failure-recovery', '--request-id', 'private'],
            ['--order-id', 'not-a-uuid', '--confirm-schema-failure-recovery'],
        ]) {
            expect(() => parseEarlybirdSchemaFailureRecoveryCliArgs(args)).toThrow();
        }
    });

    it('prints only the bounded recovery disposition', async () => {
        const writeStdout = vi.fn();
        const recover = vi.fn(async () => ({
            status: 'admission_pending' as const,
            nextAction: 'wait_for_fresh_admission' as const,
        }));
        await expect(runEarlybirdSchemaFailureRecoveryCli([
            '--order-id',
            ORDER,
            '--confirm-schema-failure-recovery',
        ], { recover, writeStdout })).resolves.toEqual({
            status: 'admission_pending',
            nextAction: 'wait_for_fresh_admission',
        });
        expect(recover).toHaveBeenCalledWith(ORDER);
        expect(writeStdout).toHaveBeenCalledWith(`${JSON.stringify({
            status: 'admission_pending',
            nextAction: 'wait_for_fresh_admission',
        })}\n`);
    });

    it('rejects identifier-bearing recovery output before printing', async () => {
        const writeStdout = vi.fn();
        await expect(runEarlybirdSchemaFailureRecoveryCli([
            '--order-id',
            ORDER,
            '--confirm-schema-failure-recovery',
        ], {
            recover: async () => ({
                status: 'admission_pending',
                nextAction: 'wait_for_fresh_admission',
                requestId: 'private',
            }),
            writeStdout,
        })).rejects.toThrow();
        expect(writeStdout).not.toHaveBeenCalled();
    });
});
