// Only these source filenames, numeric code positions and fixed categories may leave the child.
const sourceModules = [
    'v2-worker','v2-dag-state-store','v2-progress-reporter','v2-dag-planner','v2-policy',
    'v2-ai-scoring-executors','v2-ai-scoring-stage-store','v2-ai-scoring-production','v2-ai-scoring-runtime-deps',
    'v2-ai-stage-runtime','v2-ai-attempt-store','v2-ai-result-store','v2-ai-result-identity','v2-result-store',
    'v2-ai-scheduler-runtime','v2-ai-scheduler-operation-store','v2-ai-scheduler-continuation','v2-ai-policy-store',
    'v2-profile-media-inputs','v2-profile-fetch-store','v2-profile-gender-plan','v2-source-media-archive',
    'v2-media-normalization','v2-media-artifact-store','v2-collection-executors','v2-standard-archive-replay',
    'standard-archive-runtime','standard-qa-copy','standard-qa-copy-cloud','live-budget','v2-staged-analysis',
    'v2-ai-fallback-policy','v2-operational-observability','v2-coordinator','v2-job-store','v2-progress-store',
    'v2-ai-gemini-leases','v2-features','result-image-capture','result-image-registry','result-image-normalizer',
    'standard-archive-store','standard-archive-projection','standard-qa-copy-expiry','gemini','gemini-response','gemini-cost','stage-policy','private-name-analysis','secure-image-fetch',
    'standard-archive-vertex','standard-vertex','standard-media','standard-database','standard-admission-result-pglite.test',
];
const kinds = ['Error','TypeError','ReferenceError','RangeError','ZodError','AggregateError','AssertionError','SyntaxError'];
const issueCodes = ['invalid_type','invalid_value','invalid_format','too_big','too_small','invalid_union',
    'unrecognized_keys','invalid_element','invalid_key','not_multiple_of','custom'];
const fields = ['ordinal','stage','status','profile','triage','feature','outcomes','rows','media','mediaCoverage',
    'mediaManifest','accounts','accountId','assessment','gender','inferredGender','evidenceSelectionIds',
    'features','oneLineOverview','normalizedSelectionIds','selectionId','result','results','confidence','candidateId'];
const rpcNames = [
    'load_analysis_v2_profile_fetch_for_consumer','load_analysis_v2_profile_media_inputs','pin_analysis_v2_profile_media_inputs',
    'pin_analysis_v2_profile_gender_plan','load_analysis_v2_ai_scoring_stage','checkpoint_analysis_v2_ai_scoring_stage',
    'load_analysis_v2_ai_result_checkpoint','load_analysis_v2_ai_operation','reserve_analysis_v2_ai_attempt',
    'claim_analysis_v2_scheduler_operation','load_analysis_v2_ai_stage_policy_version','load_analysis_v2_policy_versions_snapshot',
    'checkpoint_analysis_v2_feature_batch','load_analysis_v2_profile_ai_stage_batches',
];
const messages = new Map([
    ['PRIVATE90_NETWORK_DENIED','network_denied'], ['Unexpected source image download during archive replay','source_download'],
    ['Unexpected Apify access during archive replay','apify'], ['Missing synthetic media','local_media_absent'],
    ['Missing synthetic result object','local_image_absent'], ['Unexpected synthetic object operation','local_image_method'],
    ['Unsupported fixture SQL identifier','fixture_identifier'], ['ANALYSIS_V2_GENDER_NAME_ONLY_DUPLICATE_CANDIDATE','duplicate_name_candidate'],
    ['CONCIERGE_BATCH_FEATURE_ANALYSIS_MAX_ATTEMPTS_INVALID','feature_attempt_config'],
    ['DEV_STANDARD_EVAL_FEATURE_MISSING','eval_feature_missing'], ['DEV_STANDARD_EVAL_MEDIA_MISSING','eval_media_missing'],
    ['DEV_STANDARD_EVAL_FEATURE_IDENTITY_CHANGED','eval_feature_identity'],
    ['ANALYSIS_V2_SCHEDULER_CONTINUATION_DELAY_INVALID','scheduler_delay'],
]);
export const sourceEnums = {
    missingRpc: ['none','other',...rpcNames],
    executorPhase: ['none','handler','dag_load','policy_load','progress','stage_execute','stage_checkpoint'],
    errorClass: ['none','other',...kinds],
    sourceReason: ['none','other','missing_rpc','fixture_row_ambiguous','not_callable','read_null','read_undefined',
        'memory_limit','invalid_argument',...messages.values()],
    sourceModule: ['none','other',...sourceModules],
    callerModule: ['none','other',...sourceModules],
    issueCode: ['none','other',...issueCodes], issueField: ['none','other',...fields],
};
export function emptyPrivate90Failure() {
    return { executorPhase:'none',missingRpc:'none',errorClass:'none',sourceReason:'none',sourceModule:'none',sourceLine:0,
        callerModule:'none',callerLine:0,issueCode:'none',issueField:'none' };
}
export function describePrivate90Failure(error) {
    const { executorPhase: _, ...out } = emptyPrivate90Failure();
    out.sourceModule = 'other';
    out.errorClass = kinds.includes(error?.name) ? error.name : 'other';
    const message = typeof error?.message === 'string' ? error.message : '';
    out.sourceReason = messages.get(message) ?? 'other';
    if (message.startsWith('Missing fixture RPC ')) {
        out.sourceReason = 'missing_rpc';
        const rpc = message.slice('Missing fixture RPC '.length);
        out.missingRpc = rpcNames.includes(rpc) ? rpc : 'other';
    }
    else if (message.startsWith('Ambiguous fixture row in ')) out.sourceReason = 'fixture_row_ambiguous';
    else if (out.errorClass === 'TypeError') {
        if (message.endsWith(' is not a function')) out.sourceReason = 'not_callable';
        else if (message.startsWith('Cannot read properties of null')) out.sourceReason = 'read_null';
        else if (message.startsWith('Cannot read properties of undefined')) out.sourceReason = 'read_undefined';
        else if (error.code === 'ERR_INVALID_ARG_TYPE') out.sourceReason = 'invalid_argument';
    } else if (out.errorClass === 'RangeError' && /(?:allocation|heap|array buffer)/i.test(message)) out.sourceReason = 'memory_limit';
    if (out.errorClass === 'ZodError') {
        const first = Array.isArray(error.issues) ? error.issues[0] : null;
        out.issueCode = issueCodes.includes(first?.code) ? first.code : 'other';
        out.issueField = Array.isArray(first?.path) ? first.path.findLast(part => fields.includes(part)) ?? 'other' : 'other';
    }
    // Remove the entire header, including multiline messages, before inspecting V8 stack frames.
    const header = message ? error?.name + ': ' + message : error?.name;
    if (typeof error?.stack !== 'string' || !error.stack.startsWith(header + '\n')) return out;
    for (const frame of error.stack.slice(header.length + 1).split('\n')) {
        if (!/^\s+at /.test(frame)) continue;
        const match = /\/(?:lib\/services\/(?:analysis|ai|dev-ui|media)|tests\/analysis\/execution(?:\/fixtures)?)\/([a-z0-9.-]+)\.ts:(\d{1,5}):\d+\)?$/.exec(frame);
        if (!match || !sourceModules.includes(match[1])) continue;
        if (out.sourceModule === 'other') {
            out.sourceModule = match[1];
            out.sourceLine = Number(match[2]);
        } else if (out.sourceModule !== match[1]) {
            out.callerModule = match[1];
            out.callerLine = Number(match[2]);
            break;
        }
    }
    return out;
}
