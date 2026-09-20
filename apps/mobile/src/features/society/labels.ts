import type { MemberRole, OccupancyType, MembershipStatus, SocietyType } from '@ses/domain';

/**
 * Display labels for the domain's enums. Kept as plain strings (English-only
 * for v1 — PRD §22) and separate from the enums themselves, so a label change
 * is never mistaken for a value change.
 */

export const SOCIETY_TYPE_LABELS: Record<SocietyType, string> = {
  apartment: 'Apartment',
  villa: 'Villa',
  rowhouse: 'Row house',
  shared_flat: 'Shared flat',
  other: 'Other',
};

export const ROLE_LABELS: Record<MemberRole, string> = {
  admin: 'Society Admin',
  treasurer: 'Treasurer',
  committee_member: 'Committee Member',
  resident: 'Resident',
  tenant: 'Tenant',
  guest: 'Guest',
};

export const OCCUPANCY_LABELS: Record<OccupancyType, string> = {
  owner: 'Owner',
  tenant: 'Tenant',
  family_member: 'Family member',
};

export const MEMBERSHIP_STATUS_LABELS: Record<MembershipStatus, string> = {
  pending: 'Awaiting approval',
  active: 'Active',
  removed: 'Removed',
};
