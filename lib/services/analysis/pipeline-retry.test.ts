import { describe, expect, it } from 'vitest';
import {
    CLOUD_TASK_DELIVERY_RETRY_SAFETY_CEILING,
    isRetryablePipelineError,
    MAX_CLOUD_TASK_PIPELINE_RETRIES,
    shouldAbortPipelineBeforeExecution,
    shouldRetryPipelineError,
    trustedCloudTasksRetryCount,
} from './pipeline-retry';

describe('analysis pipeline retry policy', () => {
    it('trusts the Cloud Tasks retry header only after task OIDC verification', () => {
        const headers = new Headers({ 'X-CloudTasks-TaskRetryCount': '2' });

        expect(trustedCloudTasksRetryCount(headers, true)).toBe(2);
        expect(trustedCloudTasksRetryCount(headers, false)).toBeNull();
        expect(trustedCloudTasksRetryCount(new Headers(), true)).toBeNull();
        expect(trustedCloudTasksRetryCount(
            new Headers({ 'X-CloudTasks-TaskRetryCount': '-1' }),
            true
        )).toBeNull();
    });

    it('retries only failures classified as transient', () => {
        expect(isRetryablePipelineError(
            new Error('SCRAPING_TIMEOUT_ERROR: provider timeout')
        )).toBe(true);
        expect(isRetryablePipelineError(
            new Error('ANALYSIS_PERSISTENCE_ERROR: temporary database outage')
        )).toBe(true);
        expect(isRetryablePipelineError(
            new Error('AI_ANALYSIS_UNAVAILABLE: model response could have been charged')
        )).toBe(false);
        expect(isRetryablePipelineError(
            new Error('AI_RESULT_PERSISTENCE_ERROR: generated result was not checkpointed')
        )).toBe(false);
        expect(isRetryablePipelineError(
            new Error('SCRAPING_CONFIG_ERROR: invalid credentials')
        )).toBe(false);
        expect(isRetryablePipelineError(
            new Error('SCRAPING_BUDGET_ERROR: operation cap reached')
        )).toBe(false);
        expect(isRetryablePipelineError(
            new Error('SCRAPING_PAID_REQUEST_AMBIGUOUS_ERROR: response status unknown')
        )).toBe(false);
        expect(isRetryablePipelineError(
            new Error('SCRAPING_PAID_REQUEST_ERROR: paid provider rejected the request')
        )).toBe(false);
        expect(isRetryablePipelineError(new Error('private account'))).toBe(false);
    });

    it('allows three Cloud Tasks retries and then exhausts the request', () => {
        const error = new Error('SCRAPING_ERROR: temporary provider outage');

        expect(shouldRetryPipelineError(error, 0)).toBe(true);
        expect(shouldRetryPipelineError(error, 2)).toBe(true);
        expect(shouldRetryPipelineError(
            error,
            MAX_CLOUD_TASK_PIPELINE_RETRIES
        )).toBe(false);
        expect(shouldRetryPipelineError(error, null)).toBe(false);
    });

    it('stops paid execution before the queue exhausts its delivery attempts', () => {
        expect(shouldAbortPipelineBeforeExecution(
            CLOUD_TASK_DELIVERY_RETRY_SAFETY_CEILING - 1
        )).toBe(false);
        expect(shouldAbortPipelineBeforeExecution(
            CLOUD_TASK_DELIVERY_RETRY_SAFETY_CEILING
        )).toBe(true);
        expect(shouldAbortPipelineBeforeExecution(null)).toBe(false);
        expect(() => shouldAbortPipelineBeforeExecution(0, 0))
            .toThrow('ANALYSIS_RETRY_ERROR');
    });
});
