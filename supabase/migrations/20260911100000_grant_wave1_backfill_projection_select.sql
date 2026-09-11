-- Wave 1 backfill reachability remediation: grant only the columns selected or
-- referenced by scripts/backfill-analysis-canonical.ts.
--
-- This is deliberately column-level SELECT. Existing relation-level REVOKE ALL
-- statements, FORCE RLS, routines, flags, source authority, and activation
-- boundaries remain unchanged. service_role is the only grantee; PUBLIC, anon,
-- and authenticated receive no privilege from this migration.
-- Scope is exactly 18 currently denied executable legacy tables plus the four
-- executable canonical destinations. The three already-accepted legacy tables
-- and deferred destinations are intentionally absent.
--
-- Mechanical review contract for every statement below:
--   columns = BackfillTableSpec.columns in scripts/backfill-analysis-canonical.ts
--   filter  = request_id (the spec default requestIdColumn)
--   order   = timeColumn, request_id, keyColumn
-- The filter and order/key columns are repeated in each comment so this
-- allowlist can be checked directly against the TypeScript specs. The existing
-- catalog check using has_table_privilege(service_role, ..., 'SELECT') remains
-- false for these column-only grants because it checks relation-level SELECT.

-- jobs / analysis_v2_dag_scopes
-- columns=request_id,created_at; filter=request_id; order=created_at,request_id,request_id; key=request_id
GRANT SELECT (request_id, created_at)
    ON TABLE public.analysis_v2_dag_scopes TO service_role;

-- jobs / analysis_v2_dag_stage_manifests
-- columns=request_id,stage_kind,created_at; filter=request_id; order=created_at,request_id,stage_kind; key=stage_kind
GRANT SELECT (request_id, stage_kind, created_at)
    ON TABLE public.analysis_v2_dag_stage_manifests TO service_role;

-- jobs / analysis_v2_dag_batch_topology
-- columns=request_id,topology_kind,batch,created_at; filter=request_id; order=created_at,request_id,batch; key=batch
GRANT SELECT (request_id, topology_kind, batch, created_at)
    ON TABLE public.analysis_v2_dag_batch_topology TO service_role;

-- jobs / analysis_v2_dag_batch_results
-- columns=request_id,result_kind,batch,created_at; filter=request_id; order=created_at,request_id,batch; key=batch
GRANT SELECT (request_id, result_kind, batch, created_at)
    ON TABLE public.analysis_v2_dag_batch_results TO service_role;

-- events / analysis_progress_state
-- columns=request_id,revision,status,created_at,updated_at; filter=request_id; order=updated_at,request_id,request_id; key=request_id
GRANT SELECT (request_id, revision, status, created_at, updated_at)
    ON TABLE public.analysis_progress_state TO service_role;

-- events / analysis_progress_events
-- columns=request_id,seq,event_state,event_code,aggregate_count,occurred_at; filter=request_id; order=occurred_at,request_id,seq; key=seq
GRANT SELECT (request_id, seq, event_state, event_code, aggregate_count, occurred_at)
    ON TABLE public.analysis_progress_events TO service_role;

-- artifacts / analysis_v2_relationship_sides
-- columns=request_id,job_key,side,provider_run_id,created_at; filter=request_id; order=created_at,request_id,job_key; key=job_key
GRANT SELECT (request_id, job_key, side, provider_run_id, created_at)
    ON TABLE public.analysis_v2_relationship_sides TO service_role;

-- artifacts / analysis_v2_relationship_rows
-- columns=request_id,job_key,side,created_at; filter=request_id; order=created_at,request_id,job_key; key=job_key
GRANT SELECT (request_id, job_key, side, created_at)
    ON TABLE public.analysis_v2_relationship_rows TO service_role;

-- artifacts / analysis_v2_relationship_manifests
-- columns=request_id,job_key,created_at; filter=request_id; order=created_at,request_id,job_key; key=job_key
GRANT SELECT (request_id, job_key, created_at)
    ON TABLE public.analysis_v2_relationship_manifests TO service_role;

-- artifacts / analysis_v2_target_evidence_manifests
-- columns=request_id,job_key,revision,input_hash,liker_source_hash,comment_source_hash,result_hash,interactor_count,liker_count,comment_count,frozen_at,created_at,updated_at; filter=request_id; order=created_at,request_id,job_key; key=job_key
GRANT SELECT (request_id, job_key, revision, input_hash, liker_source_hash, comment_source_hash, result_hash, interactor_count, liker_count, comment_count, frozen_at, created_at, updated_at)
    ON TABLE public.analysis_v2_target_evidence_manifests TO service_role;

-- artifacts / analysis_target_interactors
-- columns=request_id,job_key,ordinal,post_id,signal,source_interaction_id,occurred_at,created_at; filter=request_id; order=created_at,request_id,ordinal; key=ordinal
GRANT SELECT (request_id, job_key, ordinal, post_id, signal, source_interaction_id, occurred_at, created_at)
    ON TABLE public.analysis_target_interactors TO service_role;

-- artifacts / analysis_v2_candidate_feature_manifests
-- columns=request_id,batch,created_at; filter=request_id; order=created_at,request_id,batch; key=batch
GRANT SELECT (request_id, batch, created_at)
    ON TABLE public.analysis_v2_candidate_feature_manifests TO service_role;

-- artifacts / analysis_v2_candidate_feature_rows
-- columns=request_id,candidate_id,created_at; filter=request_id; order=created_at,request_id,candidate_id; key=candidate_id
GRANT SELECT (request_id, candidate_id, created_at)
    ON TABLE public.analysis_v2_candidate_feature_rows TO service_role;

-- artifacts / analysis_v2_candidate_score_manifests
-- columns=request_id,created_at; filter=request_id; order=created_at,request_id,request_id; key=request_id
GRANT SELECT (request_id, created_at)
    ON TABLE public.analysis_v2_candidate_score_manifests TO service_role;

-- artifacts / analysis_v2_candidate_score_rows
-- columns=request_id,candidate_id,created_at; filter=request_id; order=created_at,request_id,candidate_id; key=candidate_id
GRANT SELECT (request_id, candidate_id, created_at)
    ON TABLE public.analysis_v2_candidate_score_rows TO service_role;

-- artifacts / analysis_v2_media_artifacts
-- columns=request_id,artifact_key,artifact_kind,content_sha256,expires_at,created_at,deleted_at; filter=request_id; order=created_at,request_id,artifact_key; key=artifact_key
GRANT SELECT (request_id, artifact_key, artifact_kind, content_sha256, expires_at, created_at, deleted_at)
    ON TABLE public.analysis_v2_media_artifacts TO service_role;

-- costs / analysis_v2_cost_attributions
-- columns=request_id,source_kind,source_operation_key,source_identity_hash,attributed_at,updated_at; filter=request_id; order=attributed_at,request_id,source_operation_key; key=source_operation_key
GRANT SELECT (request_id, source_kind, source_operation_key, source_identity_hash, attributed_at, updated_at)
    ON TABLE public.analysis_v2_cost_attributions TO service_role;

-- costs / analysis_v2_cost_rollup_snapshots
-- columns=request_id,rollup_version,created_at; filter=request_id; order=created_at,request_id,rollup_version; key=rollup_version
GRANT SELECT (request_id, rollup_version, created_at)
    ON TABLE public.analysis_v2_cost_rollup_snapshots TO service_role;

-- jobs / analysis_jobs (executable canonical destination)
-- columns=id,request_id,job_key,kind,state,generation,attempt_count,dependency_count,next_attempt_at,lease_expires_at,completion_hash,payload,retention_class,created_at,updated_at; filter=request_id; order=created_at,request_id,id; key=id
GRANT SELECT (id, request_id, job_key, kind, state, generation, attempt_count, dependency_count, next_attempt_at, lease_expires_at, completion_hash, payload, retention_class, created_at, updated_at)
    ON TABLE public.analysis_jobs TO service_role;

-- events / analysis_events (executable canonical destination)
-- columns=id,request_id,job_id,kind,state,payload,content_hash,retention_class,created_at; filter=request_id; order=created_at,request_id,id; key=id
GRANT SELECT (id, request_id, job_id, kind, state, payload, content_hash, retention_class, created_at)
    ON TABLE public.analysis_events TO service_role;

-- artifacts / analysis_artifacts (executable canonical destination)
-- columns=id,request_id,job_id,kind,artifact_key,state,content_hash,payload,retention_class,created_at,updated_at; filter=request_id; order=created_at,request_id,id; key=id
GRANT SELECT (id, request_id, job_id, kind, artifact_key, state, content_hash, payload, retention_class, created_at, updated_at)
    ON TABLE public.analysis_artifacts TO service_role;

-- costs / analysis_costs (executable canonical destination)
-- columns=id,request_id,provider,operation_key,stage,currency,amount_known,amount_conservative,usage_unknown,source_hash,idempotency_key,payload,retention_class,recorded_at; filter=request_id; order=recorded_at,request_id,id; key=id
GRANT SELECT (id, request_id, provider, operation_key, stage, currency, amount_known, amount_conservative, usage_unknown, source_hash, idempotency_key, payload, retention_class, recorded_at)
    ON TABLE public.analysis_costs TO service_role;
