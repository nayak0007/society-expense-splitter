import {
  csvImportPreviewResponseSchema,
  csvImportResultResponseSchema,
  joinRequestListResponseSchema,
  joinRequestResponseSchema,
  memberDetailResponseSchema,
  memberListResponseSchema,
  memberPermissionsResponseSchema,
  memberResponseSchema,
  permissionCatalogueResponseSchema,
} from "@ses/contracts";
import type {
  CsvImportPreviewResponseDto,
  CsvImportResultResponseDto,
  JoinRequestListResponseDto,
  JoinRequestResponseDto,
  MemberCapabilitiesDto,
  MemberDetailResponseDto,
  MemberListResponseDto,
  MemberPermissionsResponseDto,
  MemberResponseDto,
  PermissionCatalogueResponseDto,
} from "@ses/contracts";
import type { MemberCapabilities, MemberView } from "@ses/domain";
import type {
  CsvImportPreview,
  CsvImportResult,
  JoinQueue,
  MemberPermissionsView,
  RoleCatalogue,
} from "@ses/application";
import type { ZodType } from "zod";

import { AppError } from "../../../common/errors/app-error";

/**
 * Domain → wire, **parsed against the client's own schema**.
 *
 * The mapper does not build a plain object and hand it to the response interceptor: it parses
 * the object through the same schemas the mobile client validates with, so a domain rename
 * fails *here* — as a `500` that names the field — instead of shipping a payload the client
 * cannot read. That is the property `building.mapper.ts` records, and it is worth more in this
 * module than in the structure one: `contactVisible` is a *derived* field with no column
 * behind it, so nothing but this parse stands between a domain refactor and a client that
 * silently renders every phone number as "not shared".
 *
 * ## Why the DTO is not the entity
 *
 * `MemberView` and `MemberDto` have the same shape today — deliberately, so a screen can hold
 * one row and render it — but they are separate types with a parse between them, so the day a
 * column is added to the entity the client's contract does not change by accident.
 */
function memberSchemaOf(member: MemberView): unknown {
  return {
    id: member.id,
    societyId: member.societyId,
    userId: member.userId,
    apartmentId: member.apartmentId,
    apartment:
      member.apartment === null
        ? null
        : {
            id: member.apartment.id,
            number: member.apartment.number,
            buildingId: member.apartment.buildingId,
            buildingName: member.apartment.buildingName,
            floor: member.apartment.floor,
          },
    displayName: member.displayName,
    phone: member.phone,
    email: member.email,
    role: member.role,
    status: member.status,
    occupancy: member.occupancy,
    isPrimary: member.isPrimary,
    leaseStart: member.leaseStart,
    leaseEnd: member.leaseEnd,
    shareContact: member.shareContact,
    joinedAt: member.joinedAt,
    approvedBy: member.approvedBy,
    removedAt: member.removedAt,
    removedBy: member.removedBy,
    requestNote: member.requestNote,
    rejectionReason: member.rejectionReason,
    rejectedAt: member.rejectedAt,
    rejectedBy: member.rejectedBy,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
    contactVisible: member.contactVisible,
  };
}

function capabilitiesToDto(
  capabilities: MemberCapabilities,
): MemberCapabilitiesDto {
  return {
    canView: capabilities.canView,
    canAdd: capabilities.canAdd,
    canEdit: capabilities.canEdit,
    canSuspend: capabilities.canSuspend,
    canRemove: capabilities.canRemove,
    // T046. Spelled out rather than spread, for the reason this file's header gives: a spread
    // would carry a *new* capability to the wire without the contract ever being extended, and
    // the day the parse rejects it the failure would be here — but the day before that, a client
    // would have received a field it had no schema for.
    canChangeRoles: capabilities.canChangeRoles,
    // T049.
    canApprove: capabilities.canApprove,
  };
}

/** `POST /members` and `PATCH /members/:memberId` — the member alone. */
export function memberResponseToDto(member: MemberView): MemberResponseDto {
  return parseWith(memberResponseSchema, { member: memberSchemaOf(member) });
}

/** `GET /members/:memberId` — the member and the caller's capabilities. */
export function memberDetailToDto(
  member: MemberView,
  capabilities: MemberCapabilities,
): MemberDetailResponseDto {
  return parseWith(memberDetailResponseSchema, {
    member: memberSchemaOf(member),
    capabilities: capabilitiesToDto(capabilities),
  });
}

/** `GET /members` — one page, the total the filters produced, and the request's own paging. */
export function memberListToDto(directory: {
  readonly members: readonly MemberView[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly capabilities: MemberCapabilities;
}): MemberListResponseDto {
  return parseWith(memberListResponseSchema, {
    members: directory.members.map((member) => memberSchemaOf(member)),
    total: directory.total,
    limit: directory.limit,
    offset: directory.offset,
    capabilities: capabilitiesToDto(directory.capabilities),
  });
}

/**
 * `GET /members/join-requests` — one page of the queue, and the caller's capabilities.
 *
 * The requests are mapped with the same `memberSchemaOf` every other member response uses, so a
 * request row and a directory row cannot render differently; `claims` goes through it too, which
 * is what keeps a queue from becoming a way around the contact-consent rule the directory
 * enforces.
 */
export function joinQueueToDto(queue: JoinQueue): JoinRequestListResponseDto {
  return parseWith(joinRequestListResponseSchema, {
    requests: queue.requests.map((request) => ({
      member: memberSchemaOf(request.member),
      claims: request.claims.map((claim) => memberSchemaOf(claim)),
    })),
    total: queue.total,
    limit: queue.limit,
    offset: queue.offset,
    capabilities: capabilitiesToDto(queue.capabilities),
  });
}

/** `POST /members/join-requests/:memberId/approve|reject` — the membership after the decision. */
export function joinDecisionToDto(detail: {
  readonly member: MemberView;
  readonly capabilities: MemberCapabilities;
}): JoinRequestResponseDto {
  return parseWith(joinRequestResponseSchema, {
    member: memberSchemaOf(detail.member),
    capabilities: capabilitiesToDto(detail.capabilities),
  });
}

/**
 * `POST /members/import/preview` — the classification of every row, before any write.
 *
 * A `valid` row travels as its resolved self (ids in, phone normalised); an invalid or
 * conflicted row travels as its `CsvRowError`, addressed by file line — which is what the
 * screen puts under the cell the admin can fix.
 */
export function csvImportPreviewToDto(
  preview: CsvImportPreview,
): CsvImportPreviewResponseDto {
  return parseWith(csvImportPreviewResponseSchema, {
    rows: preview.rows.map((outcome) =>
      outcome.status === "valid"
        ? {
            status: "valid" as const,
            line: outcome.line,
            displayName: outcome.displayName,
            phone: outcome.phone,
            email: outcome.email,
            apartmentNumber: outcome.apartmentNumber,
            apartmentId: outcome.apartmentId,
            occupancy: outcome.occupancy,
          }
        : {
            status: outcome.status,
            line: outcome.line,
            error: {
              line: outcome.error.line,
              field: outcome.error.field,
              code: outcome.error.code,
              message: outcome.error.message,
            },
          },
    ),
    summary: preview.summary,
    capabilities: capabilitiesToDto(preview.capabilities),
  });
}

/** `POST /members/import` — what happened, per row, after the confirmation. */
export function csvImportResultToDto(
  result: CsvImportResult,
): CsvImportResultResponseDto {
  return parseWith(csvImportResultResponseSchema, {
    summary: result.summary,
    imported: result.imported.map((member) => memberSchemaOf(member)),
    failed: result.failed.map((failure) => ({
      line: failure.line,
      error: {
        line: failure.error.line,
        field: failure.error.field,
        code: failure.error.code,
        message: failure.error.message,
      },
    })),
    capabilities: capabilitiesToDto(result.capabilities),
  });
}

/** `GET /permissions` — every role with its actions, and the caller's capabilities. */
export function roleCatalogueToDto(
  catalogue: RoleCatalogue,
): PermissionCatalogueResponseDto {
  return parseWith(permissionCatalogueResponseSchema, {
    roles: catalogue.roles.map((definition) => ({
      role: definition.role,
      permissions: [...definition.permissions],
    })),
    capabilities: capabilitiesToDto(catalogue.capabilities),
  });
}

/**
 * `GET /permissions/me`, `GET /permissions/members/:memberId` and both role writes.
 *
 * One mapper for four routes because they answer one question — what may this membership do — and
 * the role write's whole response *is* that answer recomputed from the stored row. The copy is not
 * a shortcut either: `permissions` is the evaluator's own array, so a client can render it without
 * a second call, and this parse is what keeps a domain rename from reaching the wire unnoticed.
 */
export function memberPermissionsToDto(
  view: MemberPermissionsView,
): MemberPermissionsResponseDto {
  return parseWith(memberPermissionsResponseSchema, {
    memberId: view.memberId,
    role: view.role,
    permissions: [...view.permissions],
    capabilities: capabilitiesToDto(view.capabilities),
  });
}

/**
 * A shape mismatch is a server bug, never the caller's — so it is reported as `INTERNAL` with
 * the offending path in the details, and deliberately **not** as a `VALIDATION_ERROR`: the
 * request was fine, the response was wrong.
 */
function parseWith<TData>(schema: ZodType<TData>, value: unknown): TData {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw shapeError(parsed.error.issues[0]?.path.join(".") ?? "member");
  }
  return parsed.data;
}

function shapeError(path: string): AppError {
  return new AppError(
    "INTERNAL",
    "The member response did not match the published contract.",
    {
      details: [
        {
          field: path,
          code: "RESPONSE_SHAPE",
          message: `The member contract rejected "${path}".`,
        },
      ],
    },
  );
}
