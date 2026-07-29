import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createReplayJobGcsClient } from './replay-job-gcs';

const ciphertext = Buffer.from('exact encrypted replay bytes');
const baseConfig = {
    bucket: 'replay-safe-output',
    bundleObject: 'inputs/bundle.enc',
    bundleGeneration: '123456789',
    bundleBytes: ciphertext.byteLength,
    bundleSha256: createHash('sha256').update(ciphertext).digest('hex'),
    claimObject: 'claims/claim-0123456789abcdef.json',
    reportObject: 'reports/report-0123456789abcdef.json',
};

function tokenResponse() {
    return new Response(JSON.stringify({
        access_token: 'adc-access-token-value-1234567890',
        token_type: 'Bearer',
    }), { status: 200 });
}

describe('replay job GCS JSON API client', () => {
    it('downloads one exact generation and create-only writes two fixed objects', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(tokenResponse())
            .mockResolvedValueOnce(new Response(ciphertext, {
                status: 200,
                headers: { 'x-goog-generation': baseConfig.bundleGeneration },
            }))
            .mockResolvedValueOnce(new Response(null, { status: 200 }))
            .mockResolvedValueOnce(new Response(null, { status: 200 }));
        const client = createReplayJobGcsClient(baseConfig, {
            fetch: fetchMock,
        });

        await expect(client.downloadBundle()).resolves.toEqual(ciphertext);
        await client.createClaim(
            '{"status":"claimed","schema":"analysis-v2-replay-job-claim-v1"}',
        );
        await client.createReport('{"status":"ok"}');

        expect(fetchMock).toHaveBeenCalledTimes(4);
        const download = new URL(fetchMock.mock.calls[1]![0].toString());
        expect(download.pathname).toContain('/download/storage/v1/b/');
        expect(download.searchParams.get('generation')).toBe('123456789');
        expect(download.searchParams.get('alt')).toBe('media');
        for (const index of [2, 3]) {
            const [url, init] = fetchMock.mock.calls[index]!;
            expect(init.method).toBe('POST');
            expect(init.headers.authorization).toBe(
                'Bearer adc-access-token-value-1234567890',
            );
            expect(new URL(url.toString()).searchParams.get(
                'ifGenerationMatch',
            )).toBe('0');
        }
        expect(Object.keys(client).sort()).toEqual([
            'createClaim',
            'createReport',
            'downloadBundle',
        ]);
    });

    it('fails closed on ciphertext size, hash, or generation mismatch', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(tokenResponse())
            .mockResolvedValueOnce(new Response(Buffer.from('wrong'), {
                status: 200,
                headers: { 'x-goog-generation': baseConfig.bundleGeneration },
            }));
        await expect(createReplayJobGcsClient(baseConfig, {
            fetch: fetchMock,
        }).downloadBundle()).rejects.toThrow(
            'ANALYSIS_V2_REPLAY_JOB_BUNDLE_INTEGRITY_FAILED',
        );
    });

    it.each([412, 500])(
        'fails closed on claim create status %s without retry or list/delete',
        async status => {
            const fetchMock = vi.fn()
                .mockResolvedValueOnce(tokenResponse())
                .mockResolvedValueOnce(new Response(null, { status }));
            const client = createReplayJobGcsClient(baseConfig, {
                fetch: fetchMock,
            });
            await expect(client.createClaim(
                '{"status":"claimed","schema":"analysis-v2-replay-job-claim-v1"}',
            )).rejects.toThrow(
                status === 412
                    ? 'ANALYSIS_V2_REPLAY_JOB_CLAIM_COLLISION'
                    : 'ANALYSIS_V2_REPLAY_JOB_CLAIM_CREATE_AMBIGUOUS',
            );
            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(fetchMock.mock.calls[1]![1].method).toBe('POST');
        },
    );

    it('rejects unsafe claim or report payloads before ADC fetch', async () => {
        const fetchMock = vi.fn();
        const client = createReplayJobGcsClient(baseConfig, {
            fetch: fetchMock,
        });
        await expect(client.createClaim('{"token":"raw-secret"}'))
            .rejects.toThrow('ANALYSIS_V2_REPLAY_JOB_UNSAFE_OUTPUT');
        await expect(client.createReport(
            '{"status":"ok","username":"private-person"}',
        )).rejects.toThrow('ANALYSIS_V2_REPLAY_JOB_UNSAFE_OUTPUT');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
