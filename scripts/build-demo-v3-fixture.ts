import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseSafePublicRiskNarrative } from '../lib/services/analysis/narrative-privacy';

type SourcePublic = {
    kind: 'female';
    sourceRunId: string;
    sourceCandidateId: string;
    sort_ordinal: number;
    instagram_id: string;
    full_name: string | null;
    bio: string | null;
    display_score: string | number;
    risk_band: 'high_risk' | 'caution' | 'normal';
    featured_rank: number | null;
    recent_mutual_rank: number | null;
    analysis_depth: 'narrative' | 'features';
    one_line_overview: string;
    narrative_line_one: string | null;
    narrative_line_two: string | null;
};

type SourcePrivate = {
    kind: 'private';
    sourceRunId: string;
    sourceCandidateId: string;
    sort_ordinal: number;
    instagram_id: string;
    full_name: string | null;
};

const selectionSql = `
WITH grouped AS (
    SELECT r.id,
        COUNT(*) AS total_objects,
        COUNT(*) FILTER (WHERE o.kind = 'target') AS total_target,
        COUNT(*) FILTER (WHERE o.kind = 'female') AS total_female,
        COUNT(*) FILTER (WHERE o.kind = 'private') AS total_private,
        COUNT(*) FILTER (WHERE o.status = 'ready') AS ready_total,
        COUNT(*) FILTER (WHERE o.status = 'ready' AND o.kind = 'target') AS ready_target,
        COUNT(*) FILTER (WHERE o.status = 'ready' AND o.kind = 'female') AS ready_female,
        COUNT(*) FILTER (WHERE o.status = 'ready' AND o.kind = 'private') AS ready_private
    FROM public.analysis_requests r
    JOIN public.analysis_v2_result_image_manifests m ON m.request_id = r.id AND m.sealed_at IS NOT NULL
    JOIN public.analysis_v2_result_image_objects o ON o.request_id = r.id
    WHERE r.status = 'completed'
      AND (r.plan_type = 'standard' OR r.selected_plan_id_snapshot = 'standard')
    GROUP BY r.id
), selected AS (
    SELECT id FROM grouped
    WHERE total_objects = 230 AND total_target = 1 AND total_female = 84 AND total_private = 145
      AND ready_total = 230 AND ready_target = 1 AND ready_female = 84 AND ready_private = 145
), source_rows AS (
    SELECT
        'female'::text AS kind, selected.id::text AS "sourceRunId", image.candidate_locator::text AS "sourceCandidateId",
        image.sort_ordinal, result.instagram_id, result.full_name, result.bio,
        result.display_score, result.risk_band, result.featured_rank, result.recent_mutual_rank,
        result.analysis_depth, result.one_line_overview, result.narrative_line_one, result.narrative_line_two
    FROM selected
    JOIN public.analysis_v2_result_image_objects image ON image.request_id = selected.id
        AND image.kind = 'female' AND image.status = 'ready'
    JOIN public.analysis_v2_female_results result ON result.request_id = selected.id
        AND result.candidate_id = image.candidate_locator
    UNION ALL
    SELECT
        'private'::text AS kind, selected.id::text AS "sourceRunId", image.candidate_locator::text AS "sourceCandidateId",
        image.sort_ordinal, result.instagram_id, result.full_name, NULL::text,
        NULL::numeric, NULL::text, NULL::smallint, NULL::smallint, NULL::text, NULL::text, NULL::text, NULL::text
    FROM selected
    JOIN public.analysis_v2_result_image_objects image ON image.request_id = selected.id
        AND image.kind = 'private' AND image.status = 'ready'
    JOIN public.analysis_v2_private_results result ON result.request_id = selected.id
        AND result.candidate_id = image.candidate_locator
)
SELECT * FROM source_rows ORDER BY kind, sort_ordinal;
`;

function loadRows(): Array<SourcePublic | SourcePrivate> {
    const output = execFileSync('supabase', ['db', 'query', '--linked', selectionSql, '--output', 'json'], {
        encoding: 'utf8',
        env: process.env,
        stdio: ['ignore', 'pipe', 'inherit'],
    });
    const parsed = JSON.parse(output) as { rows?: unknown[] };
    if (!Array.isArray(parsed.rows)) throw new Error('Demo v4 source query did not return rows.');
    return parsed.rows as Array<SourcePublic | SourcePrivate>;
}

function digest(seed: string): number {
    return createHash('sha256').update(seed).digest().readUInt32BE(0);
}

function selectedIndexes(indexes: number[], seed: string): Set<number> {
    const count = Math.max(1, Math.round(indexes.length * 0.3));
    return new Set([...indexes]
        .sort((left, right) => digest(`${seed}:${left}`) - digest(`${seed}:${right}`))
        .slice(0, count));
}

function mutateIdentifier(value: string, seed: string): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const characters = [...value];
    const mutable = characters.flatMap((character, index) => /[A-Za-z0-9]/.test(character) ? [index] : []);
    const selected = selectedIndexes(mutable, seed);
    return characters.map((character, index) => {
        if (!selected.has(index)) return character;
        const lower = character.toLowerCase();
        const original = alphabet.indexOf(lower);
        const replacement = alphabet[(original + 1 + digest(`${seed}:replacement:${index}`) % (alphabet.length - 1)) % alphabet.length]!;
        return /[A-Z]/.test(character) ? replacement.toUpperCase() : replacement;
    }).join('');
}

const KOREAN_WORD_ALTERNATIVES = [
    '일상', '사진', '산책', '여행', '음악', '기록', '풍경', '주말', '취미', '마음', '공간', '시간',
] as const;
const LATIN_WORD_ALTERNATIVES = ['daily', 'photo', 'walk', 'weekend', 'mood', 'record'] as const;
const NAME_SYLLABLES = ['민', '서', '지', '윤', '하', '아', '연', '수', '진', '현'] as const;

// Curated demo-only presentation adjustments are applied after deterministic
// mutation, so rebuilding the fixture preserves the reviewed cards.
const DEMO_V4_CURATED_OVERRIDES = {
    normalInstagramId: 'bl1ckcherdk_cuu6',
    normalFullName: '이유진',
} as const;

function mutateName(value: string | null, seed: string): string | null {
    if (value === null) return null;
    const characters = [...value];
    const mutable = characters.flatMap((character, index) => /[가-힣]/u.test(character) && index > 0 ? [index] : []);
    if (mutable.length === 0) return mutateText(value, seed);
    const selected = selectedIndexes(mutable, seed);
    return characters.map((character, index) => selected.has(index)
        ? NAME_SYLLABLES[digest(`${seed}:${index}`) % NAME_SYLLABLES.length]!
        : character).join('');
}

function wordReplacement(token: string, seed: string, index: number): string {
    if (/^[가-힣]+$/u.test(token)) {
        return KOREAN_WORD_ALTERNATIVES[digest(`${seed}:${index}`) % KOREAN_WORD_ALTERNATIVES.length]!;
    }
    if (/^[A-Za-z]+$/u.test(token)) {
        const replacement = LATIN_WORD_ALTERNATIVES[digest(`${seed}:${index}`) % LATIN_WORD_ALTERNATIVES.length]!;
        return /^[A-Z]/.test(token) ? `${replacement[0]!.toUpperCase()}${replacement.slice(1)}` : replacement;
    }
    return token;
}

function mutateText(value: string | null, seed: string, protectedTerms: readonly string[] = []): string | null {
    if (value === null) return null;
    const tokens = [...value.matchAll(/[\p{L}]{2,}/gu)];
    const mutable = tokens.flatMap((match, index) => {
        const token = match[0]!;
        return protectedTerms.some(term => token.includes(term)) ? [] : [index];
    });
    const selected = selectedIndexes(mutable, seed);
    let cursor = 0;
    return value.replace(/[\p{L}]{2,}/gu, token => {
        const tokenIndex = cursor++;
        return selected.has(tokenIndex) ? wordReplacement(token, seed, tokenIndex) : token;
    });
}

function presentationText(value: string | null, seed: string, protectedTerms: readonly string[] = []): string | null {
    const mutated = mutateText(value, seed, protectedTerms);
    if (mutated === null) return null;
    // A demo account must never generate an actionable external profile link.
    return mutated
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/(?:https?:)?\/\/|www\.|(?:^|[\s(\[{'":,])[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.(?:xn--[a-z0-9-]{2,59}|\p{L}{2,63})(?:[\/?#:;,!?\])'"]|$|\.(?![\p{L}\p{N}-]))/giu, '')
        .replace(/@/g, '');
}

function uniqueByImageOrdinal<T extends { sort_ordinal: number }>(rows: readonly T[]): T[] {
    const seen = new Set<number>();
    return rows.filter(row => !seen.has(row.sort_ordinal) && seen.add(row.sort_ordinal));
}

type FixtureIdentity = Readonly<{
    imageSortOrdinal: number;
    instagramId: string;
}>;

export function assertUniqueFixture(fixture: Readonly<{
    public: readonly FixtureIdentity[];
    private: readonly FixtureIdentity[];
}>): void {
    const cards = [...fixture.public, ...fixture.private];
    if (new Set(cards.map(row => row.imageSortOrdinal)).size !== cards.length
        || new Set(cards.map(row => row.instagramId)).size !== cards.length) {
        throw new Error('The demo fixture repeats a source image or synthetic identifier across public and private cards.');
    }
}

function sourceFixture(rows: Array<SourcePublic | SourcePrivate>) {
    const selectedRunIds = new Set(rows.map(row => row.sourceRunId));
    if (selectedRunIds.size !== 1) {
        throw new Error('Expected exactly one sealed source selection for the demo v4 fixture.');
    }
    const sourceCandidateIds = new Set(rows.map(row => row.sourceCandidateId));
    if (sourceCandidateIds.size !== rows.length) {
        throw new Error('The selected demo source contains a duplicate candidate identity.');
    }
    const publicRows = uniqueByImageOrdinal(rows
        .filter((row): row is SourcePublic => row.kind === 'female')
        .sort((left, right) => left.sort_ordinal - right.sort_ordinal));
    const privateRows = uniqueByImageOrdinal(rows
        .filter((row): row is SourcePrivate => row.kind === 'private')
        .sort((left, right) => left.sort_ordinal - right.sort_ordinal));
    if (publicRows.length !== 84 || privateRows.length !== 145) {
        throw new Error(`Expected exactly 84 public and 145 private source rows, received ${publicRows.length}/${privateRows.length}.`);
    }
    if (publicRows.filter(row => row.risk_band === 'high_risk').length < 1 || publicRows.filter(row => row.risk_band === 'caution').length < 2) {
        throw new Error('The selected source does not satisfy the demo risk-card contract.');
    }
    const narrativeSource = publicRows.find(row => row.risk_band === 'high_risk'
        && row.narrative_line_one && row.narrative_line_two);
    if (!narrativeSource) throw new Error('The selected source has no high-risk narrative for the v4 contract.');
    const orderedPublicRows = [narrativeSource, ...publicRows.filter(row => row !== narrativeSource)];
    const highRiskNarrative = [
        presentationText(narrativeSource.narrative_line_one, 'public-narrative-one:0', ['제법', '친절'])!,
        presentationText(narrativeSource.narrative_line_two, 'public-narrative-two:0', ['좋아요', '댓글', '상호작용', '수집', '관측', '확인', '표본', '제법', '친절', '순진하게'])!,
    ];
    if (!parseSafePublicRiskNarrative(highRiskNarrative)) {
        throw new Error('The deterministically redacted high-risk narrative violated its public contract.');
    }
    const publicFixture = orderedPublicRows.map((row, index) => {
        const riskBand = index === 0 ? 'high_risk' : index < 3 ? 'caution' : 'normal';
        const displayScore = index === 0 ? 8 : index < 3 ? 5 : [3, 2, 1][index % 3]!;
        return {
            imageSortOrdinal: row.sort_ordinal,
            instagramId: mutateIdentifier(row.instagram_id, `public-handle:${index}`),
            fullName: mutateName(row.full_name, `public-name:${index}`),
            bio: presentationText(row.bio, `public-bio:${index}`),
            displayScore,
            riskBand,
            featuredRank: index < 3 ? index + 1 : null,
            recentMutualRank: index < 10 ? index + 1 : null,
            analysisDepth: index === 0 ? 'narrative' : 'features',
            oneLineOverview: presentationText(row.one_line_overview, `public-overview:${index}`)!,
            highRiskNarrative: index === 0
                ? highRiskNarrative
                : null,
        };
    });
    const curatedNormalIndex = publicFixture.findIndex(
        row => row.instagramId === DEMO_V4_CURATED_OVERRIDES.normalInstagramId,
    );
    if (curatedNormalIndex < 0) {
        throw new Error('The reviewed account was not present in the selected fixture.');
    }
    publicFixture[curatedNormalIndex] = {
        ...publicFixture[curatedNormalIndex]!,
        fullName: DEMO_V4_CURATED_OVERRIDES.normalFullName,
        displayScore: 3,
        riskBand: 'normal',
        featuredRank: null,
    };
    const promotedCautionIndex = publicFixture.findIndex(
        (row, index) => index !== curatedNormalIndex && row.riskBand === 'normal',
    );
    if (promotedCautionIndex < 0) {
        throw new Error('No distinct normal account was available to promote to caution.');
    }
    publicFixture[promotedCautionIndex] = {
        ...publicFixture[promotedCautionIndex]!,
        displayScore: 5,
        riskBand: 'caution',
        featuredRank: 3,
    };

    const privateFixture = privateRows.map(row => ({
            imageSortOrdinal: row.sort_ordinal,
            instagramId: mutateIdentifier(row.instagram_id, `private-handle:${row.sort_ordinal}`),
            fullName: mutateName(row.full_name, `private-name:${row.sort_ordinal}`),
        }));
    assertUniqueFixture({ public: publicFixture, private: privateFixture });
    return {
        public: publicFixture,
        private: privateFixture,
    };
}

async function main() {
    const fixture = sourceFixture(loadRows());
    const target = path.join(process.cwd(), 'lib/services/demo-analysis/demo-v4-source-fixture.ts');
    const contents = `/** Generated from one selected sealed source with deterministic 30% text mutation. Do not hand-edit. */\nexport const DEMO_V4_SOURCE_FIXTURE = ${JSON.stringify(fixture, null, 4)} as const;\n`;
    await writeFile(target, contents, 'utf8');
    process.stdout.write(`demo-v4-source-fixture=${fixture.public.length + fixture.private.length}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    void main();
}
