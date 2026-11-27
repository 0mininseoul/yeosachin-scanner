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
export function readCloudOwnerImages(requestId: string, get: Get, publicCount: number) {
    return safeEvidence(() => verifyImages(requestId, get, publicCount));
}

async function verifyImages(requestId: string, get: Get, publicCount: number) {
    requireCheck(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/.test(requestId), 'REQUEST');
    requireCheck(Number.isInteger(publicCount) && publicCount >= 1 && publicCount <= 600, 'PUBLIC_COUNT');
    const result = new URL('/api/analysis/v2/result/' + requestId, DEV_UI_APP_ORIGIN);
    result.searchParams.set('devAnalysis', 'live');
    result.searchParams.set('pageSize', '50');
    const firstPageUrl = result.href;
    const profiles = new Set(Array.from({ length: publicCount }, (_, index) => publicUsername(index)));
    const imagePaths: string[] = [];
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
        requireCheck(body.requestId === requestId && body.summary.planId === 'standard' && body.summary.targetInstagramId === target, 'RESULT_SCOPE');
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
                imagePaths.push(url);
            }));
        }
        pages++;
    } while (femaleCursor || privateCursor);
    requireCheck(profiles.size === 0 && privateRead && new Set(imagePaths).size === publicCount + 2, 'COVERAGE');
    return {
        pages, images: imagePaths.length, completedAt: new Date().toISOString(),
        // Run negative controls immediately after all owners' positive reads, while image locators remain valid.
        checkOtherSessions(other: Get, anonymous: Get) {
            return safeEvidence(() => checkDenied([firstPageUrl, ...imagePaths], other, anonymous));
        },
    };
}

async function checkDenied(urls: string[], other: Get, anonymous: Get) {
    for (const href of urls) {
        const [foreign, unauthenticated] = await Promise.all([other(href, policy), anonymous(href, policy)]);
        try {
            requireCheck(foreign.status === 403 && unauthenticated.status === 401, 'ACCESS');
        } finally {
            await Promise.all([foreign.body?.cancel(), unauthenticated.body?.cancel()]);
        }
    }
    return { otherDenied: urls.length, anonymousDenied: urls.length };
}
