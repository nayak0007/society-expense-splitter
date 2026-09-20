import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import request from "supertest";

import { buildOpenApiDocument } from "../src/swagger";
import { createTestApp } from "./utils/test-app";

/**
 * Boots the real application module and drives it over HTTP.
 *
 * These assertions are the ones that would catch a regression in the *pipeline*
 * rather than in a unit: the version prefix, the probe separation between
 * liveness and readiness, the request-id correlation, and the SAD §7.10 error
 * envelope. Each of them is invented in one place (`main.ts`, the health
 * controller, the exception filter) and consumed everywhere, so a unit test
 * cannot see them break.
 */
describe("API foundation (e2e)", () => {
  let app: NestFastifyApplication;

  afterEach(async () => {
    await app.close();
  });

  describe("GET /v1/health/live", () => {
    it("reports ok without touching any dependency", async () => {
      // Both dependencies are deliberately down here. SAD §17.5: liveness
      // "checks the process is responsive — no dependency checks, because a
      // database blip must not restart the pod". If this ever starts failing when
      // the database is unavailable, every instance would be killed at once.
      app = await createTestApp({ postgres: "down", redis: "down" });

      const response = await request(app.getHttpServer()).get(
        "/v1/health/live",
      );

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("ok");
    });
  });

  describe("GET /v1/health/ready", () => {
    it("reports ok when Postgres, Redis and migrations are all healthy", async () => {
      app = await createTestApp();

      const response = await request(app.getHttpServer()).get(
        "/v1/health/ready",
      );

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("ok");
      expect(Object.keys(response.body.info).sort()).toEqual([
        "migrations",
        "postgres",
        "redis",
      ]);
    });

    it("reports 503 and names the failing component when Postgres is down", async () => {
      app = await createTestApp({ postgres: "down" });

      const response = await request(app.getHttpServer()).get(
        "/v1/health/ready",
      );

      expect(response.status).toBe(503);
      expect(response.body.status).toBe("error");
      expect(response.body.error.postgres.status).toBe("down");
      // The healthy dependencies must still be reported, or an operator cannot
      // tell "Postgres is down" from "everything is down".
      expect(response.body.info.redis.status).toBe("up");
    });

    it("reports 503 when Redis is down, since rate limits and queues depend on it", async () => {
      app = await createTestApp({ redis: "down" });

      const response = await request(app.getHttpServer()).get(
        "/v1/health/ready",
      );

      expect(response.status).toBe(503);
      expect(response.body.error.redis.status).toBe("down");
    });

    it("reports 503 when migrations are pending", async () => {
      // SAD §16.4's deploy sequence runs migrations before the new version, so a
      // replica with pending migrations must not receive traffic.
      app = await createTestApp({ migrations: "down" });

      const response = await request(app.getHttpServer()).get(
        "/v1/health/ready",
      );

      expect(response.status).toBe(503);
      expect(response.body.error.migrations.status).toBe("down");
    });
  });

  describe("request correlation (SAD §17.4)", () => {
    it("echoes a request id on the response", async () => {
      app = await createTestApp();

      const response = await request(app.getHttpServer()).get(
        "/v1/health/live",
      );

      expect(response.headers["x-request-id"]).toBeDefined();
    });

    it("honours an inbound X-Request-Id so a mobile-side id survives the round trip", async () => {
      app = await createTestApp();

      const response = await request(app.getHttpServer())
        .get("/v1/health/live")
        .set("X-Request-Id", "trace-from-client");

      expect(response.headers["x-request-id"]).toBe("trace-from-client");
    });
  });

  describe("error envelope (SAD §7.10)", () => {
    it("renders an unmatched route as the documented error body", async () => {
      app = await createTestApp();

      const response = await request(app.getHttpServer()).get(
        "/v1/no-such-route",
      );

      expect(response.status).toBe(404);
      expect(response.body.error).toMatchObject({
        code: "NOT_FOUND",
        docs: "https://docs.societysplit.in/errors/NOT_FOUND",
      });
      // The correlation string support asks a user for has to be the same one the
      // access log carries.
      expect(response.body.error.requestId).toBe(
        response.headers["x-request-id"],
      );
      expect(new Date(response.body.error.timestamp).toString()).not.toBe(
        "Invalid Date",
      );
    });

    it("keeps health probe bodies in terminus format rather than the API envelope", async () => {
      // Orchestrators read these bodies for diagnosis; wrapping them would
      // discard the per-dependency detail §17.5 exists to provide.
      app = await createTestApp({ postgres: "down" });

      const response = await request(app.getHttpServer()).get(
        "/v1/health/ready",
      );

      expect(response.body).toHaveProperty("status", "error");
      expect(response.body).not.toHaveProperty("error.code");
    });
  });

  describe("versioning (SAD §7.3)", () => {
    it("serves only under the /v1 prefix", async () => {
      app = await createTestApp();

      const unversioned = await request(app.getHttpServer()).get(
        "/health/live",
      );

      expect(unversioned.status).toBe(404);
    });
  });

  describe("OpenAPI contract (SAD §7.3)", () => {
    /**
     * The committed `docs/api/OPENAPI.yaml` is what CI diffs for breaking changes,
     * and nothing in the repository reads its paths — so a prefix that silently
     * stopped being applied would produce a spec that is wrong for every endpoint
     * and a diff that looks like a harmless rewrite. This assertion is the only
     * thing standing between those two facts.
     */
    it("documents every path under the global prefix", async () => {
      app = await createTestApp();

      const document = buildOpenApiDocument(app);
      const paths = Object.keys(document.paths ?? {});

      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) {
        expect(path.startsWith("/v1/")).toBe(true);
      }
    });

    it("declares the bearer scheme the authenticated routes will inherit", async () => {
      app = await createTestApp();

      const document = buildOpenApiDocument(app);

      // Declared in the foundation even though nothing is authenticated yet: the
      // first protected controller must not have to invent its own scheme.
      expect(document.components?.securitySchemes).toHaveProperty(
        "supabase-jwt",
      );
    });
  });
});
