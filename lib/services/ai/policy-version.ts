import { z } from 'zod';

export const AI_POLICY_VERSION_MAX_LENGTH = 128;
export const AI_POLICY_VERSION_PATTERN =
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const aiPolicyVersionSchema = z.string().regex(AI_POLICY_VERSION_PATTERN);

export function isAiPolicyVersion(value: unknown): value is string {
    return typeof value === 'string' && AI_POLICY_VERSION_PATTERN.test(value);
}
