import {
    EpochError,
    canonicalDigest,
    epochFail,
    isObject,
    type ProtectedIamBinding,
    type ProtectedIamInput,
    type ProtectedIamPolicySnapshot,
} from './contracts';
import { AuthenticatedProtectedTransport } from './platform';

const HOSTS = new Set(['iam.googleapis.com', 'run.googleapis.com', 'cloudtasks.googleapis.com']);
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const LOCATION = /^[a-z][a-z0-9-]{0,62}$/;
const RESOURCE = /^[a-z][a-z0-9-]{0,62}$/;
const ETAG = /^[A-Za-z0-9+/_=-]{1,256}$/;
const MEMBER = /^(?:serviceAccount|group|user|domain):[^\s\u0000-\u001f\u007f]{1,256}$/;

function fail(code: 'RESOURCE_INVALID' | 'PROJECT_MISMATCH' | 'IAM_ETAG_REQUIRED' | 'ADAPTER_RESPONSE_INVALID' | 'ADAPTER_REQUEST_INVALID' | 'OBSERVATION_RACE'): never {
    epochFail(code);
}

function assertProject(value: string): void {
    if (!PROJECT.test(value)) fail('PROJECT_MISMATCH');
}

function assertBinding(value: unknown): asserts value is ProtectedIamBinding {
    if (!isObject(value) || typeof value.role !== 'string' || !/^roles\/[a-zA-Z0-9.]{1,128}$/.test(value.role)
        || typeof value.member !== 'string' || !MEMBER.test(value.member)) fail('ADAPTER_RESPONSE_INVALID');
    const condition = value.condition;
    if (condition !== null && typeof condition !== 'string'
        && (!isObject(condition) || Object.values(condition).some(item => typeof item !== 'string'))) {
        fail('ADAPTER_RESPONSE_INVALID');
    }
}

function normalizeBinding(binding: ProtectedIamBinding): ProtectedIamBinding {
    assertBinding(binding);
    return {
        role: binding.role,
        member: binding.member,
        condition: binding.condition === null ? null
            : typeof binding.condition === 'string' ? binding.condition
                : Object.fromEntries(Object.entries(binding.condition).sort(([left], [right]) => left.localeCompare(right))),
    };
}

function bindingKey(binding: ProtectedIamBinding): string {
    return canonicalDigest(normalizeBinding(binding));
}

function normalizeBindings(value: unknown): readonly ProtectedIamBinding[] {
    if (!Array.isArray(value)) fail('ADAPTER_RESPONSE_INVALID');
    const bindings = value.map(item => normalizeBinding(item as ProtectedIamBinding));
    const keys = new Set<string>();
    for (const binding of bindings) {
        const key = bindingKey(binding);
        if (keys.has(key)) fail('ADAPTER_RESPONSE_INVALID');
        keys.add(key);
    }
    return bindings.sort((left, right) => bindingKey(left).localeCompare(bindingKey(right)));
}

function assertPolicyResponse(value: unknown, resource: string, project: string): ProtectedIamPolicySnapshot {
    if (!isObject(value)) fail('ADAPTER_RESPONSE_INVALID');
    const etag = value.etag;
    if (typeof etag !== 'string' || !ETAG.test(etag)) fail('IAM_ETAG_REQUIRED');
    const bindings = normalizeBindings(value.bindings ?? []);
    return { resource, project, etag, bindings };
}

function parseResource(resource: string, kind: ProtectedIamInput['kind'], project: string): { host: string; path: string } {
    assertProject(project);
    if (kind === 'run' || kind === 'maintenance') {
        const match = resource.match(/^projects\/([^/]+)\/locations\/([^/]+)\/services\/([^/]+)$/);
        if (!match || match[1] !== project || !PROJECT.test(match[1]!) || !LOCATION.test(match[2]!) || !RESOURCE.test(match[3]!)) fail('RESOURCE_INVALID');
        return {
            host: 'run.googleapis.com',
            path: `/apis/serving.knative.dev/v1/namespaces/${match[1]}/services/${match[3]}`,
        };
    }
    if (kind === 'queue') {
        const match = resource.match(/^projects\/([^/]+)\/locations\/([^/]+)\/queues\/([^/]+)$/);
        if (!match || match[1] !== project || !PROJECT.test(match[1]!) || !LOCATION.test(match[2]!) || !RESOURCE.test(match[3]!)) fail('RESOURCE_INVALID');
        return { host: 'cloudtasks.googleapis.com', path: `/v2/${resource}` };
    }
    const match = resource.match(/^projects\/([^/]+)\/serviceAccounts\/([^/]+)$/);
    if (!match || match[1] !== project || !PROJECT.test(match[1]!)
        || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/.test(match[2]!)) fail('RESOURCE_INVALID');
    return { host: 'iam.googleapis.com', path: `/v1/${resource}` };
}

export type IamAdapterOptions = Readonly<{ transport: AuthenticatedProtectedTransport }>;

/** Resource-scoped IAM adapter. Every write uses the provider etag and reads it back. */
export class IamAdapter {
    private readonly transport: AuthenticatedProtectedTransport;

    constructor(options: IamAdapterOptions) {
        this.transport = options.transport;
    }

    async getPolicy(input: Pick<ProtectedIamInput, 'kind' | 'resource' | 'project'>): Promise<ProtectedIamPolicySnapshot> {
        const endpoint = parseResource(input.resource, input.kind, input.project);
        const path = `${endpoint.path}:getIamPolicy`;
        const { value } = await this.transport.json({
            method: 'POST',
            url: `https://${endpoint.host}${path}`,
            allowedHosts: HOSTS,
            allowedPath: candidate => candidate === path,
            acceptedStatuses: [200],
            body: {},
        });
        return assertPolicyResponse(value, input.resource, input.project);
    }

    async setPolicy(input: Pick<ProtectedIamInput, 'kind' | 'resource' | 'project'>, policy: ProtectedIamPolicySnapshot): Promise<ProtectedIamPolicySnapshot> {
        const endpoint = parseResource(input.resource, input.kind, input.project);
        if (policy.resource !== input.resource || policy.project !== input.project || typeof policy.etag !== 'string' || !ETAG.test(policy.etag)) fail('IAM_ETAG_REQUIRED');
        const bindings = normalizeBindings(policy.bindings);
        const path = `${endpoint.path}:setIamPolicy`;
        const { value } = await this.transport.json({
            method: 'POST',
            url: `https://${endpoint.host}${path}`,
            allowedHosts: HOSTS,
            allowedPath: candidate => candidate === path,
            acceptedStatuses: [200],
            body: { policy: { bindings, etag: policy.etag } },
        });
        const result = assertPolicyResponse(value, input.resource, input.project);
        if (canonicalDigest(result.bindings) !== canonicalDigest(bindings)) fail('OBSERVATION_RACE');
        return result;
    }

    async addBindings(input: ProtectedIamInput, additions: readonly ProtectedIamBinding[]): Promise<ProtectedIamPolicySnapshot> {
        const observed = await this.getPolicy(input);
        if (observed.etag !== input.etag) fail('OBSERVATION_RACE');
        const byKey = new Map(observed.bindings.map(binding => [bindingKey(binding), binding]));
        for (const addition of additions) {
            const normalized = normalizeBinding(addition);
            byKey.set(bindingKey(normalized), normalized);
        }
        const next: ProtectedIamPolicySnapshot = {
            resource: input.resource,
            project: input.project,
            etag: observed.etag,
            bindings: [...byKey.values()].sort((left, right) => bindingKey(left).localeCompare(bindingKey(right))),
        };
        return this.setPolicy(input, next);
    }

    async replaceBindings(input: ProtectedIamInput, bindings: readonly ProtectedIamBinding[]): Promise<ProtectedIamPolicySnapshot> {
        const observed = await this.getPolicy(input);
        if (observed.etag !== input.etag) fail('OBSERVATION_RACE');
        return this.setPolicy(input, {
            resource: input.resource,
            project: input.project,
            etag: observed.etag,
            bindings,
        });
    }
}

export { EpochError };
