import {
    canonicalDigest,
    epochFail,
    isObject,
    isBuildArgumentValue,
    type ProtectedBuildInput,
    type ProtectedRuntimeInput,
    type ProtectedOldObservations,
    type Role,
} from './contracts';
import { AuthenticatedProtectedTransport } from './platform';
import { normalizeStorageSource, storageSourceContext, type StorageSourceVerifier } from './storage-source';

const HOSTS = new Set(['cloudbuild.googleapis.com']);
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const LOCATION = /^[a-z][a-z0-9-]{0,62}$/;
const PROOF_SHA1 = /^[0-9a-f]{40}$/;
const PROOF_SHA256 = /^[0-9a-f]{64}$/;
const MAX_PAGES = 100;

function fail(code: 'ADAPTER_REQUEST_INVALID' | 'ADAPTER_RESPONSE_INVALID' | 'EVIDENCE_UNAVAILABLE' | 'SOURCE_INVALID'): never {
    epochFail(code);
}

function object(value: unknown): Record<string, unknown> {
    if (!isObject(value)) fail('ADAPTER_RESPONSE_INVALID');
    return value;
}

function safe(value: unknown, max = 4096): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

async function buildSourceMatches(build: Record<string, unknown>, input: ProtectedBuildInput, verifier?: StorageSourceVerifier): Promise<boolean> {
    const provenance = object(build.sourceProvenance);
    const rawRepo = provenance.resolvedRepoSource;
    const rawStorage = provenance.resolvedStorageSource;
    if ((rawRepo !== undefined && !isObject(rawRepo)) || (rawStorage !== undefined && !isObject(rawStorage))) return false;
    const repo = isObject(rawRepo) ? rawRepo : undefined;
    if (repo && rawStorage !== undefined) return false;
    if (repo) {
        const sourceSha = repo.commitSha ?? repo.revision;
        if (sourceSha !== input.sourceSha) return false;
        const contexts = [repo.repoName, repo.url, repo.dir]
            .filter((value): value is string => typeof value === 'string');
        return contexts.includes(input.sourceContext);
    }
    const storage = normalizeStorageSource(provenance.resolvedStorageSource);
    if (!storage || !verifier || !PROOF_SHA1.test(input.sourceSha)
        || input.sourceContext !== storageSourceContext(storage)) return false;
    const proof = await verifier({ source: storage, reviewedSha: input.sourceSha });
    return isObject(proof)
        && proof.reviewedSha === input.sourceSha
        && proof.sourceContext === input.sourceContext
        && proof.sourceBucket === storage.bucket
        && proof.sourceObject === storage.object
        && proof.sourceGeneration === storage.generation
        && typeof proof.archiveSha256 === 'string'
        && PROOF_SHA256.test(proof.archiveSha256);
}

function substitutionsMatch(build: Record<string, unknown>, expected: Readonly<Record<string, string>>): boolean {
    const substitutions = build.substitutions;
    if (!isObject(substitutions)) return false;
    const normalized = Object.fromEntries(Object.entries(substitutions)
        .filter(([key]) => key.startsWith('_'))
        .map(([key, value]) => [key.slice(1), value]));
    return canonicalDigest(normalized) === canonicalDigest(expected);
}

function immutableImageReference(image: string): string | null {
    const match = /^([^@\s]+)@sha256:([0-9a-f]{64})$/.exec(image);
    if (!match) return null;
    const name = match[1]!;
    const colon = name.lastIndexOf(':');
    // Cloud Run resolves a digest-pinned image and omits its optional tag.
    // Repository and content digest must still match exactly.
    const repository = colon > name.lastIndexOf('/') ? name.slice(0, colon) : name;
    return repository ? `${repository}@sha256:${match[2]}` : null;
}

function imageMatches(build: Record<string, unknown>, image: string): boolean {
    const expected = immutableImageReference(image);
    if (expected === null) return false;
    const results = object(build.results);
    if (!Array.isArray(results.images)) return false;
    return results.images.some(entry => {
        if (!isObject(entry) || typeof entry.name !== 'string' || typeof entry.digest !== 'string') return false;
        return immutableImageReference(`${entry.name}@${entry.digest}`) === expected;
    });
}

function buildIdentityMatches(build: Record<string, unknown>, expected: ProtectedBuildInput): boolean {
    return build.serviceAccount === expected.identity.identity
        || build.serviceAccount === `projects/${expected.identity.project}/serviceAccounts/${expected.identity.identity}`;
}

/** Bind each historical build's inputs, rather than assuming both roles shared a build. */
export function observedBuildMetadataDigest(build: Readonly<Record<string, unknown>>, input: ProtectedBuildInput): string {
    return canonicalDigest({ sourceProvenance: object(build.sourceProvenance), buildInput: input });
}

function observedBuildInput(build: Record<string, unknown>, identity: ProtectedBuildInput['identity'], sourceSha: string): ProtectedBuildInput | null {
    if (!isObject(build.sourceProvenance) || !isObject(build.substitutions)) return null;
    const provenance = build.sourceProvenance;
    const storage = normalizeStorageSource(provenance.resolvedStorageSource);
    const repo = isObject(provenance.resolvedRepoSource) ? provenance.resolvedRepoSource : undefined;
    const context = storage ? storageSourceContext(storage) : repo?.repoName ?? repo?.url ?? repo?.dir;
    if (!safe(context)) return null;
    const buildArguments: Record<string, string> = {};
    for (const [key, value] of Object.entries(build.substitutions)) {
        if (!key.startsWith('_')) continue;
        if (!isBuildArgumentValue(value)) return null;
        buildArguments[key.slice(1)] = value;
    }
    return { identity, sourceSha, sourceContext: context, buildArguments };
}

/**
 * Read-only Cloud Build provenance.  It intentionally lists and fully pages
 * successful regional builds, then requires one exact source/context,
 * substitutions, service account, and produced image match.  The adapter
 * never creates a build, chooses "latest", or treats a packet digest as
 * provider provenance.
 */
export class CloudBuildAdapter {
    private readonly transport: AuthenticatedProtectedTransport;
    private readonly storageSourceVerifier?: StorageSourceVerifier;
    private readonly oldObservations?: Pick<ProtectedOldObservations, 'source' | 'runtime'>;
    private readonly builds: Readonly<Record<'old' | 'desired', ProtectedBuildInput>>;
    private readonly runtimes: Readonly<Record<'old' | 'desired', Readonly<Record<Role, ProtectedRuntimeInput>>>>;

    constructor(options: Readonly<{
        transport: AuthenticatedProtectedTransport;
        builds: Readonly<Record<'old' | 'desired', ProtectedBuildInput>>;
        runtimes: Readonly<Record<'old' | 'desired', Readonly<Record<Role, ProtectedRuntimeInput>>>>;
        storageSourceVerifier?: StorageSourceVerifier;
        oldObservations?: Pick<ProtectedOldObservations, 'source' | 'runtime'>;
    }>) {
        this.transport = options.transport;
        this.storageSourceVerifier = options.storageSourceVerifier;
        this.oldObservations = options.oldObservations;
        this.builds = options.builds;
        this.runtimes = options.runtimes;
    }

    async sourceObservation(input: Readonly<{ role: Role; phase: 'old' | 'desired'; revision: string; runtime: ProtectedRuntimeInput }>): Promise<Readonly<{ role: Role; sourceSha: string; revision: string; metadataDigest: string }>> {
        const build = await this.findExactBuild(input.role, input.phase, undefined);
        const sourceProvenance = object(build.sourceProvenance);
        const historicalInput = input.phase === 'old' && this.oldObservations
            ? observedBuildInput(build, this.builds.old.identity, this.runtimes.old[input.role].sourceSha) : null;
        return {
            role: input.role,
            sourceSha: historicalInput?.sourceSha ?? this.builds[input.phase].sourceSha,
            revision: input.revision,
            metadataDigest: historicalInput ? observedBuildMetadataDigest(build, historicalInput) : canonicalDigest(sourceProvenance),
        };
    }

    async buildObservation(input: Readonly<{ role: Role; phase: 'old' | 'desired'; revision: string; image: string }>): Promise<string> {
        const build = await this.findExactBuild(input.role, input.phase, input.image);
        if (!imageMatches(build, input.image)) fail('SOURCE_INVALID');
        // The old packet stores the observed image digest; desired packets
        // store the reviewed immutable build-input digest. Both are derived
        // only after the provider's exact image/provenance match above.
        return input.phase === 'old' ? canonicalDigest({ image: input.image }) : canonicalDigest(this.builds[input.phase]);
    }

    private async findExactBuild(role: Role, phase: 'old' | 'desired', image: string | undefined): Promise<Record<string, unknown>> {
        const runtime = this.runtimes[phase][role];
        const expected = this.builds[phase];
        if (!PROJECT.test(runtime.project) || !LOCATION.test(runtime.location)
            || !safe(expected.sourceSha, 128) || !safe(expected.sourceContext, 4096)) fail('ADAPTER_REQUEST_INVALID');
        const path = `/v1/projects/${encodeURIComponent(runtime.project)}/locations/${encodeURIComponent(runtime.location)}/builds`;
        let pageToken: string | undefined;
        const matches: Record<string, unknown>[] = [];
        const seenTokens = new Set<string>();
        for (let page = 0; page < MAX_PAGES; page += 1) {
            const query = new URLSearchParams({ filter: 'status="SUCCESS"', pageSize: '100' });
            if (pageToken !== undefined) query.set('pageToken', pageToken);
            const { value } = await this.transport.json({
                method: 'GET',
                url: `https://cloudbuild.googleapis.com${path}?${query.toString()}`,
                allowedHosts: HOSTS,
                allowedPath: candidate => candidate === path,
                allowedMethods: ['GET'],
                allowedQueryKeys: pageToken === undefined ? ['filter', 'pageSize'] : ['filter', 'pageSize', 'pageToken'],
                acceptedStatuses: [200],
            });
            const body = object(value);
            const builds = body.builds === undefined ? [] : body.builds;
            if (!Array.isArray(builds)) fail('ADAPTER_RESPONSE_INVALID');
            for (const item of builds) {
                const build = object(item);
                if (build.status !== 'SUCCESS' || !buildIdentityMatches(build, expected)
                    || (image !== undefined && !imageMatches(build, image))) continue;
                let sourceInput = expected;
                if (phase === 'old' && this.oldObservations) {
                    const observed = this.oldObservations;
                    const historicalInput = observedBuildInput(build, expected.identity, runtime.sourceSha);
                    if (!historicalInput || observed.source[role].sourceSha !== runtime.sourceSha
                        || observed.runtime[role].sourceSha !== runtime.sourceSha
                        || observedBuildMetadataDigest(build, historicalInput) !== observed.source[role].metadataDigest) continue;
                    const images = object(build.results).images;
                    if (!Array.isArray(images) || !images.some(entry => isObject(entry)
                        && typeof entry.name === 'string' && typeof entry.digest === 'string'
                        && /^sha256:[0-9a-f]{64}$/.test(entry.digest)
                        && canonicalDigest({ image: `${entry.name}@${entry.digest}` }) === observed.runtime[role].buildDigest)) continue;
                    sourceInput = historicalInput;
                } else if (!substitutionsMatch(build, expected.buildArguments)) continue;
                if (!(await buildSourceMatches(build, sourceInput, this.storageSourceVerifier))) continue;
                matches.push(build);
            }
            if (body.nextPageToken === undefined || body.nextPageToken === '') break;
            if (!safe(body.nextPageToken, 2048) || seenTokens.has(body.nextPageToken)) fail('ADAPTER_RESPONSE_INVALID');
            seenTokens.add(body.nextPageToken);
            pageToken = body.nextPageToken;
        }
        if (pageToken !== undefined && seenTokens.size >= MAX_PAGES) fail('EVIDENCE_UNAVAILABLE');
        if (matches.length !== 1) fail('EVIDENCE_UNAVAILABLE');
        return matches[0]!;
    }
}
