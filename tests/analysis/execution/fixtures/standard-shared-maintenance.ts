import { earlybirdFulfillmentStore } from '@/lib/services/earlybird/fulfillment-store';
import { recoverExpiredAnalysisProviderAdmissions } from '@/lib/services/analysis/provider-admission-recovery';
import { analysisV2GeminiLeaseStore } from '@/lib/services/analysis/v2-gemini-lease-store';

// These are independent transactions in the same order as ordinary V2 maintenance.
// A sweep can release an expired slot without supplying unknown provider usage.
export function startSharedStandardMaintenance() {
    const passes: { scanned: number; resolved: number; skipped: number; failed: number; attemptsRecovered: number; slotsReaped: number }[] = [];
    let running: Promise<void> | undefined;
    let firstError: unknown;
    async function sweep() {
        const admissions = await recoverExpiredAnalysisProviderAdmissions();
        const attemptsRecovered = await analysisV2GeminiLeaseStore.recoverCutoffAttempts({ limit: 8 });
        const slotsReaped = await analysisV2GeminiLeaseStore.reapCutoff({ limit: 8 });
        passes.push({ scanned: admissions.scanned, resolved: admissions.resolved, skipped: admissions.skipped,
            failed: admissions.failed, attemptsRecovered, slotsReaped });
        await earlybirdFulfillmentStore.reconcile(100);
    }
    const timer = setInterval(() => {
        if (running || firstError) return;
        running = sweep().catch(error => { firstError = error; }).finally(() => { running = undefined; });
    }, 5 * 60 * 1000);
    return {
        passes,
        async stop() {
            clearInterval(timer);
            await running;
            if (firstError) throw firstError;
        },
        sweep,
    };
}
