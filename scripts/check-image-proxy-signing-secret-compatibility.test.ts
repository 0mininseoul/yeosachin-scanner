import { describe, expect, it, vi } from 'vitest';
import {
    formatImageProxyCompatibilityProbeResult,
    IMAGE_PROXY_COMPATIBILITY_FIXTURE_URL,
    runImageProxySigningSecretCompatibilityProbe,
} from './check-image-proxy-signing-secret-compatibility';

const SECRET = 'release-gate-image-proxy-secret-that-is-at-least-32-chars';
const BASE_URL = 'https://yeosachin.example';

describe('image proxy signing secret compatibility probe', () => {
    it('signs the fixed non-user fixture and accepts a 200 response without outputting details', async () => {
        let requestedUrl = '';
        const result = await runImageProxySigningSecretCompatibilityProbe(
            { secret: SECRET, baseUrl: BASE_URL },
            {
                fetchImpl: vi.fn(async (input: string) => {
                    requestedUrl = input;
                    return new Response(Buffer.from([1, 2, 3]), {
                        status: 200,
                        headers: { 'content-type': 'image/jpeg' },
                    });
                }),
            },
        );

        expect(result).toEqual({
            passed: true,
            category: 'signature_accepted_200',
        });
        expect(requestedUrl).toMatch(/^https:\/\/yeosachin\.example\/api\/image-proxy\?/);
        expect(requestedUrl).not.toContain(IMAGE_PROXY_COMPATIBILITY_FIXTURE_URL);
        expect(formatImageProxyCompatibilityProbeResult(result)).toBe(
            'PASS: image-proxy-signing compatibility signature_accepted_200\n'
        );
        expect(formatImageProxyCompatibilityProbeResult(result)).not.toContain(SECRET);
        expect(formatImageProxyCompatibilityProbeResult(result)).not.toContain('api/image-proxy');
        expect(formatImageProxyCompatibilityProbeResult(result)).not.toContain('https://');
    });

    it('accepts only the documented retryable 503 envelope as a signature success', async () => {
        const result = await runImageProxySigningSecretCompatibilityProbe(
            { secret: SECRET, baseUrl: BASE_URL },
            {
                fetchImpl: async () => new Response(JSON.stringify({
                    code: 'IMAGE_UNAVAILABLE',
                    retryable: true,
                }), {
                    status: 503,
                    headers: { 'content-type': 'application/json' },
                }),
            },
        );

        expect(result).toEqual({
            passed: true,
            category: 'signature_accepted_503_retryable',
        });
    });

    it('fails closed on 403 without reading or exposing the response body', async () => {
        const result = await runImageProxySigningSecretCompatibilityProbe(
            { secret: SECRET, baseUrl: BASE_URL },
            {
                fetchImpl: async () => new Response('private rejection body', { status: 403 }),
            },
        );

        expect(result).toEqual({
            passed: false,
            category: 'signature_rejected_403',
        });
        expect(formatImageProxyCompatibilityProbeResult(result)).toBe(
            'FAIL: image-proxy-signing compatibility signature_rejected_403\n'
        );
        expect(formatImageProxyCompatibilityProbeResult(result)).not.toContain('private rejection body');
    });

    it.each([
        ['unexpected status', new Response('raw response body', { status: 201 })],
        ['non-retryable 503', new Response(JSON.stringify({
            code: 'IMAGE_UNAVAILABLE',
            retryable: false,
        }), { status: 503 })],
        ['malformed 503', new Response('not-json', { status: 503 })],
    ])('fails closed on %s', async (_label, response) => {
        const result = await runImageProxySigningSecretCompatibilityProbe(
            { secret: SECRET, baseUrl: BASE_URL },
            { fetchImpl: async () => response },
        );

        expect(result).toEqual({
            passed: false,
            category: 'unexpected_status',
        });
    });

    it('reports only safe categories for configuration and transport failures', async () => {
        await expect(runImageProxySigningSecretCompatibilityProbe(
            { secret: 'too-short', baseUrl: BASE_URL },
            { fetchImpl: vi.fn() },
        )).resolves.toEqual({ passed: false, category: 'configuration_error' });

        await expect(runImageProxySigningSecretCompatibilityProbe(
            { secret: SECRET, baseUrl: 'http://not-production.example' },
            { fetchImpl: vi.fn() },
        )).resolves.toEqual({ passed: false, category: 'configuration_error' });

        await expect(runImageProxySigningSecretCompatibilityProbe(
            { secret: SECRET, baseUrl: BASE_URL },
            { fetchImpl: async () => { throw new Error(SECRET); } },
        )).resolves.toEqual({ passed: false, category: 'network_error' });
    });
});
