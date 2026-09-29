import { Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { Redis } from "ioredis";

import { AppConfig } from "../../config/app-config";

/**
 * Redis, for the three jobs SAD §17.1/§7.6/§18 assign it: cache, rate-limit
 * buckets and (later) BullMQ queues.
 *
 * Configured to be **completely optional at boot**. Redis holds no source of
 * truth in this system — balances are read transactionally from Postgres (SAD
 * §18) and queue jobs are redelivered — so an unavailable Redis must degrade the
 * service, not stop it. Two choices implement that:
 *
 * - `lazyConnect` with an explicit `connect()` on first use. Nothing opens a
 *   socket at construction, so a process that never touches Redis (the OpenAPI
 *   export tool, a unit test) never needs one.
 * - `enableOfflineQueue: false`, so a command issued while disconnected fails
 *   immediately instead of queueing behind a connection that may never arrive.
 *   A readiness probe that hangs is worse than one that reports `down`.
 *
 * The last connection error is retained rather than only logged, so
 * `/health/ready` can report *why* Redis is down instead of just that it is.
 */
@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly client: Redis;
  private lastError: Error | undefined;

  constructor(config: AppConfig) {
    this.client = new Redis(config.redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      // Bounded, capped backoff: ioredis's default retries forever, which turns a
      // typo in REDIS_URL into an endless log stream.
      retryStrategy: (attempt) =>
        attempt > 5 ? null : Math.min(attempt * 200, 1000),
    });

    // ioredis emits 'error' on an EventEmitter; an unhandled one would crash the
    // process. Retained for the health check rather than swallowed.
    this.client.on("error", (error: Error) => {
      this.lastError = error;
    });
  }

  /** `PING` — the readiness probe's Redis check. */
  async ping(): Promise<string> {
    await this.ensureConnected();
    return this.client.ping();
  }

  /**
   * Runs a Lua script. The membership cache's four operations are all scripts,
   * because each is a read-modify-write over several keys and every split version
   * of one has a window the authorization ordering depends on not existing. See
   * `membership-cache.redis.ts`.
   *
   * The narrow signature is deliberate: `keys` and `args` are separate because
   * Redis's own API separates them, and passing a key through `args` would put it
   * in a non-key slot where a Redis Cluster deployment could not route it. Nothing
   * here interprets either.
   */
  async evalScript(
    script: string,
    keys: readonly string[],
    args: readonly (string | number)[],
  ): Promise<unknown> {
    await this.ensureConnected();
    return this.client.eval(script, keys.length, ...keys, ...args);
  }

  /** Undefined when Redis has been reachable for the whole life of the process. */
  get connectionError(): Error | undefined {
    return this.lastError;
  }

  private async ensureConnected(): Promise<void> {
    // 'wait' is the state lazyConnect starts in and the only one where connect()
    // is both required and legal; calling it otherwise throws "already
    // connecting", which would be reported as a Redis outage.
    if (this.client.status === "wait") {
      try {
        await this.client.connect();
        this.lastError = undefined;
      } catch (error) {
        this.lastError =
          error instanceof Error ? error : new Error(String(error));
        throw this.lastError;
      }
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.client.status === "end") {
      return;
    }
    try {
      await this.client.quit();
    } catch {
      // `quit` sends a command that cannot succeed on a broken socket; dropping
      // the connection is the only remaining option and needs no reporting.
      this.client.disconnect();
    }
  }
}
