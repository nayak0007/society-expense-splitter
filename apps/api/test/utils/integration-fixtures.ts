import { paise } from "@ses/domain";
import type {
  ApartmentId,
  BuildingId,
  MemberId,
  MemberStatus,
  MemberRole,
  MemberOccupancy,
  SocietyId,
  SocietyRepository,
  UserId,
} from "@ses/domain";
import type postgres from "postgres";

import { SOCIETY_REPOSITORY } from "../../src/modules/societies/application/society.tokens";

import { createLocalUser } from "./integration-db";
import type { IntegrationHarness } from "./integration-harness";

/**
 * Small fixture builders for the repository integration specs.
 *
 * They exist to keep three lines of setup from being copied into thirty tests,
 * not to hide behaviour: every one either calls a real repository or inserts a
 * row as the owner. The owner inserts are the ones `integration-db.ts` documents
 * — fixtures have to exist before any identity does — and the specs assert
 * *behaviour*, never that a fixture seeded through the owner is visible.
 *
 * Deliberately not a framework: no fixture registry, no automatic teardown. The
 * suite already resets by truncation between tests (`resetData`), which is
 * cheaper and cannot silently stop clearing a table.
 */

export interface SocietyFixture {
  readonly societyId: SocietyId;
  readonly adminUserId: UserId;
  /** The admin's own membership row — the caller of every manager-path test. */
  readonly adminMemberId: MemberId;
  readonly joinCode: string;
  readonly name: string;
}

/** Creates a society through the real RPC-backed repository, as its creator. */
export async function seedSociety(
  harness: IntegrationHarness,
  name = "Alpha Court",
  email = "admin@repo.ses.test",
): Promise<SocietyFixture> {
  const adminUserId = (await createLocalUser(
    harness.owner,
    email,
    "Admin",
  )) as UserId;
  const societies = harness.app.get<SocietyRepository>(SOCIETY_REPOSITORY);
  const { society, membership } = await societies.create(
    {
      name,
      type: "apartment",
      city: "Pune",
      state: "MH",
      billingDay: 1,
      dueDay: 10,
      approvalThresholdPaise: paise(1_000_000n),
    },
    adminUserId,
  );
  return {
    societyId: society.id,
    adminUserId,
    adminMemberId: membership.id,
    joinCode: society.joinCode,
    name: society.name,
  };
}

/** A live building of one society, inserted as the owner (no identity column). */
export async function insertBuilding(
  owner: postgres.Sql,
  societyId: SocietyId,
  name: string,
): Promise<BuildingId> {
  const [row] = await owner<{ id: string }[]>`
    insert into public.buildings (society_id, name)
    values (${societyId}::uuid, ${name})
    returning id
  `;
  return row!.id as BuildingId;
}

/** A live flat of one building, inserted as the owner. */
export async function insertApartment(
  owner: postgres.Sql,
  societyId: SocietyId,
  buildingId: BuildingId,
  apartmentNumber: string,
  floor: number | null = null,
): Promise<ApartmentId> {
  const [row] = await owner<{ id: string }[]>`
    insert into public.apartments (society_id, building_id, apartment_number, floor)
    values (${societyId}::uuid, ${buildingId}::uuid, ${apartmentNumber}, ${floor})
    returning id
  `;
  return row!.id as ApartmentId;
}

export interface InsertMemberOptions {
  readonly userId?: string | null;
  readonly displayName?: string;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly role?: MemberRole | undefined;
  readonly status?: MemberStatus;
  readonly occupancy?: MemberOccupancy;
  readonly apartmentId?: ApartmentId | null;
  readonly isPrimary?: boolean;
  readonly requestNote?: string | null;
  /** Required by `chk_members_rejection_reason` whenever `status` is `rejected`. */
  readonly rejectionReason?: string | null;
  /** Required by the same constraint; defaults to now() for a `rejected` row. */
  readonly rejectedAt?: string | null;
  /** Explicit only where ordering is part of the assertion; the trigger owns it otherwise. */
  readonly joinedAt?: string | null;
}

/**
 * A membership row inserted as the owner, for preconditions the repositories do
 * not own (a pending request the join queue reads, a suspended member, a second
 * society's roster). `stamp_member_approval()` still runs — an `active` row gets
 * its `joined_at` — so the fixture matches what the real write paths produce.
 */
export async function insertMember(
  owner: postgres.Sql,
  societyId: SocietyId,
  options: InsertMemberOptions = {},
): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    insert into public.members (
      society_id, user_id, display_name, phone, email, role, status,
      occupancy, apartment_id, is_primary, request_note, rejection_reason,
      rejected_at, joined_at
    )
    values (
      ${societyId}::uuid,
      ${options.userId ?? null}::uuid,
      ${options.displayName ?? "Fixture Member"},
      ${options.phone ?? null},
      ${options.email ?? null},
      ${options.role === "committee_member" ? "committee" : (options.role ?? "resident")}::public.member_role,
      ${options.status ?? "active"}::public.member_status,
      ${options.occupancy ?? "owner_occupied"}::public.occupancy_type,
      ${options.apartmentId ?? null}::uuid,
      ${options.isPrimary ?? false}::boolean,
      ${options.requestNote ?? null},
      ${options.rejectionReason ?? null},
      ${
        options.rejectedAt ??
        (options.status === "rejected" ? new Date().toISOString() : null)
      }::timestamptz,
      ${options.joinedAt ?? null}::timestamptz
    )
    returning id
  `;
  return row!.id;
}
