import { mkdtemp, chmod, readFile, rename, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createReplayKeyFile,
    createReplayArtifactCreationScope,
    removeExpiredReplayArtifacts,
    removeOwnedReplayArtifacts,
    readReplayBundle,
    readAuthenticatedReplayBundle,
    removeReplayArtifacts,
    writeReplayBundle,
    type AnalysisV2ReplayBundle,
} from './replay-bundle';
import { installReplayArtifactSignalCleanup } from './replay-artifact-lifecycle';

const temporaryPaths: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function bundle(): AnalysisV2ReplayBundle {
    return {
        schemaVersion: 1,
        createdAt: '2026-07-27T00:00:00.000Z',
        expiresAt: '2026-07-27T01:00:00.000Z',
        capture: {
            requestFingerprint: 'a'.repeat(64),
            sourceLineage: {
                selectedPlanId: 'standard',
                policyVersions: {
                    pipeline: 'v2',
                    aiStage: 'ai-stage-policy-v2.7',
                    risk: 'risk-policy-v2.4',
                },
            },
        },
        profiles: [{ ordinal: 1, isPrivate: false, username: 'example', fullName: null, hasProfileImage: false, bio: 'private bundle text', media: [{
            selectionId: 'post:1',
            kind: 'feed', postId: '1',
            caption: 'caption',
            jpegBase64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
        }], triageSelectionIds: ['post:1'], featureSelectionIds: ['post:1'], resolverSelectionIds: ['post:1'], captions: [], coverage: { selectedCount: 1, normalizedCount: 1, failures: [] } }],
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

    it('authenticates source lineage, fingerprint, and evaluation policy as GCM AAD', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'analysis-v2-replay-'));
        temporaryPaths.push(directory);
        const keyPath = join(directory, 'key.key');
        const bundlePath = join(directory, 'bundle.enc');
        const value: AnalysisV2ReplayBundle = {
            ...bundle(),
            capture: {
                ...bundle().capture,
                sourceLineage: {
                    selectedPlanId: 'standard',
                    policyVersions: {
                        pipeline: 'v2',
                        aiStage: 'ai-stage-policy-v2.7',
                        risk: 'risk-policy-v2.3',
                    },
                },
                evaluationPolicy: {
                    capability: 'historical-official-e2e-standard-v27-risk-v23-to-ai-v29',
                    aiStage: 'ai-stage-policy-v2.9',
                },
            },
        };
        await createReplayKeyFile(keyPath);
        await writeReplayBundle({
            bundle: value,
            bundlePath,
            keyPath,
            now: Date.parse('2026-07-27T00:10:00.000Z'),
        });
        const envelope = JSON.parse(await readFile(bundlePath, 'utf8')) as {
            aad: string;
        };
        const aad = JSON.parse(Buffer.from(envelope.aad, 'base64').toString('utf8'));
        expect(aad).toMatchObject({
            requestFingerprint: value.capture.requestFingerprint,
            sourceLineage: value.capture.sourceLineage,
            evaluationPolicy: value.capture.evaluationPolicy,
        });
        envelope.aad = Buffer.from(JSON.stringify({
            ...aad,
            evaluationPolicy: null,
        })).toString('base64');
        await writeFile(bundlePath, JSON.stringify(envelope), { mode: 0o600 });
        await expect(readReplayBundle({
            bundlePath,
            keyPath,
            now: Date.parse('2026-07-27T00:20:00.000Z'),
        })).rejects.toThrow('ANALYSIS_V2_REPLAY_BUNDLE_AUTH_FAILED');
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

    it('removes only explicitly owned files after a partial capture failure', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'analysis-v2-replay-'));
        temporaryPaths.push(directory);
        const keyPath = join(directory, 'partial.key');
        const bundlePath = join(directory, 'partial.enc');
        const untouchedPath = join(directory, 'untouched');
        const ownedKey = await createReplayKeyFile(keyPath);
        await writeFile(untouchedPath, 'keep', { mode: 0o600 });

        await removeOwnedReplayArtifacts({
            bundlePath,
            keyPath,
            ownedKey,
        });

        await expect(stat(keyPath)).rejects.toThrow();
        await expect(readFile(untouchedPath, 'utf8')).resolves.toBe('keep');
    });

    it('unlinks its securely-created key when writing fails before ownership is returned', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'analysis-v2-replay-'));
        temporaryPaths.push(directory);
        const keyPath = join(directory, 'partial.key');

        await expect(createReplayKeyFile(keyPath, {
            writeFile: async (handle, bytes) => {
                await handle.writeFile(bytes);
                throw new Error('injected write failure');
            },
        })).rejects.toThrow('injected write failure');

        await expect(stat(keyPath)).rejects.toThrow();
    });

    it('unlinks its securely-created key when close fails before ownership is returned', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'analysis-v2-replay-'));
        temporaryPaths.push(directory);
        const keyPath = join(directory, 'partial-close.key');

        await expect(createReplayKeyFile(keyPath, {
            close: async () => {
                throw new Error('injected close failure');
            },
        })).rejects.toThrow('injected close failure');

        await expect(stat(keyPath)).rejects.toThrow();
    });

    it('cleans an active partial creation when the signal lifecycle runs', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'analysis-v2-replay-'));
        temporaryPaths.push(directory);
        const keyPath = join(directory, 'signal.key');
        const scope = createReplayArtifactCreationScope();
        const handlers = new Map<string, () => void>();
        const exit = vi.fn();
        const processLike = {
            once: vi.fn((signal: string, handler: () => void) => {
                handlers.set(signal, handler);
                return processLike;
            }),
            off: vi.fn((signal: string) => {
                handlers.delete(signal);
                return processLike;
            }),
            exit,
        };
        const uninstall = installReplayArtifactSignalCleanup({
            cleanup: () => scope.cleanupActive(),
            processLike,
        });

        let releaseWrite: (() => void) | undefined;
        const writing = createReplayKeyFile(keyPath, {
            scope,
            writeFile: async () => new Promise<void>(resolve => {
                releaseWrite = resolve;
            }),
        });
        await vi.waitFor(() => expect(releaseWrite).toBeTypeOf('function'));

        handlers.get('SIGTERM')?.();
        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(143));
        releaseWrite?.();

        await expect(writing).rejects.toThrow('ANALYSIS_V2_REPLAY_ARTIFACT_CREATION_INTERRUPTED');
        await expect(stat(keyPath)).rejects.toThrow();
        uninstall();
    });

    it('does not delete a raced bundle when exclusive creation returns EEXIST', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'analysis-v2-replay-'));
        temporaryPaths.push(directory);
        const keyPath = join(directory, 'race.key');
        const bundlePath = join(directory, 'race.enc');
        const ownedKey = await createReplayKeyFile(keyPath);
        await writeFile(bundlePath, 'raced bundle', { mode: 0o600 });

        await expect(writeReplayBundle({
            bundle: bundle(),
            bundlePath,
            keyPath,
            now: Date.parse('2026-07-27T00:10:00.000Z'),
        })).rejects.toMatchObject({ code: 'EEXIST' });
        await removeOwnedReplayArtifacts({ bundlePath, keyPath, ownedKey });

        await expect(readFile(bundlePath, 'utf8')).resolves.toBe('raced bundle');
        await expect(stat(keyPath)).rejects.toThrow();
    });

    it('does not delete a replacement inode using an ownership token for the original', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'analysis-v2-replay-'));
        temporaryPaths.push(directory);
        const keyPath = join(directory, 'race.key');
        const movedOwnedPath = join(directory, 'owned-away.key');
        const bundlePath = join(directory, 'race.enc');
        const ownedKey = await createReplayKeyFile(keyPath);
        await rename(keyPath, movedOwnedPath);
        await writeFile(keyPath, 'raced key', { mode: 0o600 });

        await removeOwnedReplayArtifacts({
            bundlePath,
            keyPath,
            ownedKey,
        });

        await expect(readFile(keyPath, 'utf8')).resolves.toBe('raced key');
    });

    it('restores a replacement swapped after identity validation instead of unlinking it', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'analysis-v2-replay-'));
        temporaryPaths.push(directory);
        const keyPath = join(directory, 'race-window.key');
        const movedOwnedPath = join(directory, 'owned-away.key');
        const bundlePath = join(directory, 'race-window.enc');
        const ownedKey = await createReplayKeyFile(keyPath);

        await removeOwnedReplayArtifacts({
            bundlePath,
            keyPath,
            ownedKey,
            beforeOwnedArtifactDelete: async path => {
                expect(path).toBe(keyPath);
                await rename(keyPath, movedOwnedPath);
                await writeFile(keyPath, 'post-validation replacement', { mode: 0o600 });
            },
        });

        await expect(readFile(keyPath, 'utf8')).resolves.toBe('post-validation replacement');
        await expect(stat(movedOwnedPath)).resolves.toBeDefined();
    });

    it('rejects an oversized encrypted artifact from fstat before reading bytes', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'analysis-v2-replay-'));
        temporaryPaths.push(directory);
        const keyPath = join(directory, 'oversized.key');
        const bundlePath = join(directory, 'oversized.enc');
        await createReplayKeyFile(keyPath);
        await writeFile(bundlePath, 'sparse', { mode: 0o600 });
        await truncate(bundlePath, 400 * 1024 * 1024);
        const readFileFromHandle = vi.fn(async () => Buffer.alloc(0));

        await expect(readAuthenticatedReplayBundle({
            bundlePath,
            keyPath,
            artifactRead: { readFile: readFileFromHandle },
        })).rejects.toThrow('ANALYSIS_V2_REPLAY_BUNDLE_LIMIT');
        expect(readFileFromHandle).not.toHaveBeenCalled();
    });

    it('removes an exact expired pair but preserves an unexpired pair', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'analysis-v2-replay-'));
        temporaryPaths.push(directory);
        const keyPath = join(directory, 'stale.key');
        const bundlePath = join(directory, 'stale.enc');
        await createReplayKeyFile(keyPath);
        await writeReplayBundle({
            bundle: bundle(),
            bundlePath,
            keyPath,
            now: Date.parse('2026-07-27T00:10:00.000Z'),
        });

        await expect(removeExpiredReplayArtifacts({
            bundlePath,
            keyPath,
            now: Date.parse('2026-07-27T00:20:00.000Z'),
        })).resolves.toBe(false);
        await expect(stat(bundlePath)).resolves.toBeDefined();
        await expect(removeExpiredReplayArtifacts({
            bundlePath,
            keyPath,
            now: Date.parse('2026-07-27T01:01:00.000Z'),
        })).resolves.toBe(true);
        await expect(stat(bundlePath)).rejects.toThrow();
        await expect(stat(keyPath)).rejects.toThrow();
    });

    it('preserves replacement inodes swapped in after an authenticated TTL read', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'analysis-v2-replay-'));
        temporaryPaths.push(directory);
        const keyPath = join(directory, 'stale.key');
        const bundlePath = join(directory, 'stale.enc');
        const originalKeyPath = join(directory, 'stale-original.key');
        const originalBundlePath = join(directory, 'stale-original.enc');
        await createReplayKeyFile(keyPath);
        await writeReplayBundle({
            bundle: bundle(),
            bundlePath,
            keyPath,
            now: Date.parse('2026-07-27T00:10:00.000Z'),
        });

        await expect(removeExpiredReplayArtifacts({
            bundlePath,
            keyPath,
            now: Date.parse('2026-07-27T01:01:00.000Z'),
            beforeOwnedArtifactRemoval: async () => {
                await rename(bundlePath, originalBundlePath);
                await rename(keyPath, originalKeyPath);
                await writeFile(bundlePath, 'replacement bundle', { mode: 0o600 });
                await writeFile(keyPath, 'replacement key', { mode: 0o600 });
            },
        })).resolves.toBe(true);

        await expect(readFile(bundlePath, 'utf8')).resolves.toBe('replacement bundle');
        await expect(readFile(keyPath, 'utf8')).resolves.toBe('replacement key');
    });
});
