import { Module } from "@nestjs/common";

import {
  MEMBERSHIP_CACHE,
  type MembershipCache,
} from "../../common/authorization/membership-cache";
import { MembershipInvalidation } from "../../common/authorization/membership-invalidation";
import { AppConfigModule } from "../../config/config.module";
import { AppConfig } from "../../config/app-config";
import { InMemoryMembershipCache } from "./membership-cache.memory";
import { RedisMembershipCache } from "./membership-cache.redis";
import { MEMBERSHIP_CACHE_GATE_TTL_SECONDS } from "../../common/authorization/membership-cache";
import { RedisService } from "./redis.service";

/**
 * Redis, and the membership cache built on it.
 *
 * Not `@Global()`, for the same reason `DatabaseModule` is not: a module that reads
 * authorization state out of a cache should say so in its own definition, and the
 * line that says it is also the line that shows a reviewer which modules can be
 * affected by a cache-ordering bug.
 *
 * The cache itself is the one provider whose *absence* is a supported state: with
 * `MEMBERSHIP_CACHE_STORE=off` the token resolves to `undefined`, and every
 * consumer takes it with `@Optional()` and behaves as if it were not there. That is
 * why the factory may answer `undefined` rather than a no-op implementation — a
 * no-op would have to exist in two consumers (the reader and the validator) and
 * would be a third thing to keep in step with the real one.
 */
@Module({
  imports: [AppConfigModule],
  providers: [
    RedisService,
    {
      provide: MEMBERSHIP_CACHE,
      inject: [AppConfig, RedisService],
      useFactory: (
        config: AppConfig,
        redis: RedisService,
      ): MembershipCache | undefined => {
        const ttl = config.membershipCacheTtlSeconds;
        const store = config.membershipCacheStore;

        if (store === "off") {
          return undefined;
        }
        if (store === "memory") {
          return new InMemoryMembershipCache(
            ttl,
            MEMBERSHIP_CACHE_GATE_TTL_SECONDS,
          );
        }
        return new RedisMembershipCache(
          redis,
          ttl,
          MEMBERSHIP_CACHE_GATE_TTL_SECONDS,
        );
      },
    },
    MembershipInvalidation,
  ],
  exports: [RedisService, MEMBERSHIP_CACHE, MembershipInvalidation],
})
export class CacheModule {}
