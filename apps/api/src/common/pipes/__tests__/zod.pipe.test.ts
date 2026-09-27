import {
  BadRequestException,
  UnprocessableEntityException,
  type ArgumentMetadata,
} from "@nestjs/common";
import type { ErrorPayload } from "../../errors/app-error";
import { z } from "zod";

import { ZodPipe } from "../zod.pipe";

/**
 * SAD §7.8 splits validation into two stages with different outcomes, and §7.10
 * fixes the error shape. Both are asserted here, because each is easy to get
 * subtly wrong in a way that only shows up as a client branching on the wrong
 * thing:
 *
 *   syntactic (wrong shape, unknown fields)        → 400
 *   semantic  (right shape, values that conflict)  → 422
 */

/** Mirrors how a real contract schema is written: strict, then cross-field rules. */
const splitSchema = z
  .strictObject({
    percentages: z.array(z.number().min(0).max(100)),
    amountPaise: z.number().int().positive(),
  })
  .refine((value) => value.percentages.reduce((sum, p) => sum + p, 0) === 100, {
    message: "Split percentages must total 100%",
    path: ["percentages"],
    params: { code: "OUT_OF_RANGE" },
  });

const bodyMetadata: ArgumentMetadata = { type: "body" };

function payloadOf(exception: unknown): ErrorPayload {
  const response = (exception as BadRequestException).getResponse();
  return response as ErrorPayload;
}

describe("ZodPipe", () => {
  it("returns the parsed value on success", () => {
    const pipe = new ZodPipe(splitSchema);

    const result = pipe.transform(
      { percentages: [60, 40], amountPaise: 125_000 },
      bodyMetadata,
    );

    expect(result).toEqual({ percentages: [60, 40], amountPaise: 125_000 });
  });

  it("rejects a semantic failure with 422 and the catalogue code", () => {
    const pipe = new ZodPipe(splitSchema);

    const run = (): unknown =>
      pipe.transform({ percentages: [60, 30], amountPaise: 100 }, bodyMetadata);

    expect(run).toThrow(UnprocessableEntityException);
    try {
      run();
    } catch (error) {
      const payload = payloadOf(error);
      expect(payload.code).toBe("VALIDATION_ERROR");
      expect(payload.message).toBe("Split percentages must total 100%");
      expect(payload.field).toBe("percentages");
    }
  });

  it("rejects an unknown field as syntactic, with 400", () => {
    // `.strictObject` is the contract convention (SAD §7.8 stage 1: unknown input
    // is rejected rather than silently dropped), and the pipe classifies that as
    // "the request is malformed" rather than "a value is wrong".
    const pipe = new ZodPipe(splitSchema);

    expect(() =>
      pipe.transform(
        { percentages: [100], amountPaise: 1, unexpected: true },
        bodyMetadata,
      ),
    ).toThrow(BadRequestException);
  });

  it("reports a wrong type as 400", () => {
    const pipe = new ZodPipe(splitSchema);

    expect(() =>
      pipe.transform({ percentages: "all", amountPaise: 1 }, bodyMetadata),
    ).toThrow(BadRequestException);
  });

  it("formats array indices the way the SAD examples do", () => {
    const pipe = new ZodPipe(
      z.strictObject({ percentages: z.array(z.number().max(100)) }),
    );

    try {
      pipe.transform({ percentages: [10, 105] }, bodyMetadata);
      throw new Error("expected the pipe to reject the payload");
    } catch (error) {
      const payload = payloadOf(error);
      expect(payload.details?.[0]?.field).toBe("percentages[1]");
    }
  });

  it("uses the code a schema names via refine params, and uppercases Zod codes otherwise", () => {
    const pipe = new ZodPipe(splitSchema);

    try {
      pipe.transform({ percentages: [60, 30], amountPaise: 100 }, bodyMetadata);
      throw new Error("expected the pipe to reject the payload");
    } catch (error) {
      // `params: { code: 'OUT_OF_RANGE' }` is how a schema produces the SAD's
      // own catalogue codes; without it the Zod code is used so the field is
      // never empty, since clients branch on `details[].code`.
      expect(payloadOf(error).details?.[0]?.code).toBe("OUT_OF_RANGE");
    }

    const typePipe = new ZodPipe(z.strictObject({ amountPaise: z.number() }));
    try {
      typePipe.transform({ amountPaise: "x" }, bodyMetadata);
      throw new Error("expected the pipe to reject the payload");
    } catch (error) {
      expect(payloadOf(error).details?.[0]?.code).toBe("INVALID_TYPE");
    }
  });

  it("names a scalar parameter by its own name, not as `(root)`", () => {
    // Found by T045's routes: a path parameter is validated with
    // `@Param("memberId", new ZodPipe(z.uuid()))`, and a scalar schema's issue has an empty
    // path, so the failure used to report `field: "(root)"` — which no client can attach to
    // an input.
    const pipe = new ZodPipe(z.uuid());
    const metadata: ArgumentMetadata = { type: "param", data: "memberId" };

    try {
      pipe.transform("not-a-uuid", metadata);
      throw new Error("expected the pipe to reject the parameter");
    } catch (error) {
      const payload = payloadOf(error);
      expect(payload.field).toBe("memberId");
      expect(payload.details?.[0]?.field).toBe("memberId");
    }
  });

  it("keeps `(root)` when the parameter has no name to use", () => {
    const pipe = new ZodPipe(z.uuid());

    try {
      pipe.transform("not-a-uuid", bodyMetadata);
      throw new Error("expected the pipe to reject the payload");
    } catch (error) {
      expect(payloadOf(error).field).toBe("(root)");
    }
  });

  it("lists every problem rather than stopping at the first", () => {
    const pipe = new ZodPipe(z.strictObject({ a: z.number(), b: z.number() }));

    try {
      pipe.transform({}, bodyMetadata);
      throw new Error("expected the pipe to reject the payload");
    } catch (error) {
      const payload = payloadOf(error);
      expect(payload.details).toHaveLength(2);
      // The headline names the count, so a client that only surfaces `message`
      // still learns there is more than one problem.
      expect(payload.message).toContain("2 problems");
    }
  });
});
