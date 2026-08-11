import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { SecureImageDownload } from '@/lib/services/media/secure-image-fetch';
import {
    REVENUE_GENDER_ROUTING_IMAGE_MAX_BYTES,
    REVENUE_GENDER_ROUTING_IMAGE_MAX_CONCURRENCY,
    REVENUE_GENDER_ROUTING_IMAGE_MAX_REDIRECTS,
    REVENUE_GENDER_ROUTING_IMAGE_TIMEOUT_MS,
    createRevenueGenderRoutingInputPreparer,
} from './revenue-gender-routing-input-preparer';
import type { GenderRoutingAssessment } from './gender-routing';
import {
    routeRevenueGenderCandidates,
    type RevenueGenderRoutingModelCandidate,
} from './revenue-routing-runtime';

const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
);

const source = (
    candidateKey: string,
    profilePicUrl: string | null,
    fullname: string | null = '  A\u030Ada  ',
) => ({
    candidateKey,
    profilePicUrl,
    fullname,
});

function downloaded(bytes = png): SecureImageDownload {
    return {
        bytes,
        contentType: 'image/png',
        finalUrl: 'https://scontent.cdninstagram.com/opaque',
    };
}

describe('revenue gender-routing input preparer', () => {
    it('deduplicates exact request-local URLs while preserving input key and order', async () => {
        const download = vi.fn(async () => downloaded());
        const normalize = vi.fn(async (bytes: Buffer) => Buffer.from(bytes));
        const prepare = createRevenueGenderRoutingInputPreparer({ download, normalize });

        const output = await prepare([
            source('candidate:2', 'https://scontent.cdninstagram.com/a.jpg'),
            source('candidate:1', 'https://scontent.cdninstagram.com/a.jpg', 'Name'),
            source('candidate:3', null, null),
        ]);

        expect(download).toHaveBeenCalledTimes(1);
        expect(normalize).toHaveBeenCalledTimes(1);
        expect(output.map(candidate => candidate.candidateKey)).toEqual([
            'candidate:2', 'candidate:1', 'candidate:3',
        ]);
        expect(output.map(candidate => candidate.fullname)).toEqual(['  A\u030Ada  ', 'Name', null]);
        expect(output[0].imageBytes).toBe(output[1].imageBytes);
        expect(output[2].imageBytes).toBeNull();
    });

    it('uses the approved secure transport bounds and actual-image allowlist', async () => {
        const download = vi.fn(async () => downloaded());
        const prepare = createRevenueGenderRoutingInputPreparer({
            download,
            normalize: async bytes => Buffer.from(bytes),
        });

        const [output] = await prepare([source(
            'candidate:1',
            'https://scontent.cdninstagram.com/a.jpg',
        )]);

        expect(download).toHaveBeenCalledWith(
            'https://scontent.cdninstagram.com/a.jpg',
            expect.objectContaining({
                maxBytes: REVENUE_GENDER_ROUTING_IMAGE_MAX_BYTES,
                timeoutMs: REVENUE_GENDER_ROUTING_IMAGE_TIMEOUT_MS,
                maxRedirects: REVENUE_GENDER_ROUTING_IMAGE_MAX_REDIRECTS,
                headers: { Accept: 'image/jpeg,image/png,image/webp' },
            }),
        );
        expect(Buffer.compare(Buffer.from(output.imageBytes!), png)).toBe(0);
    });

    it('degrades malformed, failed, decoded-invalid, and over-limit images without logging raw values', async () => {
        const rawError = new Error('https://scontent.cdninstagram.com/private?secret=raw');
        const download = vi.fn(async (url: string) => {
            if (url.endsWith('/failure')) throw rawError;
            if (url.endsWith('/malformed')) return downloaded(Buffer.from('not an image'));
            if (url.endsWith('/oversize')) return downloaded(Buffer.alloc(
                REVENUE_GENDER_ROUTING_IMAGE_MAX_BYTES + 1,
            ));
            if (url.endsWith('/decode')) return downloaded(Buffer.concat([png, Buffer.from([0]) ]));
            return downloaded();
        });
        const normalize = vi.fn(async (bytes: Buffer) => bytes.equals(png)
            ? Buffer.alloc(REVENUE_GENDER_ROUTING_IMAGE_MAX_BYTES + 1)
            : bytes.length === png.length + 1
                ? Promise.reject(rawError)
                : bytes);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const prepare = createRevenueGenderRoutingInputPreparer({ download, normalize });

        const output = await prepare([
            source('candidate:1', 'https://scontent.cdninstagram.com/failure', 'Raw Name'),
            source('candidate:2', 'https://scontent.cdninstagram.com/malformed', 'Raw Name'),
            source('candidate:3', 'https://scontent.cdninstagram.com/oversize', 'Raw Name'),
            source('candidate:4', 'https://scontent.cdninstagram.com/final-oversize', 'Raw Name'),
            source('candidate:5', 'https://scontent.cdninstagram.com/decode', 'Raw Name'),
            source('candidate:6', '   ', 'Raw Name'),
        ]);

        expect(output.map(candidate => candidate.imageBytes)).toEqual([null, null, null, null, null, null]);
        expect(output.map(candidate => candidate.fullname)).toEqual([
            'Raw Name', 'Raw Name', 'Raw Name', 'Raw Name', 'Raw Name', 'Raw Name',
        ]);
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it('never emits fields other than the permitted candidate key, fullname, and normalized bytes', async () => {
        const prepare = createRevenueGenderRoutingInputPreparer({
            download: async () => downloaded(),
            normalize: async bytes => bytes,
        });
        const input = {
            ...source('candidate:1', 'https://scontent.cdninstagram.com/a.jpg', 'Raw Name'),
            username: 'forbidden-username',
            bio: 'forbidden bio',
        };

        const [output] = await prepare([input]);

        expect(Object.keys(output).sort()).toEqual(['candidateKey', 'fullname', 'imageBytes']);
        expect(JSON.stringify(output)).not.toContain('forbidden');
        expect(JSON.stringify(output)).not.toContain('cdninstagram');
    });

    it('hands deterministic normalized bytes to the existing image-content HMAC/model seam', async () => {
        const prepare = createRevenueGenderRoutingInputPreparer({
            download: async () => downloaded(),
            normalize: async bytes => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), bytes]),
        });
        const assess = vi.fn(async (
            candidates: readonly RevenueGenderRoutingModelCandidate[],
        ): Promise<ReadonlyMap<string, GenderRoutingAssessment>> => new Map(candidates.map(candidate => [
            candidate.candidateKey,
            {
                femaleScore: 0.8,
                maleScore: 0.1,
                uncertaintyScore: 0.1,
                evidence: 'image_and_name' as const,
            },
        ])));
        const candidates = Array.from({ length: 101 }, (_, index) => source(
            `candidate:${index + 1}`,
            'https://scontent.cdninstagram.com/shared.jpg',
            '  A\u030Ada  ',
        )).map((candidate, index) => ({ ...candidate, mutualOrdinal: index + 1 }));

        const first = await routeRevenueGenderCandidates({
            requestId: '123e4567-e89b-42d3-a456-426614174000',
            relationshipCheckpointId: 'checkpoint',
            accessMode: 'test_entitlement',
            planId: 'basic',
            candidates,
            hmacSecret: 'revenue-routing-input-preparer-test-secret',
            inputPreparer: prepare,
            assess,
        });
        const second = await routeRevenueGenderCandidates({
            requestId: '123e4567-e89b-42d3-a456-426614174000',
            relationshipCheckpointId: 'checkpoint',
            accessMode: 'test_entitlement',
            planId: 'basic',
            candidates,
            hmacSecret: 'revenue-routing-input-preparer-test-secret',
            inputPreparer: prepare,
            assess,
        });

        const imageBase64 = assess.mock.calls[0]?.[0][0]?.imageBase64;
        const expectedHmac = createHmac('sha256', 'revenue-routing-input-preparer-test-secret')
            .update('gender-routing:image-content:v1\0')
            .update(Buffer.from(imageBase64!, 'base64'))
            .digest('hex');
        expect(first?.manifest.rows[0]?.imageContentHmac).toBe(expectedHmac);
        expect(first?.manifest.canonicalInputHmac).toBe(second?.manifest.canonicalInputHmac);
        expect(first).toEqual(second);
        expect(assess.mock.calls[0]?.[0][0]).toMatchObject({ fullname: 'Åda' });
    });

    it('downloads and normalizes one exact URL once across Standard microbatch boundaries', async () => {
        const download = vi.fn(async () => downloaded());
        const normalize = vi.fn(async (bytes: Buffer) => Buffer.from(bytes));
        const prepare = createRevenueGenderRoutingInputPreparer({ download, normalize });
        const assess = vi.fn(async (rows: readonly RevenueGenderRoutingModelCandidate[]) => new Map(rows.map(row => [
            row.candidateKey,
            { femaleScore: 0.8, maleScore: 0.1, uncertaintyScore: 0.1, evidence: 'image_and_name' as const },
        ])));
        const candidates = Array.from({ length: 201 }, (_, index) => ({
            ...source(`candidate:${index + 1}`, 'https://scontent.cdninstagram.com/shared-boundary.jpg', 'Name'),
            mutualOrdinal: index + 1,
        }));

        await routeRevenueGenderCandidates({
            requestId: '123e4567-e89b-42d3-a456-426614174000',
            relationshipCheckpointId: 'checkpoint',
            accessMode: 'test_entitlement',
            planId: 'standard',
            candidates,
            hmacSecret: 'revenue-routing-input-preparer-test-secret',
            inputPreparer: prepare,
            assess,
        });

        expect(download).toHaveBeenCalledTimes(1);
        expect(normalize).toHaveBeenCalledTimes(1);
        expect(assess.mock.calls.every(([rows]) => rows.length <= 10)).toBe(true);
    });

    it('keeps maximum Standard evidence immutable and bounded while downloading one exact URL once', async () => {
        const sourceBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(256 * 1024 - 3, 9)]);
        const download = vi.fn(async () => downloaded(sourceBytes));
        const normalized = Buffer.from(sourceBytes);
        const expectedBase64 = normalized.toString('base64');
        const expectedHmac = createHmac('sha256', 'revenue-routing-input-preparer-test-secret')
            .update('gender-routing:image-content:v1\0')
            .update(normalized)
            .digest('hex');
        const normalize = vi.fn(async () => normalized);
        const prepare = createRevenueGenderRoutingInputPreparer({ download, normalize });
        let assessorCall = 0;
        const assess = vi.fn(async (rows: readonly RevenueGenderRoutingModelCandidate[]) => {
            for (const row of rows) expect(row.imageBase64).toBe(expectedBase64);
            if (assessorCall++ === 0) normalized[3] ^= 0xff;
            return new Map(rows.map(row => [row.candidateKey, {
                femaleScore: 0.8,
                maleScore: 0.1,
                uncertaintyScore: 0.1,
                evidence: 'image_and_name' as const,
            }]));
        });
        const candidates = Array.from({ length: 800 }, (_, index) => ({
            ...source(`candidate:${index + 1}`, 'https://scontent.cdninstagram.com/one-exact-url.jpg', 'Name'),
            mutualOrdinal: index + 1,
        }));

        const result = await routeRevenueGenderCandidates({
            requestId: '123e4567-e89b-42d3-a456-426614174000',
            relationshipCheckpointId: 'checkpoint',
            accessMode: 'test_entitlement',
            planId: 'standard',
            candidates,
            hmacSecret: 'revenue-routing-input-preparer-test-secret',
            inputPreparer: prepare,
            assess,
        });

        candidates[0]!.fullname = 'mutated-after-routing';
        expect(download).toHaveBeenCalledTimes(1);
        expect(normalize).toHaveBeenCalledTimes(1);
        expect(assess).toHaveBeenCalledTimes(80);
        expect(assess.mock.calls.every(([rows]) => rows.length <= 10)).toBe(true);
        expect(result?.manifest.rows).toHaveLength(800);
        expect(result?.manifest.rows.every(row => row.imageContentHmac === expectedHmac)).toBe(true);
        expect(result?.manifest.canonicalInputHmac).toMatch(/^[a-f0-9]{64}$/);
        expect(result?.manifest.rows[0]?.imageContentHmac).toBe(expectedHmac);
    });

    it('bounds distinct URL preparation concurrency', async () => {
        let active = 0;
        let maximum = 0;
        const release: Array<() => void> = [];
        const download = vi.fn(async () => {
            active++;
            maximum = Math.max(maximum, active);
            await new Promise<void>(resolve => release.push(resolve));
            active--;
            return downloaded();
        });
        const prepare = createRevenueGenderRoutingInputPreparer({
            download,
            normalize: async bytes => bytes,
        });
        const pending = prepare(Array.from({ length: REVENUE_GENDER_ROUTING_IMAGE_MAX_CONCURRENCY + 1 }, (
            _, index,
        ) => source(`candidate:${index}`, `https://scontent.cdninstagram.com/${index}.jpg`)));

        await vi.waitFor(() => expect(release).toHaveLength(REVENUE_GENDER_ROUTING_IMAGE_MAX_CONCURRENCY));
        while (release.length) release.shift()!();
        await vi.waitFor(() => expect(release).toHaveLength(1));
        release.shift()!();
        await pending;

        expect(maximum).toBe(REVENUE_GENDER_ROUTING_IMAGE_MAX_CONCURRENCY);
    });
});
