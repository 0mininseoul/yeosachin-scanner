import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationsDirectory = new URL('../../../supabase/migrations/', import.meta.url);
const operationsRunbook = readFileSync(
    new URL('../../../docs/groble-earlybird-operations.md', import.meta.url),
    'utf8'
);
const APPLIED_REMOTE_HEAD = '20260719120000';
const APPLIED_REMOTE_HEAD_FILE =
    '20260719120000_add_profile_provider_canary_journal.sql';
const EXPECTED_MIGRATIONS = [
    '20260719131000_add_groble_phone_matching.sql',
    '20260719131100_activate_groble_phone_checkout.sql',
    '20260719131200_backfill_groble_phone_matching.sql',
    '20260719131300_validate_groble_phone_matching.sql',
    '20260719131400_activate_groble_phone_finalization.sql',
    '20260719131500_stop_persisting_groble_buyer_contacts.sql',
] as const;
const EXPECTED_MIGRATION_SET = new Set<string>(EXPECTED_MIGRATIONS);
const INCLUDE_ALL_OPTION = '--include-all';

function migrationVersion(file: string): string | null {
    return file.match(/^(\d+)_.*\.sql$/)?.[1] ?? null;
}

function compareMigrationFiles(left: string, right: string): number {
    const leftVersion = BigInt(migrationVersion(left) ?? '0');
    const rightVersion = BigInt(migrationVersion(right) ?? '0');

    if (leftVersion < rightVersion) return -1;
    if (leftVersion > rightVersion) return 1;
    return left.localeCompare(right);
}

function rolloutMigrationTail(files: readonly string[]): string[] {
    return files
        .filter(file => {
            const version = migrationVersion(file);
            return version !== null && BigInt(version) > BigInt(APPLIED_REMOTE_HEAD);
        })
        .sort(compareMigrationFiles);
}

function latestNonFeatureMigrationAtOrBeforeAppliedHead(
    files: readonly string[]
): string | undefined {
    return files
        .filter(file => {
            const version = migrationVersion(file);
            return !EXPECTED_MIGRATION_SET.has(file)
                && version !== null
                && BigInt(version) <= BigInt(APPLIED_REMOTE_HEAD);
        })
        .sort(compareMigrationFiles)
        .at(-1);
}

function dbPushCommandSpans(source: string): string[] {
    return Array.from(
        source.matchAll(/`([^`\n]+)`/g),
        match => match[1]
    ).filter(span => /\bnpx\s+supabase\s+db\s+push(?:\s|$)/.test(span));
}

function containsForbiddenIncludeAllPush(source: string): boolean {
    return dbPushCommandSpans(source).some(command =>
        command.trim().split(/\s+/).includes(INCLUDE_ALL_OPTION)
    );
}

describe('Groble phone migration rollout contract', () => {
    it('freezes the complete numeric migration tail to the six dependencies after the applied remote head', () => {
        const allMigrationFiles = readdirSync(migrationsDirectory);
        const featureMigrations = rolloutMigrationTail(allMigrationFiles);

        expect(featureMigrations).toEqual(EXPECTED_MIGRATIONS);
        expect(
            latestNonFeatureMigrationAtOrBeforeAppliedHead(allMigrationFiles)
        ).toBe(APPLIED_REMOTE_HEAD_FILE);

        let previousVersion = APPLIED_REMOTE_HEAD;
        for (const migration of featureMigrations) {
            const version = migration.match(/^(\d+)_/)?.[1] ?? '';
            expect(version.localeCompare(APPLIED_REMOTE_HEAD)).toBeGreaterThan(0);
            expect(version.localeCompare(previousVersion)).toBeGreaterThan(0);
            previousVersion = version;
        }
    });

    it.each([
        {
            extra: '20260719125000_other.sql',
            position: 'between the applied head and the feature rollout',
        },
        {
            extra: '20260719140000_other.sql',
            position: 'after the feature rollout',
        },
    ])('rejects an extra migration $position', ({ extra }) => {
        const migrationFiles = [
            APPLIED_REMOTE_HEAD_FILE,
            ...EXPECTED_MIGRATIONS,
            extra,
        ];

        expect(rolloutMigrationTail(migrationFiles)).not.toEqual(
            EXPECTED_MIGRATIONS
        );
    });

    it.each([
        {
            command: `npx supabase db push --dry-run ${INCLUDE_ALL_OPTION}`,
            forbidden: true,
            name: 'include-all after dry-run',
        },
        {
            command: `npx supabase db push ${INCLUDE_ALL_OPTION} --dry-run`,
            forbidden: true,
            name: 'include-all before dry-run',
        },
        {
            command: `npx   supabase  db   push    ${INCLUDE_ALL_OPTION}`,
            forbidden: true,
            name: 'include-all with repeated whitespace',
        },
        {
            command: 'npx supabase db push --dry-run',
            forbidden: false,
            name: 'the exact dry-run command',
        },
        {
            command: 'npx supabase db push',
            forbidden: false,
            name: 'the exact apply command',
        },
    ])('classifies $name', ({ command, forbidden }) => {
        const commandAndProhibition =
            `\`${command}\` and standalone \`${INCLUDE_ALL_OPTION}\``;

        expect(dbPushCommandSpans(commandAndProhibition)).toEqual([command]);
        expect(containsForbiddenIncludeAllPush(commandAndProhibition)).toBe(
            forbidden
        );
    });

    it('documents an approved ordinary rollout of exactly those six files before app deployment', () => {
        const migrationGate = operationsRunbook.slice(
            operationsRunbook.indexOf('## 전화번호 매칭 migration 게이트'),
            operationsRunbook.indexOf('## 결제 확정과 수량 운영')
        );
        const documentedMigrations = Array.from(
            migrationGate.matchAll(/^\|\s*\d+\s*\|\s*`([^`]+\.sql)`\s*\|/gm),
            match => match[1]
        );

        expect(documentedMigrations).toEqual(EXPECTED_MIGRATIONS);

        expect(operationsRunbook).toMatch(
            /(read-only|읽기 전용)[^\n]*`npx supabase migration list --linked`/i
        );
        expect(operationsRunbook).toContain(
            '`npx supabase db push --dry-run`'
        );
        expect(operationsRunbook).toMatch(
            /dry-run[^\n]*(정확히|exactly)[^\n]*(6개|여섯)[^\n]*(예상하지 않은|unexpected)[^\n]*(없|no)/i
        );
        expect(operationsRunbook).toMatch(
            /(drift|불일치)[^\n]*(중단|abort)/i
        );
        expect(migrationGate).toMatch(
            /pre-rollout freeze gate[^\n]*production[^\n]*(6개|여섯)[^\n]*적용/i
        );
        expect(migrationGate).toMatch(
            /(reconcile|재조정)[^\n]*(retire|폐기)/i
        );
        const migrationListIndex = migrationGate.indexOf(
            '`npx supabase migration list --linked`'
        );
        const dryRunIndex = migrationGate.indexOf(
            '`npx supabase db push --dry-run`'
        );
        const driftReviewIndex = migrationGate.indexOf('history drift');
        const approvalIndex = migrationGate.indexOf('명시적 운영 승인');
        const maintenanceGateIndex = migrationGate.indexOf('maintenance gate');
        const applyIndex = migrationGate.indexOf('`npx supabase db push`');
        const verificationIndex = migrationGate.indexOf(
            'DB schema와 RPC signature, service-role ACL'
        );
        const appDeploymentIndex = migrationGate.indexOf(
            'application을 배포'
        );

        expect(migrationListIndex).toBeGreaterThanOrEqual(0);
        expect(dryRunIndex).toBeGreaterThan(migrationListIndex);
        expect(driftReviewIndex).toBeGreaterThan(dryRunIndex);
        expect(approvalIndex).toBeGreaterThan(driftReviewIndex);
        expect(maintenanceGateIndex).toBeGreaterThan(dryRunIndex);
        expect(applyIndex).toBeGreaterThan(approvalIndex);
        expect(applyIndex).toBeGreaterThan(maintenanceGateIndex);
        expect(verificationIndex).toBeGreaterThan(applyIndex);
        expect(appDeploymentIndex).toBeGreaterThan(verificationIndex);
        expect(migrationGate).toMatch(
            /이 개발 작업[^\n]*`npx supabase db push`[^\n]*실행하지 않/
        );
        expect(operationsRunbook).toMatch(
            /`--include-all`[^\n]*(절대 사용하지 않|never use)/i
        );
        expect(containsForbiddenIncludeAllPush(operationsRunbook)).toBe(false);
        const ordinaryApplyLine = migrationGate
            .split('\n')
            .find(line => line.includes('`npx supabase db push`')) ?? '';
        expect(ordinaryApplyLine).not.toContain('--include-all');
        expect(operationsRunbook).toMatch(
            /DB migration[^\n]*(application|애플리케이션)[^\n]*(배포 전|먼저)/i
        );
        expect(operationsRunbook).toMatch(
            /DB schema[^\n]*RPC signature[^\n]*service-role ACL[^\n]*(확인|검증)[^\n]*(후|다음)[^\n]*(application|애플리케이션)[^\n]*배포/i
        );
    });
});
