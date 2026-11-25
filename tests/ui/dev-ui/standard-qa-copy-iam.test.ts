import { describe, expect, it, vi } from 'vitest';
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
    authorized: [devReader], expiresAt, sourceBucket: 'source-dev-live-media', bucketName: 'destination-dev-qa-copy',
    kmsKey: 'projects/fixture/locations/region/keyRings/qa/cryptoKeys/fixture', project: 'fixture', projectNumber: '123456',
};
function setup(scenario: string) {
    const source = [{ role: 'roles/reader', members: [devReader] }];
    const destination = [{ role: 'roles/reader', members: [devReader], condition: { expression } }];
    const key = [{ role: 'roles/key', members: [devReader], condition: { expression } }];
    transport.mockImplementation(async ({ url }: { url: string }) => {
        if (url.endsWith('/projects/fixture')) return { data: { name: 'projects/123456', parent: 'folders/20' } };
        if (url.endsWith('/folders/20')) return { data: { name: 'folders/20', parent: 'organizations/10' } };
        if (url.endsWith('/organizations/10')) return { data: { name: 'organizations/10' } };
        if (url.endsWith(':getIamPolicy') && url.includes('cloudresourcemanager')) {
            const inherited = scenario === 'inherited outsider' && url.includes('organizations/') ? [{ role: 'roles/reader', members: [extraReader] }] : [];
            return { data: { version: 3, bindings: inherited } };
        }
        if (url.endsWith(scope.sourceBucket + '/iam')) return { data: { version: 3, bindings: scenario === 'missing source' ? [] : source } };
        if (url.endsWith(scope.bucketName + '/iam')) return { data: { version: 3, bindings: destination } };
        if (url.endsWith('/keyRings/qa:getIamPolicy')) return { data: { version: 3, bindings: [] } };
        if (url.endsWith(scope.kmsKey + ':getIamPolicy')) return { data: { version: 3, bindings: scenario === 'untimed key'
            ? [{ role: 'roles/key', members: [devReader] }] : key } };
        if (url.endsWith('/roles/reader')) return { data: { includedPermissions: ['storage.objects.get', 'storage.objects.create'] } };
        if (url.endsWith('/roles/key')) return { data: { includedPermissions: ['cloudkms.cryptoKeyVersions.useToDecrypt'] } };
        throw new Error('Unexpected synthetic IAM request');
    });
}
describe('private-copy effective IAM with original Dev principals', () => {
    it('accepts a bounded destination and checks inherited effective permissions', async () => {
        setup('authorized');
        await expect(verifyStandardQaCopyIam(scope)).resolves.toEqual({ approvedPrincipals: 1, hierarchyResources: 3 });
    });
    it.each(['inherited outsider', 'missing source', 'untimed key'])('rejects %s', async scenario => {
        setup(scenario);
        await expect(verifyStandardQaCopyIam(scope)).rejects.toThrow('QA_COPY_IAM_UNVERIFIED');
    });
});
