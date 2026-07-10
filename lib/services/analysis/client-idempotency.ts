export interface AnalysisStartIdempotency {
    fingerprint: string;
    key: string;
}

export function getAnalysisStartIdempotency(
    current: AnalysisStartIdempotency | null,
    targetInstagramId: string,
    targetGender: 'male' | 'female',
    createKey: () => string = () => crypto.randomUUID()
): AnalysisStartIdempotency {
    const fingerprint = `${targetInstagramId.trim().replace(/^@/, '').toLowerCase()}:${targetGender}`;
    if (current?.fingerprint === fingerprint) return current;
    return { fingerprint, key: createKey() };
}
