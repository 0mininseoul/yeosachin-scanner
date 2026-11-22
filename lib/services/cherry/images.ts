import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHmac } from 'node:crypto';
import sharp from 'sharp';
import { downloadImageBytes, downloadImageBytesViaTrustedProxy } from '@/lib/services/ai/image-preprocessing';
import { loadResultImageR2Config } from '@/lib/services/media/r2-result-image-store';
import { INSTAGRAM_MEDIA_HOST_SUFFIXES, validateAllowedRemoteImageUrl } from '@/lib/services/media/secure-image-fetch';

/** Report images share the analyzer's private bucket under their own prefix. */
const KEY_PATTERN = /^cherry\/v1\/[0-9a-f]{32}\/[0-9a-f]{32}\.webp$/;
const MAX_BYTES = 300 * 1024;
const MAX_INPUT_PIXELS = 16_000_000;

export interface CherryStoredImage { key: string; webp: Buffer; jpegBase64: string }

export function isCherryImageKey(key: string): boolean {
    return KEY_PATTERN.test(key);
}

export function cherryImageKey(subscriptionId: string, eventId: string, slot: string, secret: string): string {
    if (secret.length < 16) throw new Error('CHERRY_IMAGE_SECRET_INVALID');
    const digest = (value: string) => createHmac('sha256', secret).update(value).digest('hex').slice(0, 32);
    return `cherry/v1/${digest(`subscription:${subscriptionId}`)}/${digest(`event:${eventId}:${slot}`)}.webp`;
}

function imageSecret(env: Record<string, string | undefined>): string {
    return env.ANALYSIS_V2_RESULT_IMAGE_OBJECT_HMAC_SECRET?.trim() ?? '';
}

function bucketClient(env: Record<string, string | undefined> = process.env) {
    const config = loadResultImageR2Config(env);
    return {
        bucket: config.bucket,
        client: new S3Client({
            endpoint: config.endpoint, region: 'auto',
            credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        }),
    };
}

async function download(url: string): Promise<Buffer> {
    await validateAllowedRemoteImageUrl(url, INSTAGRAM_MEDIA_HOST_SUFFIXES);
    try {
        return await downloadImageBytes(url);
    } catch {
        return downloadImageBytesViaTrustedProxy(url);
    }
}

async function encode(bytes: Buffer): Promise<{ webp: Buffer; jpegBase64: string }> {
    const base = sharp(bytes, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS, pages: 1 }).rotate().flatten({ background: '#ffffff' });
    const [webp, jpeg] = await Promise.all([
        base.clone().resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer(),
        base.clone().resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer(),
    ]);
    if (webp.byteLength > MAX_BYTES) throw new Error('CHERRY_IMAGE_TOO_LARGE');
    return { webp, jpegBase64: jpeg.toString('base64') };
}

/** Provider image links expire, so a copy is kept for the report and for the summary. */
export async function storeCherryImage(
    input: { subscriptionId: string; eventId: string; slot: string; url: string }, env: Record<string, string | undefined> = process.env,
): Promise<CherryStoredImage> {
    const { webp, jpegBase64 } = await encode(await download(input.url));
    const key = cherryImageKey(input.subscriptionId, input.eventId, input.slot, imageSecret(env));
    const { bucket, client } = bucketClient(env);
    await client.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: webp, ContentType: 'image/webp', CacheControl: 'private, max-age=86400',
    }));
    return { key, webp, jpegBase64 };
}

export async function readCherryImage(key: string): Promise<Buffer> {
    if (!isCherryImageKey(key)) throw new Error('CHERRY_IMAGE_KEY_INVALID');
    const { bucket, client } = bucketClient();
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!response.Body || response.ContentType !== 'image/webp') throw new Error('CHERRY_IMAGE_INVALID');
    return Buffer.from(await response.Body.transformToByteArray());
}

export async function deleteCherryImages(keys: readonly string[]): Promise<void> {
    const valid = keys.filter(isCherryImageKey);
    if (valid.length === 0) return;
    const { bucket, client } = bucketClient();
    for (const key of valid) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
