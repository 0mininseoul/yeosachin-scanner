import {
    runAnalysisV2SchedulerLifecycleFixture,
} from '@/lib/services/analysis/v2-ai-scheduler-max-fixture';

// JSON-only output is safe to archive and makes every modeled assumption reviewable.
console.log(JSON.stringify(runAnalysisV2SchedulerLifecycleFixture()));
