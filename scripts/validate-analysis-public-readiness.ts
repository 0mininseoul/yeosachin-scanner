import { readFileSync } from 'node:fs';
import {
    assertPublicReadiness,
    parsePublicReadinessJson,
    ReadinessContractError,
} from '../lib/services/analysis/public-readiness-contract';

const SAFE_CODE = /^[A-Za-z0-9._-]{1,128}$/;

function fail(code: string): never {
    process.stdout.write(`${SAFE_CODE.test(code) ? code : 'READINESS_CONTRACT_INVALID'}\n`);
    process.exitCode = 1;
    throw new Error('READINESS_BRIDGE_FAILED');
}

function required(name: string): string {
    const value = process.env[name];
    if (!value || value.length > 512 || /[\u0000-\u001f\u007f\s]/.test(value)) {
        fail('READINESS_EXPECTATION_MISSING');
    }
    return value;
}

function strictBoolean(name: string): boolean {
    const value = process.env[name];
    if (value === 'true') return true;
    if (value === 'false') return false;
    fail('READINESS_EXPECTATION_MISSING');
}

try {
    const raw = readFileSync(0, 'utf8');
    const dto = parsePublicReadinessJson(raw);
    if (process.argv[2] === '--shape-only') {
        process.stdout.write('PASS\n');
        process.exit(0);
    }
    assertPublicReadiness(dto, {
        sourceSha: required('READINESS_EXPECTED_SOURCE_SHA'),
        legacyTargetResource: required('READINESS_EXPECTED_TARGET_RESOURCE'),
        preflightProducerConfigFingerprintVersion: required('READINESS_EXPECTED_PREFLIGHT_VERSION'),
        preflightProducerConfigFingerprint: required('READINESS_EXPECTED_PREFLIGHT_FINGERPRINT'),
        paidProducerConfigFingerprintVersion: required('READINESS_EXPECTED_PAID_VERSION'),
        paidProducerConfigFingerprint: required('READINESS_EXPECTED_PAID_FINGERPRINT'),
        analysisV2AdmissionEnabled: strictBoolean('READINESS_EXPECTED_ANALYSIS_V2_ADMISSION'),
        earlybirdWebhookAutoAdmissionEnabled: strictBoolean('READINESS_EXPECTED_EARLYBIRD_ADMISSION'),
        ready: process.env.READINESS_EXPECTED_READY === undefined
            ? true
            : strictBoolean('READINESS_EXPECTED_READY'),
    });
    process.stdout.write('PASS\n');
} catch (error) {
    if (error instanceof ReadinessContractError) {
        process.stdout.write(`${error.code}\n`);
    } else if (process.exitCode !== 1) {
        process.stdout.write('READINESS_CONTRACT_INVALID\n');
    }
    process.exitCode = 1;
}
