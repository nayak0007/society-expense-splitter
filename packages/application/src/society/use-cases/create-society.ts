import {
  asSocietyError,
  createSocietyAddress,
  createSocietyName,
  createSocietySettings,
  err,
  isSocietyType,
  ok,
  societyError,
} from "@ses/domain";
import type {
  Paise,
  Result,
  Society,
  SocietyMembership,
  SocietyType,
  UserId,
} from "@ses/domain";

import type { SocietyDeps } from "./support";

/**
 * Create a society (PRD §3.2 step 1 and step 3).
 *
 * The command is raw, wire-shaped input — every field is unvalidated by the time
 * it arrives, which is the point: validation happens *here*, through the value
 * objects, so the API, a seed script and a test all get the same rules and the
 * same field-level errors. Nothing reaches the repository until the aggregate is
 * coherent.
 */
export interface CreateSocietyCommand {
  readonly name: string;
  readonly type: SocietyType;
  readonly registrationNumber?: string | undefined;
  readonly addressLine1?: string | undefined;
  readonly addressLine2?: string | undefined;
  readonly city: string;
  readonly state: string;
  readonly pincode?: string | undefined;
  readonly billingDay?: number | undefined;
  readonly dueDay?: number | undefined;
  readonly graceDays?: number | undefined;
  readonly approvalThresholdPaise?: number | Paise | undefined;
  readonly timezone?: string | undefined;
}

export interface CreatedSociety {
  readonly society: Society;
  /** The creator's membership — always Admin (PRD §3.2). */
  readonly membership: SocietyMembership;
}

export async function createSociety(
  deps: SocietyDeps,
  actor: UserId,
  command: CreateSocietyCommand,
): Promise<Result<CreatedSociety, ReturnType<typeof asSocietyError>>> {
  const name = createSocietyName(command.name);
  if (!name.ok) return name;

  if (!isSocietyType(command.type)) {
    return err(
      societyError("validation", "Choose a society type.", { field: "type" }),
    );
  }

  const address = createSocietyAddress({
    line1: command.addressLine1,
    line2: command.addressLine2,
    city: command.city,
    state: command.state,
    pincode: command.pincode,
  });
  if (!address.ok) return address;

  const settings = createSocietySettings({
    billingDay: command.billingDay,
    dueDay: command.dueDay,
    graceDays: command.graceDays,
    approvalThresholdPaise: command.approvalThresholdPaise,
    timezone: command.timezone,
  });
  if (!settings.ok) return settings;

  try {
    return ok(
      await deps.repository.create(
        {
          // The normalised name and its derived slug, not the raw input.
          name: name.value.value,
          type: command.type,
          registrationNumber: normalizeOptional(command.registrationNumber),
          addressLine1: address.value.line1 ?? undefined,
          addressLine2: address.value.line2 ?? undefined,
          city: address.value.city,
          state: address.value.state,
          pincode: address.value.pincode ?? undefined,
          billingDay: settings.value.billingDay,
          dueDay: settings.value.dueDay,
          approvalThresholdPaise: settings.value.approvalThresholdPaise,
        },
        actor,
      ),
    );
  } catch (error: unknown) {
    return err(asSocietyError(error));
  }
}

function normalizeOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
