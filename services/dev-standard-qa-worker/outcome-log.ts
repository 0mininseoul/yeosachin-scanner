import { createOperationalLogger } from '@/lib/observability/server';

// This transport is bundled only at the synthetic paid route's logger import.
// Keep Cloud Logging dimensions finite and omit request, job and buyer identifiers.
export const operationalLogger = createOperationalLogger({
    log(_level, event, fields) {
        if (!['analysis_v2.worker_completed', 'analysis_v2.worker_retry', 'analysis_v2.worker_failed'].includes(event)) return;
        console.log(JSON.stringify({ event, disposition: fields.disposition, error_code: fields.error_code }));
    },
    async flush() {},
});
