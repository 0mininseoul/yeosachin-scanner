export interface InteractionJobState {
    kind: string;
    batch_index: number;
    status: 'running' | 'completed' | 'failed';
}

export function requireCompletedInteractionJob(
    jobs: readonly InteractionJobState[],
    kind: string,
    batchIndex: number
): void {
    const job = jobs.find(candidate =>
        candidate.kind === kind && candidate.batch_index === batchIndex
    );
    if (!job || job.status !== 'completed') {
        throw new Error(
            'INTERACTION_PROVIDER_ERROR: required interaction job did not complete.'
        );
    }
}

export function requireNoIncompleteInteractionJobs(
    jobs: readonly InteractionJobState[]
): void {
    if (jobs.some(job => job.status !== 'completed')) {
        throw new Error(
            'INTERACTION_PROVIDER_ERROR: incomplete interaction job cannot be scored.'
        );
    }
}
