import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { readCloudOwnerImages } from '../../tests/analysis/execution/fixtures/standard-cloud-owner-http.ts';
import { verifyCloudOwnerPage } from '../../tests/analysis/execution/fixtures/standard-cloud-owner-browser.mjs';
import { ReaderError, assertReaderRegion, contextGet, createOwnerCookies, readerAdmin, readerContext, requireReader } from './session.mjs';
import { resolveDevPublicKey } from './public-key.mjs';
import { monitorReaders, safeCode } from './monitor.mjs';

function emit(event) { console.log(JSON.stringify(event)); }
async function main() {
    const env = process.env;
    const admin = readerAdmin(env);
    requireReader(env.CLOUD_RUN_TASK_ATTEMPT === '0', 'RETRY_DISABLED');
    await assertReaderRegion();
    const anon = await resolveDevPublicKey(env.NEXT_PUBLIC_SUPABASE_ANON_KEY).catch(() => {
        throw new ReaderError('DEV_PUBLIC_KEY_UNAVAILABLE');
    });
    requireReader(anon !== env.SUPABASE_SERVICE_ROLE_KEY, 'INVALID_READER_CONFIG');
    const wave = env.DEV_STANDARD_QA_WAVE;
    const plus = env.DEV_STANDARD_QA_PLAN === 'plus';
    const plusTwoSeats = plus && env.DEV_STANDARD_QA_PAID_SEATS === '2';
    const participantCount = plusTwoSeats ? 3 : plus ? 4 : 6;
    const ownerResultCount = plusTwoSeats ? 2 : participantCount;
    const rows = async () => {
        const poll = () => admin.rpc('dev_cloud_six_order_state_v1', { p_wave: wave })
            .select('slot,request_id,request_status,preflight_status,order_status,seat_at,published_at');
        let result = await poll();
        for (let retry = 1; retry <= 2 && result.error; retry++) {
            const timeout = result.error.code === '57014';
            if (!timeout && result.status !== 0 && result.status < 500) break;
            emit({ event: 'roster_read_retry', retry, code: timeout ? '57014' : 'UPSTREAM' });
            await delay(retry * 2_000);
            result = await poll();
        }
        requireReader(!result.error && Array.isArray(result.data), 'ROSTER_READ');
        const terminal = ['failed', 'expired', 'cancelled', 'refunded', 'upgrade_required', 'refund_required'];
        return result.data.map(row => ({
            slot: row.slot, requestId: row.request_id, startedAt: row.seat_at, publishedAt: row.published_at,
            status: [row.preflight_status, row.request_status, row.order_status].some(s => terminal.includes(s))
                ? 'failed' : 'open',
        }));
    };
    const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE dev.yeosachin.com'] });
    try {
        const anonymous = contextGet(await readerContext(browser));
        const slots = await monitorReaders(rows, async (slot, requestId) => {
            const cookies = await createOwnerCookies(admin, wave, slot, requestId, anon);
            const context = await readerContext(browser, cookies);
            const page = await context.newPage();
            const get = contextGet(context);
            const [render, images] = await Promise.allSettled([
                verifyCloudOwnerPage(page, requestId, plus ? 'plus' : 'standard'),
                readCloudOwnerImages(requestId, get, plus ? 900 : 600, plus ? 'plus' : 'standard'),
            ]);
            await page.close();
            if (render.status === 'rejected') throw render.reason;
            if (images.status === 'rejected') throw images.reason;
            return { get, browser: render.value, http: images.value };
        }, emit, undefined, participantCount, ownerResultCount);
        await Promise.all(slots.map(async slot => {
            if (!slot.http) return;
            try {
                const other = slots.find(other => other.slot !== slot.slot && other.get);
                requireReader(other, 'OTHER_SESSION_MISSING');
                const counts = await slot.http.checkOtherSessions(other.get, anonymous);
                emit({ event: 'access_controls', slot: slot.slot, ...counts });
            } catch (error) {
                slot.failure = safeCode(error);
                emit({ event: 'access_failure', slot: slot.slot, code: slot.failure });
            }
        }));
        const successes = slots.filter(slot => !slot.failure && slot.evidence?.withinHour === true).length;
        emit({ event: 'complete', tested: slots.length, withinHourAndControls: successes });
        if (successes !== ownerResultCount) process.exitCode = 1;
    } finally { await browser.close(); }
}
main().catch(error => { emit({ event: 'reader_failure', code: safeCode(error) }); process.exitCode = 1; });
