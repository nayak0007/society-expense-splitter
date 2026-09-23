import {
  createdSocietyResponseSchema,
  membershipResponseSchema,
  societyJoinPreviewSchema,
  societyProfileResponseSchema,
  societySchema,
  societySummarySchema,
} from "@ses/contracts";
import type {
  CreatedSocietyResponseDto,
  MembershipDto,
  MembershipResponseDto,
  SocietyCapabilitiesDto,
  SocietyDto,
  SocietyJoinPreviewDto,
  SocietyProfileResponseDto,
  SocietySummaryDto,
} from "@ses/contracts";
import type {
  Society,
  SocietyCapabilities,
  SocietyJoinPreview,
  SocietyMembership,
  SocietySummary,
} from "@ses/domain";

/**
 * Domain entity → wire DTO, per SAD §4.5's `presentation/*.mapper.ts`.
 *
 * ## Why every mapper *parses* rather than constructs
 *
 * The contract schemas in `@ses/contracts` are the client's parse target, so the
 * response has to satisfy them exactly. Mapping by hand and trusting it means a
 * domain rename — `registrationNumber` to `registrationNo`, a `null` becoming
 * `undefined` — ships as a silently wrong payload that the mobile client then
 * fails to parse, in production, on one screen. Parsing here turns that into a
 * 500 with a stack trace at the moment the field moves, and the cost is a Zod
 * pass over a small object on the response path.
 *
 * The mappers are deliberately explicit rather than spreads of the entity: a
 * spread would forward any field the domain grows, including ones the contract
 * does not define, and the whole point of the boundary is that it is enumerated.
 */

export function societyToDto(society: Society): SocietyDto {
  return societySchema.parse({
    id: society.id,
    name: society.name,
    slug: society.slug,
    type: society.type,
    registrationNumber: society.registrationNumber,
    addressLine1: society.addressLine1,
    addressLine2: society.addressLine2,
    city: society.city,
    state: society.state,
    pincode: society.pincode,
    country: society.country,
    currency: society.currency,
    timezone: society.timezone,
    joinCode: society.joinCode,
    joinCodeExpiresAt: society.joinCodeExpiresAt,
    plan: society.plan,
    createdBy: society.createdBy,
    createdAt: society.createdAt,
    updatedAt: society.updatedAt,
    deletedAt: society.deletedAt,
    settings: {
      billingDay: society.settings.billingDay,
      dueDay: society.settings.dueDay,
      graceDays: society.settings.graceDays,
      approvalThresholdPaise: society.settings.approvalThresholdPaise,
      billVacantFlats: society.settings.billVacantFlats,
      allowPartialPayments: society.settings.allowPartialPayments,
      defaulterListPublic: society.settings.defaulterListPublic,
      financialYearStartMonth: society.settings.financialYearStartMonth,
      timezone: society.settings.timezone,
      currency: society.settings.currency,
    },
    memberCount: society.memberCount,
  });
}

export function membershipToDto(membership: SocietyMembership): MembershipDto {
  return societyProfileResponseSchema.shape.membership.parse({
    id: membership.id,
    societyId: membership.societyId,
    userId: membership.userId,
    role: membership.role,
    status: membership.status,
    occupancyType: membership.occupancyType,
    joinedAt: membership.joinedAt,
  });
}

export function capabilitiesToDto(
  capabilities: SocietyCapabilities,
): SocietyCapabilitiesDto {
  return societyProfileResponseSchema.shape.capabilities.parse({
    canManage: capabilities.canManage,
    canDelete: capabilities.canDelete,
    canRegenerateJoinCode: capabilities.canRegenerateJoinCode,
    canViewJoinCode: capabilities.canViewJoinCode,
    canLeave: capabilities.canLeave,
  });
}

export function summaryToDto(summary: SocietySummary): SocietySummaryDto {
  return societySummarySchema.parse({
    id: summary.id,
    name: summary.name,
    city: summary.city,
    type: summary.type,
    role: summary.role,
    status: summary.status,
    memberCount: summary.memberCount,
  });
}

export function joinPreviewToDto(
  preview: SocietyJoinPreview,
): SocietyJoinPreviewDto {
  return societyJoinPreviewSchema.parse({
    id: preview.id,
    name: preview.name,
    city: preview.city,
    state: preview.state,
    type: preview.type,
    memberCount: preview.memberCount,
  });
}

export function profileToDto(
  society: Society,
  membership: SocietyMembership,
  capabilities: SocietyCapabilities,
): SocietyProfileResponseDto {
  return societyProfileResponseSchema.parse({
    society: societyToDto(society),
    membership: membershipToDto(membership),
    capabilities: capabilitiesToDto(capabilities),
  });
}

export function createdSocietyToDto(
  society: Society,
  membership: SocietyMembership,
): CreatedSocietyResponseDto {
  return createdSocietyResponseSchema.parse({
    society: societyToDto(society),
    membership: membershipToDto(membership),
  });
}

export function membershipResponseToDto(
  membership: SocietyMembership,
): MembershipResponseDto {
  return membershipResponseSchema.parse({
    membership: membershipToDto(membership),
  });
}
