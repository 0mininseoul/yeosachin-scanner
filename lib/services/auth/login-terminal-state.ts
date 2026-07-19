import {
    clearPendingAuthEvent,
    type AuthMarkerStorage,
} from '@/lib/services/analytics-auth';
import { clearPendingAnalysisTarget } from '@/lib/services/pending-analysis-target';

export function clearLoginTerminalState(
    hasError: boolean,
    storage?: AuthMarkerStorage,
): boolean {
    if (!hasError) return false;

    clearPendingAuthEvent(storage);
    if (storage) clearPendingAnalysisTarget(storage);
    return true;
}
