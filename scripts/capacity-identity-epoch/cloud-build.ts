import {
    canonicalDigest,
    epochFail,
    isObject,
    type ProtectedBuildInput,
    type ProtectedRuntimeInput,
    type Role,
} from './contracts';
import { AuthenticatedProtectedTransport } from './platform';

const HOSTS = new Set(['cloudbuild.googleapis.com']);
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const LOCATION = /^[a-z][a-z0-9-]{0,62}$/;
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

function buildSourceMatches(build: Record<string, unknown>, input: ProtectedBuildInput): boolean {
    const provenance = object(build.sourceProvenance);
    const repo = isObject(provenance.resolvedRepoSource) ? provenance.resolvedRepoSource : undefined;
    const storage = isObject(provenance.resolvedStorageSource) ? provenance.resolvedStorageSource : undefined;
    const sourceSha = repo?.commitSha ?? repo?.revision ?? storage?.generation;
    if (sourceSha !== input.sourceSha) return false;
    const contexts = [
        repo?.repoName,
        repo?.url,
        repo?.dir,
        storage && typeof storage.bucket === 'string' && typeof storage.object === 'string'
            ? `${storage.bucket}/${storage.object}` : undefined,
        storage && typeof storage.bucket === 'string' && typeof storage.object === 'string' && typeof storage.generation === 'string'
            ? `${storage.bucket}/${storage.object}#${storage.generation}` : undefined,
    ].filter((value): value is string => typeof value === 'string');
    return contexts.includes(input.sourceContext);
}

function substitutionsMatch(build: Record<string, unknown>, expected: Readonly<Record<string, string>>): boolean {
    const substitutions = build.substitutions;
    if (!isObject(substitutions)) return false;
    const normalized = Object.fromEntries(Object.entries(substitutions)
        .filter(([key]) => key.startsWith('_'))
        .map(([key, value]) => [key.slice(1), value]));
    return canonicalDigest(normalized) === canonicalDigest(expected);
}

function imageMatches(build: Record<string, unknown>, image: string): boolean {
    const results = object(build.results);
    if (!Array.isArray(results.images)) return false;
    return results.images.some(entry => {
        if (!isObject(entry) || typeof entry.name !== 'string' || typeof entry.digest !== 'string') return false;
        return `${entry.name}@${entry.digest.replace(/^sha256:/, 'sha256:')}` === image;
    });
}

function buildIdentityMatches(build: Record<string, unknown>, expected: ProtectedBuildInput): boolean {
    return build.serviceAccount === expected.identity.identity;
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
    private readonly builds: Readonly<Record<'old' | 'desired', ProtectedBuildInput>>;
    private readonly runtimes: Readonly<Record<'old' | 'desired', Readonly<Record<Role, ProtectedRuntimeInput>>>>;

    constructor(options: Readonly<{
        transport: AuthenticatedProtectedTransport;
        builds: Readonly<Record<'old' | 'desired', ProtectedBuildInput>>;
        runtimes: Readonly<Record<'old' | 'desired', Readonly<Record<Role, ProtectedRuntimeInput>>>>;
    }>) {
        this.transport = options.transport;
        this.builds = options.builds;
        this.runtimes = options.runtimes;
    }

    async sourceObservation(input: Readonly<{ role: Role; phase: 'old' | 'desired'; revision: string; runtime: ProtectedRuntimeInput }>): Promise<Readonly<{ role: Role; sourceSha: string; revision: string; metadataDigest: string }>> {
        const build = await this.findExactBuild(input.role, input.phase, undefined);
        const sourceProvenance = object(build.sourceProvenance);
        return {
            role: input.role,
            sourceSha: this.builds[input.phase].sourceSha,
            revision: input.revision,
            metadataDigest: canonicalDigest(sourceProvenance),
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
            if (!Array.isArray(body.builds)) fail('ADAPTER_RESPONSE_INVALID');
            for (const item of body.builds) {
                const build = object(item);
                if (build.status !== 'SUCCESS' || !buildIdentityMatches(build, expected)
                    || !buildSourceMatches(build, expected) || !substitutionsMatch(build, expected.buildArguments)
                    || (image !== undefined && !imageMatches(build, image))) continue;
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
