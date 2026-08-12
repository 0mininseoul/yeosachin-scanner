import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const costModel = readFileSync(
    new URL('../../../docs/operations-cost-model.md', import.meta.url),
    'utf8'
);
const operations = readFileSync(
    new URL('../../../docs/groble-earlybird-operations.md', import.meta.url),
    'utf8'
);

describe('earlybird pricing operations contract', () => {
    it('documents the exact reference, checkout, discount, and stock values', () => {
        for (const source of [costModel, operations]) {
            expect(source).toContain('3,990원');
            expect(source).toContain('1,990원');
            expect(source).toContain('7,990원');
            expect(source).toContain('2,990원');
            expect(source).toContain('50%');
            expect(source).toContain('62%');
        }
        expect(operations).toMatch(/Basic 1,990원\/Standard 2,990원/);
        expect(operations).toMatch(/재고가 10건/);
    });

    it('uses the 8.69% fee only as a margin-planning assumption', () => {
        const feeRate = 0.0869;
        expect(Math.round(1_990 * (1 - feeRate))).toBe(1_817);
        expect(Math.round(2_990 * (1 - feeRate))).toBe(2_730);
        expect(costModel).toContain('1,817.07원');
        expect(costModel).toContain('2,730.17원');
        expect(costModel).toContain('1,817원');
        expect(costModel).toContain('2,730원');
        expect(costModel).toContain('결제 webhook 금액 검증에 사용하지 않고');
    });

    it('pins migration-first rollout and read-only checkout verification', () => {
        expect(operations).toContain(
            '20260812120000_update_earlybird_pricing_v4.sql'
        );
        expect(operations).toContain('EARLYBIRD_PRICING_REFRESH_REQUIRED');
        expect(operations).toContain('읽기 전용 회귀 검증');
        expect(operations).toContain(
            'Groble 대시보드나 상품 설정은 이 검증에서 변경하지 않는다.'
        );
    });

    it('does not retain the rejected Basic 4,900 KRW option in active docs', () => {
        expect([costModel, operations].join('\n')).not.toContain('4,900원');
    });
});
