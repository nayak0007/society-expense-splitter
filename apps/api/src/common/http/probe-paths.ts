/**
 * The one definition of "this response is a health probe".
 *
 * Two components have to agree about it — the error filter and the response
 * envelope interceptor — and they must agree in the same direction. A probe that
 * is exempt from the envelope on success but wrapped in it on failure produces
 * two different bodies for the same endpoint, which is exactly the kind of
 * asymmetry an orchestrator's health check will trip over.
 *
 * Prefixes rather than an exact-path set, because the leading slash is not
 * guaranteed: an adapter may hand over a URL with or without the global prefix,
 * and a probe served at `/health/live` instead of `/v1/health/live` must still
 * be recognised. The trailing-segment risk of a prefix match is nil here: no
 * business route begins with `health`.
 */
const PROBE_PREFIXES = ["/v1/health", "/health"] as const;

export function isHealthProbeUrl(url: string | undefined): boolean {
  if (url === undefined) {
    return false;
  }
  const path = url.split("?")[0] ?? "";
  return PROBE_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}
