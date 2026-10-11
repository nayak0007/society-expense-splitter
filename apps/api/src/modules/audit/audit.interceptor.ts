import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Observable } from "rxjs";

import { AuditService } from "./audit.service";
import { AUDITED_ACTIONS } from "./audited.decorator";

/**
 * Reads `@Audited()` and records what the route declared — T050, ADR-0014 D7.
 *
 * ## What it does, and — more importantly — what it does not
 *
 * It does **not** write an audit row. An interceptor's response tap runs after the
 * handler's transaction has committed, so a write here could only ever be
 * best-effort: the business change would survive an audit failure, which is the
 * inversion T050's acceptance forbids. The row is written by the operation itself
 * through `UnitOfWork`'s audit seam; this interceptor only makes the declaration
 * available to the layers below, so Stage B can require that a declared action
 * actually recorded something.
 *
 * Registered **after** `RequestContextInterceptor` (Nest runs interceptors
 * outermost-first), because it writes into the request's context store and the
 * store has to exist first.
 *
 * ## Why it is global even though most routes declare nothing
 *
 * A global interceptor cannot be forgotten on a route the way a per-controller one
 * can, which is the same argument the global guards make. On a route with no
 * `@Audited()` it reads `undefined` and returns the handler's stream untouched —
 * one metadata lookup, no allocation.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Both the handler and the class are asked, so a decorator on either works —
    // `getAllAndOverride` returns the handler's value when both are present, which
    // is the narrower declaration and therefore the right precedence.
    const declared = this.reflector.getAllAndOverride<
      readonly string[] | undefined
    >(AUDITED_ACTIONS, [context.getHandler(), context.getClass()]);

    if (declared !== undefined && declared.length > 0) {
      this.audit.declare(declared);
    }

    return next.handle();
  }
}
