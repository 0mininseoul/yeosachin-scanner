/**
 * DTO contract for the "precheckout B-lite persona teaser" feature.
 *
 * This is a standalone contract that lives beside `lib/contracts/analysis-v2.ts` on purpose —
 * it must never be merged into that file's `.strict()` checkout schemas. Both the API route and
 * the client re-validate every payload against `precheckoutBliteV1Schema` so a malformed or
 * over-widened model/response can never reach the UI.
 */
import { z } from 'zod';

export const PRECHECKOUT_BLITE_SCHEMA_VERSION = 1 as const;

/**
 * `genderRead.likelyFemale` is only meaningful at/above this confidence. The caller (and any
 * confirmation UI) must branch on `likelyFemale === true && confidence >= this threshold`, so
 * the value is shared here instead of being re-declared per consumer.
 */
export const PRECHECKOUT_BLITE_LIKELY_FEMALE_CONFIDENCE_THRESHOLD = 0.7;

/** Thresholds that derive a signal's `band` from its `confidence`. Never hand-author a band. */
export const PRECHECKOUT_BLITE_SIGNAL_BAND_THRESHOLDS = {
    high: 0.7,
    medium: 0.5,
} as const;

export const PRECHECKOUT_BLITE_SIGNAL_BANDS = ['high', 'medium', 'low'] as const;
export type PrecheckoutBliteSignalBand = typeof PRECHECKOUT_BLITE_SIGNAL_BANDS[number];

/**
 * Derive a signal's band from its confidence so the two values can never disagree.
 * `>= 0.7` -> high, `>= 0.5` -> medium, otherwise low.
 */
export function derivePrecheckoutBliteSignalBand(confidence: number): PrecheckoutBliteSignalBand {
    if (confidence >= PRECHECKOUT_BLITE_SIGNAL_BAND_THRESHOLDS.high) return 'high';
    if (confidence >= PRECHECKOUT_BLITE_SIGNAL_BAND_THRESHOLDS.medium) return 'medium';
    return 'low';
}

/**
 * Audit list of source fields the digest builder reads from the allowlisted
 * `InstagramProfile`/`InstagramPost` shape (see `blite-inference.ts`). This is the exhaustive
 * set `evidenceFields` may draw from.
 *
 * `post.*` fields feed persona/signals as before. The `profile.fullName`, `profile.bio`,
 * `profile.profilePicUrl`, and `post.imageUrl` fields are widened evidence for `genderRead`
 * only — the model prompt restricts them to that one field and forbids citing them for
 * persona/signals. `profile.username`, `profile.externalUrl`, `profile.followersCount`, and
 * `profile.followingCount` remain permanently excluded; the digest never sends those to the
 * model under any field.
 */
export const PRECHECKOUT_BLITE_EVIDENCE_FIELDS = [
    'post.caption',
    'post.hashtags',
    'post.type',
    'post.mediaItems',
    'post.declaredMediaCount',
    'post.likesCount',
    'post.commentsCount',
    'post.likesCountHidden',
    'post.commentsCountHidden',
    'post.taggedUsers',
    'post.mentionedUsers',
    'post.imageUrl',
    'profile.fullName',
    'profile.bio',
    'profile.profilePicUrl',
] as const;
export type PrecheckoutBliteEvidenceField = typeof PRECHECKOUT_BLITE_EVIDENCE_FIELDS[number];

function hasAtMostTwoDecimals(value: number): boolean {
    return Number.isFinite(value) && Number(value.toFixed(2)) === value;
}

const confidenceSchema = z.number()
    .finite()
    .min(0)
    .max(1)
    .refine(hasAtMostTwoDecimals, { message: 'confidence must have at most two decimal places' });

const FORBIDDEN_PUBLIC_TEXT_PATTERNS = [
    /https?:\/\//iu,
    /www\./iu,
    /@/u,
] as const;

function koreanCopySchema(maxLength: number) {
    return z.string()
        .trim()
        .min(1)
        .max(maxLength)
        .refine(value => !/[\r\n]/u.test(value), { message: 'must be a single line' })
        .refine(value => /[가-힣]/u.test(value), { message: 'must contain Korean text' })
        .refine(
            value => FORBIDDEN_PUBLIC_TEXT_PATTERNS.every(pattern => !pattern.test(value)),
            { message: 'must not contain a URL or an @ mention' }
        );
}

const precheckoutBliteSignalSchema = z.object({
    claim: koreanCopySchema(120),
    category: koreanCopySchema(24),
    confidence: confidenceSchema,
    band: z.enum(PRECHECKOUT_BLITE_SIGNAL_BANDS),
}).strict().superRefine((value, context) => {
    if (value.band !== derivePrecheckoutBliteSignalBand(value.confidence)) {
        context.addIssue({
            code: 'custom',
            path: ['band'],
            message: 'band must match the confidence-derived band',
        });
    }
});

const precheckoutBliteSignalsSchema = z.array(precheckoutBliteSignalSchema)
    .length(4)
    .superRefine((signals, context) => {
        if (signals.length === 4 && signals.every(signal => signal.band === 'high')) {
            context.addIssue({
                code: 'custom',
                message: 'at least one of the four signals must be medium or low',
            });
        }
    });

const precheckoutBliteGenderReadSchema = z.object({
    likelyFemale: z.boolean(),
    confidence: confidenceSchema,
    reasons: z.array(koreanCopySchema(90)).length(3),
}).strict();

const precheckoutBliteCandidateRangeSchema = z.object({
    min: z.number().int().nonnegative(),
    max: z.number().int().nonnegative(),
}).strict().refine(value => value.min < value.max, {
    message: 'min must be less than max',
    path: ['max'],
});

const precheckoutBlitePersonaSchema = z.object({
    headline: koreanCopySchema(80),
    summary: koreanCopySchema(400),
}).strict();

const precheckoutBliteEvidenceFieldsSchema = z.array(z.enum(PRECHECKOUT_BLITE_EVIDENCE_FIELDS))
    .min(1)
    .max(PRECHECKOUT_BLITE_EVIDENCE_FIELDS.length)
    .superRefine((fields, context) => {
        if (new Set(fields).size !== fields.length) {
            context.addIssue({ code: 'custom', message: 'evidenceFields must not contain duplicates' });
        }
    });

export const precheckoutBliteV1Schema = z.object({
    schemaVersion: z.literal(PRECHECKOUT_BLITE_SCHEMA_VERSION),
    persona: precheckoutBlitePersonaSchema,
    signals: precheckoutBliteSignalsSchema,
    candidateRange: precheckoutBliteCandidateRangeSchema,
    genderRead: precheckoutBliteGenderReadSchema,
    postCount: z.number().int().nonnegative().max(100),
    evidenceFields: precheckoutBliteEvidenceFieldsSchema,
}).strict();

export type PrecheckoutBliteV1 = z.infer<typeof precheckoutBliteV1Schema>;
export type PrecheckoutBliteSignal = z.infer<typeof precheckoutBliteSignalSchema>;
export type PrecheckoutBliteGenderRead = z.infer<typeof precheckoutBliteGenderReadSchema>;
export type PrecheckoutBliteCandidateRange = z.infer<typeof precheckoutBliteCandidateRangeSchema>;
