import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    beginDevStandardArchivePreflight,
    captureDevStandardInput,
    currentDevStandardArchive,
    sealDevStandardArchive,
    withDevStandardArchiveApproval,
    withVerifiedDevStandardArchive,
} from '@/lib/services/dev-ui/standard-archive-runtime';
import { archiveMediaUrlAnchor } from '@/lib/services/dev-ui/standard-archive-media-identity';
import { devLiveStandardNeedsArchive, type DevLiveApproval } from '@/lib/services/dev-ui/live-approval';

const archive = vi.hoisted(() => ({
    objects: new Map<string, unknown>(),
    bindCapture: vi.fn(),
    seal: vi.fn(),
    readBinding: vi.fn(),
    readSeal: vi.fn(),
    verifyMembership: vi.fn(),
}));
vi.mock('@/lib/services/dev-ui/standard-archive-store', () => {
    const reader = {
        inputKeys(kind: string) {
            const prefix = `${kind}|`;
            return [...archive.objects.keys()].filter(key => key.startsWith(prefix))
                .map(key => key.slice(prefix.length));
        },
        async readFragment({ kind, inputKey }: { kind: string; inputKey: string }) {
            const key = `${kind}|${inputKey}`;
            return archive.objects.has(key) ? { value: archive.objects.get(key) } : null;
        },
    };
    return {
        createDevStandardArchiveStore: () => ({
            bindCapture: archive.bindCapture,
            readBinding: archive.readBinding,
            verifySealedMembership: archive.verifyMembership,
            async seal(validate: (view: typeof reader) => Promise<void>) {
                await validate(reader);
                await archive.seal();
            },
            async openSealedArchive() {
                const binding = await archive.readSeal();
                return binding ? { binding, ...reader } : null;
            },
            async writeFragment({ kind, inputKey, value }: { kind: string; inputKey: string; value: unknown }) {
                archive.objects.set(`${kind}|${inputKey}`, value);
            },
            ...reader,
        }),
    };
});

const approvedAt = new Date().toISOString();
const standard: DevLiveApproval = {
    planId: 'standard',
    id: '23bbecc3-1cb1-4f4b-aac9-3a1f703ac842',
    targetInstagramId: 'synthetic.qa',
    approvedAt,
    expiresAt: null,
    apifyMaxCents: 600,
    aiMaxCents: 1800,
    idempotencyKey: 'synthetic-key',
    nonce: 'synthetic-nonce',
};
const env = {
    DEV_LIVE_WORKLOAD: 'preflight',
    DEV_LIVE_ANALYSIS_ARMED: 'true',
    DEV_LIVE_ANALYSIS_MODE: 'owner_start',
    DEV_LIVE_STANDARD_TARGET: standard.targetInstagramId,
    DEV_LIVE_STANDARD_COLLECTION_MODE: 'archive_capture',
    DEV_LIVE_STANDARD_ARCHIVE_APPROVAL_NOT_BEFORE: approvedAt,
    DEV_LIVE_STANDARD_ARCHIVE_SLOT: '1'.repeat(32),
    DEV_LIVE_STANDARD_ARCHIVE_KEY: 'synthetic-key',
    DEV_LIVE_STANDARD_ARCHIVE_BUCKET: 'synthetic-dev-live-media',
};
const target = standard.targetInstagramId;

describe('Standard Dev archive scope and sealing', () => {
    beforeEach(() => {
        archive.objects.clear();
        vi.resetAllMocks();
    });

    it('keeps archive replay and incomplete capture config closed at the Dev entry gate', () => {
        expect(devLiveStandardNeedsArchive({})).toBe(true);
        expect(devLiveStandardNeedsArchive({ DEV_LIVE_STANDARD_COLLECTION_MODE: 'archive_replay' })).toBe(true);
        expect(devLiveStandardNeedsArchive({ DEV_LIVE_STANDARD_COLLECTION_MODE: 'archive_capture' })).toBe(true);
        expect(devLiveStandardNeedsArchive(env)).toBe(false);
        expect(devLiveStandardNeedsArchive({ DEV_LIVE_STANDARD_COLLECTION_MODE: 'live_apify' })).toBe(false);
    });

    it('blocks work before the callback when a configured capture cannot bind its single approval', async () => {
        archive.bindCapture.mockRejectedValueOnce(new Error('secret fixture'));
        const callback = vi.fn();
        await expect(withDevStandardArchiveApproval(standard, async () => {
            await beginDevStandardArchivePreflight();
            return callback();
        }, env)).rejects.toThrow('DEV_STANDARD_ARCHIVE_UNAVAILABLE');
        expect(callback).not.toHaveBeenCalled();
        expect(currentDevStandardArchive()).toBeNull();
    });

    it('never lets a pre-existing approval claim a new capture slot', async () => {
        const callback = vi.fn();
        const old = { ...standard, approvedAt: new Date(Date.parse(approvedAt) - 1000).toISOString() };
        await expect(withDevStandardArchiveApproval(old, callback, env))
            .rejects.toThrow('DEV_STANDARD_ARCHIVE_UNAVAILABLE');
        expect(archive.bindCapture).not.toHaveBeenCalled();
        expect(callback).not.toHaveBeenCalled();
    });

    it('seals only when all expected collection families and profile batches exist', async () => {
        await withDevStandardArchiveApproval(standard, async () => {
            expect(archive.bindCapture).not.toHaveBeenCalled();
            await beginDevStandardArchivePreflight();
            expect(archive.bindCapture).toHaveBeenCalledOnce();
        }, env);
        archive.readBinding.mockResolvedValue({
            grantId: standard.id,
            target,
            expiresAt: Date.parse(approvedAt) + 24 * 60 * 60_000,
        });
        await withDevStandardArchiveApproval(standard, async () => {
            const fragments: ReadonlyArray<readonly [string, readonly (string | number)[]]> = [
                ['preflight-profile-v1', [target]],
                ['fresh-profile-v1', [target]],
                ['relationship-side-v1', [target, 'followers', 0]],
                ['relationship-side-v1', [target, 'following', 0]],
                ['formal-target-profile-v1', [target]],
                ['target-evidence-v1', [target]],
                ['reverse-coverage-v1', [target]],
            ];
            for (const [kind, identity] of fragments) {
                await captureDevStandardInput(kind, identity, []);
            }
            await expect(sealDevStandardArchive({ profileBatches: [0] }))
                .rejects.toThrow('DEV_STANDARD_ARCHIVE_UNAVAILABLE');
            expect(archive.seal).not.toHaveBeenCalled();
            await captureDevStandardInput('candidate-profile-batch-v1', [target, 0, 'synthetic'], []);
            const proof = { providerOperationKey: 'sample-operation:123', providerInputHash: 'a'.repeat(64) };
            await captureDevStandardInput('source-profile-proof-v1', [target, 'track:target-evidence:collect'], proof);
            await captureDevStandardInput('source-profile-proof-v1', [target, 'track:profiles:batch:0'], proof);
            const targetImage = ['target', 'target', null] as const;
            await captureDevStandardInput('result-image-manifest-v1', [target], {
                expectedRows: 1,
                imageCount: 0,
                orderedManifestHash: 'a'.repeat(64),
                imageInputs: [targetImage],
            });
            await expect(sealDevStandardArchive({profileBatches: [0]}))
                .rejects.toThrow('DEV_STANDARD_ARCHIVE_UNAVAILABLE');
            await captureDevStandardInput('result-image-v1', targetImage, 'source_missing');
            const aiGroup = ['ai-stage-policy-v2.12', '1'.repeat(64)] as const;
            await captureDevStandardInput('ai-image-selection-v1', aiGroup, [[...aiGroup, 0]]);
            await expect(sealDevStandardArchive({ profileBatches: [0] }))
                .rejects.toThrow('DEV_STANDARD_ARCHIVE_UNAVAILABLE');
            await captureDevStandardInput('ai-image', [...aiGroup, 0], {
                status: 'failure', reason: 'unsupported_url', disposition: 'permanent',
            });
            await sealDevStandardArchive({ profileBatches: [0] });
            expect(archive.seal).toHaveBeenCalledOnce();
        }, { ...env, DEV_LIVE_WORKLOAD: 'paid' });
        expect(currentDevStandardArchive()).toBeNull();
        const replay = vi.fn();
        await expect(withVerifiedDevStandardArchive(target, replay, env))
            .rejects.toThrow('DEV_STANDARD_ARCHIVE_UNAVAILABLE');
        archive.readSeal.mockResolvedValue({ target });
        archive.verifyMembership.mockResolvedValue({ target });
        await expect(withVerifiedDevStandardArchive('different.qa', replay, env))
            .rejects.toThrow('DEV_STANDARD_ARCHIVE_UNAVAILABLE');
        expect(replay).not.toHaveBeenCalled();

        await withVerifiedDevStandardArchive(target, async coverage => {
            expect(coverage.profileBatches).toEqual([0]);
            expect(currentDevStandardArchive()?.mode).toBe('replay');
            await expect(currentDevStandardArchive()!.load('fresh-profile-v1', [target]))
                .resolves.toEqual([]);
            await expect(currentDevStandardArchive()!.load('candidate-profile-batch-v1', [target, 0, 'different']))
                .rejects.toThrow('DEV_STANDARD_ARCHIVE_UNAVAILABLE');
            await expect(currentDevStandardArchive()!.capture('fresh-profile-v1', [target], []))
                .rejects.toThrow('DEV_STANDARD_ARCHIVE_UNAVAILABLE');
        }, env);
        expect(currentDevStandardArchive()).toBeNull();
    });

    it('preserves exact image identity and video type without retaining URL path or query', () => {
        const source = 'https://scontent.cdninstagram.com/fixture-private-path/file.mp4?signature=fixture-secret';
        const anchor = archiveMediaUrlAnchor(source);
        expect(anchor).toMatch(/^https:\/\/scontent\.cdninstagram\.com\/.+\.mp4$/);
        expect(anchor).not.toContain('fixture');
        expect(archiveMediaUrlAnchor(anchor)).toBe(anchor);
        expect(archiveMediaUrlAnchor(source.replace('fixture-secret', 'other-fixture'))).not.toBe(anchor);
    });

    it('keeps ordinary execution independent of archive writes', async () => {
        await withDevStandardArchiveApproval(standard, async () => {
            await captureDevStandardInput('preflight-profile-v1', [target], []);
            await sealDevStandardArchive({ profileBatches: [] });
        }, { DEV_LIVE_STANDARD_COLLECTION_MODE: 'live_apify' });
        expect(archive.bindCapture).not.toHaveBeenCalled();
        expect(archive.seal).not.toHaveBeenCalled();
        expect(archive.objects.size).toBe(0);
    });
});
