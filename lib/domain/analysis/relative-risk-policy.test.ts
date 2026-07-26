import { describe, expect, it } from 'vitest';
import {
    assignRelativeRiskTiers,
    type RelativeRiskCandidate,
} from './relative-risk-policy';

function candidate(
    candidateId: string,
    naturalDisplayScore: number,
    naturalRiskBand: RelativeRiskCandidate['naturalRiskBand'] = 'normal',
    partnerCapApplied = false,
    naturalPublicScore = naturalDisplayScore,
    isInbound = false,
    personalRiskEligible = true
): RelativeRiskCandidate {
    return {
        candidateId,
        naturalPublicScore,
        naturalDisplayScore,
        naturalRiskBand,
        partnerCapApplied,
        isInbound,
        personalRiskEligible,
    };
}

describe('relative risk tier policy', () => {
    it.each([0, 1, 2])(
        'preserves natural scores and bands when only %i rows are eligible',
        count => {
            const input = Array.from(
                { length: count },
                (_, index) => candidate(`candidate:${index}`, 2 + index)
            );

            expect(assignRelativeRiskTiers(input)).toEqual(input.map(row => ({
                candidateId: row.candidateId,
                displayScore: row.naturalDisplayScore,
                riskBand: row.naturalRiskBand,
                relativeTierApplied: false,
            })));
        }
    );

    it('assigns one high-risk and two caution tiers to three all-normal rows', () => {
        const result = assignRelativeRiskTiers([
            candidate('candidate:a', 3.3),
            candidate('candidate:b', 2.2),
            candidate('candidate:c', 1.1),
        ]);

        expect(result.map(row => row.riskBand))
            .toEqual(['high_risk', 'caution', 'caution']);
        expect(result.map(row => row.displayScore)).toEqual([6.8, 4.2, 4.2]);
        expect(result.every(row => row.relativeTierApplied)).toBe(true);
    });

    it('restricts high-risk selection to inbound candidates when any are present', () => {
        const result = assignRelativeRiskTiers([
            candidate('candidate:no-inbound', 4.1, 'normal', false, 4.1),
            candidate('candidate:inbound', 1.1, 'normal', false, 1.1, true),
            candidate('candidate:other', 1, 'normal'),
        ]);

        expect(result.find(row => row.candidateId === 'candidate:inbound')?.riskBand)
            .toBe('high_risk');
        expect(result.find(row => row.candidateId === 'candidate:no-inbound')?.riskBand)
            .toBe('caution');
    });

    it('uses the full eligible pool for the all-zero-inbound fallback', () => {
        const result = assignRelativeRiskTiers([
            candidate('candidate:top', 4.1),
            candidate('candidate:middle', 2),
            candidate('candidate:low', 1),
        ]);

        expect(result.find(row => row.candidateId === 'candidate:top')?.riskBand)
            .toBe('high_risk');
    });

    it('caps quota assignment at three high and ten caution rows', () => {
        const result = assignRelativeRiskTiers(Array.from(
            { length: 20 },
            (_, index) => candidate(`candidate:${index}`, 9 - index * 0.1, 'high_risk')
        ));

        expect(result.filter(row => row.riskBand === 'high_risk')).toHaveLength(3);
        expect(result.filter(row => row.riskBand === 'caution')).toHaveLength(10);
        expect(result.filter(row => row.riskBand === 'normal')).toHaveLength(7);
    });

    it('keeps an official account out of personal ranking and normal in presentation', () => {
        const result = assignRelativeRiskTiers([
            candidate('candidate:official', 9, 'high_risk', false, 9, true, false),
            candidate('candidate:a', 3),
            candidate('candidate:b', 2),
            candidate('candidate:c', 1),
        ]);

        expect(result.find(row => row.candidateId === 'candidate:official')).toEqual({
            candidateId: 'candidate:official',
            displayScore: 4.1,
            riskBand: 'normal',
            relativeTierApplied: false,
        });
    });

    it('keeps the two lowest eligible rows caution when every natural row is high-risk', () => {
        const result = assignRelativeRiskTiers([
            candidate('candidate:a', 9.8, 'high_risk'),
            candidate('candidate:b', 9.1, 'high_risk'),
            candidate('candidate:c', 8.4, 'high_risk'),
        ]);

        expect(result.map(row => row.riskBand))
            .toEqual(['high_risk', 'caution', 'caution']);
        expect(result.map(row => row.displayScore)).toEqual([9.8, 6.7, 6.7]);
    });

    it('excludes strong-partner-capped rows from the three-row minimum pool', () => {
        const result = assignRelativeRiskTiers([
            candidate('candidate:partner', 3.4, 'normal', true),
            candidate('candidate:a', 3.3),
            candidate('candidate:b', 3.2),
        ]);

        expect(result.map(row => row.riskBand)).toEqual(['normal', 'normal', 'normal']);
        expect(result.every(row => row.relativeTierApplied === false)).toBe(true);
    });

    it('uses candidate ID as the deterministic tie-break without changing input order', () => {
        const result = assignRelativeRiskTiers([
            candidate('candidate:c', 2),
            candidate('candidate:b', 2),
            candidate('candidate:a', 2),
        ]);

        expect(result.map(row => row.candidateId))
            .toEqual(['candidate:c', 'candidate:b', 'candidate:a']);
        expect(result.find(row => row.candidateId === 'candidate:a')).toMatchObject({
            displayScore: 6.8,
            riskBand: 'high_risk',
        });
        expect(result.find(row => row.candidateId === 'candidate:b')?.riskBand).toBe('caution');
        expect(result.find(row => row.candidateId === 'candidate:c')?.riskBand).toBe('caution');
    });

    it('orders display-score ties by the unrounded natural public score first', () => {
        const result = assignRelativeRiskTiers([
            candidate('candidate:a', 3.3, 'normal', false, 3.26),
            candidate('candidate:z', 3.3, 'normal', false, 3.34),
            candidate('candidate:m', 2.2),
        ]);

        expect(result.find(row => row.candidateId === 'candidate:z')).toMatchObject({
            displayScore: 6.8,
            riskBand: 'high_risk',
        });
        expect(result.find(row => row.candidateId === 'candidate:a')?.riskBand).toBe('caution');
    });

    it('keeps a large weak set monotonic with at least one high and two cautions', () => {
        const result = assignRelativeRiskTiers(Array.from(
            { length: 77 },
            (_, index) => candidate(
                `candidate:${String(index).padStart(2, '0')}`,
                Math.max(1, Math.round((4 - index * 0.05) * 10) / 10)
            )
        ));
        const sorted = result.slice().sort((left, right) =>
            right.displayScore - left.displayScore
            || left.candidateId.localeCompare(right.candidateId));

        expect(result.filter(row => row.riskBand === 'high_risk')).toHaveLength(1);
        expect(result.filter(row => row.riskBand === 'caution').length).toBeGreaterThanOrEqual(2);
        expect(sorted.findIndex(row => row.riskBand === 'normal'))
            .toBeGreaterThan(sorted.findLastIndex(row => row.riskBand === 'caution'));
    });

    it('rejects duplicate IDs and invalid natural score-band pairs', () => {
        expect(() => assignRelativeRiskTiers([
            candidate('candidate:same', 3),
            candidate('candidate:same', 2),
            candidate('candidate:other', 1),
        ])).toThrow('candidate IDs must be unique');
        expect(() => assignRelativeRiskTiers([
            candidate('candidate:a', 3.4, 'high_risk'),
        ])).toThrow('natural score and band are incompatible');
    });
});
