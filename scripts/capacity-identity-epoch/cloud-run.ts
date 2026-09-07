import {
    EpochError,
    canonicalDigest,
    epochFail,
    isObject,
    type ProtectedRuntimeInput,
    type RuntimeSettings,
} from './contracts';
import {
    AuthenticatedProtectedTransport,
    parseProtectedObject,
} from './platform';

const HOSTS = new Set(['run.googleapis.com']);
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const LOCATION = /^[a-z][a-z0-9-]{0,62}$/;
const RESOURCE_NAME = /^[a-z][a-z0-9-]{0,62}$/;
const REVISION = /^[a-z][a-z0-9-]{0,62}$/;
const DECIMAL = /^[1-9][0-9]*$/;

function fail(code: 'RESOURCE_INVALID' | 'PROJECT_MISMATCH' | 'ADAPTER_REQUEST_INVALID' | 'ADAPTER_RESPONSE_INVALID' | 'OBSERVATION_RACE'): never {
    epochFail(code);
}

function assertProject(value: string): void {
    if (!PROJECT.test(value)) fail('PROJECT_MISMATCH');
}

function assertResource(resource: string): { project: string; location: string; service: string } {
    const match = resource.match(/^projects\/([^/]+)\/locations\/([^/]+)\/services\/([^/]+)$/);
    if (!match || !PROJECT.test(match[1]!) || !LOCATION.test(match[2]!) || !RESOURCE_NAME.test(match[3]!)) fail('RESOURCE_INVALID');
    return { project: match[1]!, location: match[2]!, service: match[3]! };
}

function assertGeneration(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !DECIMAL.test(value)) fail('ADAPTER_RESPONSE_INVALID');
}

function assertRevision(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !REVISION.test(value) || value === 'latest') fail('ADAPTER_RESPONSE_INVALID');
}

function asObject(value: unknown): Record<string, unknown> {
    if (!isObject(value)) fail('ADAPTER_RESPONSE_INVALID');
    return value;
}

function asTraffic(value: unknown): readonly Readonly<Record<string, unknown>>[] {
    if (!Array.isArray(value)) fail('ADAPTER_RESPONSE_INVALID');
    return value.map(entry => asObject(entry));
}

export type CloudRunTraffic = Readonly<{
    revisionName: string | null;
    percent: number;
    tag: string | null;
}>;

export type CloudRunServiceObservation = Readonly<{
    resource: string;
    project: string;
    location: string;
    service: string;
    generation: string;
    resourceVersion: string;
    latestCreatedRevision: string | null;
    latestReadyRevision: string | null;
    traffic: readonly CloudRunTraffic[];
    runtimeDigest: string;
    buildDigest: string;
    sourceSha: string;
    noTraffic: boolean;
    rawDigest: string;
}>;

function observeService(resource: string, body: Record<string, unknown>): CloudRunServiceObservation {
    const { project, location, service } = assertResource(resource);
    const metadata = asObject(body.metadata);
    const spec = asObject(body.spec);
    const status = asObject(body.status);
    assertProject(project);
    const generation = metadata.generation;
    const resourceVersion = metadata.resourceVersion;
    assertGeneration(generation);
    if (typeof resourceVersion !== 'string' || !DECIMAL.test(resourceVersion)) fail('ADAPTER_RESPONSE_INVALID');
    const latestCreatedRevision = status.latestCreatedRevisionName ?? null;
    const latestReadyRevision = status.latestReadyRevisionName ?? null;
    if (latestCreatedRevision !== null) assertRevision(latestCreatedRevision);
    if (latestReadyRevision !== null) assertRevision(latestReadyRevision);
    const traffic = asTraffic(status.traffic ?? spec.traffic ?? []).map(entry => {
        const revisionName = entry.revisionName ?? null;
        if (revisionName !== null) assertRevision(revisionName);
        if (!Number.isSafeInteger(entry.percent) || (entry.percent as number) < 0 || (entry.percent as number) > 100) fail('ADAPTER_RESPONSE_INVALID');
        const tag = entry.tag ?? null;
        if (tag !== null && (typeof tag !== 'string' || !REVISION.test(tag))) fail('ADAPTER_RESPONSE_INVALID');
        return { revisionName, percent: entry.percent as number, tag };
    });
    const template = asObject(spec.template ?? {});
    const templateMetadata = asObject(template.metadata ?? {});
    const annotations = asObject(templateMetadata.annotations ?? {});
    const labels = asObject(templateMetadata.labels ?? {});
    const runtimeDigest = typeof annotations['capacity.runtimeDigest'] === 'string'
        ? annotations['capacity.runtimeDigest'] : canonicalDigest(asObject(template.spec ?? {}));
    const buildDigest = typeof annotations['capacity.buildDigest'] === 'string'
        ? annotations['capacity.buildDigest'] : canonicalDigest(template);
    const sourceSha = typeof labels['capacity.sourceSha'] === 'string' ? labels['capacity.sourceSha'] : '';
    const noTraffic = traffic.length === 0 || traffic.every(entry => entry.percent === 0);
    return {
        resource, project, location, service, generation, resourceVersion,
        latestCreatedRevision, latestReadyRevision, traffic,
        runtimeDigest, buildDigest, sourceSha, noTraffic,
        rawDigest: canonicalDigest(body),
    };
}

export type CloudRunAdapterOptions = Readonly<{
    transport: AuthenticatedProtectedTransport;
}>;

/** Cloud Run Admin v1 adapter using exact service/revision paths and read-back. */
export class CloudRunAdapter {
    private readonly transport: AuthenticatedProtectedTransport;

    constructor(options: CloudRunAdapterOptions) {
        this.transport = options.transport;
    }

    async getService(resource: string): Promise<CloudRunServiceObservation> {
        const path = this.servicePath(resource);
        const { value } = await this.transport.json({
            method: 'GET',
            url: `https://run.googleapis.com${path}`,
            allowedHosts: HOSTS,
            allowedPath: candidate => candidate === path,
            acceptedStatuses: [200],
        });
        return observeService(resource, asObject(value));
    }

    async getRevision(project: string, location: string, revision: string): Promise<Record<string, unknown>> {
        assertProject(project);
        if (!LOCATION.test(location) || !REVISION.test(revision) || revision === 'latest') fail('RESOURCE_INVALID');
        const path = `/apis/serving.knative.dev/v1/namespaces/${project}/revisions/${revision}`;
        const { value } = await this.transport.json({
            method: 'GET',
            url: `https://run.googleapis.com${path}`,
            allowedHosts: HOSTS,
            allowedPath: candidate => candidate === path,
            acceptedStatuses: [200],
        });
        return asObject(value);
    }

    /**
     * Apply a reviewed Cloud Run service template.  Cloud Run has no request
     * CAS for this operation, so the caller must provide the fresh metadata
     * generation and this method verifies it before issuing exactly one
     * bounded PATCH and then exact read-back.
     */
    async applyService(options: Readonly<{
        resource: string;
        expectedGeneration: string;
        body: Readonly<Record<string, unknown>>;
        updateMask: 'template' | 'template,traffic' | 'traffic';
    }>): Promise<CloudRunServiceObservation> {
        const before = await this.getService(options.resource);
        assertGeneration(options.expectedGeneration);
        if (before.generation !== options.expectedGeneration) fail('OBSERVATION_RACE');
        if (!isObject(options.body)) fail('ADAPTER_REQUEST_INVALID');
        const path = this.servicePath(options.resource);
        const { value } = await this.transport.json({
            method: 'PATCH',
            url: `https://run.googleapis.com${path}?updateMask=${encodeURIComponent(options.updateMask)}`,
            allowedHosts: HOSTS,
            allowedPath: candidate => candidate === path,
            allowedQueryKeys: ['updateMask'],
            body: options.body,
            acceptedStatuses: [200],
        });
        const response = observeService(options.resource, asObject(value));
        if (response.generation === before.generation) fail('OBSERVATION_RACE');
        return response;
    }

    async stageRevision(options: Readonly<{
        runtime: ProtectedRuntimeInput;
        revision: string;
        expectedGeneration: string;
        serviceBody: Readonly<Record<string, unknown>>;
    }>): Promise<CloudRunServiceObservation> {
        if (options.runtime.project !== options.runtime.identity.project) fail('PROJECT_MISMATCH');
        if (!REVISION.test(options.revision) || options.revision === 'latest') fail('RESOURCE_INVALID');
        const body = asObject(options.serviceBody);
        const spec = asObject(body.spec);
        const template = asObject(spec.template);
        const metadata = asObject(template.metadata);
        if (metadata.name !== options.revision) fail('RESOURCE_INVALID');
        const traffic = spec.traffic;
        if (traffic !== undefined && (!Array.isArray(traffic) || traffic.some(item => {
            if (!isObject(item)) return true;
            return item.percent !== 0;
        }))) fail('RESOURCE_INVALID');
        return this.applyService({
            resource: `projects/${options.runtime.project}/locations/${options.runtime.location}/services/${options.runtime.service}`,
            expectedGeneration: options.expectedGeneration,
            body,
            updateMask: 'template',
        });
    }

    async setTraffic(options: Readonly<{
        resource: string;
        expectedGeneration: string;
        traffic: readonly Readonly<Record<string, unknown>>[];
        expectedRevision: string;
        expectedPercent: number;
    }>): Promise<CloudRunServiceObservation> {
        if (!REVISION.test(options.expectedRevision) || options.expectedRevision === 'latest'
            || !Number.isSafeInteger(options.expectedPercent) || options.expectedPercent < 0 || options.expectedPercent > 100) fail('RESOURCE_INVALID');
        const target = options.traffic.map(entry => ({ ...entry }));
        const response = await this.applyService({
            resource: options.resource,
            expectedGeneration: options.expectedGeneration,
            body: { traffic: target },
            updateMask: 'traffic',
        });
        const match = response.traffic.find(item => item.revisionName === options.expectedRevision);
        if (!match || match.percent !== options.expectedPercent) fail('OBSERVATION_RACE');
        if (options.expectedPercent === 100 && response.traffic.some(item => item.revisionName !== options.expectedRevision && item.percent !== 0)) {
            fail('OBSERVATION_RACE');
        }
        return response;
    }

    private servicePath(resource: string): string {
        const { project, service } = assertResource(resource);
        return `/apis/serving.knative.dev/v1/namespaces/${project}/services/${service}`;
    }
}

export { EpochError, RuntimeSettings };
