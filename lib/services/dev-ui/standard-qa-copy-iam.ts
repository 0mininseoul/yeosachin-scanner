import 'server-only';

import { GoogleAuth } from 'google-auth-library';

type Binding = { role: string; members: string[]; condition?: { expression?: string } };
type Policy = { bindings?: Binding[]; version?: number; etag?: string };
const storagePermissions = new Set(['storage.objects.get', 'storage.objects.create']);
const keyPermissions = new Set(['cloudkms.cryptoKeyVersions.useToDecrypt', 'cloudkms.cryptoKeyVersions.useToEncrypt']);
const principalPattern = /^(?:user|serviceAccount|group):[^\s:@,]+@[^\s:@,]+$/;
function reject(): never { throw new Error('QA_COPY_IAM_UNVERIFIED'); }

export type QaCopyIamScope = {
    project: string; projectNumber: string; sourceBucket: string; bucketName: string; kmsKey: string;
    expiresAt: number; authorized: string[];
};

/**
 * Inspect the policy hierarchy using the auditor's ADC. Only unconditional original access
 * and an exact request.time deadline in the destination are accepted. Unknown CEL is ambiguous.
 */
export async function verifyStandardQaCopyIam(scope: QaCopyIamScope) {
    const { authorized, bucketName, expiresAt, kmsKey, project, projectNumber, sourceBucket } = scope;
    if (!authorized.length || new Set(authorized).size !== authorized.length || authorized.some(member => !principalPattern.test(member))) reject();
    const client = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient();
    const manager = 'https://cloudresourcemanager.googleapis.com/v3/';
    const hierarchy: Binding[] = [];
    let resource = 'projects/' + project;
    const ancestors = new Set<string>();
    while (true) {
        if (ancestors.has(resource) || ancestors.size > 12) reject();
        ancestors.add(resource);
        const [metadata, access] = await Promise.all([
            client.request<{ name?: string; parent?: string }>({ url: manager + resource }),
            client.request<Policy>({
                url: manager + resource + ':getIamPolicy', method: 'POST', data: { options: { requestedPolicyVersion: 3 } },
            }),
        ]);
        if (!metadata.data.name || (resource.startsWith('projects/') && metadata.data.name !== 'projects/' + projectNumber)) reject();
        hierarchy.push(...bindings(access.data));
        const parent = metadata.data.parent;
        if (!parent) break;
        if (!/^(organizations|folders)\/[0-9]+$/.test(parent)) reject();
        resource = parent;
    }
    function bindings(policy: Policy): Binding[] {
        if (!policy || !Array.isArray(policy.bindings ?? []) || (!policy.etag && !policy.version && !policy.bindings)) reject();
        const entries = policy.bindings ?? [];
        if (entries.some(item => !item.role || !Array.isArray(item.members) || item.role.includes('_withcond_')
            || (item.condition && (policy.version !== 3 || !item.condition.expression)))) reject();
        return entries;
    }
    async function bucket(name: string) {
        const response = await client.request<Policy>({
            url: 'https://storage.googleapis.com/storage/v1/b/' + encodeURIComponent(name) + '/iam',
            params: { optionsRequestedPolicyVersion: 3 },
        });
        return [...hierarchy, ...bindings(response.data)];
    }
    async function key(name: string) {
        const response = await client.request<Policy>({
            url: 'https://cloudkms.googleapis.com/v1/' + name + ':getIamPolicy',
            params: { 'options.requestedPolicyVersion': 3 },
        });
        return bindings(response.data);
    }
    const [source, destination, ring, cryptoKey] = await Promise.all([
        bucket(sourceBucket), bucket(bucketName), key(kmsKey.split('/cryptoKeys/')[0]!), key(kmsKey),
    ]);
    const keyPolicies = [...hierarchy, ...ring, ...cryptoKey];
    const permissions = new Map<string, Set<string>>();
    for (const role of new Set([...source, ...destination, ...keyPolicies].map(binding => binding.role))) {
        if (!/^(?:(?:projects|organizations)\/[a-z0-9-]+\/)?roles\/[A-Za-z0-9_.]+$/.test(role)) reject();
        const { data } = await client.request<{ includedPermissions?: string[] }>({ url: 'https://iam.googleapis.com/v1/' + role });
        if (!Array.isArray(data.includedPermissions)) reject();
        permissions.set(role, new Set(data.includedPermissions));
    }
    function has(binding: Binding, wanted: ReadonlySet<string>) {
        return [...wanted].some(permission => permissions.get(binding.role)?.has(permission));
    }
    function end(binding: Binding): number | undefined {
        if (!binding.condition) return undefined;
        const match = /^request\.time\s*<\s*timestamp\((["'])([\dT:.-]+Z)\1\)$/.exec(binding.condition.expression?.trim() ?? '');
        return match ? Date.parse(match[2]!) : NaN;
    }
    const approved = new Set(authorized);
    const sourceReaders = new Set<string>();
    for (const item of source) {
        if (!has(item, new Set(['storage.objects.get']))) continue;
        const cutoff = end(item);
        if (cutoff === undefined || cutoff > Date.now()) item.members.forEach(member => sourceReaders.add(member));
    }
    if (authorized.some(member => !sourceReaders.has(member))) reject();
    function timedPrincipals(policies: Binding[], wanted: ReadonlySet<string>) {
        const observed = new Set<string>();
        for (const item of policies) {
            if (!has(item, wanted)) continue;
            const cutoff = end(item);
            if (cutoff !== undefined && cutoff <= Date.now()) continue;
            if (cutoff !== expiresAt || item.members.some(member => !approved.has(member))) reject();
            item.members.forEach(member => observed.add(member));
        }
        if (!observed.size) reject();
        return observed;
    }
    timedPrincipals(destination, storagePermissions);
    timedPrincipals(keyPolicies, keyPermissions);
    const objectAccess = timedPrincipals(destination, new Set(['storage.objects.get']));
    const cryptographicAccess = timedPrincipals(keyPolicies, new Set(['cloudkms.cryptoKeyVersions.useToDecrypt']));
    if (authorized.some(member => !objectAccess.has(member) || !cryptographicAccess.has(member))) reject();
    return { approvedPrincipals: authorized.length, hierarchyResources: ancestors.size };
}
