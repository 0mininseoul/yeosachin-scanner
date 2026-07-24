import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260714140011_fix_analysis_v2_owner_history_deletion.sql',
        import.meta.url
    ),
    'utf8'
);

const resultImageMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260724123500_add_analysis_v2_result_image_objects.sql',
        import.meta.url
    ),
    'utf8'
);

const deleteRoute = readFileSync(
    new URL('../../../app/api/analysis/result/[requestId]/route.ts', import.meta.url),
    'utf8'
);

const myPage = readFileSync(
    new URL('../../../app/mypage/page.tsx', import.meta.url),
    'utf8'
);

const analysisList = readFileSync(
    new URL('../../../app/mypage/analysis-list.tsx', import.meta.url),
    'utf8'
);

function functionDefinition(name: string): string {
    const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n$$;', start);
    expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
    return migration.slice(start, end);
}

describe('analysis V2 owner history and deletion migration contract', () => {
    it('cascades a terminal request deletion through its consumed preflight tombstone', () => {
        expect(migration).toContain(
            'DROP CONSTRAINT IF EXISTS analysis_preflights_consumed_request_id_fkey'
        );
        expect(migration).toMatch(
            /ADD CONSTRAINT analysis_preflights_consumed_request_id_fkey\s+FOREIGN KEY \(consumed_request_id\)\s+REFERENCES public\.analysis_requests\(id\)\s+ON DELETE CASCADE\s+DEFERRABLE INITIALLY DEFERRED/
        );
        expect(migration).not.toMatch(
            /analysis_preflights_consumed_request_id_fkey[\s\S]*?ON DELETE NO ACTION/
        );
    });

    it('keeps the application delete boundary owner-scoped and terminal-only', () => {
        expect(deleteRoute).toContain(".eq('user_id', user.id)");
        expect(deleteRoute).toContain(".in('status', ['completed', 'failed'])");
        expect(deleteRoute).toContain("if (authError || !user)");
    });

    it('queues every retained image key before the owned request is deleted', () => {
        expect(resultImageMigration).toContain(
            'CREATE FUNCTION public.enqueue_analysis_v2_result_image_purges_before_delete()'
        );
        expect(resultImageMigration).toContain(
            'BEFORE DELETE ON public.analysis_requests'
        );
        expect(resultImageMigration).toContain(
            'INSERT INTO public.analysis_v2_result_image_purge_outbox'
        );
        expect(resultImageMigration).toContain("'owner_delete'");
        expect(resultImageMigration).toContain(
            "image_object.status = 'ready'"
        );
        expect(resultImageMigration).not.toMatch(
            /analysis_v2_result_image_purge_outbox[\s\S]{0,500}REFERENCES public\.analysis_requests/
        );
    });

    it('projects only the authenticated owner history through a locked-down function', () => {
        const loader = functionDefinition('load_analysis_owner_history_v1');

        expect(loader).toContain('SECURITY DEFINER');
        expect(loader).toContain("SET search_path = ''");
        expect(loader).toContain('v_user_id UUID := auth.uid()');
        expect(loader).toContain('IF v_user_id IS NULL THEN');
        expect(loader).toContain('analysis_request.user_id = v_user_id');
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.load_analysis_owner_history_v1\(\)\s+FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.load_analysis_owner_history_v1\(\)\s+TO authenticated/
        );
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.load_analysis_owner_history_v1\(\)\s+TO (?:anon|service_role)/
        );
    });

    it('uses final V2 summaries, redacts failed V2 rows, and preserves V1 usernames', () => {
        const loader = functionDefinition('load_analysis_owner_history_v1');

        expect(loader).toContain('public.analysis_v2_result_summaries AS result_summary');
        expect(loader).toContain("analysis_request.status = 'completed'");
        expect(loader).toContain('THEN result_summary.target_instagram_id');
        expect(loader).toContain("analysis_request.status = 'failed'");
        expect(loader).toContain("analysis_request.target_instagram_id LIKE 'retained.%'");
        expect(loader).toContain('THEN NULL');
        expect(loader).toContain('ELSE analysis_request.target_instagram_id');
        expect(loader).toContain("'schemaVersion', 1");
    });

    it('makes mypage consume only the validated owner projection', () => {
        expect(myPage).toContain(".rpc('load_analysis_owner_history_v1')");
        expect(myPage).toContain('ownerAnalysisHistoryV1Schema.safeParse(historyPayload)');
        expect(myPage).not.toContain(".from('analysis_requests')");
        expect(analysisList).toContain('ownerHistoryTargetLabel(item)');
        expect(analysisList).not.toContain('target_instagram_id');
    });
});
