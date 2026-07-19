const PAID_CONFIRMATION_FLAG = '--confirm-paid-api-call';

export function parseConfirmedAnalysisTestIssuerArgs(
    args: readonly string[],
    requiredOptions: readonly string[]
): ReadonlyMap<string, string> {
    const allowedOptions = new Set(requiredOptions);
    const values = new Map<string, string>();
    let paidConfirmationCount = 0;

    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];

        if (argument === PAID_CONFIRMATION_FLAG) {
            paidConfirmationCount += 1;
            if (paidConfirmationCount > 1) {
                throw new Error(`${PAID_CONFIRMATION_FLAG} must appear exactly once`);
            }
            continue;
        }
        if (argument.startsWith(`${PAID_CONFIRMATION_FLAG}=`)) {
            throw new Error(`${PAID_CONFIRMATION_FLAG} must be exact and valueless`);
        }
        if (!allowedOptions.has(argument)) {
            throw new Error(`unknown argument: ${argument}`);
        }
        if (values.has(argument)) {
            throw new Error(`${argument} must be provided exactly once`);
        }

        const value = args[index + 1];
        if (!value || value.startsWith('--')) {
            throw new Error(`${argument} requires a value`);
        }
        values.set(argument, value);
        index += 1;
    }

    for (const option of requiredOptions) {
        if (!values.has(option)) {
            throw new Error(`${option} is required`);
        }
    }
    if (paidConfirmationCount !== 1) {
        throw new Error(`${PAID_CONFIRMATION_FLAG} is required`);
    }

    return values;
}
