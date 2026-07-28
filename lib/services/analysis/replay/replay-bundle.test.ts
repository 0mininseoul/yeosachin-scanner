import { mkdtemp, chmod, readFile, rename, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
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
    replayBundleSizeLimits,
    type AnalysisV2ReplayBundle,
} from './replay-bundle';
import { installReplayArtifactSignalCleanup } from './replay-artifact-lifecycle';
import { historicalPartialSourceUniverseDigest } from './historical-partial-available-artifact';
import { HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V211_CAPABILITY } from './replay-source-lineage';

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

function partialBundle(): AnalysisV2ReplayBundle {
    const base = bundle();
    const sourceIdentities = [{ ordinal: 1, username: 'example', partition: 'public' as const }];
    return {
        ...base,
        schemaVersion: 2,
        capture: {
            ...base.capture,
            scope: 'ai-only-historical-partial-available', notExact: true,
            fullE2eEvidence: false, noMediaSubstitution: true,
            sourceLineage: { selectedPlanId: 'standard', policyVersions: { pipeline: 'v2', aiStage: 'ai-stage-policy-v2.7', risk: 'risk-policy-v2.3' } },
            evaluationPolicy: { capability: 'historical-partial-available-standard-v27-risk-v23-to-ai-v29', aiStage: 'ai-stage-policy-v2.9' },
            partial: { sourceUniverseDigest: historicalPartialSourceUniverseDigest(sourceIdentities), sourceIdentities, mediaUnavailable: [] },
        },
    };
}

async function writeRawEncrypted(bundlePath: string, keyPath: string, value: unknown) {
    const key = await readFile(keyPath);
    const payload = Buffer.from(JSON.stringify(value));
    const aadValue = value as { schemaVersion: number; capture: { requestFingerprint: string; sourceLineage: unknown; evaluationPolicy?: unknown } };
    const aad = Buffer.from(JSON.stringify({ schemaVersion: aadValue.schemaVersion, requestFingerprint: aadValue.capture.requestFingerprint, sourceLineage: aadValue.capture.sourceLineage, evaluationPolicy: aadValue.capture.evaluationPolicy ?? null }));
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    await writeFile(bundlePath, JSON.stringify({ v: 2, aad: aad.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'), sha256: createHash('sha256').update(payload).digest('hex') }), { mode: 0o600 });
}

describe('analysis V2 replay bundle', () => {
    it('keeps exact limits frozen while bounding the measured partial artifact with narrow headroom', () => {
        expect(replayBundleSizeLimits(1)).toEqual({
            maxMediaBytes: 192 * 1024 * 1024,
            maxPlaintextBytes: 256 * 1024 * 1024,
        });
        const partial = replayBundleSizeLimits(2);
        expect(partial).toEqual({
            maxMediaBytes: 208 * 1024 * 1024,
            maxPlaintextBytes: 272 * 1024 * 1024,
        });
        expect(partial.maxMediaBytes).toBeGreaterThan(204_053_284);
        expect(partial.maxPlaintextBytes).toBeGreaterThan(273_704_429);
    });

    it('seals evaluation capabilities to their artifact schema at write', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'analysis-v2-replay-'));
        temporaryPaths.push(directory);
        const keyPath = join(directory, 'key.key'); await createReplayKeyFile(keyPath);
        const invalid = [
            { ...bundle(), capture: { ...bundle().capture, evaluationPolicy: { capability: 'historical-partial-available-standard-v27-risk-v23-to-ai-v29', aiStage: 'ai-stage-policy-v2.9' } } },
            { ...bundle(), capture: { ...bundle().capture, evaluationPolicy: { capability: 'historical-partial-available-standard-v27-risk-v23-to-ai-v210', aiStage: 'ai-stage-policy-v2.10' } } },
            { ...partialBundle(), capture: { ...partialBundle().capture, evaluationPolicy: undefined } },
            { ...partialBundle(), capture: { ...partialBundle().capture, evaluationPolicy: { capability: 'historical-official-e2e-standard-v27-risk-v23-to-ai-v29', aiStage: 'ai-stage-policy-v2.9' } } },
        ];
        for (const [index, value] of invalid.entries()) {
            await expect(writeReplayBundle({ bundle: value as AnalysisV2ReplayBundle, bundlePath: join(directory, `${index}.enc`), keyPath, now: Date.parse('2026-07-27T00:10:00.000Z') })).rejects.toThrow('ANALYSIS_V2_REPLAY_BUNDLE_INVALID');
        }
    });

    it('authenticates a distinct v2.10 evaluation in a sealed schema-v2 bundle', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'analysis-v2-replay-'));
        temporaryPaths.push(directory);
        const keyPath = join(directory, 'key.key');
        const bundlePath = join(directory, 'partial-v210.enc');
        await createReplayKeyFile(keyPath);
        const value = {
            ...partialBundle(),
            capture: {
                ...partialBundle().capture,
                evaluationPolicy: {
                    capability: 'historical-partial-available-standard-v27-risk-v23-to-ai-v210',
                    aiStage: 'ai-stage-policy-v2.10',
                },
                partial: (() => {
                    const sourceIdentities = [
                        { ordinal: 1, username: 'example', partition: 'public' as const },
                        { ordinal: 2, username: 'unavailable', partition: 'public' as const },
                    ];
                    return {
                        sourceUniverseDigest: historicalPartialSourceUniverseDigest(sourceIdentities),
                        sourceIdentities,
                        mediaUnavailable: [{
                            ordinal: 2,
                            terminal: 'media_unavailable' as const,
                            selectedMediaCount: 3,
                            triageFailures: 1,
                            featureFailures: 1,
                            reasons: ['source_missing'],
                        }],
                    };
                })(),
            },
        } as AnalysisV2ReplayBundle;

        await writeReplayBundle({
            bundle: value,
            bundlePath,
            keyPath,
            now: Date.parse('2026-07-27T00:10:00.000Z'),
        });
        await expect(readAuthenticatedReplayBundle({
            bundlePath,
            keyPath,
            now: Date.parse('2026-07-27T00:20:00.000Z'),
        })).resolves.toMatchObject({
            bundle: {
                schemaVersion: 2,
                capture: {
                    scope: 'ai-only-historical-partial-available',
                    notExact: true,
                    fullE2eEvidence: false,
                    noMediaSubstitution: true,
                    evaluationPolicy: {
                        capability: 'historical-partial-available-standard-v27-risk-v23-to-ai-v210',
                        aiStage: 'ai-stage-policy-v2.10',
                    },
                    partial: {
                        mediaUnavailable: [{ selectedMediaCount: 3 }],
                    },
                },
            },
        });
    });

    it('authenticates the exact v2.11 gender-quality capability in a sealed schema-v2 bundle', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'analysis-v2-replay-'));
        temporaryPaths.push(directory);
        const keyPath = join(directory, 'key.key');
        const bundlePath = join(directory, 'partial-v211.enc');
        await createReplayKeyFile(keyPath);
        const value = {
            ...partialBundle(),
            capture: {
                ...partialBundle().capture,
                evaluationPolicy: {
                    capability: HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V211_CAPABILITY,
                    aiStage: 'ai-stage-policy-v2.11',
                },
            },
        } as AnalysisV2ReplayBundle;

        await writeReplayBundle({
            bundle: value,
            bundlePath,
            keyPath,
            now: Date.parse('2026-07-27T00:10:00.000Z'),
        });
        await expect(readAuthenticatedReplayBundle({
            bundlePath,
            keyPath,
            now: Date.parse('2026-07-27T00:20:00.000Z'),
        })).resolves.toMatchObject({
            bundle: {
                schemaVersion: 2,
                capture: {
                    evaluationPolicy: {
                        capability: HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V211_CAPABILITY,
                        aiStage: 'ai-stage-policy-v2.11',
                    },
                },
            },
        });
    });

    it('rejects cross-version capabilities again while reading authenticated plaintext', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'analysis-v2-replay-'));
        temporaryPaths.push(directory);
        const keyPath = join(directory, 'key.key'); const bundlePath = join(directory, 'invalid.enc');
        await createReplayKeyFile(keyPath);
        const invalid = { ...partialBundle(), capture: { ...partialBundle().capture, evaluationPolicy: undefined } };
        await writeRawEncrypted(bundlePath, keyPath, invalid);
        await expect(readReplayBundle({ bundlePath, keyPath, now: Date.parse('2026-07-27T00:10:00.000Z') })).rejects.toThrow('ANALYSIS_V2_REPLAY_BUNDLE_INVALID');
    });

    it('rejects duplicate or overlapping partial ordinals at the artifact boundary', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'analysis-v2-replay-'));
        temporaryPaths.push(directory);
        const keyPath = join(directory, 'key.key'); await createReplayKeyFile(keyPath);
        const base = partialBundle() as Extract<AnalysisV2ReplayBundle, { schemaVersion: 2 }>;
        const invalid = { ...base, capture: { ...base.capture, partial: { ...base.capture.partial!, mediaUnavailable: [{ ordinal: 1, terminal: 'media_unavailable' as const, triageFailures: 0, featureFailures: 0, reasons: ['profile_unavailable'] }] } } };
        await expect(writeReplayBundle({ bundle: invalid as AnalysisV2ReplayBundle, bundlePath: join(directory, 'overlap.enc'), keyPath, now: Date.parse('2026-07-27T00:10:00.000Z') })).rejects.toThrow('ANALYSIS_V2_REPLAY_BUNDLE_INVALID');
    });

    it('rejects duplicate normalized usernames across retained and terminal identities at write and read', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'analysis-v2-replay-'));
        temporaryPaths.push(directory);
        const keyPath = join(directory, 'key.key'); await createReplayKeyFile(keyPath);
        const base = partialBundle() as Extract<AnalysisV2ReplayBundle, { schemaVersion: 2 }>;
        const sourceIdentities = [
            { ordinal: 1, username: 'example', partition: 'public' as const },
            { ordinal: 9, username: 'EXAMPLE', partition: 'fetch_terminal' as const },
        ];
        const invalid = { ...base, capture: { ...base.capture, partial: {
            ...base.capture.partial,
            sourceIdentities,
            sourceUniverseDigest: historicalPartialSourceUniverseDigest(sourceIdentities),
        } } };
        await expect(writeReplayBundle({ bundle: invalid as AnalysisV2ReplayBundle, bundlePath: join(directory, 'write.enc'), keyPath, now: Date.parse('2026-07-27T00:10:00.000Z') })).rejects.toThrow('ANALYSIS_V2_REPLAY_BUNDLE_INVALID');
        const readPath = join(directory, 'read.enc'); await writeRawEncrypted(readPath, keyPath, invalid);
        await expect(readReplayBundle({ bundlePath: readPath, keyPath, now: Date.parse('2026-07-27T00:10:00.000Z') })).rejects.toThrow('ANALYSIS_V2_REPLAY_BUNDLE_INVALID');
    });

    it.each([
        (base: Extract<AnalysisV2ReplayBundle, { schemaVersion: 2 }>) => base.capture.partial.sourceIdentities.slice(0, 0),
        (base: Extract<AnalysisV2ReplayBundle, { schemaVersion: 2 }>) => base.capture.partial.sourceIdentities.map(identity => ({ ...identity, partition: 'private' as const })),
    ])('rejects missing or mismatched identity accounting with a recomputed digest at write and read %#', async mutate => {
        const directory = await mkdtemp(join(tmpdir(), 'analysis-v2-replay-'));
        temporaryPaths.push(directory);
        const keyPath = join(directory, 'key.key'); await createReplayKeyFile(keyPath);
        const base = partialBundle() as Extract<AnalysisV2ReplayBundle, { schemaVersion: 2 }>;
        const sourceIdentities = mutate(base);
        const invalid = { ...base, capture: { ...base.capture, partial: {
            ...base.capture.partial,
            sourceIdentities,
            sourceUniverseDigest: historicalPartialSourceUniverseDigest(sourceIdentities),
        } } };
        await expect(writeReplayBundle({ bundle: invalid, bundlePath: join(directory, 'account-write.enc'), keyPath, now: Date.parse('2026-07-27T00:10:00.000Z') })).rejects.toThrow('ANALYSIS_V2_REPLAY_BUNDLE_INVALID');
        const readPath = join(directory, 'account-read.enc'); await writeRawEncrypted(readPath, keyPath, invalid);
        await expect(readReplayBundle({ bundlePath: readPath, keyPath, now: Date.parse('2026-07-27T00:10:00.000Z') })).rejects.toThrow('ANALYSIS_V2_REPLAY_BUNDLE_INVALID');
    });

    it('rejects a source universe digest that does not authenticate canonical identities at write and read', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'analysis-v2-replay-'));
        temporaryPaths.push(directory);
        const keyPath = join(directory, 'key.key'); await createReplayKeyFile(keyPath);
        const base = partialBundle() as Extract<AnalysisV2ReplayBundle, { schemaVersion: 2 }>;
        const invalid = { ...base, capture: { ...base.capture, partial: { ...base.capture.partial, sourceUniverseDigest: '0'.repeat(64) } } };
        await expect(writeReplayBundle({ bundle: invalid, bundlePath: join(directory, 'digest-write.enc'), keyPath, now: Date.parse('2026-07-27T00:10:00.000Z') })).rejects.toThrow('ANALYSIS_V2_REPLAY_BUNDLE_INVALID');
        const readPath = join(directory, 'digest-read.enc'); await writeRawEncrypted(readPath, keyPath, invalid);
        await expect(readReplayBundle({ bundlePath: readPath, keyPath, now: Date.parse('2026-07-27T00:10:00.000Z') })).rejects.toThrow('ANALYSIS_V2_REPLAY_BUNDLE_INVALID');
    });

    it('accepts the complete canonical feature set for deferred resolver projection', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'analysis-v2-replay-'));
        temporaryPaths.push(directory);
        const keyPath = join(directory, 'key.key'); const bundlePath = join(directory, 'resolver.enc');
        await createReplayKeyFile(keyPath);
        const base = partialBundle() as Extract<AnalysisV2ReplayBundle, { schemaVersion: 2 }>;
        const media = Array.from({ length: 10 }, (_, index) => ({
            selectionId: `media-${index}`, kind: 'feed' as const,
            jpegBase64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
        }));
        const value: Extract<AnalysisV2ReplayBundle, { schemaVersion: 2 }> = {
            ...base,
            profiles: [{ ...base.profiles[0]!, media, triageSelectionIds: media.slice(0, 5).map(item => item.selectionId), featureSelectionIds: media.map(item => item.selectionId), resolverSelectionIds: media.map(item => item.selectionId), coverage: { selectedCount: 10, normalizedCount: 10, failures: [] } }],
        };
        await expect(writeReplayBundle({ bundle: value, bundlePath, keyPath, now: Date.parse('2026-07-27T00:10:00.000Z') })).resolves.toBeDefined();
        await expect(readReplayBundle({ bundlePath, keyPath, now: Date.parse('2026-07-27T00:20:00.000Z') })).resolves.toEqual(value);
    });
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
        const value = {
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
        } as AnalysisV2ReplayBundle;
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
