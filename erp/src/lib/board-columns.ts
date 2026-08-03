// Client-safe (no src/server imports): the order board's column model — the fixed column list
// (design spec §11), the show/hide+reorder state a saved view's `config.columns` captures, the
// filter/sort shape the rest of `config` captures, and the "Default board" arrangement every user
// starts from before picking or saving a view. Kept out of src/app/page.tsx itself for the same
// reason step-drafts.ts sits beside ProcessStepsSection.tsx rather than inline in it: the pure
// shape-and-defaults logic is independently readable (and, unlike the page component, importable
// by a future test) separately from the rendering that consumes it.
//
// `SavedView.config` is opaque Json the SERVER never validates (saved-views.ts: "config is opaque
// Json to the server — the client owns its shape") — so anything read back out of it here is
// defensively normalized, never trusted blindly. That matters twice over: a hand-edited or
// partially-written row, and simply this app's own future — a column added after a view was saved
// must not silently vanish from that view forever.
import { ORDER_STATUSES, type OrderStatusValue } from "./order-constants";

export type ColumnKey =
  | "orderNumber" | "customer" | "leadPart" | "po" | "qty" | "weight"
  | "received" | "request" | "target" | "lightStatus" | "loads" | "linked" | "vsNumber";

export type ColumnDef = {
  key: ColumnKey;
  label: string;
  /** The board API's `sort` key this column maps to (orders.ts's `SORTABLE` map), or omitted when
   *  the column has no server-sortable equivalent: qty/weight/loads/linked are derived sums/counts
   *  with no column of their own to order by, and "light" is computed too — only the `status`
   *  half of the combined "light + status" column is a real, sortable column. */
  sortKey?: string;
};

/** Spec §11's column order. Also this array's own order IS the built-in "Default board"
 *  arrangement — the one every new user starts from, and what the "Default board" dropdown entry
 *  (a synthetic choice, not a real `SavedView` row) always applies. */
export const BOARD_COLUMNS: ColumnDef[] = [
  { key: "orderNumber", label: "Order #", sortKey: "orderNumber" },
  { key: "customer", label: "Customer", sortKey: "customerCode" },
  { key: "leadPart", label: "Lead part" },
  { key: "po", label: "PO", sortKey: "poNumber" },
  { key: "qty", label: "Qty" },
  { key: "weight", label: "Weight" },
  { key: "received", label: "Received", sortKey: "receivedDate" },
  { key: "request", label: "Request", sortKey: "requestDate" },
  { key: "target", label: "Target", sortKey: "targetDate" },
  { key: "lightStatus", label: "Status", sortKey: "status" },
  { key: "loads", label: "Loads" },
  { key: "linked", label: "Linked" },
  { key: "vsNumber", label: "VS #", sortKey: "vsOrderNumber" },
];

const COLUMN_KEYS = new Set<string>(BOARD_COLUMNS.map((c) => c.key));

export type ColumnState = { key: ColumnKey; visible: boolean };

/** Every column, visible, in spec order — "Default board". */
export function defaultColumnState(): ColumnState[] {
  return BOARD_COLUMNS.map((c) => ({ key: c.key, visible: true }));
}

/**
 * Recovers a valid, complete column arrangement from whatever a saved view's `config.columns`
 * actually holds. Unrecognized entries (a stale key from a column since removed, or simply
 * malformed data) are dropped silently — there is nothing safe to render for them. A column this
 * build knows about but the saved value never mentions (the view was saved before that column
 * existed) is appended, visible, at the end, so shipping a new column can never permanently hide
 * it from a view saved under an older build.
 */
export function normalizeColumnState(input: unknown): ColumnState[] {
  const seen = new Set<string>();
  const fromInput: ColumnState[] = Array.isArray(input)
    ? input.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const key = (entry as { key?: unknown }).key;
      const visible = (entry as { visible?: unknown }).visible;
      if (typeof key !== "string" || !COLUMN_KEYS.has(key) || seen.has(key)) return [];
      seen.add(key);
      return [{ key: key as ColumnKey, visible: visible !== false }];
    })
    : [];
  const missing = BOARD_COLUMNS.filter((c) => !seen.has(c.key)).map((c) => ({ key: c.key, visible: true }));
  return [...fromInput, ...missing];
}

/** The filter half of `config` — everything `GET /api/orders`'s query string can express
 *  (src/app/api/orders/query.ts's `parseOrderFilter`), kept as the strings/booleans the form
 *  controls themselves hold rather than the parsed `OrderFilter` shape the server builds from
 *  them — there is no client-safe import of that type (it lives in src/server/orders.ts). */
export type BoardFilters = {
  search: string;
  status: OrderStatusValue[];
  customerId: string;
  receivedFrom: string;
  receivedTo: string;
  requestFrom: string;
  requestTo: string;
  includeVoided: boolean;
};

export function defaultFilters(): BoardFilters {
  return {
    search: "", status: [], customerId: "",
    receivedFrom: "", receivedTo: "", requestFrom: "", requestTo: "",
    includeVoided: false,
  };
}

const STATUS_SET = new Set<string>(ORDER_STATUSES);

function normalizeFilters(input: unknown): BoardFilters {
  const d = defaultFilters();
  if (!input || typeof input !== "object") return d;
  const f = input as Record<string, unknown>;
  const status = Array.isArray(f.status)
    ? f.status.filter((s): s is OrderStatusValue => typeof s === "string" && STATUS_SET.has(s))
    : d.status;
  return {
    search: typeof f.search === "string" ? f.search : d.search,
    status,
    customerId: typeof f.customerId === "string" ? f.customerId : d.customerId,
    receivedFrom: typeof f.receivedFrom === "string" ? f.receivedFrom : d.receivedFrom,
    receivedTo: typeof f.receivedTo === "string" ? f.receivedTo : d.receivedTo,
    requestFrom: typeof f.requestFrom === "string" ? f.requestFrom : d.requestFrom,
    requestTo: typeof f.requestTo === "string" ? f.requestTo : d.requestTo,
    includeVoided: typeof f.includeVoided === "boolean" ? f.includeVoided : d.includeVoided,
  };
}

export type SortState = { sort: string; dir: "asc" | "desc" };

/** `orderNumber` desc — the same fallback `orders.ts`'s `orderByFor` applies when the `sort`/`dir`
 *  query params are absent entirely, made explicit here so the board's own sort-arrow UI has
 *  something to point at for "Default board" rather than showing no active sort at all. */
export function defaultSort(): SortState {
  return { sort: "orderNumber", dir: "desc" };
}

export type ViewConfig = { columns: ColumnState[]; filters: BoardFilters; sort: string; dir: "asc" | "desc" };

export function defaultViewConfig(): ViewConfig {
  return { columns: defaultColumnState(), filters: defaultFilters(), ...defaultSort() };
}

/** The inverse of building a saved view's `config` — see `normalizeColumnState`/`normalizeFilters`
 *  for why nothing here trusts the stored value at face value. */
export function normalizeViewConfig(input: unknown): ViewConfig {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const fallback = defaultSort();
  return {
    columns: normalizeColumnState(obj.columns),
    filters: normalizeFilters(obj.filters),
    sort: typeof obj.sort === "string" ? obj.sort : fallback.sort,
    dir: obj.dir === "asc" ? "asc" : "desc",
  };
}

/**
 * Builds the query string `GET /api/orders` and `GET /api/orders/export` both expect
 * (src/app/api/orders/query.ts's `parseOrderFilter`) from the board's own filter/sort state. Every
 * key an empty/default value would omit is left out entirely rather than sent blank — `orUndefined`
 * on the route's side already treats a blank string as "not set", but omitting it here keeps the
 * URL (and the Export link built from it) readable instead of trailing empty `&foo=`.
 */
export function buildOrderQuery(filters: BoardFilters, sort: SortState): string {
  const params = new URLSearchParams();
  const search = filters.search.trim();
  if (search) params.set("search", search);
  if (filters.status.length) params.set("status", filters.status.join(","));
  if (filters.customerId) params.set("customerId", filters.customerId);
  if (filters.receivedFrom) params.set("receivedFrom", filters.receivedFrom);
  if (filters.receivedTo) params.set("receivedTo", filters.receivedTo);
  if (filters.requestFrom) params.set("requestFrom", filters.requestFrom);
  if (filters.requestTo) params.set("requestTo", filters.requestTo);
  if (filters.includeVoided) params.set("includeVoided", "1");
  if (sort.sort) params.set("sort", sort.sort);
  if (sort.dir) params.set("dir", sort.dir);
  return params.toString();
}
