import { randomBytes } from 'node:crypto';
import { createAnalysisTestEntitlement } from '@/lib/services/analysis/test-entitlement';
import { parseConfirmedAnalysisTestIssuerArgs } from './analysis-test-issuer-options';

interface Arguments {
    preflightId: string;
    userId: string;
    planId: 'basic' | 'standard' | 'plus';
}

function usage(): never {
    throw new Error(
        'Usage: npm run test-entitlement:issue -- --preflight <uuid> --user <uuid> '
        + '--plan <basic|standard|plus> --confirm-paid-api-call'
    );
}

function parseArguments(argv: string[]): Arguments {
    const values = (() => {
        try {
            return parseConfirmedAnalysisTestIssuerArgs(argv, [
                '--preflight', '--user', '--plan',
            ]);
        } catch {
            return usage();
        }
    })();
    const planId = values.get('--plan');
    if (planId !== 'basic' && planId !== 'standard' && planId !== 'plus') usage();
    return {
        preflightId: values.get('--preflight')!,
        userId: values.get('--user')!,
        planId,
    };
}

function main(): void {
    const input = parseArguments(process.argv.slice(2));
    const token = createAnalysisTestEntitlement({
        ...input,
        nonce: randomBytes(18).toString('base64url'),
    });
    process.stdout.write(`${token}\n`);
}

main();
