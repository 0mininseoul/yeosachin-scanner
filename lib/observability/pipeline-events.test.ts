import { describe, expect, it } from 'vitest';

import { sanitizeOperationalEvent } from './schema';

const PIPELINE_EVENTS = [
    'scraper.batch_completed',
    'scraper.batch_failed',
    'scraper.fallback_selected',
    'scraper.candidate_failed',
    'cloud_task.enqueue_completed',
    'cloud_task.enqueue_failed',
    'analysis_v2.worker_completed',
    'analysis_v2.worker_retry',
    'analysis_v2.worker_failed',
    'gemini.stage_completed',
    'gemini.stage_rate_limited',
    'gemini.stage_failed',
] as const;

describe('pipeline operational event contract', () => {
    it.each(PIPELINE_EVENTS)('keeps the registered %s event', event => {
        expect(sanitizeOperationalEvent({ event, severity: 'info' }).message).toBe(event);
    });

    it.each(['already_terminal', 'stale_delivery', 'unavailable']) (
        'keeps the closed pipeline disposition %s',
        disposition => {
            expect(sanitizeOperationalEvent({
                event: 'analysis_v2.worker_completed',
                severity: 'info',
                fields: { disposition },
            }).fields.disposition).toBe(disposition);
        }
    );

    it('keeps pipeline dimensions while dropping provider and model payload content', () => {
        const sanitized = sanitizeOperationalEvent({
            event: 'gemini.stage_completed',
            severity: 'info',
            fields: {
                analysis_request_id: '123e4567-e89b-42d3-a456-426614174000',
                job_key: 'track:profile-ai:batch:0',
                provider: 'gemini',
                operation: 'genderTriage',
                phase: 'terminalize',
                attempt: 1,
                model: 'gemini-3.1-flash-lite',
                thinking_level: 'minimal',
                prompt_tokens: 100,
                completion_tokens: 20,
                thinking_tokens: 5,
                estimated_cost_usd: 0.000001,
                disposition: 'success',
                prompt: 'private prompt',
                response_json: '{"private":"result"}',
                input_hash: 'private-input-hash',
                result_hash: 'private-result-hash',
                finish_reason: 'STOP',
                location: 'asia-northeast3',
                image_url: 'https://private.example/image.jpg',
                caption: 'private caption',
                comment: 'private comment',
            },
        });

        expect(sanitized.fields).toMatchObject({
            analysis_request_id: '123e4567-e89b-42d3-a456-426614174000',
            job_key: 'track:profile-ai:batch:0',
            provider: 'gemini',
            operation: 'genderTriage',
            phase: 'terminalize',
            attempt: 1,
            model: 'gemini-3.1-flash-lite',
            thinking_level: 'minimal',
            prompt_tokens: 100,
            completion_tokens: 20,
            thinking_tokens: 5,
            estimated_cost_usd: 0.000001,
            disposition: 'success',
        });
        expect(JSON.stringify(sanitized)).not.toMatch(
            /private prompt|private.*result|private-input|private-result|STOP|asia-northeast3|private\.example|private caption|private comment/
        );
    });
});
