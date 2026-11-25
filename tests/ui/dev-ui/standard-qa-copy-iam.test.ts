import { describe, expect, it, vi } from 'vitest';
import { expirySecretResource } from '@/lib/services/dev-ui/standard-qa-copy-expiry';
import { verifyStandardQaCopyIam } from '@/lib/services/dev-ui/standard-qa-copy-iam';

const transport = vi.hoisted(() => vi.fn());
vi.mock('google-auth-library', () => ({
    GoogleAuth: class { async getClient() { return { request: transport }; } },
}));
const devReader = 'serviceAccount:synthetic@fixture.example';
const extraReader = 'user:other@fixture.example';
const expiresAt = Date.now() + 90 * 86_400_000;
const expression = 'request.time < timestamp("' + new Date(expiresAt).toISOString() + '")';
const scope = {
    prefix: 'analysis-v2-dev-standard-archive/' + 'a'.repeat(64) + '/', authorized: [devReader], expiresAt, sourceBucket: 'source-dev-live-media', bucketName: 'destination-dev-qa-copy',
    expirySecret: expirySecretResource('projects/fixture/secrets/expiry/versions/1', 'fixture', '123456', 'region'),
    sourceKeySecret: 'projects/fixture/secrets/original', kmsKey: 'projects/fixture/locations/region/keyRings/qa/cryptoKeys/fixture', project: 'fixture', projectNumber: '123456',
};
function setup(scenario: string) {
    const source = [{ role: 'roles/reader', members: [devReader] }];
    const destination = [{ role: 'roles/reader', members: [devReader], condition: { expression } }];
    const key = [{ role: 'roles/key', members: [devReader], condition: { expression } }];
    transport.mockImplementation(async ({ url, params }: { url: string; params?: { pageToken?: string } }) => {
        if (url.endsWith('/managedFolders')) {
            expect(params).toMatchObject({ prefix: 'analysis-v2-dev-standard-archive/', pageSize: 256 });
            expect(params).not.toHaveProperty('maxResults');
            if (scenario === 'managed parent') return { data: { items: [{ name: 'analysis-v2-dev-standard-archive/' }] } };
            if (scenario === 'managed descendant' || scenario === 'unrelated folder') {
                if (!params?.pageToken) return { data: { nextPageToken: 'next' } };
                const prefix = scenario === 'managed descendant' ? scope.prefix : 'analysis-v2-dev-standard-archive/other/';
                return { data: { items: [{ name: prefix + 'nested/' }] } };
            }
            if (scenario === 'incomplete folder list') return { data: { nextPageToken: 'loop' } };
            return { data: {} };
        }
        if (url.endsWith('/projects/fixture')) return { data: { name: 'projects/123456', parent: 'folders/20' } };
        if (url.endsWith('/folders/20')) return { data: { name: 'folders/20', parent: 'organizations/10' } };
        if (url.endsWith('/organizations/10')) return { data: { name: 'organizations/10' } };
        if (url.endsWith(':getIamPolicy') && url.includes('cloudresourcemanager')) {
            const inherited = (scenario === 'inherited outsider' || scenario === 'ciphertext-only outsider') && url.includes('organizations/') ? [{ role: 'roles/reader', members: [extraReader] }] : [];
            if (scenario === 'project alias' && url.includes('projects/')) inherited.push({ role: 'roles/owner', members: [devReader] });
            return { data: { version: 3, bindings: inherited } };
        }
        if (url === scope.expirySecret.url + ':getIamPolicy') return { data: { version: 3, bindings: [{
            role: 'roles/secret', members: scenario === 'inherited outsider' ? [devReader, extraReader] : scenario === 'missing expiry key' ? [] : [devReader],
        }] } };
        if (url.endsWith(scope.sourceKeySecret + ':getIamPolicy')) return { data: { version: 3, bindings: [
            { role: 'roles/secret', members: scenario === 'missing source key' ? [] : [devReader] },
        ] } };
        if (url.endsWith(scope.sourceBucket + '/iam')) return { data: { version: 3, bindings: scenario === 'missing source' ? [] : scenario === 'project alias' ? [{ role: 'roles/reader', members: ['projectOwner:fixture'] }] : source } };
        if (url.endsWith(scope.bucketName + '/iam')) return { data: { version: 3, bindings: scenario === 'untimed key' ? source : destination } };
        if (url.endsWith('/keyRings/qa:getIamPolicy')) return { data: { version: 3, bindings: [] } };
        if (url.endsWith(scope.kmsKey + ':getIamPolicy')) return { data: { version: 3, bindings: scenario === 'untimed key'
            ? [{ role: 'roles/key', members: [devReader] }] : scenario === 'inherited outsider' ? [...key, { role: 'roles/key', members: [extraReader], condition: { expression } }] : key } };
        if (url.endsWith('/roles/owner')) return { data: { includedPermissions: ['resourcemanager.projects.get'] } };
        if (url.endsWith('/roles/reader')) return { data: { includedPermissions: ['storage.objects.get', 'storage.objects.create'] } };
        if (url.endsWith('/roles/secret')) return { data: { includedPermissions: ['secretmanager.versions.access'] } };
        if (url.endsWith('/roles/key')) return { data: { includedPermissions: ['cloudkms.cryptoKeyVersions.useToDecrypt'] } };
        throw new Error('Unexpected synthetic IAM request');
    });
}
describe('private-copy effective IAM with original Dev principals', () => {
    it('accepts a bounded destination and checks inherited effective permissions', async () => {
        setup('authorized');
        await expect(verifyStandardQaCopyIam(scope)).resolves.toEqual({ approvedPrincipals: 1, hierarchyResources: 3 });
    });
    it('resolves a projectOwner convenience value from basic role grants in the same project', async () => {
        setup('project alias');
        await expect(verifyStandardQaCopyIam(scope)).resolves.toMatchObject({ approvedPrincipals: 1 });
    });
    it('permits a ciphertext-only inherited reader without unwrap access', async () => {
        setup('ciphertext-only outsider');
        await expect(verifyStandardQaCopyIam(scope)).resolves.toMatchObject({ approvedPrincipals: 1 });
    });
    it('accepts an authorized inherited key reader when the independent secret has a fixed expiry', async () => {
        setup('untimed key');
        await expect(verifyStandardQaCopyIam(scope)).resolves.toMatchObject({ approvedPrincipals: 1 });
    });
    it('allows a listed managed folder outside the copy namespace', async () => {
        setup('unrelated folder');
        await expect(verifyStandardQaCopyIam(scope)).resolves.toMatchObject({ approvedPrincipals: 1 });
    });
    it.each(['managed parent', 'managed descendant', 'incomplete folder list', 'inherited outsider', 'missing source', 'missing source key', 'missing expiry key'])('rejects %s', async scenario => {
        setup(scenario);
        await expect(verifyStandardQaCopyIam(scope)).rejects.toThrow('QA_COPY_IAM_UNVERIFIED');
    });
});
