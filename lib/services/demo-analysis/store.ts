import 'server-only';

import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { DEMO_FIXTURE_VERSION, DEMO_TARGET_USERNAME, demoDurationSeconds } from './demo-analysis';

const uuid = z.string().uuid();
const rowSchema = z.object({
    id: uuid,
    user_id: uuid,
    target_instagram_id: z.literal(DEMO_TARGET_USERNAME),
    fixture_version: z.literal(DEMO_FIXTURE_VERSION),
    idempotency_key: z.string().min(16).max(128),
    duration_seconds: z.number().int().min(60).max(90),
    created_at: z.string().datetime({ offset: true }),
    started_at: z.string().datetime({ offset: true }).nullable(),
}).passthrough();

export type DemoAnalysisRun = z.infer<typeof rowSchema>;

function parseRow(value: unknown): DemoAnalysisRun | null {
    const parsed = rowSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

export const DEMO_ANALYSIS_DATABASE_NAMES = Object.freeze({
    table: 'demo_analysis_runs',
    createRpc: 'create_demo_analysis_preflight',
    startRpc: 'start_demo_analysis_run',
});

export const demoAnalysisStore = {
    async createOrReplay(input: { userId: string; idempotencyKey: string }): Promise<{ run: DemoAnalysisRun; created: boolean } | null> {
        const { data, error } = await supabaseAdmin.rpc(DEMO_ANALYSIS_DATABASE_NAMES.createRpc, {
            p_user_id: input.userId,
            p_target_instagram_id: DEMO_TARGET_USERNAME,
            p_idempotency_key: input.idempotencyKey,
            p_duration_seconds: demoDurationSeconds(),
        });
        if (error || !Array.isArray(data) || data.length !== 1) return null;
        const entry = data[0] as Record<string, unknown>;
        const run = parseRow(entry);
        if (!run || run.user_id !== input.userId) return null;
        return { run, created: entry.created === true };
    },

    async startForOwner(runId: string, userId: string): Promise<DemoAnalysisRun | null> {
        const { data, error } = await supabaseAdmin.rpc(DEMO_ANALYSIS_DATABASE_NAMES.startRpc, {
            p_run_id: runId,
            p_user_id: userId,
        });
        if (error || !Array.isArray(data) || data.length !== 1) return null;
        const run = parseRow(data[0]);
        return run?.user_id === userId ? run : null;
    },

    async findForOwner(runId: string, userId: string): Promise<DemoAnalysisRun | null> {
        const { data, error } = await supabaseAdmin
            .from(DEMO_ANALYSIS_DATABASE_NAMES.table)
            .select('id, user_id, target_instagram_id, fixture_version, idempotency_key, duration_seconds, created_at, started_at')
            .eq('id', runId)
            .eq('user_id', userId)
            .maybeSingle();
        if (error || !data) return null;
        return parseRow(data);
    },

    async listForOwner(userId: string): Promise<DemoAnalysisRun[]> {
        const { data, error } = await supabaseAdmin
            .from(DEMO_ANALYSIS_DATABASE_NAMES.table)
            .select('id, user_id, target_instagram_id, fixture_version, idempotency_key, duration_seconds, created_at, started_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });
        if (error || !Array.isArray(data)) return [];
        return data.map(parseRow).filter((row): row is DemoAnalysisRun => row !== null);
    },

    async deleteForOwner(runId: string, userId: string): Promise<boolean> {
        const { data, error } = await supabaseAdmin
            .from(DEMO_ANALYSIS_DATABASE_NAMES.table)
            .delete()
            .eq('id', runId)
            .eq('user_id', userId)
            .select('id');
        return !error && Array.isArray(data) && data.length === 1;
    },
};
