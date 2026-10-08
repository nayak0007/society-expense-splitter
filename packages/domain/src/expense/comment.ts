import type {
  ExpenseCommentId,
  ExpenseId,
  MemberId,
  SocietyId,
  UserId,
} from "../shared/ids";

/**
 * The expense discussion stream — PRD §3.5.3 "Notes", Roadmap T072.
 *
 * ## Flat, ordered, append-only
 *
 * The stream is a single chronological list per expense. There are **no nested
 * replies and no `parent_id`** (D1): the PRD's word "threaded" describes the
 * discussion *belonging to its expense*, which is what makes a comment meaningful
 * — it is the expense that is the thread, not another comment. A flat stream also
 * removes the one structure that makes an append-only stream hard: a reply's
 * position depends on its parent's.
 *
 * ## Ordering is the database's sequence, not the client's
 *
 * `sequence` is assigned by the database (a monotonic identity), never by the
 * application: `MAX(sequence) + 1` computed in a use case is a lost-update bug the
 * moment two members comment at once, and the requirement is explicit that
 * concurrent inserts must all survive with a deterministic order. Unique per
 * expense (the migration's `uq_expense_comments_order`), so no two rows can ever
 * share a position.
 *
 * ## Immutable content, tombstoned deletion
 *
 * Body, author, expense and society never change after insert (D1). A deletion is
 * a **soft delete**: `deleted_at`/`deleted_by` are stamped, the row keeps its
 * position in the stream, and the body is no longer returned to clients. There is
 * no application or API path that issues SQL `DELETE` (D8) — the tombstone is the
 * only removal this product has.
 */

/** A comment body's bound. The PRD sets none; the column is `text`, and the cap is this module's. */
export const EXPENSE_COMMENT_BODY_MAX_LENGTH = 2000;

/** A stored comment on an expense. */
export interface ExpenseCommentRecord {
  readonly id: ExpenseCommentId;
  readonly expenseId: ExpenseId;
  readonly societyId: SocietyId;
  readonly authorId: MemberId;
  /** The stored body, even when deleted — the mapper decides what a client sees. */
  readonly body: string;
  /**
   * The database-assigned position within the expense's stream. A `number` on the
   * domain side (it is an ordinal, not money); the column is `bigint` and the
   * value is read as an integer, and no expense will ever carry 2^53 comments.
   */
  readonly sequence: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly deletedBy: MemberId | null;
}

/** The one fact a write supplies: whose expense, who is speaking, and what they said. */
export interface ExpenseCommentDraft {
  readonly expenseId: ExpenseId;
  readonly societyId: SocietyId;
  readonly authorId: MemberId;
  readonly body: string;
}

/** True once a comment has been tombstoned, whatever its body still says. */
export function isCommentDeleted(comment: ExpenseCommentRecord): boolean {
  return comment.deletedAt !== null;
}

/** True when the caller wrote the comment — the author half of the delete rule (D2). */
export function isCommentAuthor(
  comment: ExpenseCommentRecord,
  membershipId: MemberId,
): boolean {
  return comment.authorId === membershipId;
}

/**
 * The comment stream's reads and writes — one per-tenant port.
 *
 * Three operations and no hard delete. `listForExpense` is the only read the
 * product needs (a comment is never fetched alone), and the two writes are the
 * append and the tombstone — the pair the PRD's "append-only with soft-delete"
 * names.
 */
export interface ExpenseCommentRepository {
  /** Every comment the caller may see, oldest first, tombstones included. */
  listForExpense(
    expenseId: ExpenseId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<readonly ExpenseCommentRecord[]>;

  /**
   * One comment of one expense, or `null` when the caller may not see it.
   *
   * Exists so the delete use case can make its author-or-Admin decision through
   * the permission evaluator before calling the write, rather than relying solely
   * on the database's own refusal (D2).
   */
  findById(
    commentId: ExpenseCommentId,
    expenseId: ExpenseId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<ExpenseCommentRecord | null>;

  /** Append one comment; the database assigns its `sequence`. */
  add(draft: ExpenseCommentDraft, actor: UserId): Promise<ExpenseCommentRecord>;

  /**
   * Tombstone one comment — author or Admin only, refused inside the database.
   *
   * The parent expense id travels with the comment id because the database's
   * `expense_comment_soft_delete()` scopes by both: a comment id from another
   * expense is not addressable, exactly as a cross-society id is not.
   */
  softDelete(
    commentId: ExpenseCommentId,
    expenseId: ExpenseId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<ExpenseCommentRecord>;
}
