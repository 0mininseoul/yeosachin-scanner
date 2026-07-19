import { afterEach, describe, expect, it } from 'vitest';

import {
    sanitizeOperationalEvent,
    type OperationalEvent,
} from './schema';

const ORIGINAL_VERCEL_ENV = process.env.VERCEL_ENV;
const ORIGINAL_NODE_ENV = process.env['NODE_ENV'];
const mutableProcessEnv = process.env as Record<string, string | undefined>;

const UUIDS = {
    request: '01234567-89ab-4def-8123-456789abcdef',
    user: '11234567-89ab-4def-8123-456789abcdef',
    preflight: '21234567-89ab-4def-8123-456789abcdef',
    order: '31234567-89ab-4def-8123-456789abcdef',
    analysis: '41234567-89ab-4def-8123-456789abcdef',
} as const;

afterEach(() => {
    if (ORIGINAL_VERCEL_ENV === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = ORIGINAL_VERCEL_ENV;
    if (ORIGINAL_NODE_ENV === undefined) delete mutableProcessEnv.NODE_ENV;
    else mutableProcessEnv.NODE_ENV = ORIGINAL_NODE_ENV;
});

describe('sanitizeOperationalEvent', () => {
    it('derives the envelope and preserves every allowed field with a safe value', () => {
        process.env.VERCEL_ENV = 'preview';

        const sanitized = sanitizeOperationalEvent({
            event: 'analysis_v2.worker_completed',
            severity: 'info',
            fields: {
                schema_version: 99,
                environment: 'attacker-controlled',
                service: 'another-service',
                event: 'overridden.event',
                severity: 'error',
                request_id: UUIDS.request,
                trace_id: '0123456789abcdef0123456789abcdef',
                route: '/api/analysis/v2/worker',
                method: 'POST',
                status: 202,
                duration_ms: 125.75,
                user_id: UUIDS.user,
                preflight_id: UUIDS.preflight,
                order_id: UUIDS.order,
                analysis_request_id: UUIDS.analysis,
                job_key: 'track:profile-ai:batch:17',
                target_instagram_id: 'Target.Account',
                candidate_instagram_id: 'Candidate_One',
                excluded_instagram_id: 'Excluded.Account',
                provider: 'apify',
                operation: 'profiles_batch',
                phase: 'terminalize',
                attempt: 2,
                result_count: 25,
                error_name: 'Error',
                error_code: 'SCRAPING_PROVIDER_QUOTA_ERROR',
                disposition: 'completed',
                retryable: false,
                estimated_cost_usd: 0.0125,
                input_count: 30,
                output_count: 25,
                model: 'gemini-2.5-flash',
                thinking_level: 'medium',
                prompt_tokens: 1_000,
                completion_tokens: 200,
                thinking_tokens: 50,
                fallback: true,
                queue_name: 'analysis-v2',
                progress: 75,
                plan_id: 'standard',
                amount_krw: 39_000,
            },
        });

        expect(sanitized.message).toBe('analysis_v2.worker_completed');
        expect(sanitized.fields).toEqual({
            schema_version: 1,
            environment: 'preview',
            service: 'yeosachin-web',
            event: 'analysis_v2.worker_completed',
            severity: 'info',
            request_id: UUIDS.request,
            trace_id: '0123456789abcdef0123456789abcdef',
            route: '/api/analysis/v2/worker',
            method: 'POST',
            status: 202,
            duration_ms: 125.75,
            user_id: UUIDS.user,
            preflight_id: UUIDS.preflight,
            order_id: UUIDS.order,
            analysis_request_id: UUIDS.analysis,
            job_key: 'track:profile-ai:batch:17',
            target_instagram_id: 'target.account',
            candidate_instagram_id: 'candidate_one',
            excluded_instagram_id: 'excluded.account',
            provider: 'apify',
            operation: 'profiles_batch',
            phase: 'terminalize',
            attempt: 2,
            result_count: 25,
            error_name: 'Error',
            error_code: 'SCRAPING_PROVIDER_QUOTA_ERROR',
            disposition: 'completed',
            retryable: false,
            estimated_cost_usd: 0.0125,
            input_count: 30,
            output_count: 25,
            model: 'gemini-2.5-flash',
            thinking_level: 'medium',
            prompt_tokens: 1_000,
            completion_tokens: 200,
            thinking_tokens: 50,
            fallback: true,
            queue_name: 'analysis-v2',
            progress: 75,
            plan_id: 'standard',
            amount_krw: 39_000,
        });
    });

    it('drops unknown, forbidden, and nested fields instead of recursively redacting them', () => {
        const forbidden = {
            email: 'buyer@example.com',
            phone: '+821012345678',
            name: 'Buyer Name',
            token: 'runtime-secret',
            auth: 'Bearer secret',
            authorization: 'Bearer secret',
            cookie: 'session=secret',
            signature: 'secret-signature',
            body: { target: 'private' },
            response: { raw: 'private' },
            payload: { raw: 'private' },
            comment: 'private comment',
            bio: 'private bio',
            caption: 'private caption',
            prompt: 'private prompt',
            image: 'https://cdn.example/private.jpg',
            media: ['https://cdn.example/private.jpg'],
            url: 'https://example.com/?secret=value',
            profile: { biography: 'private' },
            buyer: { email: 'buyer@example.com' },
            stack: 'secret stack',
            message: 'secret message',
            cause: new Error('secret cause'),
            unknown: 'must not pass',
            provider: { name: 'nested values never pass' },
            retryable: { value: true },
        };

        const sanitized = sanitizeOperationalEvent({
            event: 'http.route_completed',
            severity: 'warn',
            fields: forbidden,
        });

        expect(sanitized.fields).toEqual({
            schema_version: 1,
            environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development',
            service: 'yeosachin-web',
            event: 'http.route_completed',
            severity: 'warn',
        });
        expect(JSON.stringify(sanitized)).not.toContain('secret');
        expect(JSON.stringify(sanitized)).not.toContain('private');
    });

    it('bounds strings and rejects malformed event names, routes, identifiers, and Instagram IDs', () => {
        const sanitized = sanitizeOperationalEvent({
            event: `INVALID ${'x'.repeat(300)}`,
            severity: 'info',
            fields: {
                provider: 'p'.repeat(257),
                route: '/api/orders?buyer=private',
                request_id: 'request id with spaces',
                trace_id: 'not-a-trace-id',
                user_id: 'not-a-uuid',
                preflight_id: 'not-a-uuid',
                order_id: 'not-a-uuid',
                analysis_request_id: 'not-a-uuid',
                job_key: 'UPPERCASE:job',
                target_instagram_id: 'not-an-instagram-id!',
                candidate_instagram_id: 'x'.repeat(31),
                excluded_instagram_id: { username: 'nested' },
                plan_id: 'x'.repeat(257),
            },
        });

        expect(sanitized.message).toBe('operational.invalid_event');
        expect(sanitized.fields).toEqual({
            schema_version: 1,
            environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development',
            service: 'yeosachin-web',
            event: 'operational.invalid_event',
            severity: 'info',
        });
    });

    it('keeps only finite bounded numeric values and exact booleans', () => {
        const sanitized = sanitizeOperationalEvent({
            event: 'gemini.stage_completed',
            severity: 'debug',
            fields: {
                status: 600,
                duration_ms: Number.POSITIVE_INFINITY,
                attempt: -1,
                result_count: 1.5,
                estimated_cost_usd: Number.NaN,
                input_count: Number.MAX_SAFE_INTEGER,
                output_count: -1,
                prompt_tokens: 1_000_000_001,
                completion_tokens: 2.5,
                thinking_tokens: -10,
                progress: 101,
                amount_krw: 1_000_000_001,
                retryable: 'true',
                fallback: 1,
            },
        });

        expect(sanitized.fields).toEqual({
            schema_version: 1,
            environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development',
            service: 'yeosachin-web',
            event: 'gemini.stage_completed',
            severity: 'debug',
        });
    });

    it('extracts only a bounded error name and registered uppercase code', () => {
        const error = Object.assign(
            new Error('SCRAPING_TIMEOUT_ERROR: buyer@example.com token=secret'),
            {
                name: 'TimeoutError',
                code: 'SCRAPING_TIMEOUT_ERROR',
                stack: 'private stack',
                cause: new Error('private cause'),
                response: { body: 'private response' },
            },
        );

        const sanitized = sanitizeOperationalEvent({
            event: 'scraper.batch_failed',
            severity: 'error',
            fields: {
                error_name: 'CallerOverride',
                error_code: 'SECRET_TOKEN_VALUE',
            },
            error,
        });

        expect(sanitized.fields).toMatchObject({
            error_name: 'TimeoutError',
            error_code: 'SCRAPING_TIMEOUT_ERROR',
        });
        expect(Object.keys(sanitized.fields)).not.toContain('message');
        expect(Object.keys(sanitized.fields)).not.toContain('stack');
        expect(Object.keys(sanitized.fields)).not.toContain('cause');
        expect(JSON.stringify(sanitized)).not.toContain('buyer@example.com');
        expect(JSON.stringify(sanitized)).not.toContain('secret');
        expect(JSON.stringify(sanitized)).not.toContain('private');
    });

    it('accepts a registered code prefix from an Error message but not an arbitrary uppercase prefix', () => {
        const known = sanitizeOperationalEvent({
            event: 'scraper.batch_failed',
            severity: 'error',
            error: new Error('SCRAPING_SCHEMA_ERROR: raw provider response'),
        });
        const unknown = sanitizeOperationalEvent({
            event: 'scraper.batch_failed',
            severity: 'error',
            error: new Error('BUYER_PRIVATE_SECRET: raw provider response'),
        });

        expect(known.fields.error_code).toBe('SCRAPING_SCHEMA_ERROR');
        expect(unknown.fields.error_code).toBeUndefined();
    });

    it('accepts the repository registered operational subsystem codes', () => {
        for (const errorCode of [
            'AI_RATE_LIMIT_ERROR',
            'PROFILE_FETCH_PERSISTENCE_ERROR',
            'JOB_DISPATCH_NOT_READY',
            'INVALID_REQUEST',
            'PROVIDER_RATE_LIMITED',
        ]) {
            const sanitized = sanitizeOperationalEvent({
                event: 'analysis_v2.worker_failed',
                severity: 'error',
                fields: { error_code: errorCode },
            });

            expect(sanitized.fields.error_code).toBe(errorCode);
        }
    });

    it('preserves exact registered V2 codes before applying sensitive segment denial', () => {
        const registeredCodes = [
            'AI_GENERATION_RESPONSE_REJECTED_ERROR',
            'ANALYSIS_V2_MEDIA_ARTIFACT_CONFIG_ERROR',
            'ANALYSIS_V2_PRIVATE_NAME_COUNT_DRIFT',
            'ANALYSIS_V2_PROFILE_MEDIA_STRUCTURAL_INCOMPLETE',
        ];

        for (const errorCode of registeredCodes) {
            const explicit = sanitizeOperationalEvent({
                event: 'analysis_v2.worker_failed',
                severity: 'error',
                fields: { error_code: errorCode },
            });
            const property = sanitizeOperationalEvent({
                event: 'analysis_v2.worker_failed',
                severity: 'error',
                error: Object.assign(new Error('safe failure'), { code: errorCode }),
            });
            const messagePrefix = sanitizeOperationalEvent({
                event: 'analysis_v2.worker_failed',
                severity: 'error',
                error: new Error(`${errorCode}: raw failure detail`),
            });

            expect(explicit.fields.error_code).toBe(errorCode);
            expect(property.fields.error_code).toBe(errorCode);
            expect(messagePrefix.fields.error_code).toBe(errorCode);
        }
    });

    it('rejects sensitive exact error-code segments through every error input path', () => {
        const sensitiveCodes = [
            'AUTH_TOKEN_SECRET',
            'APIFY_TOKEN_PROVIDER_SECRET_ERROR',
            'AUTH_BUYER_EMAIL',
            'AUTH_BUYER_PHONE',
            'AUTH_COOKIE_ERROR',
            'AUTH_SIGNATURE_ERROR',
            'AUTH_AUTHORIZATION_ERROR',
            'AUTH_BODY_ERROR',
            'AUTH_RESPONSE_ERROR',
            'AUTH_PAYLOAD_ERROR',
            'AUTH_COMMENT_ERROR',
            'AUTH_BIO_ERROR',
            'AUTH_CAPTION_ERROR',
            'AUTH_PROMPT_ERROR',
            'AUTH_IMAGE_ERROR',
            'AUTH_MEDIA_ERROR',
            'AUTH_NAME_ERROR',
        ];

        for (const errorCode of sensitiveCodes) {
            const explicit = sanitizeOperationalEvent({
                event: 'analysis_v2.worker_failed',
                severity: 'error',
                fields: { error_code: errorCode },
            });
            const property = sanitizeOperationalEvent({
                event: 'analysis_v2.worker_failed',
                severity: 'error',
                error: Object.assign(new Error('safe failure'), { code: errorCode }),
            });
            const messagePrefix = sanitizeOperationalEvent({
                event: 'analysis_v2.worker_failed',
                severity: 'error',
                error: new Error(`${errorCode}: raw failure detail`),
            });

            expect(explicit.fields.error_code).toBeUndefined();
            expect(property.fields.error_code).toBeUndefined();
            expect(messagePrefix.fields.error_code).toBeUndefined();
        }
    });

    it('matches forbidden error-code words as exact segments only', () => {
        for (const errorCode of [
            'AUTH_USERNAME_INVALID',
            'PROFILE_FETCH_PERSISTENCE_ERROR',
            'AI_RATE_LIMIT_ERROR',
        ]) {
            expect(sanitizeOperationalEvent({
                event: 'analysis_v2.worker_failed',
                severity: 'error',
                fields: { error_code: errorCode },
            }).fields.error_code).toBe(errorCode);
        }
    });

    it('drops unregistered categorical values and broad-prefix error codes', () => {
        const sanitized = sanitizeOperationalEvent({
            event: 'attacker.secret_token',
            severity: 'warn',
            fields: {
                request_id: 'xaat-secret-token',
                provider: 'xaat-secret-token',
                operation: 'xaat-secret-token',
                phase: 'xaat-secret-token',
                disposition: 'xaat-secret-token',
                queue_name: 'xaat-secret-token',
                model: 'gemini-secret-token',
                thinking_level: 'secret',
                plan_id: 'secret-plan',
                error_name: 'SecretToken',
                error_code: 'AUTH_SKLIVEABC123',
            },
        });

        expect(sanitized.message).toBe('operational.invalid_event');
        expect(sanitized.fields).not.toHaveProperty('request_id');
        expect(sanitized.fields).not.toHaveProperty('provider');
        expect(sanitized.fields).not.toHaveProperty('operation');
        expect(sanitized.fields).not.toHaveProperty('phase');
        expect(sanitized.fields).not.toHaveProperty('disposition');
        expect(sanitized.fields).not.toHaveProperty('queue_name');
        expect(sanitized.fields).not.toHaveProperty('model');
        expect(sanitized.fields).not.toHaveProperty('thinking_level');
        expect(sanitized.fields).not.toHaveProperty('plan_id');
        expect(sanitized.fields).not.toHaveProperty('error_name');
        expect(sanitized.fields).not.toHaveProperty('error_code');
        expect(JSON.stringify(sanitized)).not.toContain('secret-token');
    });

    it('falls back from an unregistered runtime environment without reflecting it', () => {
        process.env.VERCEL_ENV = 'xaat-secret-token';

        const sanitized = sanitizeOperationalEvent({
            event: 'http.route_completed',
            severity: 'info',
        });

        expect(sanitized.fields.environment).toBe('development');
        expect(JSON.stringify(sanitized)).not.toContain('secret-token');
    });

    it('accepts the complete planned operational event vocabulary', () => {
        const eventNames = [
            'operational.invalid_event',
            'http.route_completed',
            'http.route_failed',
            'next.request_error',
            'auth.callback_completed',
            'auth.profile_sync_failed',
            'preflight.requested',
            'preflight.profile_collected',
            'preflight.completed',
            'preflight.failed',
            'preflight.exclusion_decided',
            'earlybird.checkout_created',
            'earlybird.checkout_failed',
            'groble.webhook_received',
            'groble.webhook_finalized',
            'groble.webhook_rejected',
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
        ];

        for (const event of eventNames) {
            expect(sanitizeOperationalEvent({
                event,
                severity: 'info',
            }).message).toBe(event);
        }
    });

    it('uses a safe runtime severity when untyped input bypasses TypeScript', () => {
        const input = {
            event: 'next.request_error',
            severity: 'fatal',
        } as unknown as OperationalEvent;

        expect(sanitizeOperationalEvent(input).fields.severity).toBe('info');
    });
});
