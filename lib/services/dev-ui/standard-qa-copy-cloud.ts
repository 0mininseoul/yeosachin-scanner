import 'server-only';

import { expirySecretResource, readExpirySecret, validateExpirySecret } from './standard-qa-copy-expiry';
import { verifyStandardQaCopyIam } from './standard-qa-copy-iam';
import type { StandardQaFixtureOperation } from './standard-archive-runtime';
import { createHash, hkdfSync, randomBytes } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import {
    createGoogleCloudPrivateMediaObjectClient, isAnalysisV2DevQaCopyBucketName, isAnalysisV2DevLiveMediaBucketName,
} from '@/lib/services/analysis/v2-media-artifact-store';
import {
    createDevStandardQaCopyStore, devStandardQaCopyObjectPrefix,
} from '@/lib/services/dev-ui/standard-archive-store';
import {
    activeStandardQaCopyPolicy, standardQaCopyPolicyWindow, withVerifiedStandardQaCopy,
} from '@/lib/services/dev-ui/standard-qa-copy';

function required(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error('QA_COPY_CONFIGURATION_INVALID');
    return value;
}
function hash(value: Buffer | string): string {
    return createHash('sha256').update(value).digest('hex');
}

function configuration(mode: 'export' | 'read' | 'audit' | 'iam') {
    const descriptor = {
        approval: required('DEV_STANDARD_QA_COPY_APPROVAL'),
        sourceApproval: required('DEV_STANDARD_QA_COPY_SOURCE_APPROVAL'),
        approvedAt: required('DEV_STANDARD_QA_COPY_APPROVED_AT'),
        target: required('DEV_LIVE_STANDARD_TARGET'),
        days: Number(required('DEV_STANDARD_QA_COPY_DAYS')),
    };
    const { policy, context, binding } = mode === 'audit'
        ? standardQaCopyPolicyWindow(descriptor) : activeStandardQaCopyPolicy(descriptor);
    if (mode === 'audit' && Date.now() < binding.expiresAt) throw new Error('QA_COPY_AUDIT_EARLY');
    const project = required('DEV_STANDARD_QA_COPY_PROJECT');
    const projectNumber = required('DEV_STANDARD_QA_COPY_PROJECT_NUMBER');
    const bucketName = required('DEV_STANDARD_QA_COPY_BUCKET');
    const kmsKey = required('DEV_STANDARD_QA_COPY_KMS_KEY');
    const resource = /^projects\/([a-z][a-z0-9-]+)\/locations\/([a-z0-9-]+)\/keyRings\/[a-zA-Z0-9_-]+\/cryptoKeys\/[a-zA-Z0-9_-]+$/.exec(kmsKey);
    const sourceBucket = mode === 'export' || mode === 'iam' ? required('DEV_LIVE_STANDARD_ARCHIVE_BUCKET') : undefined;
    if (!isAnalysisV2DevQaCopyBucketName(bucketName)
        || project !== required('DEV_LIVE_GCP_PROJECT') || project !== required('GOOGLE_CLOUD_PROJECT')
        || !/^[1-9]\d{5,19}$/.test(projectNumber) || projectNumber !== required('DEV_LIVE_GCP_PROJECT_NUMBER')
        || resource?.[1] !== project
        || (sourceBucket !== undefined && (!isAnalysisV2DevLiveMediaBucketName(sourceBucket)
            || sourceBucket !== required('DEV_STANDARD_QA_COPY_APPROVED_SOURCE_BUCKET')))) {
        throw new Error('QA_COPY_CONFIGURATION_INVALID');
    }

    const expirySecret = expirySecretResource(required('DEV_STANDARD_QA_COPY_EXPIRY_SECRET_VERSION'), project, projectNumber, resource[2]!);
    const slot = hash('dev-standard-copy-slot/v1\n' + policy.approval).slice(0, 32);
    const prefix = devStandardQaCopyObjectPrefix(bucketName, slot);
    const wrappedKeyName = prefix + hash('wrapped-key/v1') + '.bin';
    return { policy, context, bucketName, sourceBucket, project, projectNumber, kmsKey, expirySecret, expiresAt: binding.expiresAt, location: resource[2], slot, prefix, wrappedKeyName };
}

function cloudClient() {
    return new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient();
}

export async function openStandardQaCopyForJob(mode: 'export' | 'read') {
    const { policy, context, bucketName, sourceBucket, projectNumber, kmsKey, location, slot, wrappedKeyName, expirySecret, expiresAt } = configuration(mode);
    const requester = await cloudClient();
    const { data: bucket } = await requester.request<{
        projectNumber: string; location: string; storageClass: string; billing?: { requesterPays?: boolean };
        iamConfiguration?: { uniformBucketLevelAccess?: { enabled?: boolean }; publicAccessPrevention?: string };
        retentionPolicy?: unknown; defaultEventBasedHold?: boolean; versioning?: { enabled?: boolean };
        softDeletePolicy?: { retentionDurationSeconds?: string };
        lifecycle?: { rule?: Array<{ action?: { type?: string }; condition?: { age?: number } }> };
    }>({ url: 'https://storage.googleapis.com/storage/v1/b/' + encodeURIComponent(bucketName) });
    if (sourceBucket !== undefined) {
        const { data: source } = await requester.request<{ projectNumber: string; location: string }>({
            url: 'https://storage.googleapis.com/storage/v1/b/' + encodeURIComponent(sourceBucket),
            params: { fields: 'projectNumber,location' },
        });
        if (source.projectNumber !== projectNumber || source.location.toLowerCase() !== location) {
            throw new Error('QA_COPY_SOURCE_BUCKET_INVALID');
        }
    }
    const days = policy.days;
    const rules = bucket.lifecycle?.rule;
    const ttl = rules?.length === 1 && rules[0]?.action?.type === 'Delete'
        && rules[0].condition?.age === days && Object.keys(rules[0].condition).length === 1;
    if (bucket.projectNumber !== projectNumber || bucket.location.toLowerCase() !== location
        || bucket.storageClass !== 'STANDARD' || bucket.versioning?.enabled || bucket.billing?.requesterPays
        || bucket.defaultEventBasedHold || bucket.retentionPolicy || !ttl
        || (bucket.softDeletePolicy?.retentionDurationSeconds ?? '0') !== '0'
        || bucket.iamConfiguration?.uniformBucketLevelAccess?.enabled !== true
        || bucket.iamConfiguration?.publicAccessPrevention !== 'enforced') throw new Error('QA_COPY_BUCKET_POLICY_INVALID');

    // A single scoped receipt permits exact retries after a crash. An attempted change to the
    // authorized target, deadline, key, or bucket invalidates the KMS associated data.
    await validateExpirySecret(requester, expirySecret, expiresAt);
    const aad = Buffer.from(JSON.stringify([context, bucketName, slot, kmsKey, expirySecret.version, expiresAt])).toString('base64');
    const objects = createGoogleCloudPrivateMediaObjectClient({ bucketName });
    const wrapped = () => objects.readRetained({ objectName: wrappedKeyName, maximumBytes: 8192 });
    let ciphertext = await wrapped();
    if (!ciphertext && mode === 'export') {
        const key = randomBytes(32);
        try {
            const encrypted = await requester.request<{ name: string; ciphertext: string }>({
                url: 'https://cloudkms.googleapis.com/v1/' + kmsKey + ':encrypt', method: 'POST',
                data: { plaintext: key.toString('base64'), additionalAuthenticatedData: aad },
            });
            if (!encrypted.data.name.startsWith(kmsKey + '/cryptoKeyVersions/')) throw new Error('QA_COPY_KMS_INVALID');
            const bytes = Buffer.from(encrypted.data.ciphertext, 'base64');
            if (bytes.length < 32 || bytes.length > 8192) throw new Error('QA_COPY_KMS_INVALID');
            try {
                await objects.createRetained({ objectName: wrappedKeyName, bytes, contentType: 'application/octet-stream', contentSha256: hash(bytes) });
            } catch {
                // A concurrent writer can commit a different random key first. Read the immutable winner.
            }
        } finally {
            key.fill(0);
        }
        ciphertext = await wrapped();
    }
    if (!ciphertext) throw new Error('QA_COPY_KEY_UNAVAILABLE');
    const expiryKey = await readExpirySecret(requester, expirySecret, expiresAt);
    try {
        const decrypted = await requester.request<{ plaintext: string }>({
            url: 'https://cloudkms.googleapis.com/v1/' + kmsKey + ':decrypt', method: 'POST',
            data: { ciphertext: ciphertext.toString('base64'), additionalAuthenticatedData: aad },
        });
        const seed = Buffer.from(decrypted.data.plaintext, 'base64');
        delete (decrypted.data as Partial<typeof decrypted.data>).plaintext;
        try {
            if (seed.length !== 32 || expiresAt <= Date.now()) throw new Error('QA_COPY_KEY_UNAVAILABLE');
            const key = Buffer.from(hkdfSync('sha256', seed, expiryKey, 'private-qa-object-key/v2\n' + aad, 32));
            try {
                const destination = createDevStandardQaCopyStore({ bucketName, slot, key: key.toString('base64'), objects });
                return { destination, policy };
            } finally { key.fill(0); }
        } finally { seed.fill(0); }
    } finally { expiryKey.fill(0); }
}

/** The isolated reader uses only the copy bucket, wrapped seed and independently expiring secret. */
export async function withCloudStandardQaFixture<T>(
    operation: StandardQaFixtureOperation<T>,
) {
    const { destination, policy } = await openStandardQaCopyForJob('read');
    return withVerifiedStandardQaCopy(policy, destination, operation);
}


/** Execute as the QA reader for access, or as the list-only auditor for erasure. */
export async function verifyExpiredStandardQaCopy(mode: 'revoked' | 'deleted') {
    const { bucketName, expirySecret, prefix, wrappedKeyName } = configuration('audit');
    const client = await cloudClient();
    const url = 'https://storage.googleapis.com/storage/v1/b/' + encodeURIComponent(bucketName) + '/o';
    if (mode === 'revoked') {
        const receipt = await client.request({
            url: url + '/' + encodeURIComponent(wrappedKeyName), params: { fields: 'kind' },
            validateStatus: status => status === 200 || status === 403 || status === 404,
        });
        const secret = await client.request({
            url: expirySecret.url + '/versions/1:access', params: { fields: 'name' },
            validateStatus: status => status === 403 || status === 404,
        });
        if (![200, 403, 404].includes(receipt.status) || ![403, 404].includes(secret.status)) {
            throw new Error('QA_COPY_ACCESS_UNVERIFIED');
        }
        return 'revoked';
    }
    const deletedSecret = await client.request({
        url: expirySecret.url, params: { fields: 'name' }, validateStatus: status => status === 404,
    });
    if (deletedSecret.status !== 404) throw new Error('QA_COPY_DELETION_PENDING');
    for (const options of [{ versions: true }, { softDeleted: true }]) {
        const list = await client.request<{
            items?: { kind: string }[]; nextPageToken?: string; error?: { errors?: { reason?: string }[] };
        }>({
            url, params: { prefix, fields: 'items(kind),nextPageToken', maxResults: 1, ...options },
            validateStatus: status => status === 200 || ('softDeleted' in options && status === 400),
        });
        // GCS rejects soft-deleted listings when the bucket has no soft-delete policy.
        // An empty version listing alone cannot exclude past soft-deleted generations.
        if (list.status === 400 && list.data.error?.errors?.some(error => error.reason === 'invalidArgument')) {
            return 'versions_absent_soft_delete_unverified';
        }
        if (list.status !== 200 || list.data.items?.length || list.data.nextPageToken) {
            throw new Error('QA_COPY_DELETION_PENDING');
        }
    }
    return 'deleted';
}


export async function checkPrivateQaCopyPrincipalAccess() {
    const cfg = configuration('iam');
    if (!cfg.sourceBucket) throw new Error('QA_COPY_CONFIGURATION_INVALID');
    await validateExpirySecret(await cloudClient(), cfg.expirySecret, cfg.expiresAt);
    return verifyStandardQaCopyIam({
        ...cfg, sourceBucket: cfg.sourceBucket, sourceKeySecret: required('DEV_STANDARD_QA_COPY_SOURCE_KEY_SECRET'),
        authorized: required('DEV_STANDARD_QA_COPY_APPROVED_PRINCIPALS').split(',').map(value => value.trim()),
    });
}
