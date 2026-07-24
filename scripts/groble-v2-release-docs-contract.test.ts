import { existsSync, readFileSync } from 'node:fs';
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
        expect(gate).toContain('pendingOldLineageCount');
        expect(gate).toContain('earlybird_groble_product_versions');
        expect(gate).toContain('expected_amount_krw');
        expect(gate).not.toContain('console.log(config');
    });
});
