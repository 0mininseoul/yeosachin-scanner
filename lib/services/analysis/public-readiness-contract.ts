import type { LegacyPublicReadiness } from './legacy-analysis-public-readiness';
import {
    LEGACY_PUBLIC_READINESS_ROUTES,
    PAID_ENQUEUER_IDENTITY_FINGERPRINT_VERSION,
    PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION,
    PREFLIGHT_ENQUEUER_IDENTITY_FINGERPRINT_VERSION,
    PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION,
} from './legacy-analysis-public-readiness';

const HISTORICAL_READINESS_KEYS = [
    'schemaVersion', 'ready', 'stage', 'freezeMode', 'publicFreezeEnabled',
    'sourceSha', 'legacyTargetResource',
    'preflightProducerConfigFingerprintVersion', 'preflightProducerConfigFingerprint',
    'preflightProducerConfigReady', 'paidProducerConfigFingerprintVersion',
    'paidProducerConfigFingerprint', 'paidProducerConfigReady', 'routes',
    'analysisV2AdmissionEnabled', 'earlybirdWebhookAutoAdmissionEnabled',
] as const;
const ENQUEUER_READINESS_KEYS = [
    'preflightEnqueuerIdentityFingerprintVersion', 'preflightEnqueuerIdentityFingerprint',
    'paidEnqueuerIdentityFingerprintVersion', 'paidEnqueuerIdentityFingerprint',
] as const;
export const READINESS_KEYS = [...HISTORICAL_READINESS_KEYS, ...ENQUEUER_READINESS_KEYS] as const;

const ROUTE_KEYS = ['gateState', 'expectedStatus', 'gateBeforeRuntime'] as const;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const MAX_BYTES = 65_536;
const MAX_DEPTH = 12;

export type PublicReadinessExpected = Readonly<{
    sourceSha: string;
    legacyTargetResource: string;
    preflightProducerConfigFingerprintVersion: string;
    preflightProducerConfigFingerprint: string;
    paidProducerConfigFingerprintVersion: string;
    paidProducerConfigFingerprint: string;
    preflightEnqueuerIdentityFingerprintVersion?: string;
    preflightEnqueuerIdentityFingerprint?: string;
    paidEnqueuerIdentityFingerprintVersion?: string;
    paidEnqueuerIdentityFingerprint?: string;
    analysisV2AdmissionEnabled: boolean;
    earlybirdWebhookAutoAdmissionEnabled: boolean;
    ready?: boolean;
}>;

export class ReadinessContractError extends Error {
    readonly code: 'READINESS_TOO_LARGE'
        | 'READINESS_DUPLICATE_KEY'
        | 'READINESS_MALFORMED'
        | 'READINESS_CONTRACT_INVALID'
        | 'READINESS_EXPECTATION_MISMATCH';

    constructor(code: ReadinessContractError['code']) {
        super(code);
        this.name = 'ReadinessContractError';
        this.code = code;
    }
}

function fail(code: ReadinessContractError['code']): never {
    throw new ReadinessContractError(code);
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasExactKeys(value: object, expected: readonly string[]): boolean {
    const keys = Object.keys(value).sort();
    const expectedKeys = [...expected].sort();
    return keys.length === expectedKeys.length
        && keys.every((key, index) => key === expectedKeys[index]);
}

function hasExactOrderedKeys(value: object, expected: readonly string[]): boolean {
    const keys = Object.keys(value);
    return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isBoolean(value: unknown): value is boolean {
    return typeof value === 'boolean';
}

function isString(value: unknown): value is string {
    return typeof value === 'string';
}

/**
 * A small JSON grammar scanner used solely to detect duplicate object keys
 * before JSON.parse can discard them. It deliberately returns no input value
 * and reports only fixed contract codes.
 */
class JsonDuplicateScanner {
    private index = 0;
    private depth = 0;

    constructor(private readonly source: string) {}

    scan(): void {
        this.skipWhitespace();
        this.value();
        this.skipWhitespace();
        if (this.index !== this.source.length) fail('READINESS_MALFORMED');
    }

    private value(): void {
        if (++this.depth > MAX_DEPTH) fail('READINESS_MALFORMED');
        this.skipWhitespace();
        const char = this.source[this.index];
        if (char === '{') this.object();
        else if (char === '[') this.array();
        else if (char === '"') this.string();
        else if (char === 't' && this.consume('true')) {}
        else if (char === 'f' && this.consume('false')) {}
        else if (char === 'n' && this.consume('null')) {}
        else if (char === '-' || (char >= '0' && char <= '9')) this.number();
        else fail('READINESS_MALFORMED');
        this.depth -= 1;
    }

    private object(): void {
        this.index += 1;
        const keys = new Set<string>();
        this.skipWhitespace();
        if (this.source[this.index] === '}') {
            this.index += 1;
            return;
        }
        while (true) {
            this.skipWhitespace();
            if (this.source[this.index] !== '"') fail('READINESS_MALFORMED');
            const key = this.stringValue();
            if (keys.has(key)) fail('READINESS_DUPLICATE_KEY');
            keys.add(key);
            this.skipWhitespace();
            if (this.source[this.index] !== ':') fail('READINESS_MALFORMED');
            this.index += 1;
            this.value();
            this.skipWhitespace();
            if (this.source[this.index] === '}') {
                this.index += 1;
                return;
            }
            if (this.source[this.index] !== ',') fail('READINESS_MALFORMED');
            this.index += 1;
        }
    }

    private array(): void {
        this.index += 1;
        this.skipWhitespace();
        if (this.source[this.index] === ']') {
            this.index += 1;
            return;
        }
        while (true) {
            this.value();
            this.skipWhitespace();
            if (this.source[this.index] === ']') {
                this.index += 1;
                return;
            }
            if (this.source[this.index] !== ',') fail('READINESS_MALFORMED');
            this.index += 1;
        }
    }

    private string(): void {
        this.stringValue();
    }

    private stringValue(): string {
        const start = this.index;
        this.index += 1;
        while (this.index < this.source.length) {
            const char = this.source[this.index];
            if (char === '"') {
                this.index += 1;
                try {
                    const parsed = JSON.parse(this.source.slice(start, this.index));
                    if (typeof parsed !== 'string' || parsed.length > MAX_BYTES) fail('READINESS_MALFORMED');
                    return parsed;
                } catch (error) {
                    if (error instanceof ReadinessContractError) throw error;
                    fail('READINESS_MALFORMED');
                }
            }
            if (char === '\\') {
                this.index += 1;
                if (this.index >= this.source.length) fail('READINESS_MALFORMED');
                if (this.source[this.index] === 'u') this.index += 4;
            } else if (char < ' ') {
                fail('READINESS_MALFORMED');
            }
            this.index += 1;
        }
        fail('READINESS_MALFORMED');
    }

    private number(): void {
        const match = this.source.slice(this.index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
        if (!match) fail('READINESS_MALFORMED');
        this.index += match[0].length;
    }

    private consume(value: string): boolean {
        if (this.source.slice(this.index, this.index + value.length) !== value) {
            fail('READINESS_MALFORMED');
        }
        this.index += value.length;
        return true;
    }

    private skipWhitespace(): void {
        while (/\s/.test(this.source[this.index] ?? '')) this.index += 1;
    }
}

export function parsePublicReadinessJson(raw: string): LegacyPublicReadiness {
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > MAX_BYTES) {
        fail('READINESS_TOO_LARGE');
    }
    try {
        new JsonDuplicateScanner(raw).scan();
        const parsed: unknown = JSON.parse(raw);
        if (!isObject(parsed)) fail('READINESS_CONTRACT_INVALID');
        return assertPublicReadinessShape(parsed);
    } catch (error) {
        if (error instanceof ReadinessContractError) throw error;
        fail('READINESS_MALFORMED');
    }
}

function assertPublicReadinessShape(value: Record<string, unknown>): LegacyPublicReadiness {
    // JSON object order is not part of the consumer wire contract. The
    // runtime emitter keeps the documented order, while consumers accept any
    // permutation of the exact duplicate-free key set.
    const hasEnqueuerExtension = ENQUEUER_READINESS_KEYS.some(key => Object.hasOwn(value, key));
    const baseKeys = hasEnqueuerExtension ? READINESS_KEYS : HISTORICAL_READINESS_KEYS;
    const keys = Object.hasOwn(value, 'testEntitlementsEnabled') ? [...baseKeys, 'testEntitlementsEnabled'] : baseKeys;
    if (!hasExactKeys(value, keys)) fail('READINESS_CONTRACT_INVALID');
    if (Object.hasOwn(value, 'testEntitlementsEnabled') && !isBoolean(value.testEntitlementsEnabled)) fail('READINESS_CONTRACT_INVALID');
    if (value.schemaVersion !== 'analysis-public-freeze-readiness-v3'
        || !isBoolean(value.ready)
        || !isString(value.stage)
        || !['initial', 'expanded', 'unknown'].includes(value.stage)
        || !isString(value.freezeMode)
        || !['drain-and-block', 'unknown'].includes(value.freezeMode)
        || !isBoolean(value.publicFreezeEnabled)
        || (value.sourceSha !== null && (!isString(value.sourceSha) || !SHA_PATTERN.test(value.sourceSha)))
        || (value.legacyTargetResource !== null && !isString(value.legacyTargetResource))
        || value.preflightProducerConfigFingerprintVersion !== PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION
        || (value.preflightProducerConfigFingerprint !== null
            && (!isString(value.preflightProducerConfigFingerprint)
                || !FINGERPRINT_PATTERN.test(value.preflightProducerConfigFingerprint)))
        || !isBoolean(value.preflightProducerConfigReady)
        || value.paidProducerConfigFingerprintVersion !== PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION
        || (value.paidProducerConfigFingerprint !== null
            && (!isString(value.paidProducerConfigFingerprint)
                || !FINGERPRINT_PATTERN.test(value.paidProducerConfigFingerprint)))
        || !isBoolean(value.paidProducerConfigReady)
        || (hasEnqueuerExtension && (value.preflightEnqueuerIdentityFingerprintVersion
            !== PREFLIGHT_ENQUEUER_IDENTITY_FINGERPRINT_VERSION
            || (value.preflightEnqueuerIdentityFingerprint !== null
                && (!isString(value.preflightEnqueuerIdentityFingerprint)
                    || !FINGERPRINT_PATTERN.test(value.preflightEnqueuerIdentityFingerprint)))
            || value.paidEnqueuerIdentityFingerprintVersion !== PAID_ENQUEUER_IDENTITY_FINGERPRINT_VERSION
            || (value.paidEnqueuerIdentityFingerprint !== null
                && (!isString(value.paidEnqueuerIdentityFingerprint)
                    || !FINGERPRINT_PATTERN.test(value.paidEnqueuerIdentityFingerprint)))))
        || !isObject(value.routes)
        || !isBoolean(value.analysisV2AdmissionEnabled)
        || !isBoolean(value.earlybirdWebhookAutoAdmissionEnabled)) {
        fail('READINESS_CONTRACT_INVALID');
    }
    const routes = value.routes;
    if (!hasExactKeys(routes, LEGACY_PUBLIC_READINESS_ROUTES)) fail('READINESS_CONTRACT_INVALID');
    for (const route of LEGACY_PUBLIC_READINESS_ROUTES) {
        const entry = routes[route] as Record<string, unknown>;
        if (!isObject(entry)
            || !hasExactKeys(entry, ROUTE_KEYS)
            || !isString(entry.gateState)
            || !['frozen', 'not_ready'].includes(entry.gateState)
            || ![410, 503].includes(entry.expectedStatus as number)
            || entry.gateBeforeRuntime !== true) {
            fail('READINESS_CONTRACT_INVALID');
        }
        const expectedStatus = entry.gateState === 'frozen' ? 410 : 503;
        if (entry.expectedStatus !== expectedStatus) fail('READINESS_CONTRACT_INVALID');
    }
    const producerReady = value.preflightProducerConfigFingerprint !== null;
    const paidReady = value.paidProducerConfigFingerprint !== null;
    if (value.preflightProducerConfigReady !== producerReady
        || value.paidProducerConfigReady !== paidReady) {
        fail('READINESS_CONTRACT_INVALID');
    }
    const frozen = (routes[LEGACY_PUBLIC_READINESS_ROUTES[0]] as Record<string, unknown>).gateState === 'frozen';
    const enqueuerReady = !hasEnqueuerExtension
        || (value.preflightEnqueuerIdentityFingerprint !== null
            && value.paidEnqueuerIdentityFingerprint !== null);
    if ((routes[LEGACY_PUBLIC_READINESS_ROUTES[1]] as Record<string, unknown>).gateState !== (frozen ? 'frozen' : 'not_ready')
        || (routes[LEGACY_PUBLIC_READINESS_ROUTES[2]] as Record<string, unknown>).gateState !== (frozen ? 'frozen' : 'not_ready')
        || value.ready !== (value.stage !== 'unknown'
            && value.freezeMode === 'drain-and-block'
            && value.publicFreezeEnabled
            && frozen
            && value.sourceSha !== null
            && producerReady
            && paidReady
            && enqueuerReady)) {
        fail('READINESS_CONTRACT_INVALID');
    }
    return value as unknown as LegacyPublicReadiness;
}

export function assertPublicReadiness(
    dto: unknown,
    expected: PublicReadinessExpected,
): LegacyPublicReadiness {
    if (!isObject(dto)) fail('READINESS_CONTRACT_INVALID');
    const validated = assertPublicReadinessShape(dto);
    if (validated.sourceSha !== expected.sourceSha
        || validated.legacyTargetResource !== expected.legacyTargetResource
        || validated.preflightProducerConfigFingerprintVersion
            !== expected.preflightProducerConfigFingerprintVersion
        || validated.preflightProducerConfigFingerprint !== expected.preflightProducerConfigFingerprint
        || validated.paidProducerConfigFingerprintVersion !== expected.paidProducerConfigFingerprintVersion
        || validated.paidProducerConfigFingerprint !== expected.paidProducerConfigFingerprint
        || (expected.preflightEnqueuerIdentityFingerprintVersion !== undefined
            || expected.preflightEnqueuerIdentityFingerprint !== undefined)
            && (validated.preflightEnqueuerIdentityFingerprintVersion
                !== expected.preflightEnqueuerIdentityFingerprintVersion
                || validated.preflightEnqueuerIdentityFingerprint
                !== expected.preflightEnqueuerIdentityFingerprint)
        || (expected.paidEnqueuerIdentityFingerprintVersion !== undefined
            || expected.paidEnqueuerIdentityFingerprint !== undefined)
            && (validated.paidEnqueuerIdentityFingerprintVersion
                !== expected.paidEnqueuerIdentityFingerprintVersion
                || validated.paidEnqueuerIdentityFingerprint
                !== expected.paidEnqueuerIdentityFingerprint)
        || validated.analysisV2AdmissionEnabled !== expected.analysisV2AdmissionEnabled
        || validated.earlybirdWebhookAutoAdmissionEnabled !== expected.earlybirdWebhookAutoAdmissionEnabled
        || (expected.ready !== undefined && validated.ready !== expected.ready)) {
        fail('READINESS_EXPECTATION_MISMATCH');
    }
    return validated;
}

export const parseReadinessJson = parsePublicReadinessJson;
