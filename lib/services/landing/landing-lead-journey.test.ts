import { describe, expect, it } from 'vitest';
import {
    createCaptureToken,
    deriveAnonymousPrincipalHash,
    hashCaptureToken,
    readCaptureToken,
} from './landing-lead-journey';

const secret = 'landing-lead-test-secret-with-at-least-32-bytes';

describe('landing lead journey identity boundaries', () => {
    it('uses a domain-separated digest and never returns raw identity material', () => {
        const result = deriveAnonymousPrincipalHash('device-123', secret);
        expect(result).toMatch(/^[a-f0-9]{64}$/);
        expect(result).not.toContain('device-123');
        expect(result).not.toBe(createCaptureToken('device-123', secret).token);
    });

    it('creates an opaque, signed, one-time capture token and only exposes its digest to persistence', () => {
        const capture = createCaptureToken('device-123', secret);
        expect(capture.token).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
        expect(capture.token).not.toContain('device-123');
        expect(capture.tokenHash).toMatch(/^[a-f0-9]{64}$/);
        expect(capture.tokenHash).not.toContain(capture.token);
        expect(hashCaptureToken(capture.token, secret)).toBe(capture.tokenHash);
        expect(readCaptureToken(capture.token, secret)).toEqual({
            tokenHash: capture.tokenHash,
        });
    });

    it('rejects tampered capture tokens before they can be replayed', () => {
        const capture = createCaptureToken('device-123', secret);
        expect(readCaptureToken(`${capture.token}x`, secret)).toBeNull();
        expect(readCaptureToken(capture.token, `${secret}-wrong`)).toBeNull();
    });
});
