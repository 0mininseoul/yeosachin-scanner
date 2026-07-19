import { randomBytes } from 'node:crypto';
import { createAnalysisTestAdmission } from '@/lib/services/analysis/test-entitlement';
import { parseConfirmedAnalysisTestIssuerArgs } from './analysis-test-issuer-options';

interface Arguments {
    userId: string;
    targetInstagramId: string;
    idempotencyKey: string;
}

function usage(): never {
    throw new Error(
        'Usage: npm run test-admission:issue -- '
        + '--user <uuid> --target <instagram-id> --idempotency-key <16-128 safe chars> '
        + '--confirm-paid-api-call'
    );
}

function parseArguments(argv: string[]): Arguments {
    const values = (() => {
        try {
            return parseConfirmedAnalysisTestIssuerArgs(argv, [
                '--user', '--target', '--idempotency-key',
            ]);
        } catch {
            return usage();
        }
    })();
    return {
        userId: values.get('--user')!,
        targetInstagramId: values.get('--target')!,
        idempotencyKey: values.get('--idempotency-key')!,
    };
}

function main(): void {
    const input = parseArguments(process.argv.slice(2));
    const token = createAnalysisTestAdmission({
        ...input,
        nonce: randomBytes(18).toString('base64url'),
    });
    process.stdout.write(`${token}\n`);
}

main();
