import {
  asSocietyError,
  createSocietyAddress,
  createSocietyName,
  err,
  isSocietyType,
  ok,
  societyError,
  updateSocietySettings,
} from "@ses/domain";
import type {
  Paise,
  Result,
  Society,
  SocietyId,
  SocietyType,
  UpdateSocietyInput,
  UserId,
} from "@ses/domain";

import { loadSocietyContext, requireCapability } from "./support";
import type { SocietyDeps } from "./support";

/**
 * Edit a society (PRD §3.2 "Edit Society").
 *
 * Admin-only, and the guard is the domain's own `canManage` capability rather
 * than a role string compared inline — one definition, shared with the RLS
 * policy and the UI affordance.
 *
 * "Absent" and "explicitly cleared" are different intentions and are treated
 * differently: `undefined` means *leave unchanged* (the repository ignores it),
 * `''` means *clear this optional field* (normalised to `null`). Without that
 * distinction, an edit form that only sends the fields it touched would wipe the
 * ones it did not.
 */
export interface UpdateSocietyCommand {
  readonly name?: string | undefined;
  readonly type?: SocietyType | undefined;
  readonly registrationNumber?: string | undefined;
  readonly addressLine1?: string | undefined;
  readonly addressLine2?: string | undefined;
  readonly city?: string | undefined;
  readonly state?: string | undefined;
  readonly pincode?: string | undefined;
  readonly billingDay?: number | undefined;
  readonly dueDay?: number | undefined;
  readonly graceDays?: number | undefined;
  readonly approvalThresholdPaise?: number | Paise | undefined;
  readonly billVacantFlats?: boolean | undefined;
  readonly allowPartialPayments?: boolean | undefined;
  readonly defaulterListPublic?: boolean | undefined;
  readonly financialYearStartMonth?: number | undefined;
  readonly timezone?: string | undefined;
}

const ADDRESS_FIELDS = [
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "pincode",
] as const;

const SETTINGS_FIELDS = [
  "billingDay",
  "dueDay",
  "graceDays",
  "approvalThresholdPaise",
  "billVacantFlats",
  "allowPartialPayments",
  "defaulterListPublic",
  "financialYearStartMonth",
  "timezone",
] as const;

export async function updateSociety(
  deps: SocietyDeps,
  actor: UserId,
  societyId: SocietyId,
  command: UpdateSocietyCommand,
): Promise<Result<Society, ReturnType<typeof asSocietyError>>> {
  const loaded = await loadSocietyContext(deps, actor, societyId);
  if (!loaded.ok) return loaded;

  const guard = requireCapability(
    loaded.value.capabilities,
    "canManage",
    "Only a society Admin can change society details.",
  );
  if (!guard.ok) return guard;

  if (!hasAnyField(command)) {
    return err(societyError("validation", "Nothing to update."));
  }

  const patch: UpdateSocietyInput = {};

  if (command.name !== undefined) {
    const name = createSocietyName(command.name);
    if (!name.ok) return name;
    patch.name = name.value.value;
  }

  if (command.type !== undefined) {
    if (!isSocietyType(command.type)) {
      return err(
        societyError("validation", "Choose a society type.", { field: "type" }),
      );
    }
    patch.type = command.type;
  }

  if (command.registrationNumber !== undefined) {
    // Empty string clears it; the database column is nullable on purpose
    // (PRD §3.2: registration number is optional).
    patch.registrationNumber =
      normalizeOptional(command.registrationNumber) ?? undefined;
  }

  if (ADDRESS_FIELDS.some((field) => command[field] !== undefined)) {
    // Validate the *resulting* address, not just the changed fields: removing
    // the city while keeping the PIN code must fail as a whole address.
    const merged = {
      line1:
        command.addressLine1 ?? loaded.value.society.addressLine1 ?? undefined,
      line2:
        command.addressLine2 ?? loaded.value.society.addressLine2 ?? undefined,
      city: command.city ?? loaded.value.society.city,
      state: command.state ?? loaded.value.society.state,
      pincode: command.pincode ?? loaded.value.society.pincode ?? undefined,
    };
    const address = createSocietyAddress(merged);
    if (!address.ok) return address;

    if (command.addressLine1 !== undefined)
      patch.addressLine1 = address.value.line1 ?? undefined;
    if (command.addressLine2 !== undefined)
      patch.addressLine2 = address.value.line2 ?? undefined;
    if (command.city !== undefined) patch.city = address.value.city;
    if (command.state !== undefined) patch.state = address.value.state;
    if (command.pincode !== undefined)
      patch.pincode = address.value.pincode ?? undefined;
  }

  if (SETTINGS_FIELDS.some((field) => command[field] !== undefined)) {
    const settings = updateSocietySettings(loaded.value.society.settings, {
      billingDay: command.billingDay,
      dueDay: command.dueDay,
      graceDays: command.graceDays,
      approvalThresholdPaise: command.approvalThresholdPaise,
      billVacantFlats: command.billVacantFlats,
      allowPartialPayments: command.allowPartialPayments,
      defaulterListPublic: command.defaulterListPublic,
      financialYearStartMonth: command.financialYearStartMonth,
      timezone: command.timezone,
    });
    if (!settings.ok) return settings;

    // Settings are stored with the society, so the repository receives the whole
    // object rather than a partial patch — there is no way to half-apply it.
    patch.billingDay = settings.value.billingDay;
    patch.dueDay = settings.value.dueDay;
    patch.approvalThresholdPaise = settings.value.approvalThresholdPaise;
  }

  try {
    return ok(await deps.repository.update(societyId, patch, actor));
  } catch (error: unknown) {
    return err(asSocietyError(error));
  }
}

function normalizeOptional(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function hasAnyField(command: UpdateSocietyCommand): boolean {
  return Object.values(command).some((value) => value !== undefined);
}
