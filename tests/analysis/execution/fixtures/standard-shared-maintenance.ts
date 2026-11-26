import { earlybirdFulfillmentStore } from '@/lib/services/earlybird/fulfillment-store';
import { recoverExpiredAnalysisProviderAdmissions } from '@/lib/services/analysis/provider-admission-recovery';
import { analysisV2GeminiLeaseStore } from '@/lib/services/analysis/v2-gemini-lease-store';

const recoveryIntervalMs = 5 * 60_000;
function untilNextTick(startedAt: number) {
    return recoveryIntervalMs - (performance.now() - startedAt) % recoveryIntervalMs;
}

// These are independent transactions in the same order as ordinary V2 maintenance.
// A sweep can release an expired slot without supplying unknown provider usage.
export function startSharedStandardMaintenance(
    onReconciled: () => Promise<void>, cadenceStartedAt: number,
) {
    const passes: { scanned: number; resolved: number; skipped: number; failed: number; attemptsRecovered: number; slotsReaped: number }[] = [];
    let running: Promise<void> | undefined;
    let firstError: unknown;
    async function sweep() {
        const admissions = await recoverExpiredAnalysisProviderAdmissions();
        const attemptsRecovered = await analysisV2GeminiLeaseStore.recoverCutoffAttempts({ limit: 8 });
        const slotsReaped = await analysisV2GeminiLeaseStore.reapCutoff({ limit: 8 });
        passes.push({ scanned: admissions.scanned, resolved: admissions.resolved, skipped: admissions.skipped,
            failed: admissions.failed, attemptsRecovered, slotsReaped });
        await reconcile();
    }
    async function reconcile() {
        await earlybirdFulfillmentStore.reconcile(100);
        await onReconciled();
    }
    function tick() {
        if (running || firstError) return;
        running = sweep().catch(error => { firstError = error; }).finally(() => { running = undefined; });
    }
    let regularTimer: ReturnType<typeof setInterval> | undefined;
    const firstTimer = setTimeout(() => {
        regularTimer = setInterval(tick, recoveryIntervalMs);
        tick();
    }, untilNextTick(cadenceStartedAt));
    return {
        passes,
        reconcile,
        async stop() {
            clearTimeout(firstTimer);
            clearInterval(regularTimer);
            await running;
            if (firstError) throw firstError;
        },
        sweep,
    };
}
