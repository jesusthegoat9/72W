/** Videos per page on Explore and category pages: six rows of the four-column grid. */
export const PAGE_SIZE = 24;
const MAX_PAGE = 10_000;

/** `?page=` as a positive integer, else 1. Never throws on odd input. */
export function parsePage(v: string | undefined): number {
  if (!v || !/^\d{1,5}$/.test(v)) return 1;
  const n = Number(v);
  return n >= 1 && n <= MAX_PAGE ? n : 1;
}

export interface Page {
  /** Requested page clamped to the available range (1 when there is nothing). */
  page: number;
  pages: number;
  offset: number;
  /** 1-based range shown on this page; `from` is 0 when total is 0. */
  from: number;
  to: number;
  total: number;
  size: number;
}

/** Clamps a requested page to what `total` allows and derives the offset and visible range. */
export function paginate(total: number, requested: number, size = PAGE_SIZE): Page {
  const safeTotal = Math.max(0, Math.floor(total));
  const pages = Math.max(1, Math.ceil(safeTotal / size));
  const page = Math.min(Math.max(1, Math.floor(requested) || 1), pages);
  const offset = (page - 1) * size;
  return {
    page,
    pages,
    offset,
    from: safeTotal === 0 ? 0 : offset + 1,
    to: Math.min(offset + size, safeTotal),
    total: safeTotal,
    size,
  };
}
