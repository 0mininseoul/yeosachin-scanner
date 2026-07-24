import { describe, expect, it, vi } from 'vitest';
import {
    purgeConfiguredResultImages,
    RESULT_IMAGE_PURGE_CONCURRENCY,
    RESULT_IMAGE_PURGE_LEASE_SECONDS,
} from './result-image-purge';

const CLAIM_TOKEN = '123e4567-e89b-42d3-a456-426614174000';

function objectKey(index: number) {
    return `v1/${'a'.repeat(32)}/female/${index.toString(16).padStart(32, '0')}.webp`;
}

describe('retained result image purge', () => {
    it('does nothing when retained images are disabled', async () => {
        const claimPurge = vi.fn();

        await expect(purgeConfiguredResultImages({
            env: { ANALYSIS_V2_RESULT_IMAGES_ENABLED: 'false' },
            registry: {
                claimPurge,
                completePurge: vi.fn(),
            },
            writer: { delete: vi.fn() },
        })).resolves.toEqual({
            claimed: 0,
            deleted: 0,
            failed: 0,
            hasMore: false,
        });
        expect(claimPurge).not.toHaveBeenCalled();
    });

    it('deletes claimed keys idempotently before completing their rows', async () => {
        const calls: string[] = [];
        const registry = {
            claimPurge: vi.fn(async () => [
                { objectKey: objectKey(1), reason: 'owner_delete' as const },
                { objectKey: objectKey(2), reason: 'expired' as const },
            ]),
            completePurge: vi.fn(async (input: {
                objectKey: string;
            }) => {
                calls.push(`complete:${input.objectKey}`);
                return true;
            }),
        };
        const writer = {
            delete: vi.fn(async (key: string) => {
                calls.push(`delete:${key}`);
            }),
        };

        await expect(purgeConfiguredResultImages({
            env: { ANALYSIS_V2_RESULT_IMAGES_ENABLED: 'true' },
            registry,
            writer,
            claimToken: () => CLAIM_TOKEN,
            limit: 10,
            concurrency: 2,
        })).resolves.toEqual({
            claimed: 2,
            deleted: 2,
            failed: 0,
            hasMore: false,
        });
        expect(registry.claimPurge).toHaveBeenCalledWith({
            claimToken: CLAIM_TOKEN,
            limit: 10,
            leaseSeconds: RESULT_IMAGE_PURGE_LEASE_SECONDS,
        });
        for (const index of [1, 2]) {
            expect(calls.indexOf(`delete:${objectKey(index)}`)).toBeLessThan(
                calls.indexOf(`complete:${objectKey(index)}`)
            );
        }
    });

    it('leaves failed or lost-lease rows retryable and reports saturation', async () => {
        const claims = Array.from({ length: 3 }, (_, index) => ({
            objectKey: objectKey(index + 1),
            reason: 'expired' as const,
        }));
        const registry = {
            claimPurge: vi.fn(async () => claims),
            completePurge: vi.fn(async (input: {
                objectKey: string;
            }) => input.objectKey !== objectKey(2)),
        };

        await expect(purgeConfiguredResultImages({
            env: { ANALYSIS_V2_RESULT_IMAGES_ENABLED: 'true' },
            registry,
            writer: {
                delete: vi.fn(async key => {
                    if (key === objectKey(3)) throw new Error('redacted');
                }),
            },
            claimToken: () => CLAIM_TOKEN,
            limit: 3,
        })).resolves.toEqual({
            claimed: 3,
            deleted: 1,
            failed: 2,
            hasMore: true,
        });
        expect(registry.completePurge).toHaveBeenCalledTimes(2);
    });

    it('bounds concurrency and rejects malformed runtime settings', async () => {
        const claims = Array.from({ length: 40 }, (_, index) => ({
            objectKey: objectKey(index + 1),
            reason: 'expired' as const,
        }));
        let active = 0;
        let maximum = 0;
        const registry = {
            claimPurge: vi.fn(async () => claims),
            completePurge: vi.fn(async () => true),
        };
        await purgeConfiguredResultImages({
            env: { ANALYSIS_V2_RESULT_IMAGES_ENABLED: 'true' },
            registry,
            writer: {
                async delete() {
                    active += 1;
                    maximum = Math.max(maximum, active);
                    await Promise.resolve();
                    active -= 1;
                },
            },
            claimToken: () => CLAIM_TOKEN,
            limit: 40,
            concurrency: RESULT_IMAGE_PURGE_CONCURRENCY,
        });
        expect(maximum).toBeLessThanOrEqual(
            RESULT_IMAGE_PURGE_CONCURRENCY
        );

        await expect(purgeConfiguredResultImages({
            env: { ANALYSIS_V2_RESULT_IMAGES_ENABLED: 'yes' },
        })).rejects.toThrow('RESULT_IMAGE_PURGE_INVALID_CONFIGURATION');
    });
});
