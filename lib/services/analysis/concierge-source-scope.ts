export type ConciergeSourceRequest = {
    id: string;
    user_id: string;
    target_instagram_id: string | null;
    status: string;
    pipeline_version: string | null;
    step_data?: unknown;
};

function isRetainedTargetPlaceholder(value: string): boolean {
    return /^retained\.[0-9a-f]{20}$/i.test(value);
}

export function selectConciergeSourceRequest(
    requests: readonly ConciergeSourceRequest[],
    scope: {
        sourceRequestId: string;
        userId: string;
        targetInstagramId: string;
    },
): ConciergeSourceRequest {
    const source = requests.find(request => (
        request.id === scope.sourceRequestId
        && request.user_id === scope.userId
        && (request.target_instagram_id === null
            || request.target_instagram_id === scope.targetInstagramId
            || isRetainedTargetPlaceholder(request.target_instagram_id))
        && request.pipeline_version === 'v2'
        && request.status === 'failed'
    ));
    if (!source) throw new Error('CONCIERGE_SAMPLE_REQUEST_SCOPE_CONFLICT');
    return source;
}
