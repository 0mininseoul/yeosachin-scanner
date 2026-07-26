const replayCapabilityBrand = Symbol('replay-stateless-capability');
const issuedReplayCapabilities = new WeakSet<object>();

export type ReplayStatelessCapability = {
    readonly [replayCapabilityBrand]: true;
};

export function issueReplayStatelessCapability(): ReplayStatelessCapability {
    const capability = Object.freeze({
        [replayCapabilityBrand]: true as const,
    });
    issuedReplayCapabilities.add(capability);
    return capability;
}

export function isReplayStatelessCapability(
    value: unknown,
): value is ReplayStatelessCapability {
    return (
        typeof value === 'object'
        && value !== null
        && issuedReplayCapabilities.has(value)
    );
}
