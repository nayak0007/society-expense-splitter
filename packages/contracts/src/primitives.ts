import { SOCIETY_TYPES } from "@ses/domain";
import { z } from "zod";

/**
 * Primitives shared across contracts. Kept in the contract package (not the
 * domain) because these describe the wire format, not the business rules.
 */

export const societyTypeSchema = z.enum(SOCIETY_TYPES);

/** Money is always an integer number of paise — never a float (PRD §18). */
export const paiseSchema = z.number().int();
