import {
    bestEffortBetaApifyRefresh,
    bestEffortBetaApifySettlement,
    refreshBetaApifyCreditSnapshots,
    settleBetaApifyPreflightCredit,
} from './beta-apify-credit-settlement-runtime';
import type { BetaApifyCreditTelemetry } from './beta-apify-credit-telemetry';
import type { BetaApifyPoolStoreClient } from './beta-apify-credit-runtime';

/**
 * The fresh-admission worker owns the same blocked beta settlement boundary
 * regardless of whether it is reached through the legacy preflight service or
 * the paid capacity service. Keep this helper intentionally small so the two
 * routes cannot drift on credit-hold cleanup or telemetry.
 */
export async function settleBlockedFreshAdmission(
    client: BetaApifyPoolStoreClient,
    preflightId: string,
    telemetry?: BetaApifyCreditTelemetry,
): Promise<void> {
    await bestEffortBetaApifySettlement(async () => {
        const processed = await settleBetaApifyPreflightCredit(
            client,
            preflightId,
            { telemetry },
        );
        if (processed) {
            await bestEffortBetaApifyRefresh(() => (
                refreshBetaApifyCreditSnapshots(client, { telemetry })
            ));
        }
    });
}
