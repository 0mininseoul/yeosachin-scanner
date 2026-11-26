import { randomUUID } from 'node:crypto';
import { buildReadyPreflightSnapshot, currentPreflightCatalogSnapshot, launchStatusSnapshot } from '@/lib/services/analysis/preflight';
import type { createSharedStandardDatabase } from './standard-shared-database';

export async function seedProcessingJob(db: Awaited<ReturnType<typeof createSharedStandardDatabase>>) {
    const owner = randomUUID();
    const requestId = randomUUID();
    const jobClaimToken = randomUUID();
    const jobKey = 'track:profile-ai:batch:0';
    const target = 'capacity_fixture';
    const catalog = currentPreflightCatalogSnapshot();
    const snapshot = buildReadyPreflightSnapshot(
        { username: target, followersCount: 150, followingCount: 110, isPrivate: false }, 'test_entitlement', catalog,
    );
    if (typeof snapshot === 'string') throw new Error('Unsupported synthetic preflight');
    const cards = Object.fromEntries(snapshot.plans.map(card => [card.planId, {
        launchStatus: card.launchStatus, selectionState: card.selectionState, unavailableReason: card.unavailableReason,
        relationshipCapacity: card.relationshipCapacity, detailedMutualLimit: card.detailedMutualLimit,
    }]));
    const policy = { pipeline: 'v2', risk: 'risk-policy-v2.5', aiStage: 'ai-stage-policy-v2.11', scheduler: 'ai-scheduler-v1' };
    await db.transaction(async tx => {
        await tx.query("INSERT INTO public.users(id,email,provider) VALUES ($1,$2,'kakao')", [owner, owner + '@example.invalid']);
        const { rows: [preflight] } = await tx.query<{ id: string }>(`INSERT INTO public.analysis_preflights(user_id,
            idempotency_key,target_instagram_id,access_mode,created_at,expires_at,launch_status_snapshot,plan_catalog_snapshot,
            pricing_version,pricing_snapshot,policy_versions_snapshot) VALUES ($1,'capacity-fixture',$2,
            'test_entitlement',now(),now()+interval '30 minutes',$3,$4,$5,$6,$7) RETURNING id`,
            [owner, target, launchStatusSnapshot(), catalog.plans, catalog.pricingVersion, catalog.prices, policy]);
        await tx.query(`INSERT INTO public.analysis_requests(id,user_id,target_instagram_id,target_gender,status,pipeline_version,
            preflight_id,idempotency_key,exclusion_decision_snapshot,plan_access_mode_snapshot,capacity_required_plan_id_snapshot,
            required_plan_id_snapshot,selected_plan_id_snapshot,plan_launch_status_snapshot,plan_cards_snapshot,
            pricing_version_snapshot,pricing_snapshot,analysis_scope_snapshot,policy_versions_snapshot,test_entitlement_jti_hash)
            VALUES ($1,$2,$3,'male','processing','v2',$4,'capacity-fixture','skip','test_entitlement','basic','basic',
            'standard',$5,$6,$7,$8,$9,$10,repeat('a',64))`, [requestId, owner, target, preflight.id, launchStatusSnapshot(),
            cards, catalog.pricingVersion, catalog.prices, {
                relationshipCapacity: cards.standard.relationshipCapacity,
                detailedMutualLimit: cards.standard.detailedMutualLimit
            }, policy]);
        await tx.query(`INSERT INTO public.analysis_pipeline_jobs(request_id,job_key,track,kind,batch,input_hash,
            status,lease_token,lease_expires_at,created_at,updated_at,recovery_not_before,
            dispatch_state,dispatch_generation,dispatch_reservation_token,dispatch_reserved_at,dispatched_at,
            dispatch_task_name,delivered_at,attempt_count,first_started_at)
            VALUES($1,$2,'relationships','profile_ai',0,repeat('a',64),'processing',$3,now()+interval '5 minutes',
                now(),now(),now()+interval '5 minutes','delivered',1,gen_random_uuid(),now(),now(),'fixture',now(),1,now())`,
            [requestId, jobKey, jobClaimToken]);
    });
    return { requestId, jobKey, jobClaimToken };
}
