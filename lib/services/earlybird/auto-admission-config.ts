import { z } from 'zod';

const autoAdmissionNotBeforeSchema = z.string().datetime({ offset: true });
const autoAdmissionPaidAtSchema = z.string().datetime({ offset: true });

export type EarlybirdAutoAdmissionConfig = Readonly<{
    enabled: boolean;
    notBeforeMs: number | null;
}>;

export function readEarlybirdAutoAdmissionConfig(
    environment: Readonly<Record<string, string | undefined>> = process.env
): EarlybirdAutoAdmissionConfig {
    const enabled = environment.EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED;
    if (enabled === undefined || enabled === 'false') {
        return { enabled: false, notBeforeMs: null };
    }
    if (enabled !== 'true') {
        throw new Error('EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED_INVALID');
    }

    const parsedNotBefore = autoAdmissionNotBeforeSchema.safeParse(
        environment.EARLYBIRD_WEBHOOK_AUTO_ADMISSION_NOT_BEFORE
    );
    if (!parsedNotBefore.success) {
        throw new Error('EARLYBIRD_WEBHOOK_AUTO_ADMISSION_NOT_BEFORE_INVALID');
    }
    const notBeforeMs = Date.parse(parsedNotBefore.data);
    if (!Number.isFinite(notBeforeMs)) {
        throw new Error('EARLYBIRD_WEBHOOK_AUTO_ADMISSION_NOT_BEFORE_INVALID');
    }
    return { enabled: true, notBeforeMs };
}

export function isEarlybirdAutoAdmissionEligible(
    paidAt: string | null,
    config: EarlybirdAutoAdmissionConfig,
): boolean {
    if (!config.enabled || config.notBeforeMs === null || paidAt === null) {
        return false;
    }
    const parsedPaidAt = autoAdmissionPaidAtSchema.safeParse(paidAt);
    if (!parsedPaidAt.success) return false;
    const paidAtMs = Date.parse(parsedPaidAt.data);
    return Number.isFinite(paidAtMs) && paidAtMs >= config.notBeforeMs;
}
