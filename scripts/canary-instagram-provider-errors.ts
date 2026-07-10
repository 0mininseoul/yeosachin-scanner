export class CanaryInputError extends Error {
    constructor(readonly category: string, message: string) {
        super(message);
    }
}

export interface SanitizedError {
    category: string;
    code: string;
    message: string;
}

const APIFY_ERROR_CODES = [
    ['APIFY_DATASET_TRANSPORT_EXHAUSTED', 'dataset_transport_exhausted'],
    ['APIFY_DATASET_OFFSET_MISMATCH', 'dataset_offset_mismatch'],
    ['APIFY_DATASET_COUNT_MISMATCH', 'dataset_count_mismatch'],
    ['APIFY_DATASET_TOTAL_CHANGED', 'dataset_total_changed'],
    ['APIFY_DATASET_TOTAL_LAGGING', 'dataset_total_lagging'],
    ['APIFY_DATASET_PAGE_EMPTY', 'dataset_page_empty'],
    ['APIFY_DATASET_LIMIT_EXCEEDED', 'dataset_limit_exceeded'],
    ['APIFY_DATASET_READ_INCOMPLETE', 'dataset_read_incomplete'],
    ['APIFY_RESULT_LIMIT_EXCEEDED', 'provider_result_limit_exceeded'],
] as const;

function stableApifyErrorCode(message: string): string | undefined {
    return APIFY_ERROR_CODES.find(([token]) => message.includes(token))?.[1];
}

export function sanitizeCanaryError(error: unknown): SanitizedError {
    if (error instanceof CanaryInputError) {
        return { category: error.category, code: error.category, message: error.message };
    }
    const message = error instanceof Error ? error.message : '';
    if (message.includes('CANARY_EMPTY_RELATIONSHIP_RESULT')) {
        return {
            category: 'incomplete',
            code: 'provider_empty_result',
            message: 'canary provider returned no relationship rows',
        };
    }
    const stableApifyCode = stableApifyErrorCode(message);
    if (stableApifyCode === 'dataset_transport_exhausted') {
        return {
            category: 'transport',
            code: stableApifyCode,
            message: 'canary provider transport failure',
        };
    }
    if (
        stableApifyCode === 'dataset_limit_exceeded' ||
        stableApifyCode === 'provider_result_limit_exceeded'
    ) {
        return {
            category: 'schema',
            code: stableApifyCode,
            message: 'canary provider schema failure',
        };
    }
    if (stableApifyCode) {
        return {
            category: 'incomplete',
            code: stableApifyCode,
            message: 'canary provider completeness failure',
        };
    }
    if (message.includes('SCRAPING_CONFIG_ERROR')) {
        return {
            category: 'configuration',
            code: 'provider_configuration_invalid',
            message: 'canary provider configuration failure',
        };
    }
    if (message.includes('SCRAPING_BUDGET_ERROR')) {
        const code = message.includes('quota reserve')
            ? 'quota_reserve_reached'
            : message.includes('cost ceiling')
              ? 'operation_cost_ceiling_reached'
              : 'operation_request_ceiling_reached';
        return { category: 'budget', code, message: 'canary provider budget guard stopped' };
    }
    if (message.includes('SCRAPING_SCHEMA_ERROR')) {
        const code = message.includes('dataset total')
            ? 'dataset_total_invalid'
            : message.includes('dataset items')
              ? 'dataset_items_invalid'
              : message.includes('username')
                ? 'target_username_mismatch'
                : message.includes('relationship type')
                  ? 'relationship_type_mismatch'
                  : 'provider_schema_invalid';
        return { category: 'schema', code, message: 'canary provider schema failure' };
    }
    if (message.includes('SCRAPING_INCOMPLETE_ERROR')) {
        const code = message.includes('total이 페이지 사이')
            ? 'dataset_total_changed'
            : message.includes('offset')
              ? 'dataset_offset_mismatch'
              : message.includes('count')
                ? 'dataset_count_mismatch'
                : message.includes('중간에서 비')
                  ? 'dataset_page_empty'
                  : message.includes('중복')
                    ? 'duplicate_ratio_exceeded'
                    : 'provider_result_incomplete';
        return { category: 'incomplete', code, message: 'canary provider completeness failure' };
    }
    if (message.includes('SCRAPING_TIMEOUT_ERROR')) {
        return { category: 'timeout', code: 'provider_timeout', message: 'canary provider timeout' };
    }
    const actorStatus = message.match(/status=([A-Z_]+)/)?.[1];
    if (actorStatus) {
        return {
            category: 'provider',
            code: `actor_status_${actorStatus.toLowerCase()}`,
            message: 'canary actor run failure',
        };
    }
    const httpStatus = message.match(/HTTP (\d{3})/)?.[1];
    if (httpStatus) {
        return {
            category: 'provider',
            code: `http_status_${httpStatus}`,
            message: 'canary provider HTTP failure',
        };
    }
    if (message.includes('transport request failed')) {
        return {
            category: 'transport',
            code: 'provider_transport_failed',
            message: 'canary provider transport failure',
        };
    }
    return {
        category: 'provider',
        code: 'provider_operation_failed',
        message: 'canary provider failure',
    };
}
