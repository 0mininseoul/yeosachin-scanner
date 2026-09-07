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
const ROLE = /^(?:roles\/[A-Za-z0-9._-]{1,256}|projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/roles\/[A-Za-z0-9._-]{1,256}|organizations\/[0-9]+\/roles\/[A-Za-z0-9._-]{1,256})$/;
const MEMBER = /^(?:allUsers|allAuthenticatedUsers|serviceAccount|group|user|domain|principal|principalSet):[^\s\u0000-\u001f\u007f]{1,1023}$|^(?:allUsers|allAuthenticatedUsers)$/;

type WireCondition = Readonly<{ title?: string; description?: string; expression?: string; location?: string }>;
type WireBinding = Readonly<{ role: string; members: readonly string[]; condition?: WireCondition }>;
type WirePolicy = Readonly<{
    version: number;
    etag: string;
    bindings: readonly WireBinding[];
    auditConfigs?: readonly unknown[];
}>;

function fail(code: 'RESOURCE_INVALID' | 'PROJECT_MISMATCH' | 'IAM_ETAG_REQUIRED' | 'ADAPTER_RESPONSE_INVALID' | 'ADAPTER_REQUEST_INVALID' | 'OBSERVATION_RACE'): never {
    epochFail(code);
}

function assertProject(value: string): void {
    if (!PROJECT.test(value)) fail('PROJECT_MISMATCH');
}

function normalizeCondition(value: unknown): string | null | Readonly<Record<string, string>> {
    if (value === undefined || value === null) return null;
    if (typeof value === 'string') return value;
    if (!isObject(value) || Object.keys(value).some(key => !['title', 'description', 'expression', 'location'].includes(key))
        || Object.values(value).some(item => typeof item !== 'string')) fail('ADAPTER_RESPONSE_INVALID');
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) as Record<string, string>;
}

function normalizeBinding(binding: ProtectedIamBinding): ProtectedIamBinding {
    if (!isObject(binding) || typeof binding.role !== 'string' || !ROLE.test(binding.role)
        || typeof binding.member !== 'string' || !MEMBER.test(binding.member)) fail('ADAPTER_RESPONSE_INVALID');
    return { role: binding.role, member: binding.member, condition: normalizeCondition(binding.condition) };
}

function bindingKey(binding: ProtectedIamBinding): string {
    return canonicalDigest(normalizeBinding(binding));
}

function normalizeBindings(value: readonly ProtectedIamBinding[]): readonly ProtectedIamBinding[] {
    if (!Array.isArray(value)) fail('ADAPTER_RESPONSE_INVALID');
    const bindings = value.map(normalizeBinding);
    const keys = new Set<string>();
    for (const binding of bindings) {
        const key = bindingKey(binding);
        if (keys.has(key)) fail('ADAPTER_RESPONSE_INVALID');
        keys.add(key);
    }
    return bindings.sort((left, right) => bindingKey(left).localeCompare(bindingKey(right)));
}

function decodeWirePolicy(value: unknown, resource: string, project: string): { snapshot: ProtectedIamPolicySnapshot; wire: WirePolicy } {
    if (!isObject(value) || (value.version !== undefined && (typeof value.version !== 'number' || !Number.isSafeInteger(value.version)))
        || ![0, 1, 3].includes((value.version ?? 0) as number)
        || typeof value.etag !== 'string' || !ETAG.test(value.etag) || !Array.isArray(value.bindings)) fail('IAM_ETAG_REQUIRED');
    const version = (value.version ?? 0) as number;
    const flattened: ProtectedIamBinding[] = [];
    const wireBindings: WireBinding[] = [];
    for (const item of value.bindings as unknown[]) {
        if (!isObject(item) || typeof item.role !== 'string' || !ROLE.test(item.role)
            || !Array.isArray(item.members) || item.members.length === 0
            || item.members.some(member => typeof member !== 'string' || !MEMBER.test(member))) fail('ADAPTER_RESPONSE_INVALID');
        const condition = normalizeCondition(item.condition);
        if (condition !== null && version < 3) fail('ADAPTER_RESPONSE_INVALID');
        const members = [...(item.members as string[])].sort();
        wireBindings.push({ role: item.role, members, ...(condition === null ? {} : { condition: condition as WireCondition }) });
        for (const member of members) flattened.push({ role: item.role, member, condition });
    }
    const bindings = normalizeBindings(flattened);
    const wire: WirePolicy = {
        version,
        etag: value.etag,
        bindings: wireBindings,
        ...(Array.isArray(value.auditConfigs) ? { auditConfigs: value.auditConfigs } : {}),
    };
    return { snapshot: { resource, project, etag: value.etag, bindings }, wire };
}

function conditionWire(condition: ProtectedIamBinding['condition']): WireCondition | undefined {
    if (condition === null) return undefined;
    if (typeof condition === 'string') return { expression: condition };
    return Object.fromEntries(Object.entries(condition).sort(([left], [right]) => left.localeCompare(right)));
}

function encodeWirePolicy(policy: ProtectedIamPolicySnapshot, previous: WirePolicy): WirePolicy {
    const bindings = normalizeBindings(policy.bindings);
    const grouped = new Map<string, { role: string; members: string[]; condition?: WireCondition }>();
    for (const binding of bindings) {
        const normalized = normalizeBinding(binding);
        const condition = conditionWire(normalized.condition);
        const key = canonicalDigest({ role: normalized.role, condition: condition ?? null });
        const group = grouped.get(key) ?? { role: normalized.role, members: [], ...(condition === undefined ? {} : { condition }) };
        group.members.push(normalized.member);
        grouped.set(key, group);
    }
    return {
        version: Math.max(3, previous.version), etag: policy.etag,
        bindings: [...grouped.values()].map(group => ({ ...group, members: [...group.members].sort() })).sort((left, right) => `${left.role}:${JSON.stringify(left.condition ?? null)}`.localeCompare(`${right.role}:${JSON.stringify(right.condition ?? null)}`)),
        ...(previous.auditConfigs === undefined ? {} : { auditConfigs: previous.auditConfigs }),
    };
}

function parseResource(resource: string, kind: ProtectedIamInput['kind'], project: string): { host: string; path: string; method: 'GET' | 'POST'; queryKeys: readonly string[]; body: unknown } {
    assertProject(project);
    if (kind === 'run' || kind === 'maintenance') {
        const match = resource.match(/^projects\/([^/]+)\/locations\/([^/]+)\/services\/([^/]+)$/);
        if (!match || match[1] !== project || !LOCATION.test(match[2]!) || !RESOURCE.test(match[3]!)) fail('RESOURCE_INVALID');
        return { host: 'run.googleapis.com', path: `/v2/${resource}`, method: 'GET', queryKeys: ['options.requestedPolicyVersion'], body: undefined };
    }
    if (kind === 'queue') {
        const match = resource.match(/^projects\/([^/]+)\/locations\/([^/]+)\/queues\/([^/]+)$/);
        if (!match || match[1] !== project || !LOCATION.test(match[2]!) || !RESOURCE.test(match[3]!)) fail('RESOURCE_INVALID');
        return { host: 'cloudtasks.googleapis.com', path: `/v2/${resource}`, method: 'POST', queryKeys: [], body: { options: { requestedPolicyVersion: 3 } } };
    }
    const match = resource.match(/^projects\/([^/]+)\/serviceAccounts\/([^/]+)$/);
    if (!match || match[1] !== project || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/.test(match[2]!)) fail('RESOURCE_INVALID');
    return { host: 'iam.googleapis.com', path: `/v1/${resource}`, method: 'POST', queryKeys: ['options.requestedPolicyVersion'], body: undefined };
}

export type IamAdapterOptions = Readonly<{ transport: AuthenticatedProtectedTransport }>;

/** Resource-scoped IAM adapter with actual Google Policy Binding envelope conversion. */
export class IamAdapter {
    private readonly transport: AuthenticatedProtectedTransport;

    constructor(options: IamAdapterOptions) {
        this.transport = options.transport;
    }

    async getPolicy(input: Pick<ProtectedIamInput, 'kind' | 'resource' | 'project'>): Promise<ProtectedIamPolicySnapshot> {
        return (await this.getWirePolicy(input)).snapshot;
    }

    async setPolicy(input: Pick<ProtectedIamInput, 'kind' | 'resource' | 'project'>, policy: ProtectedIamPolicySnapshot): Promise<ProtectedIamPolicySnapshot> {
        const current = await this.getWirePolicy(input);
        if (policy.resource !== input.resource || policy.project !== input.project || typeof policy.etag !== 'string' || !ETAG.test(policy.etag)) fail('IAM_ETAG_REQUIRED');
        if (current.snapshot.etag !== policy.etag) fail('OBSERVATION_RACE');
        const wire = encodeWirePolicy(policy, current.wire);
        const endpoint = parseResource(input.resource, input.kind, input.project);
        const path = `${endpoint.path}:setIamPolicy`;
        await this.transport.json({
            method: 'POST', url: `https://${endpoint.host}${path}`, allowedHosts: HOSTS, allowedPath: candidate => candidate === path, allowedMethods: ['POST'],
            allowedQueryKeys: [],
            acceptedStatuses: [200], body: { policy: wire },
        });
        const readback = await this.getWirePolicy(input);
        if (canonicalDigest(readback.snapshot.bindings) !== canonicalDigest(normalizeBindings(policy.bindings))) fail('OBSERVATION_RACE');
        return readback.snapshot;
    }

    async addBindings(input: ProtectedIamInput, additions: readonly ProtectedIamBinding[]): Promise<ProtectedIamPolicySnapshot> {
        const observed = await this.getPolicy(input);
        if (observed.etag !== input.etag) fail('OBSERVATION_RACE');
        const byKey = new Map(observed.bindings.map(binding => [bindingKey(binding), binding]));
        for (const addition of additions) {
            const normalized = normalizeBinding(addition);
            byKey.set(bindingKey(normalized), normalized);
        }
        return this.setPolicy(input, { resource: input.resource, project: input.project, etag: observed.etag, bindings: [...byKey.values()] });
    }

    async replaceBindings(input: ProtectedIamInput, bindings: readonly ProtectedIamBinding[]): Promise<ProtectedIamPolicySnapshot> {
        const observed = await this.getPolicy(input);
        if (observed.etag !== input.etag) fail('OBSERVATION_RACE');
        return this.setPolicy(input, { resource: input.resource, project: input.project, etag: observed.etag, bindings });
    }

    private async getWirePolicy(input: Pick<ProtectedIamInput, 'kind' | 'resource' | 'project'>): Promise<{ snapshot: ProtectedIamPolicySnapshot; wire: WirePolicy }> {
        const endpoint = parseResource(input.resource, input.kind, input.project);
        const path = `${endpoint.path}:getIamPolicy`;
        const query = endpoint.queryKeys.length === 0 ? '' : '?options.requestedPolicyVersion=3';
        const { value } = await this.transport.json({
            method: endpoint.method, url: `https://${endpoint.host}${path}${query}`, allowedHosts: HOSTS, allowedPath: candidate => candidate === path, allowedMethods: [endpoint.method],
            allowedQueryKeys: endpoint.queryKeys,
            ...(endpoint.body === undefined ? {} : { body: endpoint.body }), acceptedStatuses: [200],
        });
        return decodeWirePolicy(value, input.resource, input.project);
    }
}

export { EpochError };
