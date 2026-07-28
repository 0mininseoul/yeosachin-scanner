const diagnosticPartialCoverageCapabilityBrand = Symbol(
    'diagnostic-partial-coverage-cli-capability',
);
const parsedDiagnosticPartialCoverageCapabilities = new WeakSet<object>();

export type DiagnosticPartialCoverageCliCapability = Readonly<{
    [diagnosticPartialCoverageCapabilityBrand]: true;
}>;

/**
 * Issues an in-memory capability only after independently parsing both
 * diagnostic confirmations in their paid historical-partial CLI scope.
 * The capability cannot be serialized or reconstructed by direct callers.
 */
export function parseDiagnosticPartialCoverageCliCapability(
    args: readonly string[],
): DiagnosticPartialCoverageCliCapability | undefined {
    const allowCount = args.filter(
        arg => arg === '--allow-low-partial-coverage',
    ).length;
    const confirmCount = args.filter(
        arg => arg === '--confirm-low-partial-coverage',
    ).length;
    if (allowCount === 0 && confirmCount === 0) return undefined;
    if (allowCount !== 1 || confirmCount !== 1) {
        throw new Error(
            'ANALYSIS_V2_REPLAY_LOW_PARTIAL_COVERAGE_DOUBLE_CONFIRM_REQUIRED',
        );
    }
    if (
        !args.includes('--run')
        || !args.includes('--paid-ai')
        || !args.includes('--confirm-paid-ai')
        || !args.includes('--historical-partial-available')
    ) {
        throw new Error(
            'ANALYSIS_V2_REPLAY_LOW_PARTIAL_COVERAGE_SCOPE_REQUIRED',
        );
    }
    const capability = Object.freeze({
        [diagnosticPartialCoverageCapabilityBrand]: true as const,
    });
    parsedDiagnosticPartialCoverageCapabilities.add(capability);
    return capability;
}

export function isDiagnosticPartialCoverageCliCapability(
    value: unknown,
): value is DiagnosticPartialCoverageCliCapability {
    return (
        typeof value === 'object'
        && value !== null
        && parsedDiagnosticPartialCoverageCapabilities.has(value)
    );
}
