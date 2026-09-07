import { describe, expect, it } from 'vitest';
import {
    READINESS_KEYS,
    assertPublicReadiness,
    parsePublicReadinessJson,
} from './public-readiness-contract';

const sourceSha = '0123456789abcdef0123456789abcdef01234567';
const valid = {
    schemaVersion: 'analysis-public-freeze-readiness-v3',
    ready: true,
    stage: 'initial',
    freezeMode: 'drain-and-block',
    publicFreezeEnabled: true,
    sourceSha,
    legacyTargetResource: 'fixture-target',
    preflightProducerConfigFingerprintVersion: 'preflight-producer-config-v1',
    preflightProducerConfigFingerprint: 'a'.repeat(64),
    preflightProducerConfigReady: true,
    paidProducerConfigFingerprintVersion: 'paid-producer-config-v1',
    paidProducerConfigFingerprint: 'b'.repeat(64),
    paidProducerConfigReady: true,
    routes: {
        '/api/analysis/start': { gateState: 'frozen', expectedStatus: 410, gateBeforeRuntime: true },
        '/api/analysis/step': { gateState: 'frozen', expectedStatus: 410, gateBeforeRuntime: true },
        '/api/analysis/run': { gateState: 'frozen', expectedStatus: 410, gateBeforeRuntime: true },
    },
    analysisV2AdmissionEnabled: false,
    earlybirdWebhookAutoAdmissionEnabled: false,
} as const;

const expected = {
    sourceSha,
    legacyTargetResource: 'fixture-target',
    preflightProducerConfigFingerprintVersion: 'preflight-producer-config-v1',
    preflightProducerConfigFingerprint: 'a'.repeat(64),
    paidProducerConfigFingerprintVersion: 'paid-producer-config-v1',
    paidProducerConfigFingerprint: 'b'.repeat(64),
    analysisV2AdmissionEnabled: false,
    earlybirdWebhookAutoAdmissionEnabled: false,
};

function raw(value: unknown): string {
    return JSON.stringify(value);
}

function reverseObject(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reverseObject);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([key, entry]) => [key, reverseObject(entry)]));
}

describe('strict public readiness v3 contract', () => {
    it('accepts the exact additive wire shape and independent expected facts', () => {
        const dto = parsePublicReadinessJson(raw(valid));
        expect(Object.keys(dto)).toEqual(READINESS_KEYS);
        expect(assertPublicReadiness(dto, expected)).toBe(dto);
        expect(assertPublicReadiness(reverseObject(valid), expected).ready).toBe(true);
    });

    it.each([
        ['v2 schema', { schemaVersion: 'analysis-public-freeze-readiness-v2' }],
        ['extra top-level key', { privateProviderGate: true }],
        ['missing top-level key', null],
        ['renamed gate', { providerAdmissionEnabled: false }],
        ['wrong boolean type', { analysisV2AdmissionEnabled: 'false' }],
        ['array enum type', { stage: ['initial'] }],
        ['number enum type', { freezeMode: 1 }],
        ['array route enum type', { routes: { ...valid.routes, '/api/analysis/run': { ...valid.routes['/api/analysis/run'], gateState: ['frozen'] } } }],
        ['wrong SHA', { sourceSha: 'A'.repeat(40) }],
        ['wrong fingerprint version', { paidProducerConfigFingerprintVersion: 'wrong' }],
        ['wrong fingerprint', { paidProducerConfigFingerprint: 'z'.repeat(64) }],
        ['inconsistent fingerprint readiness', { paidProducerConfigReady: false }],
        ['route extra inner key', { routes: { ...valid.routes, '/api/analysis/run': { ...valid.routes['/api/analysis/run'], extra: true } } }],
        ['route missing key', { routes: Object.fromEntries(Object.entries(valid.routes).filter(([route]) => route !== '/api/analysis/run')) }],
        ['route extra key', { routes: { ...valid.routes, '/api/analysis/unknown': valid.routes['/api/analysis/run'] } }],
        ['route wrong status', { routes: { ...valid.routes, '/api/analysis/step': { ...valid.routes['/api/analysis/step'], expectedStatus: 200 } } }],
        ['inconsistent ready formula', { ready: false }],
    ] as const)('rejects %s', (_name, override) => {
        const value = override === null
            ? Object.fromEntries(READINESS_KEYS.slice(0, -1).map(key => [key, (valid as Record<string, unknown>)[key]]))
            : { ...valid, ...override };
        expect(() => assertPublicReadiness(value, expected)).toThrow('READINESS_CONTRACT_INVALID');
    });

    it('rejects duplicate top-level JSON keys before JSON.parse can erase them', () => {
        const duplicate = raw(valid).replace(
            '"analysisV2AdmissionEnabled":false',
            '"analysisV2AdmissionEnabled":false,"analysisV2AdmissionEnabled":false',
        );
        expect(() => parsePublicReadinessJson(duplicate)).toThrow('READINESS_DUPLICATE_KEY');
        const escapedDuplicate = raw(valid).replace(
            '"ready":true',
            '"ready":true,"r\\u0065ady":true',
        );
        expect(() => parsePublicReadinessJson(escapedDuplicate)).toThrow('READINESS_DUPLICATE_KEY');
    });

    it('rejects duplicate nested route keys, trailing input, and oversized input', () => {
        const nestedDuplicate = raw(valid).replace(
            '"gateState":"frozen","expectedStatus":410',
            '"gateState":"frozen","gateState":"frozen","expectedStatus":410',
        );
        expect(() => parsePublicReadinessJson(nestedDuplicate)).toThrow('READINESS_DUPLICATE_KEY');
        expect(() => parsePublicReadinessJson(`${raw(valid)} null`)).toThrow('READINESS_MALFORMED');
        expect(() => parsePublicReadinessJson(`${' '.repeat(65_537)}`)).toThrow('READINESS_TOO_LARGE');
    });

    it('requires the independently reviewed gate values instead of inferring one from the other', () => {
        const dto = parsePublicReadinessJson(raw({ ...valid, analysisV2AdmissionEnabled: true }));
        expect(() => assertPublicReadiness(dto, expected)).toThrow('READINESS_EXPECTATION_MISMATCH');
    });

    it('rejects aggregate ready=false for every independent gate combination', () => {
        for (const analysisV2AdmissionEnabled of [false, true]) {
            for (const earlybirdWebhookAutoAdmissionEnabled of [false, true]) {
                const dto = {
                    ...valid,
                    ready: false,
                    analysisV2AdmissionEnabled,
                    earlybirdWebhookAutoAdmissionEnabled,
                };
                expect(() => assertPublicReadiness(dto, {
                    ...expected,
                    analysisV2AdmissionEnabled,
                    earlybirdWebhookAutoAdmissionEnabled,
                })).toThrow('READINESS_CONTRACT_INVALID');
            }
        }
    });
});
