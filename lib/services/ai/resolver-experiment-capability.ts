const resolverExperimentCapabilityBrand = Symbol('resolver-experiment-capability');

export interface ResolverExperimentCapability {
    readonly [resolverExperimentCapabilityBrand]: true;
}

const issued = new WeakSet<object>();

/** Issued only by the sealed replay adapter; production policy code never calls this. */
export function issueResolverExperimentCapability(): ResolverExperimentCapability {
    const capability = Object.freeze({
        [resolverExperimentCapabilityBrand]: true as const,
    });
    issued.add(capability);
    return capability;
}

export function isResolverExperimentCapability(
    value: unknown,
): value is ResolverExperimentCapability {
    return typeof value === 'object' && value !== null && issued.has(value);
}
