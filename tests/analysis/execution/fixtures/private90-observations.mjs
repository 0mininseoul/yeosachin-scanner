import { emptyPrivate90Failure, sourceEnums } from './private90-worker-failure.mjs';
import { createRequire } from 'node:module';
const { isAnalysisV2WorkerErrorCode } = createRequire(import.meta.url)('../../../../lib/services/analysis/v2-worker-error-codes.ts');

const jobStages = {
    'coordinator:bootstrap': 'bootstrap', 'track:relationships:collect': 'relationships',
    'track:target-evidence:collect': 'target_evidence', 'coordinator:join:primary-evidence': 'primary_join',
    'coordinator:candidate-screening': 'screening', 'track:reverse-likes:collect': 'reverse_likes',
    'track:partner-safety:batch:0': 'partner_safety', 'coordinator:join:final-score': 'final_score',
    'track:narratives:batch:0': 'narrative', 'coordinator:finalize': 'finalize',
};
export function private90Job(key) {
    if (Object.hasOwn(jobStages, key)) return { jobStage: jobStages[key], jobBatch: null };
    const match = /^track:(profiles|profile-ai|private-names):batch:(0|[1-9][0-9]?)$/.exec(key);
    if (!match || Number(match[2]) >= 32) return { jobStage: 'unknown', jobBatch: null };
    return { jobStage: { profiles: 'profiles', 'profile-ai': 'profile_ai', 'private-names': 'private_names' }[match[1]], jobBatch: Number(match[2]) };
}
const sqlStates = new Set(['none','other','08006','22001','22003','22023','22P02','23502','23503','23505','23514',
    '25006','40001','40P01','42501','42601','42703','42804','42883','42P01','53000','53100','53200','53300','55P03','57014','57P01','58030','P0001','PGRST000']);
export const safePrivate90Sql = value => sqlStates.has(value) ? value : 'other';
export const safePrivate90WorkerCode = value => isAnalysisV2WorkerErrorCode(value) ? value : 'other';
const modelErrors = new Set(['none','other', ...['PROMPT_SHAPE','MODEL_INPUT_SHAPE','FEATURE_ROUTE_AMBIGUOUS',
    'UNKNOWN_BATCH_ACCOUNT','UNSUPPORTED_SCHEMA','ACCOUNT_ROUTE_AMBIGUOUS'].map(s => 'OFFLINE_STANDARD_VERTEX_' + s)]);
export const safePrivate90ModelError = value => modelErrors.has(value) ? value : 'other';
const workerEnums = {
    ...sourceEnums,
    jobStage: ['none','unknown','profiles','profile_ai','private_names',...Object.values(jobStages)],
    deliveryStatus: ['none','running','threw','retry','failed','completed','already_terminal','continuation'],
    disposition: ['none','other','transient','permanent','fence','deferred','exhausted','already_terminal','completed'],
    assertion: ['none','queue_limit','task_parse','worker_return','recovery_fanout','continuation_successor','dispatch_fence',
        'terminal_duplicate','duplicate_side_effects','duplicate_ledger','private_source_hash','owner_result','publication','vertex_ledger','image'],
    modelStage: ['none','unknown','private_names','name_only','gender_triage','features','resolver','partner','narrative','preview'],
};
export function private90ModelStage(input) {
    const schema = input?.config?.responseJsonSchema;
    const fields = schema?.properties ?? {};
    if ('femaleScore' in (schema?.items?.properties ?? {})) return 'private_names';
    if (schema?.type?.toLowerCase() === 'array') return 'name_only';
    for (const [key, stage] of Object.entries({accounts:'gender_triage',gender:'features',inferredGender:'resolver',
        companionPattern:'partner',lines:'narrative',persona:'preview'})) if (key in fields) return stage;
    return 'unknown';
}
const phases = ['reader', 'source_ledger', 'fixed_model', 'admission', 'worker', 'result', 'owner_image', 'complete'];

const causes = ['none', 'reader_verification', 'source_receipts', 'source_admission', 'sealed_model_inputs',
    'missing_keyed_media', 'model_routing', 'preflight_admission', 'worker_stage', 'timeout', 'ledger_mismatch',
    'publication_count', 'page_count', 'image_read', 'image_format', 'owner_access', 'network_denied', 'worker_sql'];

export function newPrivate90Observations() {
    return {
        ...emptyPrivate90Failure(),
        jobStage: 'none', jobBatch: null, deliveryStatus: 'none', disposition: 'none', assertion: 'none',
        workerCode: 'none', sqlState: 'none', modelStage: 'none', modelError: 'none', retries: 0, continuations: 0,
        mediaRegistryLoads: 0, mediaRegistryRegistrations: 0, ledgerChecked: 0, positiveSettlements: 0, unusedHolds: 0, unresolvedHolds: 0, duplicatePositive: 0, orphanPositive: 0,
        phase: 'reader', cause: 'reader_verification', profileBatches: 0, completedProfileBatches: 0, publicProfilesInspected: 0, missingFeatureInputs: 0,
        targetImages: 0, publicRows: 0, privateRows: 0, publicImages: 0, privateImages: 0,
        resultPages: 0, imageGets: 0, webpVerified: 0, sourceReceipts: 0, workerJobs: 0, duplicateDeliveries: 0,
        providerCountersActive: 0, apifyCalls: 0, sourceDownloads: 0, fixedVertexCalls: 0, published: 0, readyImages: 0,
        ownerResult: 0, ownerImage: 0, otherResult: 0, otherImage: 0, anonymousResult: 0, anonymousImage: 0,
    };
}

// This is the only data permitted through the private child-to-parent descriptor.
export function safePrivate90Observations(value) {
    const result = newPrivate90Observations();
    if (!value || !phases.includes(value.phase) || !causes.includes(value.cause)) return null;
    for (const key of Object.keys(result)) {
        if (key === 'phase' || key === 'cause') continue;
        if (key === 'jobBatch') {
            if (value[key] !== null && (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > 31)) return null;
        } else if (key === 'sqlState') { if (!sqlStates.has(value[key])) return null; }
        else if (key === 'workerCode') { if (!['none','other'].includes(value[key]) && !isAnalysisV2WorkerErrorCode(value[key])) return null; }
        else if (key === 'modelError') { if (!modelErrors.has(value[key])) return null; }
        else if (Object.hasOwn(workerEnums,key)) { if (!workerEnums[key].includes(value[key])) return null; }
        else
        if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 1_000_000) return null;
        result[key] = value[key];
    }
    result.phase = value.phase;
    result.cause = value.cause;
    return result;
}
