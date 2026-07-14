import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
    parseAmbiguousStartOptions,
} from './preflight-ambiguous-start-resolution-options';

const MAX_EVIDENCE_REFERENCE_BYTES = 4_096;

interface RpcError {
    code?: unknown;
    message?: unknown;
}

interface PiiFreeCandidate {
    preflightId: string;
    operationKey: string;
    inputHash: string;
    logicalProvider: string;
    actorId: string;
    credentialSlot: string;
    maxChargeUsd: number;
    reservedAt: string;
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('RPC returned an invalid PII-free record');
    }
    return value as Record<string, unknown>;
}

function stringField(row: Record<string, unknown>, name: string): string {
    const value = row[name];
    if (typeof value !== 'string' || !value) {
        throw new Error(`RPC returned an invalid ${name}`);
    }
    return value;
}

function projectCandidate(value: unknown): PiiFreeCandidate {
    const row = record(value);
    const maxChargeUsd = Number(row.maxChargeUsd);
    if (!Number.isFinite(maxChargeUsd) || maxChargeUsd !== 0.0026) {
        throw new Error('RPC returned an invalid maxChargeUsd');
    }
    return {
        preflightId: stringField(row, 'preflightId'),
        operationKey: stringField(row, 'operationKey'),
        inputHash: stringField(row, 'inputHash'),
        logicalProvider: stringField(row, 'logicalProvider'),
        actorId: stringField(row, 'actorId'),
        credentialSlot: stringField(row, 'credentialSlot'),
        maxChargeUsd,
        reservedAt: stringField(row, 'reservedAt'),
    };
}

function projectCandidateList(value: unknown): PiiFreeCandidate[] {
    if (!Array.isArray(value) || value.length > 100) {
        throw new Error('RPC returned an invalid bounded candidate list');
    }
    return value.map(projectCandidate);
}

function requiredEnvironment(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
}

function supabaseUrl(): string {
    const value = process.env.SUPABASE_URL?.trim()
        || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
    if (!value) throw new Error('SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL is required');
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') throw new Error('Supabase URL must use HTTPS');
    return parsed.origin;
}

async function rpc(name: string, body: Record<string, unknown>): Promise<unknown> {
    const serviceRoleKey = requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY');
    if (serviceRoleKey.startsWith('sb_publishable_')
        || serviceRoleKey === process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()) {
        throw new Error('SUPABASE_SERVICE_ROLE_KEY must not be a public Supabase key');
    }
    const response = await fetch(`${supabaseUrl()}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: {
            apikey: serviceRoleKey,
            authorization: `Bearer ${serviceRoleKey}`,
            'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => null) as RpcError | unknown;
    if (!response.ok) {
        const error = payload as RpcError | null;
        const code = typeof error?.code === 'string' ? error.code : 'RPC_ERROR';
        const message = typeof error?.message === 'string' ? error.message : 'request failed';
        throw new Error(`${name} failed (${response.status}, ${code}): ${message}`);
    }
    return payload;
}

async function evidenceHash(path: string): Promise<string> {
    const contents = await readFile(path);
    if (contents.byteLength < 1 || contents.byteLength > MAX_EVIDENCE_REFERENCE_BYTES) {
        throw new Error('evidence reference file must contain 1 to 4096 bytes');
    }
    const reference = contents.toString('utf8').trim();
    if (!reference) throw new Error('evidence reference file must not be blank');
    return createHash('sha256').update(reference, 'utf8').digest('hex');
}

function sqlLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

async function main(): Promise<void> {
    const options = parseAmbiguousStartOptions(process.argv.slice(2));
    if (options.mode === 'list') {
        const candidates = projectCandidateList(await rpc(
            'list_analysis_preflight_ambiguous_start_candidates',
            { p_limit: options.limit }
        ));
        process.stdout.write(`${JSON.stringify(candidates, null, 2)}\n`);
        return;
    }

    const referenceHash = await evidenceHash(options.evidenceReferenceFile);
    const values = [
        `${sqlLiteral(options.preflightId)}::UUID`,
        `${sqlLiteral(options.operationKey)}::TEXT`,
        `${sqlLiteral(options.inputHash)}::TEXT`,
        `${sqlLiteral(options.logicalProvider)}::TEXT`,
        `${sqlLiteral(options.actorId)}::TEXT`,
        `${sqlLiteral(options.credentialSlot)}::TEXT`,
        `${sqlLiteral(options.maxChargeUsd)}::NUMERIC`,
        `${sqlLiteral(options.reservedAt)}::TIMESTAMP WITH TIME ZONE`,
        `${sqlLiteral(referenceHash)}::TEXT`,
    ];
    process.stdout.write([
        '-- Database-owner-only statement.',
        '-- Execute in the Supabase SQL Editor as the project database owner.',
        'SELECT public.resolve_analysis_preflight_provider_run_no_run(',
        values.map((value, index) => `    ${value}${index < values.length - 1 ? ',' : ''}`).join('\n'),
        ');',
        '',
    ].join('\n'));
}

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unexpected failure';
    process.stderr.write(`error: ${message}\n`);
    process.exitCode = 1;
});
