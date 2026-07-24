import { describe, expect, it } from 'vitest';
import { getGrobleCheckoutUrl, readGrobleConfig } from './config';

const VALID_ENV = {
    GROBLE_BASIC_PRODUCT_ID: 'basic_product-01',
    GROBLE_STANDARD_PRODUCT_ID: 'standard_product-01',
    GROBLE_BASIC_PAYMENT_ADDRESS: 'basic-checkout-a1',
    GROBLE_STANDARD_PAYMENT_ADDRESS: 'standard-checkout-b2',
    GROBLE_WEBHOOK_SECRET: 'current-secret',
    GROBLE_WEBHOOK_PREVIOUS_SECRET: 'previous-secret',
};

describe('Groble server configuration', () => {
    it('requires existing product IDs, distinct payment addresses, and the webhook secret', () => {
        expect(() => readGrobleConfig({})).toThrow('GROBLE_BASIC_PRODUCT_ID');
        expect(() => readGrobleConfig({
            GROBLE_BASIC_PRODUCT_ID: 'basic',
            GROBLE_STANDARD_PRODUCT_ID: 'standard',
        })).toThrow('GROBLE_BASIC_PAYMENT_ADDRESS');
    });

    it('rejects product IDs and payment addresses that could alter the checkout path', () => {
        expect(() => readGrobleConfig({
            ...VALID_ENV,
            GROBLE_BASIC_PRODUCT_ID: '../basic?redirect=https://example.com',
        })).toThrow('GROBLE_BASIC_PRODUCT_ID');
        expect(() => readGrobleConfig({
            ...VALID_ENV,
            GROBLE_BASIC_PAYMENT_ADDRESS: '../basic?redirect=https://example.com',
        })).toThrow('GROBLE_BASIC_PAYMENT_ADDRESS');
    });

    it('requires distinct product IDs and payment addresses for the two paid plans', () => {
        expect(() => readGrobleConfig({
            ...VALID_ENV,
            GROBLE_STANDARD_PRODUCT_ID: VALID_ENV.GROBLE_BASIC_PRODUCT_ID,
        })).toThrow('GROBLE_PRODUCT_IDS_MUST_BE_DISTINCT');
        expect(() => readGrobleConfig({
            ...VALID_ENV,
            GROBLE_STANDARD_PAYMENT_ADDRESS: VALID_ENV.GROBLE_BASIC_PAYMENT_ADDRESS,
        })).toThrow('GROBLE_PAYMENT_ADDRESSES_MUST_BE_DISTINCT');
    });

    it('builds only allowlisted Groble payment URLs for paid plans', () => {
        const config = readGrobleConfig(VALID_ENV);

        expect(getGrobleCheckoutUrl(
            'basic',
            'ord.0123456789abcdef0123456789abcdef',
            config
        )).toBe(
            'https://groble.im/payment/basic-checkout-a1'
            + '?ref=ord.0123456789abcdef0123456789abcdef'
        );
        expect(getGrobleCheckoutUrl(
            'standard',
            'ord.fedcba9876543210fedcba9876543210',
            config
        )).toBe(
            'https://groble.im/payment/standard-checkout-b2'
            + '?ref=ord.fedcba9876543210fedcba9876543210'
        );
        expect(config.productIds).toEqual({
            basic: 'basic_product-01',
            standard: 'standard_product-01',
        });
    });

    it('rejects a checkout reference outside the server-issued format', () => {
        const config = readGrobleConfig(VALID_ENV);

        expect(() => getGrobleCheckoutUrl('basic', 'buyer@example.com', config))
            .toThrow('INVALID_GROBLE_SELLER_REFERENCE');
    });
});
