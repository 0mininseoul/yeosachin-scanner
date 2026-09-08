import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ControlChannelDispatcher, terminateProcessGroup, waitForProcessGroup } from './exclusion-launcher';

const nonce = 'd'.repeat(64);

describe('mapped exclusion launcher control channel', () => {
    it('uses one supervisor reader for child proxy traffic and release', async () => {
        const supervisor = spawn(process.execPath, ['-e', [
            `const nonce=${JSON.stringify(nonce)};`,
            `process.stdout.write('READY '+nonce+'\\n');`,
            `process.stdin.setEncoding('utf8');`,
            `process.stdin.on('data', chunk => { for (const line of chunk.split('\\n')) { if (!line) continue; const value=JSON.parse(line); process.stdout.write(value.id+' '+nonce+' '+(value.op==='release'?'RELEASED':'ASSERT_OK')+(value.op==='release'?'':' '+Buffer.from(JSON.stringify({reservationLease:{generation:'1',record:{epochDigest:'${'a'.repeat(64)}',ownerDigest:'${'b'.repeat(64)}',scopeDigest:'${'c'.repeat(64)}',lockFence:'1',lockExpiresAt:'2026-09-08T00:00:00.000Z'},members:null},legacyLeases:[]})).toString('base64url'))+'\\n'); } });`,
        ].join('')], { stdio: ['pipe', 'pipe', 'pipe'] });
        const dispatcher = new ControlChannelDispatcher(supervisor, nonce);
        const sink = new PassThrough();
        let forwarded = '';
        sink.on('data', chunk => { forwarded += String(chunk); });
        try {
            await dispatcher.waitForReady();
            const request = JSON.stringify({ id: '1'.repeat(32), nonce, op: 'assert' });
            await dispatcher.forwardChildRequest(request, sink);
            await new Promise(resolve => setImmediate(resolve));
            expect(forwarded).toMatch(/^1{32} d{64} ASSERT_OK /);
            await expect(dispatcher.sendSupervisorRequest('release')).resolves.toBe('RELEASED');
        } finally {
            dispatcher.close();
            if (supervisor.exitCode === null) supervisor.kill('SIGTERM');
        }
    });

    it('waits for descendants in the detached child process group before release', async () => {
        const child = spawn('/bin/bash', ['-c', 'sleep 0.15 & exit 0'], {
            detached: true,
            stdio: 'ignore',
        });
        try {
            await new Promise<void>((resolveExit, reject) => {
                child.once('error', reject);
                child.once('exit', () => resolveExit());
            });
            await expect(waitForProcessGroup(child, 2_000)).resolves.toBeUndefined();
        } finally {
            terminateProcessGroup(child, 'SIGTERM');
        }
    });

    it('terminates the mapped child when the supervisor reports lost authority', async () => {
        const supervisor = spawn(process.execPath, ['-e', [
            `const nonce=${JSON.stringify(nonce)};`,
            `process.stdout.write('READY '+nonce+'\\n');`,
            `setTimeout(() => process.stdout.write('FATAL '+nonce+' LOCK_LOST\\n'), 10);`,
            `process.stdin.resume();`,
        ].join('')], { stdio: ['pipe', 'pipe', 'pipe'] });
        const child = spawn('/bin/bash', ['-c', 'sleep 30'], {
            detached: true,
            stdio: 'ignore',
        });
        let failure: unknown;
        const dispatcher = new ControlChannelDispatcher(supervisor, nonce, error => {
            failure = error;
            terminateProcessGroup(child, 'SIGTERM');
        });
        try {
            await dispatcher.waitForReady();
            await new Promise<void>((resolveExit, reject) => {
                child.once('error', reject);
                child.once('exit', () => resolveExit());
            });
            expect(failure).toEqual(expect.objectContaining({ code: 'LOCK_LOST' }));
        } finally {
            dispatcher.close();
            if (supervisor.exitCode === null) supervisor.kill('SIGTERM');
            terminateProcessGroup(child, 'SIGTERM');
        }
    });
});
