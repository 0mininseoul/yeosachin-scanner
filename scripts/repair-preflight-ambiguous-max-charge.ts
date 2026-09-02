import { createHash } from 'node:crypto';
import { Client } from 'pg';
import {
    IDENTITY_DRIFT_REPAIR_CONFIRMATION,
    parseIdentityDriftRepairOptions,
    type IdentityDriftRepairOptions,
} from './preflight-ambiguous-max-charge-repair-options';
import {
    readPrivateEvidenceReference,
    safeOutputPath,
    writeExclusivePrivateOutput,
} from './preflight-ambiguous-max-charge-repair-io';
import { isApifyCredentialSlot } from '../lib/services/instagram/providers/types';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

interface PiiFreeCandidate {
    preflightId: string;
    operationKey: 'target-profile-fallback';
    inputHash: string;
    logicalProvider: 'apify';
    actorId: 'apify/instagram-profile-scraper';
    credentialSlot: string;
    maxChargeUsd: number;
    reservedAt: string;
}

interface JsonResult<T> {
    result: T;
}

function requiredEnvironment(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required for a direct owner connection`);
    return value;
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('database returned an invalid PII-free candidate');
    }
    return value as Record<string, unknown>;
}

function stringField(row: Record<string, unknown>, name: string): string {
    const value = row[name];
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`database returned an invalid ${name}`);
    }
    return value;
}

function projectCandidate(value: unknown): PiiFreeCandidate {
    const row = record(value);
    const preflightId = stringField(row, 'preflightId');
    const operationKey = stringField(row, 'operationKey');
    const inputHash = stringField(row, 'inputHash');
    const logicalProvider = stringField(row, 'logicalProvider');
    const actorId = stringField(row, 'actorId');
    const credentialSlot = stringField(row, 'credentialSlot');
    const reservedAt = stringField(row, 'reservedAt');
    const maxChargeUsd = Number(row.maxChargeUsd);
    if (!UUID_PATTERN.test(preflightId)) throw new Error('database returned an invalid preflightId');
    if (operationKey !== 'target-profile-fallback') throw new Error('database returned an invalid operationKey');
    if (!SHA256_PATTERN.test(inputHash)) throw new Error('database returned an invalid inputHash');
    if (logicalProvider !== 'apify') throw new Error('database returned an invalid provider');
    if (actorId !== 'apify/instagram-profile-scraper') throw new Error('database returned an invalid actor');
    if (!isApifyCredentialSlot(credentialSlot)) {
        throw new Error('database returned an invalid credential slot');
    }
    if (!Number.isFinite(maxChargeUsd) || maxChargeUsd !== 0.0026) {
        throw new Error('database returned an invalid max charge');
    }
    if (!ISO_TIMESTAMP_PATTERN.test(reservedAt) || !Number.isFinite(Date.parse(reservedAt))) {
        throw new Error('database returned an invalid reservation timestamp');
    }
    return {
        preflightId,
        operationKey,
        inputHash,
        logicalProvider,
        actorId,
        credentialSlot,
        maxChargeUsd,
        reservedAt,
    };
}

function projectCandidateList(value: unknown): PiiFreeCandidate[] {
    if (!Array.isArray(value) || value.length > 100) {
        throw new Error('database returned an invalid bounded candidate list');
    }
    return value.map(projectCandidate);
}

async function listCandidates(limit: number): Promise<PiiFreeCandidate[]> {
    const connectionString = requiredEnvironment('DATABASE_URL');
    const client = new Client({ connectionString });
    try {
        await client.connect();
        const result = await client.query<JsonResult<unknown>>(
            `SELECT public.list_analysis_preflight_ambiguous_identity_drift_candidates($1) AS result`,
            [limit]
        );
        return projectCandidateList(result.rows[0]?.result);
    } catch {
        throw new Error('direct owner candidate listing failed');
    } finally {
        await client.end().catch(() => undefined);
    }
}

async function evidenceHash(path: string): Promise<string> {
    const reference = await readPrivateEvidenceReference(path);
    return createHash('sha256').update(reference, 'utf8').digest('hex');
}

function sqlLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function resolveSql(options: Exclude<IdentityDriftRepairOptions, { mode: 'list' }>, evidenceHashValue: string): string {
    const values = [
        `${sqlLiteral(options.preflightId)}::UUID`,
        `${sqlLiteral(options.operationKey)}::TEXT`,
        `${sqlLiteral(options.inputHash)}::TEXT`,
        `${sqlLiteral(options.logicalProvider)}::TEXT`,
        `${sqlLiteral(options.actorId)}::TEXT`,
        `${sqlLiteral(options.credentialSlot)}::TEXT`,
        `${sqlLiteral(options.maxChargeUsd)}::NUMERIC`,
        `${sqlLiteral(options.reservedAt)}::TIMESTAMP WITH TIME ZONE`,
        `${sqlLiteral(evidenceHashValue)}::TEXT`,
    ];
    return [
        '-- Database-owner-only statement; execute only after the seven-day fence is rechecked.',
        `-- Confirmation recorded by the operator: ${IDENTITY_DRIFT_REPAIR_CONFIRMATION}`,
        '-- Only the evidence digest is retained; do not paste the external reference here.',
        'SELECT public.resolve_analysis_preflight_provider_run_identity_drift(',
        values.map((value, index) => `    ${value}${index < values.length - 1 ? ',' : ''}`).join('\n'),
        ');',
        '',
    ].join('\n');
}

async function main(): Promise<void> {
    const options = parseIdentityDriftRepairOptions(process.argv.slice(2));
    const outputFile = await safeOutputPath(options.outputFile);
    if (options.mode === 'list') {
        await writeExclusivePrivateOutput(
            outputFile,
            `${JSON.stringify(await listCandidates(options.limit), null, 2)}\n`
        );
        return;
    }
    await writeExclusivePrivateOutput(
        outputFile,
        resolveSql(options, await evidenceHash(options.evidenceReferenceFile))
    );
}

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unexpected failure';
    process.stderr.write(`error: ${message}\n`);
    process.exitCode = 1;
});
