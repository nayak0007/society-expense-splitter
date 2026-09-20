import type { INestApplication } from "@nestjs/common";
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from "@nestjs/swagger";

import type { AppConfig } from "./config/app-config";

/**
 * OpenAPI — SAD §2.2 ("`@nestjs/swagger` generating the OpenAPI spec") and §7.3
 * ("The OpenAPI spec is committed at `docs/api/OPENAPI.yaml`; CI diffs every PR
 * against `main` and fails on a breaking change").
 *
 * The document is built from the same decorators the controllers already carry,
 * which is why there is no hand-written spec to drift: a route that exists but is
 * undocumented is a missing decorator, not a missing file.
 *
 * The health probes *are* in the document, because they are ordinary controllers
 * with decorators. Their response schema is terminus's (`{ status, info, error,
 * details }`), not the §7.10 API envelope — deliberately, since the exception
 * filter exempts them for the same reason. An earlier comment here claimed they
 * were excluded, which was simply untrue of the generated output.
 */

const API_TITLE = "Society Expense Splitter API";
const API_VERSION = "1.0.0";
const API_DESCRIPTION = [
  "The SES API. Money is always integer paise in a `*Paise` field; timestamps are",
  "ISO-8601 UTC with milliseconds. Success responses are `{ data, meta }`; failures",
  "are `{ error: { code, message, requestId, timestamp, docs } }`.",
].join(" ");

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle(API_TITLE)
    .setDescription(API_DESCRIPTION)
    .setVersion(API_VERSION)
    // Declared now so the first authenticated route inherits the scheme rather
    // than each controller describing it. The token is a Supabase-issued RS256
    // JWT (SAD §9.1), verified by the API against Supabase's JWKS.
    .addBearerAuth(
      { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      "supabase-jwt",
    )
    .build();

  return SwaggerModule.createDocument(app, config, {
    // Paths in the document carry the global prefix. Left at the default rather
    // than restated, but asserted by a test: with it off, every path would be
    // missing `/v1` and the committed spec would be wrong in a way no review
    // catches, because nothing else in the repo reads these paths.
    ignoreGlobalPrefix: false,
    operationIdFactory: (controllerKey, methodKey) =>
      `${controllerKey}_${methodKey}`,
  });
}

/**
 * Mounts Swagger UI.
 *
 * **Disabled in production.** The spec describes every parameter, error code and
 * permission boundary of a financial API; publishing it anonymously is a free
 * map for an attacker, and §17.5 already treats even `/health/deep` as
 * authenticated. The committed `docs/api/OPENAPI.yaml` is the reviewable artefact,
 * not this route.
 */
export function setupSwagger(app: INestApplication, config: AppConfig): void {
  if (config.isProduction) {
    return;
  }

  SwaggerModule.setup("docs", app, buildOpenApiDocument(app), {
    // Without this the UI would be served at /docs while every route it documents
    // lives under /v1, so "Try it out" would 404.
    useGlobalPrefix: true,
    jsonDocumentUrl: "docs/json",
  });
}
