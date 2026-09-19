/**
 * Zod ⇆ React Hook Form bridge (PRD §18.1: every boundary is zod-validated;
 * types are inferred from the schema, never hand-written twice).
 *
 * Re-exported under the `sesResolver` name so feature code never imports
 * `@hookform/resolvers` directly — if the resolver or schema library changes,
 * only this file changes. The generic pass-through preserves full type
 * inference for both Zod 3 and Zod 4 schemas (the resolver auto-detects).
 *
 * Usage pattern (schemas live in `features/<feature>/schemas/`):
 *
 *   const CredentialsSchema = z.object({ phone: z.string(), otp: z.string() });
 *   type Credentials = z.infer<typeof CredentialsSchema>;
 *
 *   const form = useForm<Credentials>({
 *     resolver: sesResolver(CredentialsSchema),
 *   });
 */
export { zodResolver as sesResolver } from '@hookform/resolvers/zod';
