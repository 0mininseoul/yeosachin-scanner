import 'server-only';

import { getAnalysisV2MediaArtifactBucket } from '@/lib/services/analysis/v2-media-artifact-store';
import type { DevLiveApproval } from './live-approval';
import { requireDevLiveProviderApproval } from './live-budget';
import { createDevStandardEvalStore } from './standard-eval-store';
import type { DevStandardEvalBundle } from './standard-eval-types';

const CAPTURE_TTL_MS = 24 * 60 * 60 * 1000;

type Environment = Readonly<Record<string, string | undefined>>;

function configuredDevStandardEvalStore(env: Environment) {
    if (!env.DEV_LIVE_STANDARD_EVAL_SLOT) return null;
    if (env.DEV_LIVE_WORKLOAD !== 'paid' || env.ANALYSIS_WORKLOAD_ROLE !== 'paid'
        || env.DEV_LIVE_ANALYSIS_MODE !== 'owner_start') return null;
    const bucketName = getAnalysisV2MediaArtifactBucket(env);
    const key = env.DEV_LIVE_STANDARD_EVAL_KEY;
    if (!bucketName || !key) throw new Error('DEV_STANDARD_EVAL_CONFIG_INVALID');
    return createDevStandardEvalStore({ bucketName, slot: env.DEV_LIVE_STANDARD_EVAL_SLOT, key });
}

export async function bindDevStandardEvalRun(approval: DevLiveApproval | null): Promise<void> {
    if (approval?.planId !== 'standard' || !process.env.DEV_LIVE_STANDARD_EVAL_SLOT) return;
    try {
        const store = configuredDevStandardEvalStore(process.env);
        await store?.bindRun(approval.id);
    } catch {
        // The capture is auxiliary. Log a fixed event without exposing the approved run.
        console.warn('DEV_STANDARD_EVAL_BIND_FAILED');
    }
}

export function createDevStandardEvalCapture(env: Environment = process.env) {
    if (!env.DEV_LIVE_STANDARD_EVAL_SLOT || env.DEV_LIVE_WORKLOAD !== 'paid'
        || env.ANALYSIS_WORKLOAD_ROLE !== 'paid') return undefined;
    return async (
        build: (expiresAt: number) => Promise<DevStandardEvalBundle | null>,
    ): Promise<void> => {
        try {
            const approval = requireDevLiveProviderApproval();
            if (approval.planId !== 'standard') return;
            const store = configuredDevStandardEvalStore(env);
            if (!store || !await store.ownsRun(approval.id)) return;
            if (await store.load()) return;
            // Use the grant timestamp so retries have the same bounded window.
            const bundle = await build(Date.parse(approval.approvedAt) + CAPTURE_TTL_MS);
            if (!bundle) {
                console.warn('DEV_STANDARD_EVAL_CAPTURE_INCOMPLETE');
                return;
            }
            await store.seal(bundle);
            console.info('DEV_STANDARD_EVAL_CAPTURE_READY');
        } catch {
            console.warn('DEV_STANDARD_EVAL_CAPTURE_FAILED');
        }
    };
}
