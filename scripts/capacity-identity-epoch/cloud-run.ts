import {
    EpochError,
    canonicalDigest,
    epochFail,
    isObject,
    type ProtectedIdentity,
    type ProtectedRuntimeInput,
    type RuntimeSettings,
} from './contracts';
import { AuthenticatedProtectedTransport } from './platform';

const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const LOCATION = /^[a-z][a-z0-9-]{0,62}$/;
const RESOURCE_NAME = /^[a-z][a-z0-9-]{0,62}$/;
const REVISION = /^[a-z][a-z0-9-]{0,62}$/;
const DECIMAL = /^[1-9][0-9]*$/;
const IMAGE_REFERENCE = /^[^\s\u0000-\u001f\u007f]{1,2048}$/;
const IMAGE_DIGEST = /^.+@sha256:[0-9a-f]{64}$/;

function fail(code: 'RESOURCE_INVALID' | 'PROJECT_MISMATCH' | 'ADAPTER_REQUEST_INVALID' | 'ADAPTER_RESPONSE_INVALID' | 'OBSERVATION_RACE' | 'EVIDENCE_UNAVAILABLE' | 'RUNTIME_MISMATCH'): never {
    epochFail(code);
}

function object(value: unknown): Record<string, unknown> {
    if (!isObject(value)) fail('ADAPTER_RESPONSE_INVALID');
    return value;
}

function assertProject(value: string): void {
    if (!PROJECT.test(value)) fail('PROJECT_MISMATCH');
}

function parseResource(resource: string): { project: string; location: string; service: string } {
    const match = resource.match(/^projects\/([^/]+)\/locations\/([^/]+)\/services\/([^/]+)$/);
    if (!match || !PROJECT.test(match[1]!) || !LOCATION.test(match[2]!) || !RESOURCE_NAME.test(match[3]!)) fail('RESOURCE_INVALID');
    return { project: match[1]!, location: match[2]!, service: match[3]! };
}

function generation(value: unknown): string {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
    if (typeof value === 'string' && DECIMAL.test(value)) return value;
    fail('ADAPTER_RESPONSE_INVALID');
}

function assertRevision(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !REVISION.test(value) || value === 'latest') fail('ADAPTER_RESPONSE_INVALID');
}

function numberValue(value: unknown): number {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
    if (typeof value === 'string' && DECIMAL.test(value)) {
        const parsed = Number(value);
        if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
    }
    fail('ADAPTER_RESPONSE_INVALID');
}

function trafficProjection(value: readonly CloudRunTraffic[]): readonly CloudRunTraffic[] {
    return [...value].sort((left, right) => `${left.revisionName ?? ''}:${left.tag ?? ''}`.localeCompare(`${right.revisionName ?? ''}:${right.tag ?? ''}`));
}

export type CloudRunTraffic = Readonly<{ revisionName: string | null; percent: number; tag: string | null }>;

export type CloudRunServiceObservation = Readonly<{
    resource: string;
    project: string;
    location: string;
    service: string;
    generation: string;
    resourceVersion: string;
    observedGeneration: string;
    ready: boolean;
    latestCreatedRevision: string | null;
    latestReadyRevision: string | null;
    traffic: readonly CloudRunTraffic[];
    identity: ProtectedIdentity;
    environment: Readonly<Record<string, string>>;
    secretReferences: Readonly<Record<string, string>>;
    settings: RuntimeSettings;
    image: string;
    runtimeDigest: string;
    buildDigest: string;
    /** Source SHA is intentionally empty: Cloud Run labels are not source proof. */
    sourceSha: '';
    noTraffic: boolean;
    rawDigest: string;
    raw: Readonly<Record<string, unknown>>;
}>;

function parseEnvironment(container: Record<string, unknown>): { environment: Record<string, string>; secretReferences: Record<string, string> } {
    if (!Array.isArray(container.env)) fail('ADAPTER_RESPONSE_INVALID');
    const environment: Record<string, string> = {};
    const secretReferences: Record<string, string> = {};
    for (const item of container.env as unknown[]) {
        const env = object(item);
        if (typeof env.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(env.name) || Object.prototype.hasOwnProperty.call(environment, env.name)) fail('ADAPTER_RESPONSE_INVALID');
        if (typeof env.value === 'string') {
            environment[env.name] = env.value;
            continue;
        }
        const valueFrom = object(env.valueFrom);
        const ref = object(valueFrom.secretKeyRef);
        if (typeof ref.name !== 'string' || typeof ref.key !== 'string' || !/^[A-Za-z0-9._-]{1,240}$/.test(ref.name) || !/^[1-9][0-9]*$/.test(ref.key)) fail('ADAPTER_RESPONSE_INVALID');
        secretReferences[env.name] = `${ref.name}:${ref.key}`;
        environment[env.name] = `<secret:${env.name}>`;
    }
    return { environment, secretReferences };
}

function parseService(resource: string, body: Record<string, unknown>): CloudRunServiceObservation {
    const { project, location, service } = parseResource(resource);
    const metadata = object(body.metadata);
    const spec = object(body.spec);
    const status = object(body.status);
    const template = object(spec.template);
    const templateMetadata = object(template.metadata ?? {});
    const templateSpec = object(template.spec);
    const containers = templateSpec.containers;
    if (!Array.isArray(containers) || containers.length !== 1) fail('ADAPTER_RESPONSE_INVALID');
    const container = object(containers[0]);
    const image = container.image;
    if (typeof image !== 'string' || !IMAGE_REFERENCE.test(image)) fail('ADAPTER_RESPONSE_INVALID');
    const serviceAccountName = templateSpec.serviceAccountName;
    if (typeof serviceAccountName !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/.test(serviceAccountName)) fail('ADAPTER_RESPONSE_INVALID');
    const identity = { identity: serviceAccountName, project: serviceAccountName.split('@')[1]!.replace(/\.iam\.gserviceaccount\.com$/, '') };
    if (identity.project !== project) fail('PROJECT_MISMATCH');
    const parsedEnv = parseEnvironment(container);
    const resources = object(container.resources);
    const limits = object(resources.limits);
    if (typeof limits.cpu !== 'string' || typeof limits.memory !== 'string') fail('ADAPTER_RESPONSE_INVALID');
    const annotations = object(templateMetadata.annotations ?? {});
    const settings: RuntimeSettings = {
        cpu: limits.cpu,
        memory: limits.memory,
        concurrency: numberValue(templateSpec.containerConcurrency),
        timeoutSeconds: numberValue(templateSpec.timeoutSeconds),
        maxInstances: numberValue(annotations['autoscaling.knative.dev/maxScale']),
    };
    const generation = metadata.generation;
    const resourceVersion = metadata.resourceVersion;
    const generationValue = generationValueOrFail(generation);
    if (typeof resourceVersion !== 'string' || resourceVersion.length === 0 || resourceVersion.length > 512 || /[\u0000-\u001f\u007f]/.test(resourceVersion)) fail('ADAPTER_RESPONSE_INVALID');
    const observedGeneration = generationValueOrFail(status.observedGeneration);
    const conditions = status.conditions;
    if (!Array.isArray(conditions)) fail('ADAPTER_RESPONSE_INVALID');
    const ready = conditions.some(condition => {
        if (!isObject(condition)) return false;
        return condition.type === 'Ready' && condition.status === 'True';
    });
    const latestCreatedRevision = status.latestCreatedRevisionName ?? null;
    const latestReadyRevision = status.latestReadyRevisionName ?? null;
    if (latestCreatedRevision !== null) assertRevision(latestCreatedRevision);
    if (latestReadyRevision !== null) assertRevision(latestReadyRevision);
    const rawTraffic = status.traffic ?? spec.traffic ?? [];
    if (!Array.isArray(rawTraffic)) fail('ADAPTER_RESPONSE_INVALID');
    const traffic = rawTraffic.map(entry => {
        const item = object(entry);
        const revisionName = item.revisionName ?? null;
        if (revisionName !== null) assertRevision(revisionName);
        if (!Number.isSafeInteger(item.percent) || (item.percent as number) < 0 || (item.percent as number) > 100) fail('ADAPTER_RESPONSE_INVALID');
        const tag = item.tag ?? null;
        if (tag !== null && (typeof tag !== 'string' || !REVISION.test(tag))) fail('ADAPTER_RESPONSE_INVALID');
        return { revisionName, percent: item.percent as number, tag };
    });
    const runtimeDigest = canonicalDigest({ identity, environment: parsedEnv.environment, secretReferences: parsedEnv.secretReferences, settings });
    const buildDigest = canonicalDigest({ image });
    return {
        resource, project, location, service, generation: generationValue, resourceVersion, observedGeneration, ready, latestCreatedRevision, latestReadyRevision,
        traffic, identity, environment: parsedEnv.environment, secretReferences: parsedEnv.secretReferences, settings, image,
        runtimeDigest, buildDigest, sourceSha: '', noTraffic: traffic.length === 0 || traffic.every(entry => entry.percent === 0),
        rawDigest: canonicalDigest(body), raw: body,
    };
}

function generationValueOrFail(value: unknown): string {
    return generation(value);
}

export type CloudRunAdapterOptions = Readonly<{ transport: AuthenticatedProtectedTransport }>;

/** Cloud Run v1 regional adapter: GET/PUT Service and independent GET read-back. */
export class CloudRunAdapter {
    private readonly transport: AuthenticatedProtectedTransport;

    constructor(options: CloudRunAdapterOptions) {
        this.transport = options.transport;
    }

    async getService(resource: string): Promise<CloudRunServiceObservation> {
        const parsed = parseResource(resource);
        const path = this.servicePath(parsed.project, parsed.service);
        const { value } = await this.transport.json({
            method: 'GET', url: `https://${parsed.location}-run.googleapis.com${path}`,
            allowedHosts: new Set([`${parsed.location}-run.googleapis.com`]), allowedPath: candidate => candidate === path, allowedMethods: ['GET'],
            allowedQueryKeys: [], acceptedStatuses: [200],
        });
        return parseService(resource, object(value));
    }

    async getRevision(project: string, location: string, revision: string): Promise<Record<string, unknown>> {
        assertProject(project);
        if (!LOCATION.test(location) || !REVISION.test(revision) || revision === 'latest') fail('RESOURCE_INVALID');
        const path = `/apis/serving.knative.dev/v1/namespaces/${project}/revisions/${revision}`;
        const { value } = await this.transport.json({
            method: 'GET', url: `https://${location}-run.googleapis.com${path}`,
            allowedHosts: new Set([`${location}-run.googleapis.com`]), allowedPath: candidate => candidate === path, allowedMethods: ['GET'],
            allowedQueryKeys: [], acceptedStatuses: [200],
        });
        const revisionObject = object(value);
        this.validateRevisionWire(revisionObject, revision);
        return revisionObject;
    }

    async applyService(options: Readonly<{
        resource: string;
        expectedGeneration: string;
        body: Readonly<Record<string, unknown>>;
        /** Retained for source compatibility; v1 uses PUT, not updateMask. */
        updateMask?: 'template' | 'template,traffic' | 'traffic';
    }>): Promise<CloudRunServiceObservation> {
        const before = await this.getService(options.resource);
        if (!DECIMAL.test(options.expectedGeneration)) fail('ADAPTER_REQUEST_INVALID');
        if (before.generation !== options.expectedGeneration) fail('OBSERVATION_RACE');
        const parsed = parseResource(options.resource);
        const path = this.servicePath(parsed.project, parsed.service);
        const body = object(options.body);
        const metadata = object(body.metadata ?? {});
        const requestBody = { ...body, metadata: { ...metadata, resourceVersion: before.resourceVersion } };
        await this.transport.json({
            method: 'PUT', url: `https://${parsed.location}-run.googleapis.com${path}`,
            allowedHosts: new Set([`${parsed.location}-run.googleapis.com`]), allowedPath: candidate => candidate === path, allowedMethods: ['PUT'],
            allowedQueryKeys: [], body: requestBody, acceptedStatuses: [200],
        });
        const after = await this.getService(options.resource);
        if (after.generation === before.generation || after.resourceVersion === before.resourceVersion
            || after.observedGeneration !== after.generation || !after.ready) fail('OBSERVATION_RACE');
        return after;
    }

    async stageRevision(options: Readonly<{
        runtime: ProtectedRuntimeInput;
        revision: string;
        expectedGeneration: string;
        serviceBody: Readonly<Record<string, unknown>>;
    }>): Promise<CloudRunServiceObservation> {
        if (options.runtime.project !== options.runtime.identity.project) fail('PROJECT_MISMATCH');
        if (!REVISION.test(options.revision) || options.revision === 'latest') fail('RESOURCE_INVALID');
        const body = object(options.serviceBody);
        const spec = object(body.spec);
        const template = object(spec.template);
        const metadata = object(template.metadata);
        if (metadata.name !== options.revision) fail('RESOURCE_INVALID');
        const resource = `projects/${options.runtime.project}/locations/${options.runtime.location}/services/${options.runtime.service}`;
        const before = await this.getService(resource);
        const after = await this.applyService({ resource, expectedGeneration: options.expectedGeneration, body });
        const beforeTraffic = new Map(before.traffic.map(entry => [`${entry.revisionName ?? ''}:${entry.tag ?? ''}`, entry.percent]));
        const afterTraffic = new Map(after.traffic.map(entry => [`${entry.revisionName ?? ''}:${entry.tag ?? ''}`, entry.percent]));
        for (const [key, percent] of beforeTraffic) if (afterTraffic.get(key) !== percent) fail('OBSERVATION_RACE');
        for (const [key, percent] of afterTraffic) if (!beforeTraffic.has(key) && percent !== 0) fail('OBSERVATION_RACE');
        const stagedTraffic = after.traffic.find(entry => entry.revisionName === options.revision);
        if (stagedTraffic && stagedTraffic.percent !== 0) fail('OBSERVATION_RACE');
        const revisionObject = await this.getRevision(options.runtime.project, options.runtime.location, options.revision);
        this.assertRevisionMatches(revisionObject, options.runtime, options.revision);
        if (after.latestCreatedRevision !== options.revision && after.latestReadyRevision !== options.revision) fail('OBSERVATION_RACE');
        return after;
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
        const before = await this.getService(options.resource);
        const body = object(before.raw);
        const spec = object(body.spec);
        const after = await this.applyService({
            resource: options.resource, expectedGeneration: options.expectedGeneration,
            body: { ...body, spec: { ...spec, traffic: options.traffic.map(entry => ({ ...entry })) } },
        });
        const match = after.traffic.find(item => item.revisionName === options.expectedRevision);
        if (!match || match.percent !== options.expectedPercent) fail('OBSERVATION_RACE');
        if (options.expectedPercent === 100 && after.traffic.some(item => item.revisionName !== options.expectedRevision && item.percent !== 0)) fail('OBSERVATION_RACE');
        return after;
    }

    private servicePath(project: string, service: string): string {
        return `/apis/serving.knative.dev/v1/namespaces/${project}/services/${service}`;
    }

    private assertRevisionMatches(body: Record<string, unknown>, runtime: ProtectedRuntimeInput, revision: string): void {
        const metadata = object(body.metadata);
        if (metadata.name !== revision) fail('OBSERVATION_RACE');
        const spec = object(body.spec);
        const serviceAccountName = spec.serviceAccountName;
        if (serviceAccountName !== runtime.identity.identity) fail('OBSERVATION_RACE');
        const containers = spec.containers;
        if (!Array.isArray(containers) || containers.length !== 1) fail('ADAPTER_RESPONSE_INVALID');
        const container = object(containers[0]);
        if (typeof container.image !== 'string' || !IMAGE_REFERENCE.test(container.image)) fail('ADAPTER_RESPONSE_INVALID');
        const parsedEnv = parseEnvironment(container);
        const resources = object(container.resources);
        const limits = object(resources.limits);
        const annotations = object(metadata.annotations ?? {});
        const actualSettings: RuntimeSettings = {
            cpu: typeof limits.cpu === 'string' ? limits.cpu : fail('ADAPTER_RESPONSE_INVALID'),
            memory: typeof limits.memory === 'string' ? limits.memory : fail('ADAPTER_RESPONSE_INVALID'),
            concurrency: numberValue(spec.containerConcurrency),
            timeoutSeconds: numberValue(spec.timeoutSeconds),
            maxInstances: numberValue(annotations['autoscaling.knative.dev/maxScale']),
        };
        if (canonicalDigest(parsedEnv.environment) !== canonicalDigest(runtime.environment)
            || canonicalDigest(parsedEnv.secretReferences) !== canonicalDigest(runtime.secretReferences)
            || canonicalDigest(actualSettings) !== canonicalDigest(runtime.settings)) fail('RUNTIME_MISMATCH');
        const status = object(body.status ?? {});
        if (!Array.isArray(status.conditions) || !status.conditions.some(condition => isObject(condition) && condition.type === 'Ready' && condition.status === 'True')) fail('OBSERVATION_RACE');
        if (typeof status.imageDigest !== 'string' || !IMAGE_DIGEST.test(status.imageDigest)) fail('ADAPTER_RESPONSE_INVALID');
    }

    private validateRevisionWire(body: Record<string, unknown>, revision: string): void {
        const metadata = object(body.metadata);
        if (metadata.name !== revision || !Number.isSafeInteger(metadata.generation) || (metadata.generation as number) <= 0) fail('ADAPTER_RESPONSE_INVALID');
        const status = object(body.status);
        if (!Number.isSafeInteger(status.observedGeneration) || status.observedGeneration !== metadata.generation || !Array.isArray(status.conditions)
            || !status.conditions.some(condition => isObject(condition) && condition.type === 'Ready' && condition.status === 'True')
            || typeof status.imageDigest !== 'string' || !IMAGE_DIGEST.test(status.imageDigest)) fail('ADAPTER_RESPONSE_INVALID');
    }
}

export { EpochError, RuntimeSettings };
