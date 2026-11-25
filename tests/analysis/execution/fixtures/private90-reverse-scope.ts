import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isGeminiRateLimitError, isRecoverableGeminiResponseError } from '@/lib/services/ai/gemini-generation-policy';
import type { PGlite } from '@electric-sql/pglite';
import { ANALYSIS_V2_MAX_REVERSE_CANDIDATES, ANALYSIS_V2_REVERSE_LIKE_LIMIT } from '@/lib/services/analysis/v2-apify-operation-costs';
import type { AnalysisV2CheckpointProfile } from '@/lib/services/analysis/v2-profile-fetch-store';

const archiveSchema = z.object({
    scopeHash: z.string().regex(/^[a-f0-9]{64}$/),
    results: z.array(z.object({ candidateId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
        status: z.enum(['observed','not_observed','not_collected']) }).strict()).max(ANALYSIS_V2_MAX_REVERSE_CANDIDATES),
}).strict();
const outerEvents = ['genderStart','genderFemale','genderMale','genderUnknown','genderSafeFallback','genderCardinality',
    'genderRejected','genderTerminal','genderRate','genderOther','featureOuterStart','featureOuterFemale','featureOuterUnresolved',
    'featureOuterRejected','featureOuterTerminal','featureOuterRate','featureOuterOther'] as const;
export type Private90OuterEvent = typeof outerEvents[number];
export function private90OuterFailure(stage:'gender'|'featureOuter',error:unknown): Private90OuterEvent {
    const name = (error as {name?:string})?.name;
    if (isRecoverableGeminiResponseError(error)) return stage === 'gender' ? 'genderRejected' : 'featureOuterRejected';
    if (name === 'AnalysisV2AiTerminalUnavailableError') return stage === 'gender' ? 'genderTerminal' : 'featureOuterTerminal';
    if (isGeminiRateLimitError(error) || name === 'AnalysisV2AiResultRateLimitExhaustedError') return stage === 'gender' ? 'genderRate' : 'featureOuterRate';
    return stage === 'gender' ? 'genderOther' : 'featureOuterOther';
}
type StageEvent = Private90OuterEvent | 'triage' | 'featureModel' | 'featureStart' | 'featureReturned' | 'rejectedOverview' | 'rejectedEvidence' | 'rejectedSchema' | 'terminalUnavailable' | 'stageError';
type Row = { candidateId:string; postUrl:string; declaredLikesCount:number; declaredLikesCountKnown?:boolean };

function tuples(rows: readonly Row[]) {
    return [...rows].sort((a,b) => a.candidateId.localeCompare(b.candidateId))
        .map(r => [r.candidateId,r.postUrl,r.declaredLikesCount,r.declaredLikesCountKnown ?? true]);
}

export function private90ReverseScope(target: string, value: unknown) {
    const sealed = archiveSchema.parse(value);
    const expected = new Set(sealed.results.map(r => r.candidateId));
    if (expected.size !== sealed.results.length) throw new Error('OFFLINE_STANDARD_VERTEX_REVERSE_DUPLICATE');
    const source = new Map<string,Row>();
    const accounts = new Map<string,string>();
    const owners = new Map<string,string | null>();
    const history = new Map<string, Partial<Record<StageEvent,number>>>();
    const operations = new Map<string,Set<string>>();
    function selectionOwner(items: readonly {selectionId:string;kind:string}[]) {
        const profile = items.find(item => item.kind === 'profile');
        const owner = profile && owners.get(profile.selectionId);
        if (owner) return owner;
        const choices = new Set(items.map(item => owners.get(item.selectionId)).filter(v => typeof v === 'string'));
        return choices.size === 1 ? [...choices][0] : undefined;
    }
    function event(id: string | undefined, name: StageEvent, op?:string) {
        if (!id || !expected.has(id)) return;
        const item = history.get(id) ?? {};
        item[name] = (item[name] ?? 0) + 1;
        history.set(id,item);
        if (op) {
            const keys = operations.get(id) ?? new Set();
            keys.add(op);
            operations.set(id,keys);
        }
    }
    const hash = (rows: readonly Row[]) => createHash('sha256')
        .update(JSON.stringify([target, ANALYSIS_V2_REVERSE_LIKE_LIMIT, tuples(rows)])).digest('hex');
    return {
        expected, event, selectionOwner,
        bindAccount(accountId:string,id:string) { if (expected.has(id)) accounts.set(accountId,id); },
        accountEvent(accountId:string,stage:Private90OuterEvent,op:string) { event(accounts.get(accountId),stage,op); },
        bind(id: string, selections: readonly string[]) {
            for (const selection of selections) {
                const old = owners.get(selection);
                owners.set(selection, old === undefined || old === id ? id : null);
            }
        },
        featureFailure(error: unknown): StageEvent {
            // The transport wraps GeminiResponseValidationError in Error.cause.
            let cause: unknown = error;
            for (let depth=0; cause && typeof cause === 'object' && depth<4; depth++) {
                const e = cause as {name?:string;cause?:unknown;diagnostics?:{issues?:{path?:string}[]}};
                if (e.name === 'GeminiResponseValidationError') {
                    const issues = e.diagnostics?.issues ?? [];
                    if (issues.some(i => i.path === 'oneLineOverview')) return 'rejectedOverview';
                    if (issues.some(i => i.path?.startsWith('evidenceSelectionIds'))) return 'rejectedEvidence';
                    return 'rejectedSchema';
                }
                if (e.name === 'AnalysisV2AiTerminalUnavailableError') return 'terminalUnavailable';
                cause = e.cause;
            }
            return 'stageError';
        },
        remember(candidateId:string, profile:AnalysisV2CheckpointProfile) {
            if (!expected.has(candidateId)) return;
            // Reconstruct the tuple independently from the sealed profile. The production collector still verifies its own input.
            const post = [...profile.latestPosts ?? []].sort((a,b) => Date.parse(b.timestamp)-Date.parse(a.timestamp) || a.id.localeCompare(b.id))[0];
            if (post) source.set(candidateId, { candidateId, postUrl:'https://www.instagram.com/' + (post.type === 'reel' ? 'reel' : 'p') + '/' + post.shortCode + '/',
                declaredLikesCount:post.likesCount, declaredLikesCountKnown:post.likesCountHidden !== true });
        },
        sourceCounts() {
            return { reverseExpected:expected.size, reverseSourceTupleCount:source.size, reverseSourceHashMatch:Number(hash([...source.values()]) === sealed.scopeHash) };
        },
        async compare(db:PGlite,requestId:string,rows:readonly Row[], receipts?:ReadonlyMap<string,Set<string>>) {
            const actual = new Set(rows.map(r => r.candidateId));
            const missing = [...expected].filter(id => !actual.has(id));
            const calls = (event: StageEvent) => missing.reduce((n,id) => n+(history.get(id)?.[event] ?? 0),0);
            const keys = missing.flatMap(id => [...operations.get(id) ?? []]);
            const genderKeys = [...new Set(keys.filter(op => op.startsWith('gender-triage:')))];
            const featureKeys = [...new Set(keys.filter(op => op.startsWith('feature-analysis:')))];
            const receiptIds = (ops:string[]) => [...new Set(ops.flatMap(op => [...receipts?.get(op) ?? []]))];
            const dbStates = (await db.query<Record<string,number>>(`
              WITH a AS (SELECT status FROM analysis_v2_ai_attempts WHERE request_id=$1 AND operation_key=ANY($2::text[])),
              s AS (SELECT stage,status FROM analysis_v2_scheduler_operations WHERE request_id=$1 AND operation_key=ANY($2::text[] || $3::text[]))
              SELECT (SELECT count(*)::int FROM a) AS "reverseMissingGenderAttempts",
                (SELECT count(*)::int FROM a WHERE status='success') AS "reverseMissingGenderSuccess",
                (SELECT count(*)::int FROM a WHERE status='response_rejected') AS "reverseMissingGenderResponseRejected",
                (SELECT count(*)::int FROM a WHERE status='rate_limited') AS "reverseMissingGenderRateLimited",
                (SELECT count(*)::int FROM s WHERE stage='genderTriage' AND status='terminal_unavailable') AS "reverseMissingGenderSchedulerTerminal",
                (SELECT count(*)::int FROM s WHERE stage='genderTriage' AND status='ready') AS "reverseMissingGenderSchedulerReady",
                (SELECT count(*)::int FROM s WHERE stage='featureAnalysis' AND status='terminal_unavailable') AS "reverseMissingFeatureSchedulerTerminal",
                (SELECT count(*)::int FROM s WHERE stage='featureAnalysis' AND status='ready') AS "reverseMissingFeatureSchedulerReady",
                (SELECT count(*)::int FROM dev_live_budget.reservations WHERE reservation_id=ANY($4::uuid[]) AND actual_micros>0) AS "reverseMissingGenderPaid",
                (SELECT count(*)::int FROM dev_live_budget.reservations WHERE reservation_id=ANY($5::uuid[]) AND actual_micros>0) AS "reverseMissingFeaturePaid"`,
                [requestId,genderKeys,featureKeys,receiptIds(genderKeys),receiptIds(featureKeys)])).rows[0]!;
            const outerCounts = Object.fromEntries(outerEvents.map(e => ['reverseMissing' + e[0]!.toUpperCase() + e.slice(1), calls(e)]));
            const attemptCounts = (await db.query<Record<string,number>>(`
                WITH pins AS (
                    SELECT p.input->>'operationKey' op FROM analysis_v2_ai_scoring_stage_checkpoints s
                    CROSS JOIN LATERAL jsonb_array_elements(s.payload->'outcomes') WITH ORDINALITY o(item,num)
                    JOIN analysis_v2_profile_media_inputs p ON p.request_id=s.request_id AND p.job_key=s.producer_job_key
                        AND p.ordinal=o.num-1 AND p.stage='feature_remainder'
                    WHERE s.request_id=$1 AND s.stage_kind='profile_ai_batch' AND o.item->>'candidateId'=ANY($3::text[])
                ) SELECT count(*)::int AS "reverseMissingDbAttempts",
                    count(*) FILTER (WHERE status='response_rejected')::int AS "reverseMissingDbRejected",
                    count(*) FILTER (WHERE status='success')::int AS "reverseMissingDbSucceeded"
                FROM analysis_v2_ai_attempts WHERE request_id=$1 AND (operation_key=ANY($2::text[]) OR operation_key IN(SELECT op FROM pins))`,[requestId,keys,missing])).rows[0]!;
            const fieldsChanged = rows.filter(r => source.has(r.candidateId)
                && JSON.stringify(tuples([r])) !== JSON.stringify(tuples([source.get(r.candidateId)!]))).length;
            const hist = (await db.query<Record<string,number>>(`
                WITH o AS (
                    SELECT a FROM analysis_v2_ai_scoring_stage_checkpoints s
                    CROSS JOIN LATERAL jsonb_array_elements(s.payload->'outcomes') a
                    WHERE s.request_id=$1 AND s.stage_kind='profile_ai_batch' AND a->>'candidateId'=ANY($2::text[])
                ) SELECT count(*)::int AS "reverseMissingOutcomes",
                    count(*) FILTER(WHERE a->>'status'='verified_female')::int AS "reverseMissingVerified",
                    count(*) FILTER(WHERE a->'triage'->'assessment'->>'inferredGender'='female')::int AS "reverseMissingTriageFemale",
                    count(*) FILTER(WHERE a->'feature'->'features'->>'gender'='female')::int AS "reverseMissingFeatureFemale",
                    count(*) FILTER(WHERE a->>'status'='analysis_unavailable')::int AS "reverseMissingAnalysisUnavailable",
                    count(*) FILTER(WHERE a->>'status'='media_unavailable')::int AS "reverseMissingMediaUnavailable",
                    count(*) FILTER(WHERE a->>'status' LIKE 'unresolved%')::int AS "reverseMissingUnresolved",
                    count(*) FILTER(WHERE a->'triage'->'assessment'->>'confidence'='high')::int AS "reverseMissingTriageHigh",
                    count(*) FILTER(WHERE a->>'v29FeatureAdmission'='unsupported_unknown')::int AS "reverseMissingAdmissionUnknown",
                    count(*) FILTER(WHERE a->'feature'->>'finalGenderDecision'='verified_female')::int AS "reverseMissingFeatureVerified",
                    count(*) FILTER(WHERE a->>'status'='verified_non_female')::int AS "reverseMissingNonFemale"
                FROM o`, [requestId,missing])).rows[0]!;
            return { reverseCompared:1, reverseActual:actual.size,reverseShared:expected.size-missing.length,reverseMissing:missing.length,
                reverseExtra:[...actual].filter(id => !expected.has(id)).length, reverseTupleDifferences:fieldsChanged,
                reverseActualHashMatch:Number(hash(rows) === sealed.scopeHash), ...hist, ...attemptCounts, ...outerCounts, ...dbStates,
                reverseMissingTriageModelCalls:calls('triage'),reverseMissingFeatureModelCalls:calls('featureModel'),
                reverseMissingFeatureStarts:calls('featureStart'),reverseMissingFeatureReturned:calls('featureReturned'),
                reverseMissingOverviewRejected:calls('rejectedOverview'),reverseMissingEvidenceRejected:calls('rejectedEvidence'),
                reverseMissingSchemaRejected:calls('rejectedSchema'),reverseMissingTerminalUnavailable:calls('terminalUnavailable'),
                reverseMissingOtherErrors:calls('stageError') };
        },
    };
}
