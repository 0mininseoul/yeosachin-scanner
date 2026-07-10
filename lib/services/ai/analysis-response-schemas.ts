import { z } from 'zod';
import type {
    AppearanceAnalysisResponse,
    CombinedAnalysisResponse,
    ExposureAnalysisResponse,
    GenderAnalysisResponse,
    IntimacyAnalysisResponse,
    PhotogenicAnalysisResponse,
} from '@/lib/types/analysis';

const confidence = z.number().finite().min(0).max(1);
const reasoning = z.string().trim().min(1).max(4_000);
const photogenicGrade = z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
]);

export const genderAnalysisResponseSchema: z.ZodType<GenderAnalysisResponse> = z.object({
    gender: z.enum(['male', 'female', 'unknown']),
    confidence,
    reasoning,
}).strict();

export const photogenicAnalysisResponseSchema: z.ZodType<PhotogenicAnalysisResponse> = z.object({
    ownerIdentified: z.boolean(),
    photogenicGrade,
    confidence,
    reasoning,
    hasCouplePhoto: z.boolean().optional(),
    couplePhotoConfidence: confidence.optional(),
}).strict();

export const exposureAnalysisResponseSchema: z.ZodType<ExposureAnalysisResponse> = z.object({
    ownerIdentified: z.boolean(),
    skinVisibility: z.enum(['high', 'low']),
    confidence,
    reasoning,
}).strict();

export const appearanceAnalysisResponseSchema: z.ZodType<AppearanceAnalysisResponse> = z.object({
    ownerIdentified: z.boolean(),
    attractivenessLevel: z.enum(['high', 'medium', 'low']),
    confidence,
    reasoning,
}).strict();

export const intimacyAnalysisResponseSchema: z.ZodType<IntimacyAnalysisResponse> = z.object({
    intimacyLevel: z.enum(['intimate', 'normal']),
    confidence,
    indicators: z.array(z.string().trim().min(1).max(200)).max(20),
    reasoning,
}).strict();

const combinedBase = {
    genderConfidence: confidence,
    genderReasoning: reasoning,
};

export const combinedAnalysisResponseSchema: z.ZodType<CombinedAnalysisResponse> =
    z.discriminatedUnion('gender', [
        z.object({
            gender: z.literal('male'),
            ...combinedBase,
        }).strict(),
        z.object({
            gender: z.literal('unknown'),
            ...combinedBase,
        }).strict(),
        z.object({
            gender: z.literal('female'),
            ...combinedBase,
            photogenicGrade,
            photogenicConfidence: confidence,
            skinVisibility: z.enum(['high', 'low']),
            exposureConfidence: confidence,
            ownerIdentified: z.boolean(),
            isMarried: z.boolean(),
            marriedConfidence: confidence,
            isForeigner: z.boolean(),
            foreignerConfidence: confidence,
            featureReasoning: reasoning,
        }).strict(),
    ]);

export const COMBINED_ANALYSIS_SCHEMA_VERSION = '2';
