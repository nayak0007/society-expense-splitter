import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import {
  SupabaseJwtVerifier,
  TokenVerificationError,
  type TokenFailureCode,
} from "../auth/supabase-jwt";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";
import { AppError } from "../errors/app-error";
import { readBearerToken, writeRequestActor } from "../http/http-access";

/**
 * The client-facing copy per failure, in one place.
 *
 * Written here rather than derived from the verifier's message so that the two
 * cannot drift: a message that reaches a client is product copy, and the
 * verifier's own strings are developer-facing (`supabase-jwt.ts` documents that
 * distinction). None of them explains *which* check failed — `TOKEN_EXPIRED` is
 * distinguishable by its code, and everything else deliberately is not.
 */
const MESSAGE_BY_CODE: Readonly<Record<TokenFailureCode, string>> = {
  TOKEN_EXPIRED: "Your session has expired. Refresh your token and try again.",
  UNAUTHENTICATED: "Sign in to continue.",
  DEPENDENCY_UNAVAILABLE:
    "Sign-in could not be verified right now. Please try again.",
};

/**
 * Authenticates every route unless it is marked `@Public()` — T018.
 *
 * Registered as `APP_GUARD` rather than per controller: Nest runs global guards
 * before route-bound ones, and a guard declared in one module cannot be
 * forgotten by the next module someone writes. This is the fail-closed half of
 * T041's route inventory ("a new unprotected route fails the suite").
 *
 * It **authenticates and stops there.** Authorisation is three separate layers
 * by design (SAD §1.2): RLS decides what rows this identity may touch,
 * `SocietyGuard`/`PermissionGuard` (T038) decide whether the route may proceed,
 * and the use cases evaluate the domain's own capability rules. A guard that
 * also tried to decide permissions would put tenancy logic in a place with no
 * access to the rows it would need.
 *
 * The failure shape is `AppError`, so `ApiExceptionFilter` renders the SAD §7.10
 * envelope without a second path: a 401 from here is byte-identical in shape to
 * a 401 from anywhere else, which is what lets a client implement one refresh
 * path. The reason is never echoed: telling a caller *why* their token failed
 * tells an attacker which half to attack.
 */
@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  constructor(
    private readonly verifier: SupabaseJwtVerifier,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Class-level metadata is checked too, so a whole controller can be public
    // (health probes) without repeating the decorator per route.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) {
      return true;
    }

    const request: unknown = context.switchToHttp().getRequest();
    const token = readBearerToken(request);
    if (token === undefined) {
      throw new AppError(
        "UNAUTHENTICATED",
        "Sign in to continue. Provide a bearer token.",
      );
    }

    try {
      writeRequestActor(request, await this.verifier.verify(token));
      return true;
    } catch (error: unknown) {
      // The verifier already picked the catalogue code, including
      // `DEPENDENCY_UNAVAILABLE` for a JWKS fetch that failed — a case that must
      // not be reported as 401, because telling a signed-in user to sign in
      // again cannot help and would disguise an outage as a normal rejection.
      if (error instanceof TokenVerificationError) {
        throw new AppError(error.code, MESSAGE_BY_CODE[error.code]);
      }
      throw error;
    }
  }
}
