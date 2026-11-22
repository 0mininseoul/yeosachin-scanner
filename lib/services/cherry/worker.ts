import { createServerApifyCreditClientFactory } from '@/lib/services/analysis/apify-account-credit-inventory';
import { readApifyAccountCredit } from '@/lib/services/analysis/beta-apify-credit-pool';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { processCherryRefunds, processDueBilling, reconcileCherryPayments } from './billing';
import { processCherryCheck } from './checks';
import { cherryErrorCode } from './errors';
import { deleteCherryImages } from './images';
import { processCherryNotifications } from './notifications';
import { claimCherryReports, processCherryReport } from './reports';
import { assertNoDatabaseError, cherryRpc } from './rpc';
import { claimCherryChecks, loadCherrySettings } from './store';
import { pendingTargetChecks, processTargetCheck } from './target-checks';

const SNAPSHOT_MAX_AGE_MS = 10 * 60_000;
const LEASE_SECONDS = 660;
const CHECKS_PER_ROUND = 3;
/** A new round of paid work starts only with this much time left. */
const ROUND_MIN_MS = 240_000;

export interface CherryTickSummary { steps: Record<string, unknown>; failed: string[] }

/** Both products spend the same paid account, so the balance is read from Apify, not estimated. */
export async function refreshApifySnapshot(nowMs = Date.now()): Promise<boolean> {
    const settings = await loadCherrySettings();
    if (settings.apify_observed_at && nowMs - Date.parse(settings.apify_observed_at) < SNAPSHOT_MAX_AGE_MS) return false;
    const reading = await readApifyAccountCredit({ credentialSlot: 'secondary', client: createServerApifyCreditClientFactory()('secondary') });
    const { error } = await supabaseAdmin.from('cherry_settings').update({
        apify_limit_usd: reading.monthlyLimitUsd, apify_usage_usd: reading.monthlyUsageUsd,
        apify_cycle_end_at: reading.billingCycleEndAt, apify_observed_at: reading.observedAt,
    }).eq('id', true);
    assertNoDatabaseError('apify_snapshot', error);
    return true;
}

async function runChecks(deadlineAtMs: number): Promise<Record<string, number>> {
    const totals: Record<string, number> = {};
    while (deadlineAtMs - Date.now() > ROUND_MIN_MS) {
        const checks = await claimCherryChecks(CHECKS_PER_ROUND, LEASE_SECONDS);
        if (checks.length === 0) break;
        const outcomes = await Promise.all(checks.map(check => processCherryCheck(check, deadlineAtMs)));
        for (const { outcome, code } of outcomes) {
            const key = code ? `${outcome}:${code}` : outcome;
            totals[key] = (totals[key] ?? 0) + 1;
        }
        // Waiting work is retried by a later minute instead of holding this one open.
        if (outcomes.every(({ outcome }) => outcome === 'deferred')) break;
    }
    return totals;
}

async function runReports(deadlineAtMs: number): Promise<number> {
    let done = 0;
    for (let round = 0; round < 5 && deadlineAtMs - Date.now() > ROUND_MIN_MS / 2; round += 1) {
        const reports = await claimCherryReports(2, 420);
        if (reports.length === 0) break;
        const outcomes = await Promise.all(reports.map(report => processCherryReport(report, deadlineAtMs)));
        done += outcomes.filter(({ outcome }) => outcome === 'done').length;
        if (outcomes.every(({ outcome }) => outcome === 'deferred')) break;
    }
    return done;
}

async function runRetention(nowMs: number): Promise<unknown> {
    // Once a day in the quiet early morning (04:00-04:10 KST).
    const kst = new Date(nowMs + 9 * 3_600_000);
    if (kst.getUTCHours() !== 4 || kst.getUTCMinutes() >= 10) return 'skipped';
    const batch = await cherryRpc<{ events: { id: string; images: { key?: string }[] }[]; purged: number }>('cherry_retention_batch', { p_limit: 50 });
    for (const event of batch.events) {
        await deleteCherryImages(event.images.map(image => image.key ?? '').filter(Boolean));
        const { error } = await supabaseAdmin.from('cherry_mutual_events').update({ images: [] }).eq('id', event.id);
        assertNoDatabaseError('retention_images', error);
    }
    return { images: batch.events.length, purged: batch.purged };
}

/** One scheduled minute. A failed step is reported and never blocks the next one. */
export async function runCherryTick(deadlineAtMs: number): Promise<CherryTickSummary> {
    const summary: CherryTickSummary = { steps: {}, failed: [] };
    const step = async (name: string, task: () => Promise<unknown>) => {
        try {
            summary.steps[name] = await task();
        } catch (error) {
            summary.failed.push(name);
            summary.steps[name] = cherryErrorCode(error);
        }
    };
    await step('snapshot', () => refreshApifySnapshot());
    await step('due', () => cherryRpc('cherry_enqueue_due'));
    await step('targets', async () => {
        const ids = await pendingTargetChecks(5);
        return (await Promise.all(ids.map(id => processTargetCheck(id, Math.min(deadlineAtMs, Date.now() + 120_000))))).length;
    });
    await step('payments', () => reconcileCherryPayments(10));
    await step('billing', () => processDueBilling(5));
    await step('refunds', () => processCherryRefunds(5));
    await step('notifications', () => processCherryNotifications(20));
    await step('checks', () => runChecks(deadlineAtMs));
    await step('reports', () => runReports(deadlineAtMs));
    await step('notifications_after', () => processCherryNotifications(20));
    await step('retention', () => runRetention(Date.now()));
    return summary;
}
