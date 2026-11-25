import { expect } from 'vitest';
import { NextRequest } from 'next/server';
import sharp from 'sharp';
import { DEV_UI_APP_ORIGIN } from '@/lib/constants/dev-ui';
import { GET as readImage } from '@/app/api/image-proxy/route';
import { GET as readResult } from '@/app/api/analysis/v2/result/[requestId]/route';
import type { newPrivate90Observations } from './private90-observations.mjs';

type Page = {
    summary: { targetProfileImage: string | null };
    femaleAccounts: { profileImage: string | null }[];
    privateAccounts: { profileImage: string | null }[];
    femaleNextCursor: string | null;
    privateNextCursor: string | null;
};

export async function verifyPrivate90Images(requestId: string, first: Page, observed: ReturnType<typeof newPrivate90Observations>) {
    async function image(path: string | null) {
        if (!path) return 0;
        observed.cause = 'image_read';
        const url = new URL(path, DEV_UI_APP_ORIGIN);
        expect(url.origin === DEV_UI_APP_ORIGIN && url.pathname === '/api/image-proxy').toBe(true);
        const response = await readImage(new NextRequest(url));
        observed.imageGets++;
        expect(response.status).toBe(200);
        observed.cause = 'image_format';
        const bytes = Buffer.from(await response.arrayBuffer());
        expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
        expect(bytes.subarray(8, 12).toString('ascii')).toBe('WEBP');
        expect((await sharp(bytes).metadata()).format).toBe('webp');
        observed.webpVerified++;
        return 1;
    }
    observed.targetImages = await image(first.summary.targetProfileImage);
    let page = first;
    let readPublic = true;
    let readPrivate = true;
    const cursors = new Set<string>();
    for (;;) {
        observed.cause = 'page_count';
        observed.resultPages++;
        if (readPublic) for (const row of page.femaleAccounts) {
            observed.publicRows++;
            observed.publicImages += await image(row.profileImage);
        }
        if (readPrivate) for (const row of page.privateAccounts) {
            observed.privateRows++;
            observed.privateImages += await image(row.profileImage);
        }
        readPublic = readPublic && page.femaleNextCursor !== null;
        readPrivate = readPrivate && page.privateNextCursor !== null;
        if (!readPublic && !readPrivate) return;
        const url = new URL('/api/analysis/v2/result/' + requestId, DEV_UI_APP_ORIGIN);
        url.searchParams.set('devAnalysis', 'live');
        if (readPublic) url.searchParams.set('femaleCursor', page.femaleNextCursor!);
        if (readPrivate) url.searchParams.set('privateCursor', page.privateNextCursor!);
        observed.cause = 'page_count';
        expect(cursors.has(url.search)).toBe(false);
        cursors.add(url.search);
        const response = await readResult(new Request(url), { params: Promise.resolve({ requestId }) });
        expect(response.status).toBe(200);
        page = await response.json();
    }
}
