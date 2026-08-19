import { after } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { reconcileSettledAnalysisProviderCosts } from '@/lib/services/analysis/provider-cost-reconciliation';

// Kept out of the step route module so that route file only exports Next.js
// route handlers (the webpack build validates route exports strictly).
const PROVIDER_COST_RECONCILIATION_DELAY_MS = 35_000;
const PROVIDER_COST_RECONCILIATION_RETRIES = 3;

export function scheduleBrowserFallbackCostReconciliation(requestId: string): void {
    after(async () => {
        await new Promise<void>((resolve) => {
            setTimeout(resolve, PROVIDER_COST_RECONCILIATION_DELAY_MS);
        });
        for (let attempt = 0; attempt < PROVIDER_COST_RECONCILIATION_RETRIES; attempt++) {
            const result = await reconcileSettledAnalysisProviderCosts(
                supabaseAdmin,
                requestId
            );
            if (result.failed === 0 && !result.hasMore) return;
            if (attempt + 1 < PROVIDER_COST_RECONCILIATION_RETRIES) {
                await new Promise<void>((resolve) => setTimeout(resolve, 30_000));
            }
        }
        console.warn('Browser fallback provider cost reconciliation remains pending');
    });
}
