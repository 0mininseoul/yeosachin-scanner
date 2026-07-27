import {
    runAnalysisV2MicrobatchV29LifecycleFixture,
    runAnalysisV2SchedulerLifecycleFixture,
} from '@/lib/services/analysis/v2-ai-scheduler-max-fixture';

// JSON-only output is safe to archive and makes every modeled assumption reviewable.
console.log(JSON.stringify({
    v28Baseline: runAnalysisV2SchedulerLifecycleFixture(),
    v29MicrobatchModel: runAnalysisV2MicrobatchV29LifecycleFixture(),
}));
