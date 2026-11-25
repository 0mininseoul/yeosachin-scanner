import 'server-only';

import type { AuthClient } from 'google-auth-library';

export type ExpirySecret = Readonly<{ resource: string; url: string; version: string; location: string; regional: boolean }>;

export function expirySecretResource(version: string, project: string, number: string, expectedLocation?: string): ExpirySecret {
    const match = /^projects\/([a-z\d-]+)(?:\/locations\/([a-z\d-]+))?\/secrets\/([a-zA-Z\d_-]+)\/versions\/1$/.exec(version);
    if (!match || (match[1] !== project && match[1] !== number) || (match[2] && expectedLocation && match[2] !== expectedLocation)) {
        throw new Error('QA_COPY_EXPIRY_SECRET_INVALID');
    }
    const location = match[2] ?? expectedLocation ?? '';
    const regional = !!match[2];
    const resource = 'projects/' + number + (regional ? '/locations/' + location : '') + '/secrets/' + match[3];
    const host = regional ? 'secretmanager.' + location + '.rep.googleapis.com' : 'secretmanager.googleapis.com';
    return { resource, url: 'https://' + host + '/v1/' + resource, version: resource + '/versions/1', location, regional };
}

export async function validateExpirySecret(client: AuthClient, secret: ExpirySecret, expiresAt: number) {
    const { data } = await client.request<{
        name: string; expireTime?: string; versionDestroyTtl?: string;
        replication?: { userManaged?: { replicas?: { location: string }[] } };
    }>({ url: secret.url, params: { fields: secret.regional ? 'name,expireTime,versionDestroyTtl' : 'name,expireTime,versionDestroyTtl,replication' } });
    const replicas = data.replication?.userManaged?.replicas;
    if (data.name !== secret.resource || Date.parse(data.expireTime ?? '') !== expiresAt
        || (data.versionDestroyTtl !== undefined && data.versionDestroyTtl !== '0s')
        || (!secret.regional && (replicas?.length !== 1 || replicas[0]?.location !== secret.location))) {
        throw new Error('QA_COPY_EXPIRY_SECRET_INVALID');
    }
}

export async function readExpirySecret(client: AuthClient, secret: ExpirySecret, expiresAt: number) {
    await validateExpirySecret(client, secret, expiresAt);
    const { data } = await client.request<{ name: string; payload?: { data?: string } }>({
        url: secret.url + '/versions/1:access', params: { fields: 'name,payload(data)' },
    });
    const encoded = data.payload?.data;
    if (data.payload) delete data.payload.data;
    if (data.name !== secret.version || !encoded || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
        throw new Error('QA_COPY_EXPIRY_SECRET_INVALID');
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length !== 32 || bytes.toString('base64') !== encoded) throw new Error('QA_COPY_EXPIRY_SECRET_INVALID');
    return bytes;
}
