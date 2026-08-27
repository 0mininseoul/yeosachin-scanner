import { describe, expect, it } from 'vitest';
import {
    isEarlybirdAutoAdmissionEligible,
    readEarlybirdAutoAdmissionConfig,
} from './auto-admission-config';

describe('earlybird webhook auto-admission config', () => {
    it('treats an unset or explicitly disabled gate as concierge-only', () => {
        expect(readEarlybirdAutoAdmissionConfig({})).toEqual({
            enabled: false,
            notBeforeMs: null,
        });
        expect(readEarlybirdAutoAdmissionConfig({
            EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED: 'false',
            EARLYBIRD_WEBHOOK_AUTO_ADMISSION_NOT_BEFORE: 'not-a-timestamp',
        })).toEqual({
            enabled: false,
            notBeforeMs: null,
        });
    });

    it('requires an exact true gate and an offset-bearing cutoff', () => {
        expect(() => readEarlybirdAutoAdmissionConfig({
            EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED: 'yes',
        })).toThrow('EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED_INVALID');
        expect(() => readEarlybirdAutoAdmissionConfig({
            EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED: 'true',
        })).toThrow('EARLYBIRD_WEBHOOK_AUTO_ADMISSION_NOT_BEFORE_INVALID');
        expect(() => readEarlybirdAutoAdmissionConfig({
            EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED: 'true',
            EARLYBIRD_WEBHOOK_AUTO_ADMISSION_NOT_BEFORE: '2026-08-27T04:40:00',
        })).toThrow('EARLYBIRD_WEBHOOK_AUTO_ADMISSION_NOT_BEFORE_INVALID');
    });

    it('uses paid-at at or after the configured cutoff and rejects malformed timestamps', () => {
        const config = readEarlybirdAutoAdmissionConfig({
            EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED: 'true',
            EARLYBIRD_WEBHOOK_AUTO_ADMISSION_NOT_BEFORE: '2026-08-27T04:40:00Z',
        });

        expect(isEarlybirdAutoAdmissionEligible('2026-08-27T04:40:00Z', config)).toBe(true);
        expect(isEarlybirdAutoAdmissionEligible('2026-08-27T04:39:59.999Z', config)).toBe(false);
        expect(isEarlybirdAutoAdmissionEligible('not-a-timestamp', config)).toBe(false);
        expect(isEarlybirdAutoAdmissionEligible('2026-08-27T04:40:00', config)).toBe(false);
        expect(isEarlybirdAutoAdmissionEligible(null, config)).toBe(false);
    });
});
