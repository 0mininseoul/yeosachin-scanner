import { mkdtemp, chmod, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    createReplayKeyFile,
    readReplayBundle,
    removeReplayArtifacts,
    writeReplayBundle,
    type AnalysisV2ReplayBundle,
} from './replay-bundle';

const temporaryPaths: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function bundle(): AnalysisV2ReplayBundle {
    return {
        schemaVersion: 1,
        createdAt: '2026-07-27T00:00:00.000Z',
        expiresAt: '2026-07-27T01:00:00.000Z',
        capture: { requestFingerprint: 'a'.repeat(64), plan: 'standard' },
        profiles: [{ ordinal: 1, isPrivate: false, bio: 'private bundle text', media: [{
            selectionId: 'post:1',
            caption: 'caption',
            jpegBase64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
        }] }],
        evidence: { relationship: [], targetInteractions: [], reverseInteractions: [] },
    };
}

describe('analysis V2 replay bundle', () => {
    it('encrypts private payloads with 0700/0600 artifact permissions and decrypts only with its key', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'analysis-v2-replay-'));
        temporaryPaths.push(directory);
        const keyPath = join(directory, 'key.key');
        const bundlePath = join(directory, 'bundle.enc');
        await createReplayKeyFile(keyPath);
        await writeReplayBundle({ bundle: bundle(), bundlePath, keyPath, now: Date.parse('2026-07-27T00:10:00.000Z') });

        expect((await stat(directory)).mode & 0o777).toBe(0o700);
        expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
        expect((await stat(bundlePath)).mode & 0o777).toBe(0o600);
        expect((await readFile(bundlePath, 'utf8'))).not.toContain('private bundle text');
        await expect(readReplayBundle({ bundlePath, keyPath, now: Date.parse('2026-07-27T00:20:00.000Z') }))
            .resolves.toEqual(bundle());
    });

    it('fails closed for expired, tampered, or weak-permission artifacts', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'analysis-v2-replay-'));
        temporaryPaths.push(directory);
        const keyPath = join(directory, 'key.key');
        const bundlePath = join(directory, 'bundle.enc');
        await createReplayKeyFile(keyPath);
        await writeReplayBundle({ bundle: bundle(), bundlePath, keyPath, now: Date.parse('2026-07-27T00:10:00.000Z') });
        await expect(readReplayBundle({ bundlePath, keyPath, now: Date.parse('2026-07-27T01:01:00.000Z') }))
            .rejects.toThrow('ANALYSIS_V2_REPLAY_BUNDLE_EXPIRED');
        await writeFile(bundlePath, 'tampered');
        await expect(readReplayBundle({ bundlePath, keyPath, now: Date.parse('2026-07-27T00:20:00.000Z') }))
            .rejects.toThrow('ANALYSIS_V2_REPLAY_BUNDLE_AUTH_FAILED');
        await rm(bundlePath);
        await writeReplayBundle({ bundle: bundle(), bundlePath, keyPath, now: Date.parse('2026-07-27T00:10:00.000Z') });
        await chmod(bundlePath, 0o644);
        await expect(readReplayBundle({ bundlePath, keyPath, now: Date.parse('2026-07-27T00:20:00.000Z') }))
            .rejects.toThrow('ANALYSIS_V2_REPLAY_ARTIFACT_PERMISSIONS');
    });

    it('unlinks only exact validated replay artifacts', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'analysis-v2-replay-'));
        temporaryPaths.push(directory);
        const keyPath = join(directory, 'key.key');
        const bundlePath = join(directory, 'bundle.enc');
        const untouchedPath = join(directory, 'untouched');
        await createReplayKeyFile(keyPath);
        await writeReplayBundle({ bundle: bundle(), bundlePath, keyPath, now: Date.parse('2026-07-27T00:10:00.000Z') });
        await writeFile(untouchedPath, 'keep');
        await removeReplayArtifacts({ bundlePath, keyPath });
        await expect(stat(bundlePath)).rejects.toThrow();
        await expect(stat(keyPath)).rejects.toThrow();
        await expect(readFile(untouchedPath, 'utf8')).resolves.toBe('keep');
    });
});
