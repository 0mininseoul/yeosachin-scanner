import { describe, expect, it } from 'vitest';
import {
    GROBLE_SELLER_REFERENCE_PATTERN,
    parseGrobleSellerReference,
} from './seller-reference';

const VALID_REFERENCE = `ord.${'a1'.repeat(16)}`;

describe('Groble seller references', () => {
    it('accepts only the opaque order reference issued by the application', () => {
        expect(GROBLE_SELLER_REFERENCE_PATTERN.test(VALID_REFERENCE)).toBe(true);
        expect(parseGrobleSellerReference(VALID_REFERENCE)).toBe(VALID_REFERENCE);
    });

    it.each([
        null,
        undefined,
        123,
        '',
        ` ${VALID_REFERENCE}`,
        `${VALID_REFERENCE} `,
        `ORD.${'a1'.repeat(16)}`,
        `ord.${'A1'.repeat(16)}`,
        `ord.${'a1'.repeat(15)}`,
        `ord.${'a1'.repeat(17)}`,
        `ord-${'a1'.repeat(16)}`,
        'ord.customer@example.com',
        'ord.01012345678',
        'ord.한글',
        'ord.a+b',
        'ord.a/b',
        'ord.a=b',
        'ord.a_b',
        'ord.a:b',
        'ord.a~b',
    ])('rejects non-opaque or malformed value %#', value => {
        expect(parseGrobleSellerReference(value)).toBeNull();
    });
});
