import { describe, expect, it } from 'vitest';
import {
    captureAndBindLandingLeadJourney,
    createOrReplayLandingLeadCapture,
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

    it('rejects a replay whose normalized account, principal, or context differs from the journey', async () => {
        const rpc = async () => ({
            data: [{ journey_id: '123e4567-e89b-42d3-a456-426614174000', created: false }],
            error: { message: 'LANDING_LEAD_CAPTURE_MISMATCH' },
        });

        await expect(createOrReplayLandingLeadCapture(
            { rpc },
            {
                journeyId: '123e4567-e89b-42d3-a456-426614174000',
                instagramId: 'Target.User',
                inputContext: 'target',
                anonymousPrincipalHash: 'a'.repeat(64),
                captureTokenHash: 'b'.repeat(64),
            },
        )).rejects.toThrow('LANDING_LEAD_CAPTURE_MISMATCH');
    });

    it('rejects a capture adapter that returns a different journey than the token', async () => {
        await expect(createOrReplayLandingLeadCapture(
            {
                rpc: async () => ({
                    data: [{
                        journey_id: '223e4567-e89b-42d3-a456-426614174000',
                        created: false,
                    }],
                    error: null,
                }),
            },
            {
                journeyId: '123e4567-e89b-42d3-a456-426614174000',
                instagramId: 'target.user',
                inputContext: 'target',
                anonymousPrincipalHash: 'a'.repeat(64),
                captureTokenHash: 'b'.repeat(64),
            },
        )).rejects.toThrow('LANDING_LEAD_CAPTURE_MISMATCH');
    });

    it('repairs a stale capture before binding the exact target to its preflight', async () => {
        const original = createCaptureToken('device-123', secret);
        const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
        const rpc = async (name: string, params: Record<string, unknown>) => {
            calls.push({ name, params });
            if (name === 'create_or_replay_landing_lead_capture' && calls.length === 1) {
                return { data: null, error: { message: 'LANDING_LEAD_CAPTURE_MISMATCH' } };
            }
            if (name === 'create_or_replay_landing_lead_capture') {
                return {
                    data: [{ journey_id: params.p_journey_id, created: true }],
                    error: null,
                };
            }
            return { data: true, error: null };
        };

        const result = await captureAndBindLandingLeadJourney(
            { rpc },
            {
                preflightId: '223e4567-e89b-42d3-a456-426614174000',
                targetInstagramId: 'Target.User',
                landingCaptureToken: original.token,
                anonymousDeviceId: 'device-123',
                secret,
            },
        );

        expect(result.bound).toBe(true);
        expect(result.repaired).toBe(true);
        expect(calls.map(call => call.name)).toEqual([
            'create_or_replay_landing_lead_capture',
            'create_or_replay_landing_lead_capture',
            'bind_landing_lead_journey_to_preflight',
        ]);
        expect(calls[1]?.params.p_instagram_id).toBe('target.user');
        expect(JSON.stringify(calls)).not.toContain(original.token);
    });

    it('reuses a deterministic repair capture for an idempotent preflight retry', () => {
        const first = createCaptureToken('device-123', secret, 'preflight-repair-seed');
        const second = createCaptureToken('different-device', secret, 'preflight-repair-seed');

        expect(second.token).toBe(first.token);
        expect(second.tokenHash).toBe(first.tokenHash);
    });
});
