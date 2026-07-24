import { describe, expect, it, vi } from 'vitest';
import {
    resolveAnalysisV2ResultImageLocator,
    RESULT_IMAGE_OBJECT_RPC,
    type ResultImageResolverClient,
} from './result-image-resolver';

const LOCATOR = {
    requestId: '123e4567-e89b-42d3-a456-426614174000',
    kind: 'female' as const,
    candidateId: 'candidate:one',
};
const USER_ID = '223e4567-e89b-42d3-a456-426614174000';
const OBJECT_KEY = `v1/${'a'.repeat(32)}/female/${'b'.repeat(32)}.webp`;
const SHA256 = 'c'.repeat(64);
const NOW = Date.parse('2026-07-24T05:00:00.000Z');
const EXPIRES = '2026-08-23T05:00:00.000Z';

function client(response: { data: unknown; error: unknown }) {
    return {
        rpc: vi.fn(async () => response),
    } as unknown as ResultImageResolverClient & {
        rpc: ReturnType<typeof vi.fn>;
    };
}

describe('resolveAnalysisV2ResultImageLocator', () => {
    it('keeps the owner-bound legacy URL reader while the flag is disabled', async () => {
        const database = client({
            data: 'https://cdninstagram.com/profile.jpg?z=2&a=1',
            error: null,
        });

        await expect(resolveAnalysisV2ResultImageLocator(
            LOCATOR,
            USER_ID,
            {
                client: database,
                env: { ANALYSIS_V2_RESULT_IMAGES_ENABLED: 'false' },
                now: () => NOW,
            }
        )).resolves.toEqual({
            source: 'legacy_url',
            url: 'https://cdninstagram.com/profile.jpg?a=1&z=2',
        });
    });

    it('returns only validated ready R2 metadata for the exact owner', async () => {
        const database = client({
            data: {
                objectKey: OBJECT_KEY,
                sha256: SHA256,
                byteSize: 1234,
                expiresAt: EXPIRES,
            },
            error: null,
        });

        await expect(resolveAnalysisV2ResultImageLocator(
            LOCATOR,
            USER_ID,
            {
                client: database,
                env: { ANALYSIS_V2_RESULT_IMAGES_ENABLED: 'true' },
                now: () => NOW,
            }
        )).resolves.toEqual({
            source: 'r2',
            objectKey: OBJECT_KEY,
            sha256: SHA256,
            byteSize: 1234,
            expiresAt: EXPIRES,
        });
        expect(database.rpc).toHaveBeenCalledWith(
            RESULT_IMAGE_OBJECT_RPC,
            {
                p_request_id: LOCATOR.requestId,
                p_user_id: USER_ID,
                p_kind: 'female',
                p_candidate_id: 'candidate:one',
            }
        );
    });

    it('denies exact expiry, non-owner/deleted rows, and malformed metadata', async () => {
        const expired = client({
            data: {
                objectKey: OBJECT_KEY,
                sha256: SHA256,
                byteSize: 1234,
                expiresAt: new Date(NOW).toISOString(),
            },
            error: null,
        });
        await expect(resolveAnalysisV2ResultImageLocator(
            LOCATOR,
            USER_ID,
            {
                client: expired,
                env: { ANALYSIS_V2_RESULT_IMAGES_ENABLED: 'true' },
                now: () => NOW,
            }
        )).resolves.toBeNull();

        for (const data of [
            null,
            {
                objectKey: 'https://bucket.example/private.webp',
                sha256: SHA256,
                byteSize: 1234,
                expiresAt: EXPIRES,
            },
            {
                objectKey: OBJECT_KEY,
                sha256: SHA256,
                byteSize: 131_073,
                expiresAt: EXPIRES,
            },
        ]) {
            await expect(resolveAnalysisV2ResultImageLocator(
                LOCATOR,
                USER_ID,
                {
                    client: client({ data, error: null }),
                    env: {
                        ANALYSIS_V2_RESULT_IMAGES_ENABLED: 'true',
                    },
                    now: () => NOW,
                }
            )).resolves.toBeNull();
        }
    });

    it('fails closed on invalid flag values without querying storage', async () => {
        const database = client({ data: null, error: null });
        await expect(resolveAnalysisV2ResultImageLocator(
            LOCATOR,
            USER_ID,
            {
                client: database,
                env: { ANALYSIS_V2_RESULT_IMAGES_ENABLED: '1' },
                now: () => NOW,
            }
        )).resolves.toBeNull();
        expect(database.rpc).not.toHaveBeenCalled();
    });
});
