import 'server-only';

import type { GenerateContentParameters } from '@google/genai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { VertexDispatchAuthorizationError } from '@/lib/services/ai/vertex-dispatch-window';
import registry from '@/config/dev-ui-deployment.json';
import { browserDeploymentEnvironment, deploymentEnvironment } from '@/lib/constants/dev-ui';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { isPostgresStatementTimeout, retryPostgresAbortedRpc } from '@/lib/supabase/rpc-retry';
import {
    DEV_LIVE_STANDARD_ARCHIVE_REQUIRED,
    devLiveOwnerStartEnabled,
    devLiveStandardCaptureConfigured,
    devLiveStandardNeedsArchive,
    readDevLiveApproval,
    type DevLiveApproval,
} from './live-approval';
import { DevLiveVertexBudgetReservationPendingError } from './live-budget-signals';
import { devLiveWorkerRequestBoundary } from './live-runtime';
import { estimateDevLiveVertexReservation } from './live-vertex-reservation';
import { currentDevStandardArchive } from './standard-archive-runtime';

export const DEV_LIVE_BUDGET_UNAVAILABLE = 'DEV_LIVE_BUDGET_UNAVAILABLE';
export const DEV_LIVE_BUDGET_EXCEEDED = 'DEV_LIVE_BUDGET_EXCEEDED';
const MICRODOLLARS_PER_DOLLAR = 1_000_000;
const MICRODOLLARS_PER_CENT = 10_000;

// The approved provider set uses pay-per-event Actors. Never admit an unknown Actor.
const APIFY_ACTORS = new Set([
    'apify/instagram-profile-scraper',
    'apify/instagram-scraper',
    'scraping_solutions/instagram-scraper-followers-following-no-cookies',
    'datadoping/instagram-likes-scraper',
    'apify/instagram-comment-scraper',
]);

type Provider = 'apify' | 'vertex';
const workerApproval = new AsyncLocalStorage<DevLiveApproval>();

export function withDevLiveProviderApproval<T>(approval: DevLiveApproval | null, operation: () => T): T {
    return approval ? workerApproval.run(approval, operation) : operation();
}

export type DevLiveCostReservation = Readonly<{
    grantId: string;
    reservationId: string;
    durableAttempt?: true;
}>;

type VertexAttemptIdentity = Readonly<{ requestId: string; operationKey: string; attempt: number }>;

function micros(usd: number): number {
    const amount = Math.ceil(usd * MICRODOLLARS_PER_DOLLAR);
    if (!Number.isFinite(usd) || usd < 0 || !Number.isSafeInteger(amount) || amount > 5_000_000) {
        throw new Error(DEV_LIVE_BUDGET_UNAVAILABLE);
    }
    return amount;
}

function assertRegisteredDevDatabase(): void {
    // Use a dynamic key for the runtime value and check against the public URL
    // compiled into this Dev build as well as the registered Dev database.
    const runtime = deploymentEnvironment().NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
    const built = browserDeploymentEnvironment().NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
    if (!runtime || runtime !== built
        || !registry.deployments.some(entry => runtime === `https://${entry.supabaseProjectRef}.supabase.co`)) {
        throw new Error(DEV_LIVE_BUDGET_UNAVAILABLE);
    }
}

function grantArguments(approval: DevLiveApproval) {
    assertRegisteredDevDatabase();
    return {
        p_grant_id: approval.id,
        p_approved_at: approval.approvedAt,
        p_expires_at: approval.expiresAt === null ? 'infinity' : approval.expiresAt,
        p_apify_limit_micros: approval.apifyMaxCents * MICRODOLLARS_PER_CENT,
        p_ai_limit_micros: approval.aiMaxCents * MICRODOLLARS_PER_CENT,
    };
}

async function budgetRpc(name: string, args: Record<string, string | number>): Promise<unknown> {
    let result;
    try {
        const execute = () => supabaseAdmin.rpc(name, args);
        // Keep the same reservation ID and amount after a confirmed rollback.
        // Retrying settlement here never re-enters the Vertex call.
        const retryOnStatementTimeout = name === 'dev_live_budget_reserve_v1'
            || name === 'dev_live_budget_settle_vertex_v1';
        result = retryOnStatementTimeout
            ? await retryPostgresAbortedRpc(execute, { retryDeadlock: false })
            : await execute();
    } catch {
        throw new Error(DEV_LIVE_BUDGET_UNAVAILABLE);
    }
    if (!result.error) return result.data;
    if ((name === 'dev_live_budget_reserve_vertex_attempt_v1' || name === 'dev_live_budget_reserve_v1')
        && result.error.code === 'P0001'
        && result.error.message === 'ANALYSIS_V2_VERTEX_DISPATCH_STOPPED') {
        throw new VertexDispatchAuthorizationError('closed');
    }
    // Only a structured database response proves this statement did not commit.
    if (name === 'dev_live_budget_reserve_vertex_attempt_v1' && isPostgresStatementTimeout(result.error)) {
        console.warn('Dev Vertex budget reservation rolled back before dispatch', { sqlstate: '57014' });
        throw new DevLiveVertexBudgetReservationPendingError();
    }
    throw new Error(DEV_LIVE_BUDGET_UNAVAILABLE);
}

/** Before enqueue, prove the grant and installed Dev budget schema are eligible. */
export async function assertDevLiveBudgetAvailable(approval: DevLiveApproval): Promise<void> {
    const version = await budgetRpc('dev_live_budget_check_v1', grantArguments(approval));
    if (version !== 1) throw new Error(DEV_LIVE_BUDGET_UNAVAILABLE);
}

/** Each provider entry point independently verifies it is a registered Dev worker. */
export function requireDevLiveProviderApproval(): DevLiveApproval {
    const role = process.env.DEV_LIVE_WORKLOAD;
    const url = role === 'preflight'
        ? `${process.env.DEV_LIVE_PREFLIGHT_ORIGIN}/api/analysis/preflight/worker`
        : `${process.env.DEV_LIVE_PAID_ORIGIN}/api/analysis/v2/worker`;
    const approval = devLiveOwnerStartEnabled() ? workerApproval.getStore() : readDevLiveApproval();
    if (!approval || (approval.expiresAt !== null && Date.now() >= Date.parse(approval.expiresAt))
        || devLiveWorkerRequestBoundary({ url, method: 'POST' }) !== 'dev-worker') {
        throw new Error(DEV_LIVE_BUDGET_UNAVAILABLE);
    }
    return approval;
}

async function reserve(approval: DevLiveApproval, provider: Provider, capUsd: number): Promise<DevLiveCostReservation> {
    const amount = micros(capUsd);
    if (amount < 1) throw new Error(DEV_LIVE_BUDGET_UNAVAILABLE);
    const reservationId = randomUUID();
    const reserved = await budgetRpc('dev_live_budget_reserve_v1', {
        ...grantArguments(approval),
        p_reservation_id: reservationId,
        p_provider: provider,
        p_amount_micros: amount,
    });
    if (reserved === false) throw new Error(DEV_LIVE_BUDGET_EXCEEDED);
    if (reserved !== true) throw new Error(DEV_LIVE_BUDGET_UNAVAILABLE);
    return { grantId: approval.id, reservationId };
}

export function assertDevLiveApifyCollectionAllowed(approval: DevLiveApproval): void {
    const archive = currentDevStandardArchive();
    if (approval.planId === 'standard' && (
        devLiveStandardNeedsArchive()
        || archive?.mode === 'replay'
        || process.env.DEV_LIVE_STANDARD_COLLECTION_MODE === 'archive_replay'
        || (devLiveStandardCaptureConfigured() && (archive?.mode !== 'capture' || !archive.ready()))
    )) {
        throw new Error(DEV_LIVE_STANDARD_ARCHIVE_REQUIRED);
    }
}

export async function reserveDevLiveApifyStart(approval: DevLiveApproval, actorId: string, capUsd: number): Promise<void> {
    if (!APIFY_ACTORS.has(actorId)) throw new Error(DEV_LIVE_BUDGET_UNAVAILABLE);
    await reserve(approval, 'apify', capUsd);
}

export async function reserveDevLiveVertexAttempt(
    approval: DevLiveApproval,
    request: GenerateContentParameters,
    location: string,
    identity?: VertexAttemptIdentity,
): Promise<DevLiveCostReservation> {
    const cap = estimateDevLiveVertexReservation(request, location);
    if (!cap) throw new Error(DEV_LIVE_BUDGET_UNAVAILABLE);
    if (!identity) return reserve(approval, 'vertex', cap.totalCostUsd);

    // The durable attempt primary key excludes delivery and claim tokens. The DB
    // advances this seed only after a prior hold was explicitly released before send.
    const seed = createHash('sha256').update(JSON.stringify([
        'dev-live-vertex-attempt:v1', approval.id, identity.requestId, identity.operationKey, identity.attempt,
    ])).digest().subarray(0, 16);
    seed[6] = (seed[6] & 0x0f) | 0x80;
    seed[8] = (seed[8] & 0x3f) | 0x80;
    const hex = seed.toString('hex');
    const id = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
    const reserved = await budgetRpc('dev_live_budget_reserve_vertex_attempt_v1', {
        ...grantArguments(approval),
        p_reservation_id: id,
        p_amount_micros: micros(cap.totalCostUsd),
    });
    if (reserved === null) throw new Error(DEV_LIVE_BUDGET_EXCEEDED);
    if (typeof reserved !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(reserved)) {
        throw new Error(DEV_LIVE_BUDGET_UNAVAILABLE);
    }
    return { grantId: approval.id, reservationId: reserved, durableAttempt: true };
}

/** A durable attempt hold can be renewed only when this worker proves the SDK did not send it. */
export async function releaseUnusedDevLiveVertexAttempt(reservation: DevLiveCostReservation): Promise<void> {
    if (!reservation.durableAttempt) return settleDevLiveVertexAttempt(reservation, 0);
    assertRegisteredDevDatabase();
    const released = await budgetRpc('dev_live_budget_release_unused_vertex_v1', {
        p_grant_id: reservation.grantId,
        p_reservation_id: reservation.reservationId,
    });
    if (released !== true) throw new Error(DEV_LIVE_BUDGET_UNAVAILABLE);
}

/** Settle complete provider usage or a confirmed zero charge. Unknown costs retain the whole reservation. */
export async function settleDevLiveVertexAttempt(reservation: DevLiveCostReservation, actualUsd: number): Promise<void> {
    assertRegisteredDevDatabase();
    const settled = await budgetRpc('dev_live_budget_settle_vertex_v1', {
        p_grant_id: reservation.grantId,
        p_reservation_id: reservation.reservationId,
        // An unusually high amount still has to reach SQL so it can freeze the grant.
        p_actual_micros: micros(Math.min(actualUsd, 5)),
    });
    if (settled !== true) throw new Error(DEV_LIVE_BUDGET_UNAVAILABLE);
}
