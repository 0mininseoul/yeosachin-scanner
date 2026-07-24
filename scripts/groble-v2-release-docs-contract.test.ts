import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function optionalSource(path: URL): string {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

const operations = optionalSource(new URL(
    '../docs/groble-earlybird-operations.md',
    import.meta.url
));
const packageJson = optionalSource(new URL('../package.json', import.meta.url));
const gate = optionalSource(new URL(
    './groble-v2-release-gate.ts',
    import.meta.url
));

describe('Groble v2 release documentation contract', () => {
    it('forbids product reuse and requires the two-phase executable gate', () => {
        expect(operations).toContain('신규 Basic/Standard 상품');
        expect(operations).toContain('--phase pre-migration');
        expect(operations).toContain('--phase pre-deploy');
        expect(operations).toContain(
            '--confirm-checkout-writes-paused'
        );
        expect(operations).not.toContain(
            '이미 발급된 v1 `payment_pending` 주문은 같은 주문과 결제창을 재사용'
        );
        expect(operations).not.toContain(
            '기존에 생성된 Basic/Standard 결제창을 그대로 사용'
        );
        expect(packageJson).toContain('"groble:v2:gate"');
        expect(packageJson).toContain('--env-file-if-exists=.env.local');
        expect(gate).toContain('pendingOldLineageCount');
        expect(gate).toContain('historicalProductEvidence');
        expect(gate).toContain('earlybird_groble_product_versions');
        expect(gate).toContain('expected_amount_krw');
        expect(gate).not.toContain('console.log(config');
    });

    it('pins the safe primary rollout and DB-compatible rollback order', () => {
        expect(operations).toContain('신규 v2 Basic/Standard 상품');
        expect(operations).toContain('필수 값은 총 9개');
        expect(operations).toContain(
            'checkout 접수를 먼저 중단하고 진행 중 writer를 drain'
        );
        expect(operations).toContain('DB와 호환되는 revision');
        expect(operations).toContain('호환성 복구 forward migration');
        expect(operations).toContain('검증을 마친 뒤에만 접수를 다시 연다');
        expect(operations).not.toContain(
            '기존 두 상품이 Basic 6,900원/Standard 9,900원'
        );
        expect(operations).not.toContain(
            '운영 환경의 다섯 가지 필수 서버 전용 값'
        );
        expect(operations).not.toContain(
            '롤백은 코드를 먼저 이전 버전으로 돌린 뒤 접수를 중단'
        );
    });

    it('executes the documented pre-migration command with injected env', () => {
        const result = spawnSync(
            'npm',
            [
                'run',
                'groble:v2:gate',
                '--',
                '--phase',
                'pre-migration',
                '--confirm-checkout-writes-paused',
            ],
            {
                cwd: fileURLToPath(new URL('..', import.meta.url)),
                encoding: 'utf8',
                env: {
                    ...process.env,
                    GROBLE_BASIC_PRODUCT_ID: 'legacy_basic_product',
                    GROBLE_STANDARD_PRODUCT_ID: 'legacy_standard_product',
                    GROBLE_BASIC_PAYMENT_ADDRESS: 'legacy-basic-address',
                    GROBLE_STANDARD_PAYMENT_ADDRESS: 'legacy-standard-address',
                    GROBLE_V2_BASIC_PRODUCT_ID: 'v2_basic_product',
                    GROBLE_V2_STANDARD_PRODUCT_ID: 'v2_standard_product',
                    GROBLE_V2_BASIC_PAYMENT_ADDRESS: 'v2-basic-address',
                    GROBLE_V2_STANDARD_PAYMENT_ADDRESS: 'v2-standard-address',
                },
            }
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain(
            '{"phase":"pre-migration","status":"passed"}'
        );
    });
});
