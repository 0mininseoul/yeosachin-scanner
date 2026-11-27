const origin = 'https://dev.yeosachin.com';
const syntheticTarget = 'target7'.padStart(30, 't');
const imagePath = /^\/api\/image-proxy\?result=[A-Za-z0-9_-]+&expires=\d{10}$/;

/** Playwright Page in a fresh, already-authenticated context. Return aggregate evidence only. */
export async function verifyCloudOwnerPage(page, requestId) {
    if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/.test(requestId)) throw new Error('CLOUD_OWNER_BROWSER_REQUEST');
    let step = 'NAVIGATION';
    const timeout = 45_000;
    try {
        const url = origin + '/result/' + requestId + '?devAnalysis=live';
        const [api, navigation] = await Promise.all([
            page.waitForResponse(response => {
                const endpoint = new URL(response.url());
                return endpoint.origin === origin && endpoint.pathname === '/api/analysis/v2/result/' + requestId
                    && endpoint.searchParams.get('devAnalysis') === 'live' && response.request().method() === 'GET'
                    && response.request().resourceType() === 'fetch';
            }, { timeout }),
            page.goto(url, { waitUntil: 'domcontentloaded', timeout }),
        ]);
        step = 'RESULT';
        if (navigation?.status() !== 200 || page.url() !== url || api.status() !== 200
            || await api.headerValue('x-dev-synthetic-owner') !== '1') throw new Error();
        const body = await api.json();
        const first = body.femaleAccounts?.[0];
        if (body.requestId !== requestId || body.summary?.targetInstagramId !== syntheticTarget || body.summary?.planId !== 'standard'
            || !first || !/^[a-z0-9._]{1,30}$/.test(first.instagramId) || !imagePath.test(first.profileImage)) throw new Error();
        step = 'RENDER';
        await page.getByRole('heading', { name: /님의 위장 여사친/ }).waitFor({ state: 'visible', timeout });
        await page.getByText('@' + syntheticTarget, { exact: true }).first().waitFor({ state: 'visible', timeout });
        await page.getByText('@' + first.instagramId, { exact: true }).first().waitFor({ state: 'visible', timeout });
        await page.getByText('Dev · 합성 데이터', { exact: true }).waitFor({ state: 'visible', timeout });
        step = 'IMAGE';
        const avatar = page.locator('main img[src="' + first.profileImage + '"]').first();
        await avatar.scrollIntoViewIfNeeded({ timeout });
        await page.waitForFunction(path => [...document.querySelectorAll('main img')].some(image =>
            image.getAttribute('src') === path && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0),
        first.profileImage, { timeout });
        if (page.url() !== url) throw new Error();
        return { hydrated: true, candidateImageDecoded: true, completedAt: new Date().toISOString() };
    } catch {
        // Browser errors often include locators or signed URLs. Do not propagate their messages.
        throw new Error('CLOUD_OWNER_BROWSER_' + step);
    }
}
