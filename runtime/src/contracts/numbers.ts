import { z } from 'zod';

export const SafeIntegerSchema = z.number().int().safe();
export const SafeNonNegativeIntegerSchema = SafeIntegerSchema.nonnegative();
export const SafePositiveIntegerSchema = SafeIntegerSchema.positive();

export type SafeInteger = z.infer<typeof SafeIntegerSchema>;
