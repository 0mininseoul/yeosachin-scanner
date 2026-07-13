import { randomBytes } from 'node:crypto';
import { createAnalysisTestEntitlement } from '@/lib/services/analysis/test-entitlement';

interface Arguments {
    preflightId: string;
    userId: string;
    planId: 'basic' | 'standard' | 'plus';
}

function usage(): never {
    throw new Error(
        'Usage: npm run test-entitlement:issue -- --preflight <uuid> --user <uuid> --plan <basic|standard|plus>'
    );
}

function parseArguments(argv: string[]): Arguments {
    const values = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 2) {
        const key = argv[index];
        const value = argv[index + 1];
        if (!key?.startsWith('--') || !value || value.startsWith('--')) usage();
        if (values.has(key)) usage();
        values.set(key, value);
    }
    if (
        values.size !== 3
        || !values.has('--preflight')
        || !values.has('--user')
        || !values.has('--plan')
    ) {
        usage();
    }
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
