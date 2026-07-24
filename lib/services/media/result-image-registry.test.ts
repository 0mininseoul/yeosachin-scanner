import { describe, expect, it, vi } from 'vitest';
import {
    createResultImageRegistry,
    RESULT_IMAGE_REGISTRY_RPC,
} from './result-image-registry';

const CLAIM = {
    requestId: '123e4567-e89b-42d3-a456-426614174000',
    jobKey: 'coordinator:finalize',
    claimToken: '223e4567-e89b-42d3-a456-426614174000',
    jobInputHash: 'a'.repeat(64),
};
const MANIFEST_HASH = 'b'.repeat(64);
const SOURCE_HASH = 'c'.repeat(64);
const IMAGE_HASH = 'd'.repeat(64);

function rpcClient(...responses: Array<{
    data: unknown;
    error: { code?: string; message?: string } | null;
}>) {
    return {
        rpc: vi.fn(async () => responses.shift() ?? { data: null, error: null }),
    };
}

describe('result image registry RPC adapter', () => {
    it('begins, registers, loads, and seals an exact manifest', async () => {
        const outcome = {
            kind: 'target' as const,
            candidateLocator: 'target',
            sortOrdinal: 0,
            sourceFingerprint: SOURCE_HASH,
            status: 'ready' as const,
            objectKey: `v1/${'1'.repeat(32)}/target/${'2'.repeat(32)}.webp`,
            sha256: IMAGE_HASH,
            byteSize: 1024,
            capturedAt: '2026-07-24T05:00:00.000Z',
            expiresAt: '2026-08-23T05:00:00.000Z',
            failureCode: null,
            isMandatory: true,
        };
        const client = rpcClient(
            {
                data: {
                    requestId: CLAIM.requestId,
                    orderedManifestHash: MANIFEST_HASH,
                    expectedRows: 1,
                    sealed: false,
                },
                error: null,
            },
            { data: { registered: true, status: 'ready' }, error: null },
            { data: [outcome], error: null },
            {
                data: {
                    orderedManifestHash: MANIFEST_HASH,
                    expectedRows: 1,
                    durableRows: 1,
                    sourcedImages: 1,
                    readyImages: 1,
                    captureFailedImages: 0,
                },
                error: null,
            }
        );
        const registry = createResultImageRegistry(client);

        await registry.beginManifest({
            ...CLAIM,
            orderedManifestHash: MANIFEST_HASH,
            expectedRows: 1,
        });
        await registry.registerOutcome({ ...CLAIM, outcome });
        await expect(registry.loadManifestPage({
            ...CLAIM,
            afterOrdinal: -1,
            pageSize: 100,
        })).resolves.toEqual([outcome]);
        await expect(registry.sealManifest({
            ...CLAIM,
            orderedManifestHash: MANIFEST_HASH,
        })).resolves.toMatchObject({
            durableRows: 1,
            readyImages: 1,
        });

        expect(client.rpc).toHaveBeenNthCalledWith(
            1,
            RESULT_IMAGE_REGISTRY_RPC.begin,
            {
                p_request_id: CLAIM.requestId,
                p_job_key: CLAIM.jobKey,
                p_claim_token: CLAIM.claimToken,
                p_job_input_hash: CLAIM.jobInputHash,
                p_ordered_manifest_hash: MANIFEST_HASH,
                p_expected_rows: 1,
            }
        );
        expect(client.rpc).toHaveBeenNthCalledWith(
            2,
            RESULT_IMAGE_REGISTRY_RPC.register,
            expect.objectContaining({ p_outcome: outcome })
        );
    });

    it('claims and completes bounded purge work', async () => {
        const purgeClaim = {
            objectKey: `v1/${'1'.repeat(32)}/female/${'2'.repeat(32)}.webp`,
            reason: 'expired',
        };
        const client = rpcClient(
            { data: [purgeClaim], error: null },
            { data: true, error: null }
        );
        const registry = createResultImageRegistry(client);

        await expect(registry.claimPurge({
            claimToken: CLAIM.claimToken,
            limit: 10,
            leaseSeconds: 120,
        })).resolves.toEqual([purgeClaim]);
        await expect(registry.completePurge({
            objectKey: purgeClaim.objectKey,
            claimToken: CLAIM.claimToken,
            deleted: true,
        })).resolves.toBe(true);
    });

    it('rejects malformed database payloads and redacts RPC errors', async () => {
        const malformed = createResultImageRegistry(rpcClient({
            data: [{ objectKey: 'https://bucket.example/secret' }],
            error: null,
        }));
        await expect(malformed.claimPurge({
            claimToken: CLAIM.claimToken,
            limit: 1,
            leaseSeconds: 30,
        })).rejects.toThrow('RESULT_IMAGE_REGISTRY_INVALID_RESPONSE');

        const failed = createResultImageRegistry(rpcClient({
            data: null,
            error: {
                message: 'https://database.example secret-object-key',
                code: 'P0001',
            },
        }));
        let message = '';
        try {
            await failed.beginManifest({
                ...CLAIM,
                orderedManifestHash: MANIFEST_HASH,
                expectedRows: 1,
            });
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toBe('RESULT_IMAGE_REGISTRY_OPERATION_FAILED');
        expect(message).not.toContain('database.example');
        expect(message).not.toContain('secret-object-key');
    });
});
