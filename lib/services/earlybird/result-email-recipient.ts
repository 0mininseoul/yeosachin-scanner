import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { isDevUiDeploymentContext } from '@/lib/constants/dev-ui';

export type ResultEmailEnvironment = Readonly<Record<string, string | undefined>>;
const EMAIL = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
const PURPOSE = 'paid-result-email:v1';

export function paidResultEmailEnabled(env: ResultEmailEnvironment): boolean {
    return env.PAID_RESULT_EMAIL_ENABLED === 'true' && env.NODE_ENV === 'production'
        && !isDevUiDeploymentContext(env) && !env.DEV_LIVE_WORKLOAD && !env.CLOUD_RUN_JOB;
}

export function readResultEmailKey(env: ResultEmailEnvironment): Buffer {
    const key = env.PAID_RESULT_EMAIL_KEY?.trim();
    if (!key || !/^[A-Za-z0-9_-]{43}$/.test(key)) {
        throw new Error('PAID_RESULT_EMAIL_KEY_INVALID');
    }
    return Buffer.from(key, 'base64url');
}

export function sealResultEmailRecipient(
    input: string,
    sellerReference: string,
    env: ResultEmailEnvironment,
): string | null {
    const address = input.trim();
    if (address.length > 254 || !EMAIL.test(address)) return null;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', readResultEmailKey(env), iv);
    cipher.setAAD(Buffer.from(`${PURPOSE}:${sellerReference}`));
    const body = Buffer.concat([cipher.update(address, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

export function openResultEmailRecipient(
    sealed: string,
    sellerReference: string,
    key: Buffer,
): string {
    const bytes = Buffer.from(sealed, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${PURPOSE}:${sellerReference}`));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const address = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    if (address.length > 254 || !EMAIL.test(address)) throw new Error('PAID_RESULT_EMAIL_INVALID');
    return address;
}
