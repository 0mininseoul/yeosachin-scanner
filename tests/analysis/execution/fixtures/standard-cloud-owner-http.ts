import { storedAnalysisResultPageV1Schema } from '@/lib/contracts/analysis-v2';
import { DEV_UI_APP_ORIGIN } from '@/lib/constants/dev-ui';
import { matchesSharedResultImage } from './standard-shared-image-source';
import { privateCandidate, publicUsername, target } from './standard-providers';

// Each getter is bound to its own in-memory session and must honor manual redirects.
type Get = (url: string, init: { redirect: 'manual'; cache: 'no-store' }) => Promise<Response>;
const policy = { redirect: 'manual', cache: 'no-store' } as const;
class CloudOwnerCheckError extends Error {}
function requireCheck(ok: boolean, code: string): asserts ok {
    if (!ok) throw new CloudOwnerCheckError('CLOUD_OWNER_HTTP_' + code);
}

// HTTP client and parser diagnostics can include signed image locators or raw response bodies.
async function safeEvidence<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
        if (error instanceof CloudOwnerCheckError) throw error;
        throw new CloudOwnerCheckError('CLOUD_OWNER_HTTP_VERIFICATION_UNAVAILABLE');
    }
}

function resultImagePath(value: string | null): string {
    requireCheck(typeof value === 'string', 'MISSING_IMAGE');
    const url = new URL(value, DEV_UI_APP_ORIGIN);
    requireCheck(url.origin === DEV_UI_APP_ORIGIN && url.pathname === '/api/image-proxy' && !url.hash
        && value === url.pathname + url.search && [...url.searchParams.keys()].join(',') === 'result,expires', 'IMAGE_SCOPE');
    return url.href;
}

/** Verify the published response and decoded images. The caller separately measures the hydrated UI. */
export function readCloudOwnerImages(requestId: string, get: Get, publicCount: number, plan: 'standard' | 'plus' = 'standard') {
    return safeEvidence(() => verifyImages(requestId, get, publicCount, plan));
}

async function verifyImages(requestId: string, get: Get, publicCount: number, plan: 'standard' | 'plus' = 'standard') {
    requireCheck(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/.test(requestId), 'REQUEST');
    requireCheck(Number.isInteger(publicCount) && publicCount >= 1 && publicCount <= (plan === 'plus' ? 900 : 600), 'PUBLIC_COUNT');
    const result = new URL('/api/analysis/v2/result/' + requestId, DEV_UI_APP_ORIGIN);
    result.searchParams.set('devAnalysis', 'live');
    result.searchParams.set('pageSize', '50');
    const firstPageUrl = result.href;
    const profiles = new Set(Array.from({ length: publicCount }, (_, index) => publicUsername(index)));
    const imagesRead: { url: string; username: string; page: string }[] = [];
    const cursors = new Set<string>();
    let femaleCursor: string | null = null;
    let privateCursor: string | null = null;
    let privateRead = false;
    let pages = 0;
    do {
        const key = JSON.stringify([femaleCursor, privateCursor]);
        requireCheck(!cursors.has(key) && pages < 32, 'CURSOR');
        cursors.add(key);
        if (femaleCursor) result.searchParams.set('femaleCursor', femaleCursor); else result.searchParams.delete('femaleCursor');
        if (privateCursor) result.searchParams.set('privateCursor', privateCursor); else result.searchParams.delete('privateCursor');
        const response = await get(result.href, policy);
        requireCheck(response.status === 200 && !response.redirected && response.headers.get('x-dev-synthetic-owner') === '1', 'RESULT');
        const parsed = storedAnalysisResultPageV1Schema.safeParse(await response.json());
        requireCheck(parsed.success, 'RESULT_CONTRACT');
        const body = parsed.data;
        requireCheck(body.requestId === requestId && body.summary.planId === plan && body.summary.targetInstagramId === target, 'RESULT_SCOPE');
        const images: { url: string; username: string }[] = [];
        if (pages === 0) images.push({ url: resultImagePath(body.summary.targetProfileImage), username: target });
        if (pages === 0 || femaleCursor) {
            for (const account of body.femaleAccounts) {
                requireCheck(profiles.delete(account.instagramId), 'PUBLIC_MEMBER');
                images.push({ url: resultImagePath(account.profileImage), username: account.instagramId });
            }
            femaleCursor = body.femaleNextCursor;
        }
        if (pages === 0 || privateCursor) {
            for (const account of body.privateAccounts) {
                requireCheck(!privateRead && account.instagramId === privateCandidate, 'PRIVATE_MEMBER');
                privateRead = true;
                images.push({ url: resultImagePath(account.profileImage), username: privateCandidate });
            }
            privateCursor = body.privateNextCursor;
        }
        // Two image requests per owner can be in flight, including when six owners run concurrently.
        for (let i = 0; i < images.length; i += 2) {
            await Promise.all(images.slice(i, i + 2).map(async ({ url, username }) => {
                const image = await get(url, policy);
                requireCheck(!image.redirected && image.status === 200 && image.headers.get('content-type') === 'image/webp'
                    && image.headers.get('cache-control')?.includes('no-store') === true, 'IMAGE_RESPONSE');
                const bytes = Buffer.from(await image.arrayBuffer());
                requireCheck(bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
                    && await matchesSharedResultImage(bytes, username), 'IMAGE_CONTENT');
                imagesRead.push({ url, username, page: result.href });
            }));
        }
        pages++;
    } while (femaleCursor || privateCursor);
    requireCheck(profiles.size === 0 && privateRead && new Set(imagesRead.map(image => image.url)).size === publicCount + 2, 'COVERAGE');
    return {
        pages, images: imagesRead.length, completedAt: new Date().toISOString(),
        // Run negative controls immediately after all owners' positive reads, while image locators remain valid.
        checkOtherSessions(other: Get, anonymous: Get) {
            return safeEvidence(() => checkDenied(firstPageUrl, imagesRead, get, other, anonymous));
        },
    };
}

async function checkDenied(firstPage: string, images: { url: string; username: string; page: string }[], owner: Get, other: Get, anonymous: Get) {
    const refreshed = new Map<string, string>();
    const validForControls = (href: string) => Number(new URL(href).searchParams.get('expires')) > Date.now() / 1_000 + 65;
    async function denied(href: string) {
        const [foreign, unauthenticated] = await Promise.all([other(href, policy), anonymous(href, policy)]);
        try {
            requireCheck(foreign.status === 403 && unauthenticated.status === 401, 'ACCESS');
        } finally {
            await Promise.all([foreign.body?.cancel(), unauthenticated.body?.cancel()]);
        }
    }
    await denied(firstPage);
    for (const image of images) {
        let href = refreshed.get(image.username) ?? image.url;
        // A stale signed locator could reject a foreign owner even if the ownership check were broken.
        if (!validForControls(href)) {
            const response = await owner(image.page, policy);
            requireCheck(response.status === 200 && !response.redirected && response.headers.get('x-dev-synthetic-owner') === '1', 'REFRESH_RESULT');
            const page = storedAnalysisResultPageV1Schema.parse(await response.json());
            requireCheck(page.summary.targetInstagramId === target && page.requestId === new URL(firstPage).pathname.split('/').at(-1), 'REFRESH_SCOPE');
            refreshed.set(target, resultImagePath(page.summary.targetProfileImage));
            for (const row of [...page.femaleAccounts, ...page.privateAccounts]) refreshed.set(row.instagramId, resultImagePath(row.profileImage));
            href = refreshed.get(image.username) ?? '';
            requireCheck(!!href && validForControls(href), 'CONTROL_LOCATOR_EXPIRED');
        }
        await denied(href);
    }
    return { otherDenied: images.length + 1, anonymousDenied: images.length + 1 };
}
