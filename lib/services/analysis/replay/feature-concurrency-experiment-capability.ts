const featureConcurrencyExperimentCapabilityBrand = Symbol(
    'feature-concurrency-4-cli-capability',
);
const parsedFeatureConcurrencyExperimentCapabilities = new WeakSet<object>();

export type FeatureConcurrencyExperimentCliCapability = Readonly<{
    [featureConcurrencyExperimentCapabilityBrand]: true;
}>;

/** Issues the replay-only experiment capability after both paid-run confirmations. */
export function parseFeatureConcurrencyExperimentCliCapability(
    args: readonly string[],
): FeatureConcurrencyExperimentCliCapability | undefined {
    const experimentCount = args.filter(
        arg => arg === '--feature-concurrency-4',
    ).length;
    const confirmCount = args.filter(
        arg => arg === '--confirm-feature-concurrency-4',
    ).length;
    if (experimentCount === 0 && confirmCount === 0) return undefined;
    if (experimentCount !== 1 || confirmCount !== 1) {
        throw new Error(
            'ANALYSIS_V2_REPLAY_FEATURE_CONCURRENCY_DOUBLE_CONFIRM_REQUIRED',
        );
    }
    if (
        !args.includes('--run')
        || !args.includes('--paid-ai')
        || !args.includes('--confirm-paid-ai')
        || !args.includes('--current-production')
    ) {
        throw new Error(
            'ANALYSIS_V2_REPLAY_FEATURE_CONCURRENCY_SCOPE_REQUIRED',
        );
    }
    const capability = Object.freeze({
        [featureConcurrencyExperimentCapabilityBrand]: true as const,
    });
    parsedFeatureConcurrencyExperimentCapabilities.add(capability);
    return capability;
}

export function isFeatureConcurrencyExperimentCliCapability(
    value: unknown,
): value is FeatureConcurrencyExperimentCliCapability {
    return typeof value === 'object'
        && value !== null
        && parsedFeatureConcurrencyExperimentCapabilities.has(value);
}
