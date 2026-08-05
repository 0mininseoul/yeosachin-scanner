import { describe, expect, it, vi } from 'vitest';
import { emitAnalysisLifecycleEvent } from './analytics-server';

const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174001';
const USER_ID = '123e4567-e89b-42d3-a456-426614174000';
const PREFLIGHT_ID = '123e4567-e89b-42d3-a456-426614174003';

describe('server analysis lifecycle analytics', () => {
    it('claims a durable event and sends only allowlisted UUID properties', async () => {
        const rpc = vi.fn()
            .mockResolvedValueOnce({
                data: [{
                    request_id: REQUEST_ID,
                    event_name: 'analysis_completed',
                    user_id: USER_ID,
                    plan_id: 'standard',
                    preflight_id: PREFLIGHT_ID,
                    occurred_at: '2026-08-05T00:00:00.000Z',
                    insert_id: `analysis:${REQUEST_ID}:analysis_completed`,
                    duration_ms: 12_345,
                    error_code: null,
                }],
                error: null,
            })
            .mockResolvedValueOnce({ data: [], error: null });
        const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

        await expect(emitAnalysisLifecycleEvent({
            requestId: REQUEST_ID,
            eventName: 'analysis_completed',
        }, {
            client: { rpc },
            fetchImpl,
            apiKey: 'server-api-key',
        })).resolves.toBe(true);

        expect(rpc).toHaveBeenNthCalledWith(1, 'claim_analysis_lifecycle_event', {
            p_request_id: REQUEST_ID,
            p_event_name: 'analysis_completed',
            p_error_code: null,
        });
        const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
        expect(body.events).toEqual([expect.objectContaining({
            event_type: 'analysis_completed',
            user_id: USER_ID,
            insert_id: `analysis:${REQUEST_ID}:analysis_completed`,
            event_properties: {
                request_id: REQUEST_ID,
                plan_id: 'standard',
                preflight_id: PREFLIGHT_ID,
                duration_ms: 12_345,
            },
        })]);
        expect(JSON.stringify(body)).not.toMatch(/email|phone|instagram|token|url|target/);
        expect(rpc).toHaveBeenNthCalledWith(2, 'mark_analysis_lifecycle_event_sent', {
            p_request_id: REQUEST_ID,
            p_event_name: 'analysis_completed',
        });
    });

    it('fails open when Amplitude cannot be reached', async () => {
        const rpc = vi.fn().mockResolvedValue({
            data: [{
                request_id: REQUEST_ID,
                event_name: 'analysis_failed',
                user_id: USER_ID,
                plan_id: 'basic',
                preflight_id: null,
                occurred_at: '2026-08-05T00:00:00.000Z',
                insert_id: `analysis:${REQUEST_ID}:analysis_failed`,
                duration_ms: 1,
                error_code: 'PROVIDER_TEMPORARY_FAILURE',
            }],
            error: null,
        });
        const fetchImpl = vi.fn().mockRejectedValue(new Error('network details'));

        await expect(emitAnalysisLifecycleEvent({
            requestId: REQUEST_ID,
            eventName: 'analysis_failed',
            errorCode: 'PROVIDER_TEMPORARY_FAILURE',
        }, {
            client: { rpc },
            fetchImpl,
            apiKey: 'server-api-key',
        })).resolves.toBe(false);
        expect(rpc).toHaveBeenCalledTimes(1);
    });

    it('does not attach a completion duration to the admission event', async () => {
        const rpc = vi.fn().mockResolvedValue({
            data: [{
                request_id: REQUEST_ID,
                event_name: 'analysis_started',
                user_id: USER_ID,
                plan_id: 'basic',
                preflight_id: PREFLIGHT_ID,
                occurred_at: '2026-08-05T00:00:00.000Z',
                insert_id: `analysis:${REQUEST_ID}:analysis_started`,
                duration_ms: 42,
                error_code: null,
            }],
            error: null,
        });
        const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

        await expect(emitAnalysisLifecycleEvent({
            requestId: REQUEST_ID,
            eventName: 'analysis_started',
        }, {
            client: { rpc },
            fetchImpl,
            apiKey: 'server-api-key',
        })).resolves.toBe(true);

        const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
        expect(body.events[0].event_properties).toEqual({
            request_id: REQUEST_ID,
            plan_id: 'basic',
            preflight_id: PREFLIGHT_ID,
        });
    });
});
