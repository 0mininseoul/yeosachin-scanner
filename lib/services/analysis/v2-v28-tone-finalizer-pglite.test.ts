import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260727031000_add_analysis_v2_v28_tone_finalizer.sql',
        import.meta.url,
    ),
    'utf8',
);
const predecessorMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260724123400_add_relative_risk_policy_v23.sql',
        import.meta.url,
    ),
    'utf8',
);
const REQUEST_V28 = '11111111-1111-4111-8111-111111111111';
const REQUEST_LEGACY = '22222222-2222-4222-8222-222222222222';

function functionDefinition(
    name: string,
    source = migration,
): string {
    const marker = `CREATE OR REPLACE FUNCTION public.${name}(`;
    const start = source.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = source.indexOf('\n$$;', start);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end + 4);
}

let db: PGlite;

beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
        CREATE TABLE public.analysis_requests (
            id UUID PRIMARY KEY,
            policy_versions_snapshot JSONB NOT NULL
        );
        CREATE TABLE public.analysis_v2_female_results (
            request_id UUID NOT NULL,
            candidate_id TEXT NOT NULL,
            sort_ordinal SMALLINT NOT NULL,
            one_line_overview TEXT NOT NULL,
            narrative_line_one TEXT,
            narrative_line_two TEXT,
            PRIMARY KEY (request_id, candidate_id)
        );
        INSERT INTO public.analysis_requests VALUES
            ('${REQUEST_V28}', '{"aiStage":"ai-stage-policy-v2.8"}'),
            ('${REQUEST_LEGACY}', '{"aiStage":"ai-stage-policy-v2.7"}');
    `);
    await db.exec(functionDefinition(
        'analysis_v2_relative_overview_fallback',
        predecessorMigration,
    ));
    await db.exec(functionDefinition('analysis_v2_v28_safe_overview_fallback'));
    await db.exec(functionDefinition('analysis_v2_apply_v28_summary_tone'));
});

afterAll(async () => {
    await db.close();
});

async function seed(requestId: string, count: number, laughs: readonly number[]) {
    await db.query('DELETE FROM public.analysis_v2_female_results WHERE request_id = $1', [requestId]);
    for (let ordinal = 1; ordinal <= count; ordinal++) {
        const laugh = laughs.includes(ordinal) ? ' ㅋ 그리고 ㅋㅋㅋ 또 ㅋㅋㅋㅋㅋ' : '';
        const uniqueLabel = String.fromCharCode(0xAC00 + ordinal);
        await db.query(
            `INSERT INTO public.analysis_v2_female_results (
                request_id, candidate_id, sort_ordinal, one_line_overview,
                narrative_line_one, narrative_line_two
            ) VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                requestId,
                `candidate-${ordinal}`,
                ordinal,
                `사진과 소개가 같은 방향을 가리키는 ${uniqueLabel} 계정입니다${laugh}.`,
                ordinal === 1 ? '근거가 있는 설명 ㅋ ㅋㅋㅋ' : null,
                ordinal === 1 ? '상호작용 근거 ㅋㅋㅋㅋㅋ' : null,
            ],
        );
    }
}

async function summaries(requestId: string) {
    const rows = await db.query<{
        sort_ordinal: number;
        one_line_overview: string;
        narrative_line_one: string | null;
        narrative_line_two: string | null;
    }>(`SELECT sort_ordinal, one_line_overview, narrative_line_one, narrative_line_two
        FROM public.analysis_v2_female_results WHERE request_id = $1 ORDER BY sort_ordinal`, [
        requestId,
    ]);
    return rows.rows;
}

describe('v2.8 atomic finalizer tone guard', () => {
    it('guards only v2.8 and rebinds both finalization entry points through the atomic wrapper', () => {
        expect(migration).toContain("request.policy_versions_snapshot->>'aiStage' = 'ai-stage-policy-v2.8'");
        expect(migration).toContain('ALTER FUNCTION public.complete_analysis_v2_result_and_purge(');
        expect(migration).toContain('analysis_v2_complete_result_and_purge_before_v28_tone');
        expect(migration).toContain('CREATE OR REPLACE FUNCTION public.complete_analysis_v2_result_and_purge_with_images(');
        expect(migration).toContain(
            'REVOKE ALL ON FUNCTION public.complete_analysis_v2_result_and_purge(',
        );
        expect(migration).not.toContain(
            'REVOKE ALL ON FUNCTION public.analysis_v2_complete_result_and_purge(',
        );
        expect(migration.indexOf('CREATE OR REPLACE FUNCTION public.complete_analysis_v2_result_and_purge('))
            .toBeLessThan(migration.indexOf(
                'CREATE OR REPLACE FUNCTION public.complete_analysis_v2_result_and_purge_with_images('
            ));
    });

    it('applies the complete migration against the predecessor finalizer signature', async () => {
        const migrationDb = new PGlite();
        try {
            await migrationDb.exec(`
                CREATE ROLE anon;
                CREATE ROLE authenticated;
                CREATE ROLE service_role;
                CREATE TABLE public.analysis_requests (
                    id UUID PRIMARY KEY,
                    policy_versions_snapshot JSONB NOT NULL
                );
                CREATE TABLE public.analysis_v2_female_results (
                    request_id UUID NOT NULL,
                    candidate_id TEXT NOT NULL,
                    sort_ordinal SMALLINT NOT NULL,
                    one_line_overview TEXT NOT NULL,
                    narrative_line_one TEXT,
                    narrative_line_two TEXT,
                    PRIMARY KEY (request_id, candidate_id)
                );
                CREATE TABLE public.analysis_v2_result_image_manifests (
                    request_id UUID PRIMARY KEY,
                    producer_job_key TEXT NOT NULL,
                    producer_input_hash TEXT NOT NULL,
                    producer_claim_token UUID NOT NULL,
                    ordered_manifest_hash TEXT NOT NULL,
                    expected_rows INTEGER NOT NULL,
                    durable_rows INTEGER NOT NULL,
                    sourced_images INTEGER NOT NULL,
                    ready_images INTEGER NOT NULL,
                    capture_failed_images INTEGER NOT NULL,
                    sealed_at TIMESTAMPTZ
                );
                CREATE TABLE public.analysis_v2_result_image_objects (
                    request_id UUID NOT NULL,
                    is_mandatory BOOLEAN NOT NULL,
                    status TEXT NOT NULL,
                    expires_at TIMESTAMPTZ NOT NULL
                );
                CREATE FUNCTION public.analysis_v2_result_image_coverage_ok(
                    INTEGER, INTEGER, INTEGER, INTEGER, INTEGER
                ) RETURNS BOOLEAN
                LANGUAGE sql
                IMMUTABLE
                AS $$ SELECT TRUE $$;
                CREATE FUNCTION public.complete_analysis_v2_result_and_purge(
                    UUID, TEXT, UUID, TEXT, TEXT
                ) RETURNS JSONB
                LANGUAGE sql
                AS $$ SELECT '{}'::JSONB $$;
            `);

            await migrationDb.exec(migration);
            const functions = await migrationDb.query<{ proname: string }>(`
                SELECT proname
                FROM pg_catalog.pg_proc
                WHERE proname IN (
                    'complete_analysis_v2_result_and_purge',
                    'analysis_v2_complete_result_and_purge_before_v28_tone'
                )
                ORDER BY proname
            `);
            expect(functions.rows.map(row => row.proname)).toEqual([
                'analysis_v2_complete_result_and_purge_before_v28_tone',
                'complete_analysis_v2_result_and_purge',
            ]);
        } finally {
            await migrationDb.close();
        }
    });

    it.each([
        { count: 0, expected: 0 },
        { count: 19, expected: 0 },
        { count: 20, expected: 1 },
        { count: 39, expected: 1 },
        { count: 40, expected: 2 },
    ])('enforces the floor(N / 20) global ㅋㅋ budget for N=$count', async ({ count, expected }) => {
        await seed(REQUEST_V28, count, Array.from({ length: count }, (_, index) => index + 1));
        await db.query('SELECT public.analysis_v2_apply_v28_summary_tone($1)', [REQUEST_V28]);
        const rows = await summaries(REQUEST_V28);
        const kept = rows.filter(row => /ㅋ/u.test(row.one_line_overview));
        expect(kept).toHaveLength(expected);
        expect(kept.every(row => (
            row.one_line_overview.match(/ㅋ+/gu) ?? []
        ).join('|') === 'ㅋㅋ')).toBe(true);
        if (rows[0]) {
            expect(rows[0].narrative_line_one).not.toMatch(/ㅋ/u);
            expect(rows[0].narrative_line_two).not.toMatch(/ㅋ/u);
        }
    });

    it('keeps deterministically non-adjacent summaries whenever alternatives exist', async () => {
        await seed(REQUEST_V28, 40, [1, 2, 3, 4]);
        await db.query('SELECT public.analysis_v2_apply_v28_summary_tone($1)', [REQUEST_V28]);
        const first = await summaries(REQUEST_V28);
        expect(first.filter(row => /ㅋ/u.test(row.one_line_overview)).map(row => row.sort_ordinal))
            .toEqual([1, 3]);
        await db.query('SELECT public.analysis_v2_apply_v28_summary_tone($1)', [REQUEST_V28]);
        expect(await summaries(REQUEST_V28)).toEqual(first);
    });

    it('does not modify legacy result copy and replaces a v2.8 self-referential fallback', async () => {
        await seed(REQUEST_LEGACY, 20, [1]);
        await db.query('SELECT public.analysis_v2_apply_v28_summary_tone($1)', [REQUEST_LEGACY]);
        expect((await summaries(REQUEST_LEGACY))[0]?.one_line_overview)
            .toContain('ㅋ 그리고 ㅋㅋㅋ 또 ㅋㅋㅋㅋㅋ');

        await seed(REQUEST_V28, 1, []);
        await db.query(`UPDATE public.analysis_v2_female_results
            SET one_line_overview = '판독관은 이 계정의 사진 흐름을 보며 혼자 추리합니다.'
            WHERE request_id = $1`, [REQUEST_V28]);
        await db.query('SELECT public.analysis_v2_apply_v28_summary_tone($1)', [REQUEST_V28]);
        expect((await summaries(REQUEST_V28))[0]?.one_line_overview)
            .toBe('확인된 공개 단서가 제한적이고, 계정 성격을 더 단정하기 어렵습니다. 보이는 범위까지만 확인하는 편이 낫겠네요.');
    });

    it('repairs the real predecessor duplicate fallbacks without exposing identities or internals', async () => {
        await db.query('DELETE FROM public.analysis_v2_female_results WHERE request_id = $1', [
            REQUEST_V28,
        ]);
        const safeLabels = [
            '가', '나', '다', '라', '마', '바', '사',
            '아', '자', '차', '카', '타', '파', '하',
        ];
        for (let ordinal = 1; ordinal <= 20; ordinal++) {
            let overview: string;
            if (ordinal <= 5) {
                const predecessor = await db.query<{ overview: string }>(
                    `SELECT public.analysis_v2_relative_overview_fallback($1)
                        AS overview`,
                    [ordinal],
                );
                overview = predecessor.rows[0]!.overview;
            } else if (ordinal === 6) {
                overview =
                    '공개 자료가 제한적입니다 · candidatealpha 계정은 고위험 단계로 판독됐어요.';
            } else {
                overview =
                    `공개 자료 ${safeLabels[ordinal - 7]} 범위에서 확인되는 내용만 남깁니다.`
                    + (ordinal <= 9 ? ' ㅋㅋㅋㅋ' : '');
            }
            await db.query(
                `INSERT INTO public.analysis_v2_female_results (
                    request_id, candidate_id, sort_ordinal, one_line_overview,
                    narrative_line_one, narrative_line_two
                ) VALUES ($1, $2, $3, $4, $5, $6)`,
                [
                    REQUEST_V28,
                    `candidate-${ordinal}`,
                    ordinal,
                    overview,
                    ordinal === 1 ? '근거 설명 ㅋㅋㅋㅋ' : null,
                    ordinal === 1 ? '상호작용 설명 ㅋㅋㅋ' : null,
                ],
            );
        }

        await db.query('SELECT public.analysis_v2_apply_v28_summary_tone($1)', [REQUEST_V28]);
        const rows = await summaries(REQUEST_V28);
        expect(new Set(rows.map(row => row.one_line_overview)).size).toBe(rows.length);
        expect(rows.map(row => row.one_line_overview).join(' ')).not.toMatch(
            /판독관|candidatealpha|@|고위험 단계|위험도|점수|risk[-_ ]?(?:policy|band)|\d/iu,
        );
        expect(rows.filter(row => /ㅋ/u.test(row.one_line_overview))).toHaveLength(1);
        expect(rows.flatMap(row => [
            row.narrative_line_one ?? '',
            row.narrative_line_two ?? '',
        ]).join(' ')).not.toMatch(/ㅋ/u);
    });
});
