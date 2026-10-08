import type { ExpensePage, ExpenseSummary } from '../repository/expense.repository';

/**
 * A reproducible **1 000-expense** dataset for the T073 performance criterion
 * ("60 fps scrolling across 1 000 expenses").
 *
 * ## Deterministic, so two runs measure the same thing
 *
 * The generator uses a seeded PRNG (mulberry32) rather than `Math.random`, so the exact same
 * 1 000 rows are produced on every machine and every run. A performance number measured over a
 * different dataset is not comparable to the next one, and the acceptance criterion is a
 * statement about *this* scale.
 *
 * ## What the shape is chosen to exercise
 *
 * The rows span **24 months** (so month grouping produces 24 headers interspersed with 1 000
 * rows — the recycling pattern the list actually meets), use all four statuses, and vary the
 * amount across four magnitudes so the formatted figures differ in width. That is the mix a
 * `FlashList` has to recycle: short and long rows, repeated and varied headers.
 *
 * The fixture is data only — it never claims a frame rate. Whether 60 fps is met is measured on
 * a device (see `README.md` in this feature); this module exists so that measurement is
 * reproducible and so the grouping/scale logic can be unit-tested without a device.
 */

/** The same generator used by `makePerfExpenses`, so a page stream and a flat list agree. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STATUSES = ['draft', 'pending_approval', 'published', 'void'] as const;

/**
 * `count` deterministic expense rows, newest first.
 *
 * The `expenseDate` walks back one day per row from `2026-09-30`, which lands the set across 24
 * months; ids are `perf-0000…` so a duplicate is impossible and a stable key is trivial.
 */
export function makePerfExpenses(count = 1_000, seed = 20_260_930): ExpenseSummary[] {
  const random = mulberry32(seed);
  const start = Date.UTC(2026, 8, 30);
  const dayMs = 24 * 60 * 60 * 1000;
  const rows: ExpenseSummary[] = [];

  for (let index = 0; index < count; index += 1) {
    const date = new Date(start - index * dayMs);
    const iso = date.toISOString().slice(0, 10);
    const magnitude = Math.floor(random() * 4);
    const amountPaise = (100_000 + Math.floor(random() * 900_000)) * (magnitude + 1);
    const status = STATUSES[Math.floor(random() * STATUSES.length)] ?? 'published';

    rows.push({
      id: `perf-${String(index).padStart(4, '0')}`,
      societyId: 'perf-society',
      categoryId: `cat-${String(index % 6)}`,
      title: `Performance expense ${String(index)}`,
      description: null,
      amountPaise,
      expenseDate: iso,
      vendorName: index % 5 === 0 ? `Vendor ${String(index)}` : null,
      status,
      version: index % 7 === 0 ? 2 : 1,
      publishedAt: status === 'published' ? `${iso}T10:00:00.000Z` : null,
      voidedAt: status === 'void' ? `${iso}T12:00:00.000Z` : null,
      voidReason: status === 'void' ? 'Reversed' : null,
      createdAt: `${iso}T09:00:00.000Z`,
      updatedAt: `${iso}T10:00:00.000Z`,
    });
  }

  return rows;
}

/**
 * Split the same dataset into cursor pages of `pageSize`, so a test drives the screen's real
 * infinite-scroll path (page 1, page 2, …) rather than a single pre-built array.
 */
export function makePerfPages(count = 1_000, pageSize = 25, seed = 20_260_930): ExpensePage[] {
  const rows = makePerfExpenses(count, seed);
  const pages: ExpensePage[] = [];
  for (let offset = 0; offset < rows.length; offset += pageSize) {
    const slice = rows.slice(offset, offset + pageSize);
    const hasMore = offset + pageSize < rows.length;
    pages.push({
      expenses: slice,
      nextCursor: hasMore ? `perf-cursor-${String(offset + pageSize)}` : null,
      hasMore,
    });
  }
  return pages;
}
