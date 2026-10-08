import {
  asExpenseCommentId,
  asExpenseId,
  asMemberId,
  asSocietyId,
} from "../../shared/ids";
import {
  EXPENSE_COMMENT_BODY_MAX_LENGTH,
  isCommentAuthor,
  isCommentDeleted,
  type ExpenseCommentRecord,
} from "../comment";

/**
 * The comment record's two pure facts — Roadmap T072, decisions D1/D2.
 *
 * They are tiny, and they live in the domain rather than in each use case exactly
 * because both the delete rule (author) and the response mapper (deleted) read
 * them: a helper duplicated in two places is one that can drift. Tested here so the
 * behaviour, not just the shape, is pinned.
 */

const COMMENT: ExpenseCommentRecord = {
  id: asExpenseCommentId("30000000-0000-4000-8000-000000000001"),
  expenseId: asExpenseId("20000000-0000-4000-8000-000000000001"),
  societyId: asSocietyId("b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12"),
  authorId: asMemberId("10000000-0000-4000-8000-000000000003"),
  body: "Why did this cost ₹40,000?",
  sequence: 1,
  createdAt: "2026-10-08T00:00:00.000Z",
  updatedAt: "2026-10-08T00:00:00.000Z",
  deletedAt: null,
  deletedBy: null,
};

describe("expense comment record", () => {
  it("has a bounded body", () => {
    expect(EXPENSE_COMMENT_BODY_MAX_LENGTH).toBe(2000);
  });

  it("is deleted exactly when it carries a tombstone", () => {
    expect(isCommentDeleted(COMMENT)).toBe(false);
    expect(
      isCommentDeleted({
        ...COMMENT,
        deletedAt: "2026-10-08T12:00:00.000Z",
        deletedBy: asMemberId("10000000-0000-4000-8000-000000000001"),
      }),
    ).toBe(true);
  });

  it("recognises its author by membership id, not by user", () => {
    expect(isCommentAuthor(COMMENT, COMMENT.authorId)).toBe(true);
    expect(
      isCommentAuthor(
        COMMENT,
        asMemberId("10000000-0000-4000-8000-0000000000ff"),
      ),
    ).toBe(false);
  });
});
