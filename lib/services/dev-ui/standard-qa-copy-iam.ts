import 'server-only';

import type { ExpirySecret } from './standard-qa-copy-expiry';
import { GoogleAuth } from 'google-auth-library';

type Binding = { role: string; members: string[]; condition?: { expression?: string } };
type Policy = { bindings?: Binding[]; version?: number; etag?: string };
const principalPattern = /^(?:user|serviceAccount|group):[^\s:@,]+@[^\s:@,]+$/;
function reject(): never { throw new Error('QA_COPY_IAM_UNVERIFIED'); }

export type QaCopyIamScope = {
    project: string; projectNumber: string; sourceBucket: string; sourceKeySecret: string; bucketName: string; kmsKey: string;
    expiresAt: number; authorized: string[]; expirySecret: ExpirySecret; prefix: string;
};

/**
 * Inspect the policy hierarchy using the auditor's ADC. Only unconditional original access
 * and simple request.time cutoffs prove access. Unknown CEL is considered potentially active.
 */
export async function verifyStandardQaCopyIam(scope: QaCopyIamScope) {
    const { authorized, bucketName, expiresAt, kmsKey, project, projectNumber, sourceBucket, sourceKeySecret, expirySecret } = scope;
    if (!authorized.length || new Set(authorized).size !== authorized.length || authorized.some(member => !principalPattern.test(member))) reject();
    if (!new RegExp('^projects/(' + project + '|' + projectNumber + ')/secrets/[a-zA-Z0-9_-]+$').test(sourceKeySecret)) reject();
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
    const [source, destination, ring, cryptoKey, { data: expirySecretPolicy }, { data: originalKeyPolicy }] = await Promise.all([
        bucket(sourceBucket), bucket(bucketName), key(kmsKey.split('/cryptoKeys/')[0]!), key(kmsKey),
        client.request<Policy>({
            url: expirySecret.url + ':getIamPolicy', params: { 'options.requestedPolicyVersion': 3 },
        }),
        client.request<Policy>({
            url: 'https://secretmanager.googleapis.com/v1/' + sourceKeySecret + ':getIamPolicy',
            params: { 'options.requestedPolicyVersion': 3 },
        }),
    ]);
    if (sourceKeySecret.split('/secrets/').at(-1) === expirySecret.resource.split('/secrets/').at(-1)) reject();
    const expiryPolicies = [...hierarchy, ...bindings(expirySecretPolicy)];
    // Managed-folder policies are additive below a bucket and are not returned by
    // buckets.getIamPolicy. Require the approval namespace to have no such overlay.
    if (!/^analysis-v2-dev-standard-archive\/[a-f0-9]{64}\/$/.test(scope.prefix)) reject();
    const namespace = 'analysis-v2-dev-standard-archive/';
    const pages = new Set<string>();
    let pageToken: string | undefined;
    do {
        const response = await client.request<{ items?: { name: string }[]; nextPageToken?: string }>({
            url: 'https://storage.googleapis.com/storage/v1/b/' + encodeURIComponent(bucketName) + '/managedFolders',
            params: { prefix: namespace, pageSize: 256, fields: 'items(name),nextPageToken', ...(pageToken && { pageToken }) },
        });
        const items = response.data?.items ?? [];
        if (!Array.isArray(items) || items.some(item => typeof item.name !== 'string' || !item.name.startsWith(namespace)
            || !item.name.endsWith('/') || item.name.startsWith(scope.prefix) || scope.prefix.startsWith(item.name))) reject();
        pageToken = response.data.nextPageToken;
        if (pageToken !== undefined) {
            if (typeof pageToken !== 'string' || !pageToken || pages.has(pageToken)) reject();
            pages.add(pageToken);
        }
    } while (pageToken);
    const sourceKeyPolicies = [...hierarchy, ...bindings(originalKeyPolicy)];
    const keyPolicies = [...hierarchy, ...ring, ...cryptoKey];
    const permissions = new Map<string, Set<string>>();
    for (const role of new Set([...source, ...sourceKeyPolicies, ...destination, ...keyPolicies, ...expiryPolicies].map(binding => binding.role))) {
        if (!/^(?:(?:projects|organizations)\/[a-z0-9-]+\/)?roles\/[A-Za-z0-9_.]+$/.test(role)) reject();
        const { data } = await client.request<{ includedPermissions?: string[] }>({ url: 'https://iam.googleapis.com/v1/' + role });
        if (!Array.isArray(data.includedPermissions)) reject();
        permissions.set(role, new Set(data.includedPermissions));
    }
    const now = Date.now();
    const approved = new Set(authorized);
    function cutoff(item: Binding) {
        if (!item.condition) return Infinity;
        const match = /^request\.time\s*<\s*timestamp\((["'])([\dT:.-]+Z)\1\)$/.exec(item.condition.expression?.trim() ?? '');
        return match ? Date.parse(match[2]!) : NaN;
    }
    function principals(policies: Binding[], permission: string, when: number, potential: boolean) {
        const result = new Set<string>();
        function add(member: string, depth = 0) {
            if (depth > 2) reject();
            const legacy = /^project(Owner|Editor|Viewer):(.+)$/.exec(member);
            if (legacy && (legacy[2] === project || legacy[2] === projectNumber)) {
                const role = 'roles/' + legacy[1]!.toLowerCase();
                for (const binding of hierarchy.filter(item => item.role === role && effective(item))) {
                    for (const nested of binding.members) add(nested, depth + 1);
                }
            } else if (!member.startsWith('deleted:')) result.add(member);
        }
        function effective(item: Binding) {
            const end = cutoff(item);
            return Number.isNaN(end) ? potential : when < end;
        }
        for (const item of policies) {
            if (permissions.get(item.role)?.has(permission) && effective(item)) item.members.forEach(member => add(member));
        }
        return result;
    }
    function contains(proven: Set<string>, member: string) {
        return proven.has(member) || proven.has('allAuthenticatedUsers') || proven.has('allUsers');
    }
    function overlaps(left: Set<string>, right: Set<string>) {
        // A broad or unresolved identity (e.g. a group) can include a leaf principal
        // on the other side. Never prove exclusion from two unresolved group names.
        const leaf = (member: string) => /^(user|serviceAccount):/.test(member);
        const leftWide = [...left].filter(member => !leaf(member));
        const rightWide = [...right].filter(member => !leaf(member));
        if (leftWide.length && rightWide.length) reject();
        return new Set([
            ...[...left].filter(member => right.has(member) || rightWide.length > 0),
            ...[...right].filter(member => left.has(member) || leftWide.length > 0),
        ]);
    }

    const originalObjects = principals(source, 'storage.objects.get', now, false);
    const originalKeys = principals(sourceKeyPolicies, 'secretmanager.versions.access', now, false);
    if (authorized.some(member => !contains(originalObjects, member) || !contains(originalKeys, member))) reject();

    const copyObjects = (when: number, potential: boolean) => principals(destination, 'storage.objects.get', when, potential);
    const copyKeys = (when: number, potential: boolean) => principals(keyPolicies, 'cloudkms.cryptoKeyVersions.useToDecrypt', when, potential);
    const expiryKeys = (when: number, potential: boolean) => principals(expiryPolicies, 'secretmanager.versions.access', when, potential);
    const actualReaders = overlaps(overlaps(copyObjects(now, true), copyKeys(now, true)), expiryKeys(now, true));
    if ([...actualReaders].some(member => !approved.has(member))) reject();
    const accessibleObjects = copyObjects(now, false);
    const decryptableKeys = copyKeys(now, false);
    const expiryAccess = expiryKeys(now, false);
    if (authorized.some(member => !contains(accessibleObjects, member) || !contains(decryptableKeys, member) || !contains(expiryAccess, member))) reject();
    const lastObjects = copyObjects(expiresAt - 1, false);
    const lastKeys = copyKeys(expiresAt - 1, false);
    const lastExpiryKeys = expiryKeys(expiresAt - 1, false);
    if (authorized.some(member => !contains(lastObjects, member) || !contains(lastKeys, member) || !contains(lastExpiryKeys, member))) reject();
    // The third key is irreversibly deleted by Secret Manager at expiresAt. Its
    // metadata and exact fixed version are checked by the CLI before this audit.
    return { approvedPrincipals: authorized.length, hierarchyResources: ancestors.size };
}
