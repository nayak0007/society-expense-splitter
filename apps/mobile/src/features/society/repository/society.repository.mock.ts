import {
  DEFAULT_SOCIETY_SETTINGS,
  SocietyError,
  asMemberId,
  asSocietyId,
  asUserId,
  canDeleteSociety,
  canLeaveSociety,
  canManageSociety,
  defaultSocietySettings,
  generateJoinCode,
  isJoinCodeExpired,
  normalizeJoinCode,
  slugify,
} from '@ses/domain';
import type {
  CreateSocietyInput,
  JoinSocietyInput,
  MemberRole,
  OccupancyType,
  Society,
  SocietyJoinPreview,
  SocietyMembership,
  SocietyRepository,
  SocietySettings,
  SocietyType,
  SubscriptionPlan,
} from '@ses/domain';

import { mmkvStorage } from '@/lib/storage/mmkv';

/**
 * In-memory + MMKV society repository (mock).
 *
 * WHY THIS EXISTS: the Phase 3 backend (`/societies` endpoints, RLS,
 * `SocietyGuard`) does not exist yet, so this adapter implements the
 * `SocietyRepository` **port** with identical semantics — tenancy checks,
 * join-code rules, seeding and the sole-admin invariant included — and
 * persists to MMKV so state survives a reload. Swapping it for the HTTP
 * implementation is a single line in `society.repository.ts`; no screen,
 * hook, service or domain rule changes.
 *
 * Honest limits, stated rather than hidden:
 *  - it stores *this device's* data only, so two devices cannot see each
 *    other's societies — that needs the real API;
 *  - joins auto-approve by default (`autoApproveJoins`) because no admin
 *    approval queue exists yet (T053); the `pending` path is fully
 *    implemented and the UI renders it, so flipping the flag exercises it;
 *  - `crossTenant` behaviour is emulated by returning `not_found` (never
 *    `forbidden`) for societies the actor is not a member of, matching
 *    PRD T041.
 */

interface SocietyRecord {
  id: string;
  name: string;
  slug: string;
  type: SocietyType;
  registrationNumber: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string;
  state: string;
  pincode: string | null;
  joinCode: string;
  joinCodeExpiresAt: string | null;
  plan: SubscriptionPlan;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  settings: SocietySettings;
}

interface MembershipRecord {
  id: string;
  societyId: string;
  userId: string;
  role: MemberRole;
  status: 'pending' | 'active' | 'removed';
  occupancyType: OccupancyType;
  joinedAt: string | null;
}

interface MockDatabase {
  societies: SocietyRecord[];
  memberships: MembershipRecord[];
}

export interface MockSocietyRepositoryOptions {
  /** Approve joins immediately (no approval queue yet). Default: true. */
  readonly autoApproveJoins?: boolean;
}

const STORAGE_KEY = 'ses/mock/society-db';

let sequence = 0;

export class MockSocietyRepository implements SocietyRepository {
  private readonly autoApproveJoins: boolean;

  constructor(options: MockSocietyRepositoryOptions = {}) {
    this.autoApproveJoins = options.autoApproveJoins ?? true;
  }

  async listMemberships(actor: string): Promise<readonly SocietyMembership[]> {
    const db = this.read();
    return db.memberships
      .filter((membership) => membership.userId === actor && membership.status !== 'removed')
      .map(toMembership);
  }

  async findById(id: string, actor: string): Promise<Society | null> {
    const db = this.read();
    const record = findSociety(db, id);
    if (record === null) return null;
    // Tenancy: a non-member gets the same answer as a non-existent id.
    if (findMembershipRecord(db, id, actor) === null) return null;
    return toSociety(record, countActiveMembers(db, id));
  }

  async findJoinPreview(rawCode: string): Promise<SocietyJoinPreview | null> {
    const db = this.read();
    const code = normalizeJoinCode(rawCode);
    const record = db.societies.find(
      (society) =>
        society.deletedAt === null &&
        society.joinCode === code &&
        !isJoinCodeExpired(society.joinCodeExpiresAt),
    );
    if (record === undefined) return null;
    return {
      id: asSocietyId(record.id),
      name: record.name,
      city: record.city,
      state: record.state,
      type: record.type,
      memberCount: countActiveMembers(db, record.id),
    };
  }

  async create(
    input: CreateSocietyInput,
    actor: string,
  ): Promise<{ readonly society: Society; readonly membership: SocietyMembership }> {
    const db = this.read();
    const now = new Date().toISOString();

    const record: SocietyRecord = {
      id: newId('soc'),
      name: input.name.trim(),
      slug: this.uniqueSlug(db, slugify(input.name)),
      type: input.type,
      registrationNumber: input.registrationNumber ?? null,
      addressLine1: input.addressLine1 ?? null,
      addressLine2: input.addressLine2 ?? null,
      city: input.city.trim(),
      state: input.state.trim(),
      pincode: input.pincode ?? null,
      joinCode: this.uniqueJoinCode(db),
      joinCodeExpiresAt: null,
      plan: 'free',
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      // PRD §3.2: a `society_settings` row is seeded on creation.
      settings: defaultSocietySettings({
        billingDay: input.billingDay,
        dueDay: input.dueDay,
        approvalThresholdPaise: input.approvalThresholdPaise,
        timezone: DEFAULT_SOCIETY_SETTINGS.timezone,
      }),
    };

    // PRD §3.2: "The creator becomes Society Admin."
    const membership: MembershipRecord = {
      id: newId('mem'),
      societyId: record.id,
      userId: actor,
      role: 'admin',
      status: 'active',
      occupancyType: 'owner',
      joinedAt: now,
    };

    db.societies.push(record);
    db.memberships.push(membership);
    this.write(db);

    return { society: toSociety(record, 1), membership: toMembership(membership) };
  }

  async update(id: string, input: Partial<CreateSocietyInput>, actor: string): Promise<Society> {
    const db = this.read();
    const membership = this.requireMember(db, id, actor);
    assertAllowed(canManageSociety(membership.role));

    const record = findSociety(db, id);
    if (record === null) throw new SocietyError('not_found', 'That society no longer exists.');

    applyTextPatch(record, input);
    // Settings are replaced as a value, never mutated in place — the domain
    // type is readonly on purpose.
    record.settings = {
      ...record.settings,
      ...(input.billingDay === undefined ? {} : { billingDay: input.billingDay }),
      ...(input.dueDay === undefined ? {} : { dueDay: input.dueDay }),
      ...(input.approvalThresholdPaise === undefined
        ? {}
        : { approvalThresholdPaise: input.approvalThresholdPaise }),
    };
    if (input.name !== undefined) record.slug = this.uniqueSlug(db, slugify(input.name), record.id);
    record.updatedAt = new Date().toISOString();

    this.write(db);
    return toSociety(record, countActiveMembers(db, id));
  }

  async regenerateJoinCode(id: string, actor: string): Promise<Society> {
    const db = this.read();
    const membership = this.requireMember(db, id, actor);
    assertAllowed(canManageSociety(membership.role));

    const record = findSociety(db, id);
    if (record === null) throw new SocietyError('not_found', 'That society no longer exists.');
    record.joinCode = this.uniqueJoinCode(db);
    record.updatedAt = new Date().toISOString();

    this.write(db);
    return toSociety(record, countActiveMembers(db, id));
  }

  async remove(id: string, actor: string): Promise<void> {
    const db = this.read();
    const membership = this.requireMember(db, id, actor);
    assertAllowed(canDeleteSociety(membership.role));

    const record = findSociety(db, id);
    if (record === null) throw new SocietyError('not_found', 'That society no longer exists.');

    // Soft delete (financial history is never destroyed — PRD §3.3).
    record.deletedAt = new Date().toISOString();
    record.updatedAt = record.deletedAt;
    for (const row of db.memberships) {
      if (row.societyId === id) row.status = 'removed';
    }
    this.write(db);
  }

  async join(input: JoinSocietyInput, actor: string): Promise<SocietyMembership> {
    const db = this.read();
    const code = normalizeJoinCode(input.code);
    const record = db.societies.find(
      (society) => society.deletedAt === null && society.joinCode === code,
    );
    if (record === undefined) {
      throw new SocietyError('join_code_invalid', 'That join code does not match any society.');
    }
    if (isJoinCodeExpired(record.joinCodeExpiresAt)) {
      throw new SocietyError(
        'join_code_expired',
        'That join code has expired. Ask an admin for a new one.',
      );
    }

    const existing = findMembershipRecord(db, record.id, actor);
    if (existing !== null && existing.status !== 'removed') {
      throw new SocietyError('already_member', 'You are already a member of this society.');
    }

    const now = new Date().toISOString();
    const approved = this.autoApproveJoins;
    const membership: MembershipRecord =
      existing === null
        ? {
            id: newId('mem'),
            societyId: record.id,
            userId: actor,
            role: 'resident',
            status: approved ? 'active' : 'pending',
            occupancyType: input.occupancyType,
            joinedAt: approved ? now : null,
          }
        : {
            ...existing,
            occupancyType: input.occupancyType,
            status: approved ? 'active' : 'pending',
            joinedAt: approved ? now : null,
          };

    if (existing === null) db.memberships.push(membership);
    this.write(db);

    return toMembership(membership);
  }

  async leave(id: string, actor: string): Promise<void> {
    const db = this.read();
    const membership = this.requireMember(db, id, actor);

    // Invariant: a society can never be left without an active admin.
    const sameSociety = db.memberships.filter((row) => row.societyId === id).map(toMembership);
    assertAllowed(canLeaveSociety(toMembership(membership), sameSociety));

    membership.status = 'removed';
    this.write(db);
  }

  /** Clears every local society row — used by tests and the dev menu. */
  static clearStorage(): void {
    mmkvStorage.remove(STORAGE_KEY);
  }

  private requireMember(db: MockDatabase, societyId: string, actor: string): MembershipRecord {
    const membership = findMembershipRecord(db, societyId, actor);
    if (findSociety(db, societyId) === null || membership === null) {
      // not_found, never forbidden — existence is not leaked (PRD T041).
      throw new SocietyError('not_found', 'That society is not available to you.');
    }
    if (membership.status === 'removed') {
      throw new SocietyError('not_found', 'That society is not available to you.');
    }
    return membership;
  }

  private uniqueSlug(db: MockDatabase, base: string, excludeId?: string): string {
    const root = base.length > 0 ? base : 'society';
    let candidate = root;
    let suffix = 2;
    while (db.societies.some((society) => society.slug === candidate && society.id !== excludeId)) {
      candidate = `${root}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  private uniqueJoinCode(db: MockDatabase): string {
    let candidate = generateJoinCode();
    while (db.societies.some((society) => society.joinCode === candidate)) {
      candidate = generateJoinCode();
    }
    return candidate;
  }

  private read(): MockDatabase {
    const raw = mmkvStorage.getString(STORAGE_KEY);
    if (raw === undefined || raw.length === 0) return { societies: [], memberships: [] };
    try {
      const parsed = JSON.parse(raw) as MockDatabase;
      return {
        societies: Array.isArray(parsed.societies) ? parsed.societies : [],
        memberships: Array.isArray(parsed.memberships) ? parsed.memberships : [],
      };
    } catch {
      // Corrupt payload: start clean rather than crash the app on boot.
      return { societies: [], memberships: [] };
    }
  }

  private write(db: MockDatabase): void {
    mmkvStorage.set(STORAGE_KEY, JSON.stringify(db));
  }
}

function applyTextPatch(record: SocietyRecord, input: Partial<CreateSocietyInput>): void {
  if (input.name !== undefined) record.name = input.name.trim();
  if (input.type !== undefined) record.type = input.type;
  if (input.registrationNumber !== undefined) {
    record.registrationNumber = input.registrationNumber ?? null;
  }
  if (input.addressLine1 !== undefined) record.addressLine1 = input.addressLine1 ?? null;
  if (input.addressLine2 !== undefined) record.addressLine2 = input.addressLine2 ?? null;
  if (input.city !== undefined) record.city = input.city.trim();
  if (input.state !== undefined) record.state = input.state.trim();
  if (input.pincode !== undefined) record.pincode = input.pincode ?? null;
}

function assertAllowed(outcome: { allowed: true } | { allowed: false; reason: string }): void {
  if (!outcome.allowed) {
    throw new SocietyError('forbidden', outcome.reason);
  }
}

function findSociety(db: MockDatabase, id: string): SocietyRecord | null {
  return db.societies.find((society) => society.id === id && society.deletedAt === null) ?? null;
}

function findMembershipRecord(
  db: MockDatabase,
  societyId: string,
  actor: string,
): MembershipRecord | null {
  return (
    db.memberships.find(
      (membership) => membership.societyId === societyId && membership.userId === actor,
    ) ?? null
  );
}

function countActiveMembers(db: MockDatabase, societyId: string): number {
  return db.memberships.filter(
    (membership) => membership.societyId === societyId && membership.status === 'active',
  ).length;
}

function toSociety(record: SocietyRecord, memberCount: number): Society {
  return {
    id: asSocietyId(record.id),
    name: record.name,
    slug: record.slug,
    type: record.type,
    registrationNumber: record.registrationNumber,
    addressLine1: record.addressLine1,
    addressLine2: record.addressLine2,
    city: record.city,
    state: record.state,
    pincode: record.pincode,
    country: 'IN' as const,
    currency: 'INR' as const,
    timezone: record.settings.timezone,
    joinCode: record.joinCode,
    joinCodeExpiresAt: record.joinCodeExpiresAt,
    plan: record.plan,
    createdBy: asUserId(record.createdBy),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    deletedAt: record.deletedAt,
    settings: record.settings,
    memberCount,
  };
}

function toMembership(record: MembershipRecord): SocietyMembership {
  return {
    id: asMemberId(record.id),
    societyId: asSocietyId(record.societyId),
    userId: asUserId(record.userId),
    role: record.role,
    status: record.status,
    occupancyType: record.occupancyType,
    joinedAt: record.joinedAt,
  };
}

function newId(prefix: string): string {
  sequence += 1;
  return `${prefix}_${Date.now().toString(36)}${sequence.toString(36)}`;
}
