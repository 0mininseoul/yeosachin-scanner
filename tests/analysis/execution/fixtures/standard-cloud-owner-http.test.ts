import sharp from 'sharp';
import { expect, it, vi } from 'vitest';
import { demoResultPage } from '@/lib/services/demo-analysis/demo-analysis';
import { createAnalysisV2ResultImageProxyPath } from '@/lib/services/media/image-proxy-token';
import { readCloudOwnerImages } from './standard-cloud-owner-http';
import { createSharedImageSource } from './standard-shared-image-source';
import { candidate, privateCandidate, target } from './standard-providers';

it('checks every HTTP WebP against its fixture profile and counts other-session denials', async () => {
    const requestId = '123e4567-e89b-42d3-a456-426614174000';
    const base = demoResultPage({ requestId, femaleCursor: null, privateCursor: null, pageSize: 5 });
    const paths = new Map<string, Uint8Array<ArrayBuffer>>();
    const source = createSharedImageSource();
    async function image(kind: 'target' | 'female' | 'private', username: string) {
        const path = createAnalysisV2ResultImageProxyPath({ requestId, kind, candidateId: kind === 'target' ? null : username },
            { secret: 'synthetic-standard-owner-http-test-only' })!;
        const bytes = await sharp(await source('https://scontent.cdninstagram.com/' + username + '.jpg')).webp().toBuffer();
        paths.set(path, new Uint8Array(bytes));
        return path;
    }
    const page = {
        ...base, summary: { ...base.summary, targetInstagramId: target, planId: 'standard',
            targetProfileImage: await image('target', target) },
        femaleAccounts: [{ ...base.femaleAccounts[0], instagramId: candidate, profileImage: await image('female', candidate) }],
        privateAccounts: [{ ...base.privateAccounts[0], instagramId: privateCandidate, profileImage: await image('private', privateCandidate) }],
        femaleNextCursor: null, privateNextCursor: null,
    };
    const get = vi.fn(async (input: string) => {
        const url = new URL(input);
        if (url.pathname.startsWith('/api/analysis/')) return Response.json(page, { headers: { 'x-dev-synthetic-owner': '1' } });
        return new Response(paths.get(url.pathname + url.search), { headers: { 'content-type': 'image/webp', 'cache-control': 'private, no-store' } });
    });
    const proof = await readCloudOwnerImages(requestId, get, 1);
    expect([proof.pages, proof.images]).toEqual([1, 3]);
    expect(await proof.checkOtherSessions(async () => new Response(null, { status: 403 }),
        async () => new Response(null, { status: 401 }))).toEqual({ otherDenied: 4, anonymousDenied: 4 });
    expect(get.mock.calls.every(([input]) => new URL(input).origin === 'https://dev.yeosachin.com')).toBe(true);
    paths.set(page.femaleAccounts[0]!.profileImage, paths.get(page.privateAccounts[0]!.profileImage)!);
    await expect(readCloudOwnerImages(requestId, get, 1)).rejects.toThrow('IMAGE_CONTENT');
});
