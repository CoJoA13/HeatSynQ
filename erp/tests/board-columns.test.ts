import { describe, expect, it } from "vitest";
import {
  BOARD_COLUMNS, defaultViewConfig, normalizeViewConfig, buildOrderQuery,
  type BoardFilters, type SortState, type ViewConfig,
} from "@/lib/board-columns";

// Pure module, no DB (the business-days.test.ts pattern): the board's column model, the saved-view
// `config` normalizers, and the `GET /api/orders` query-string builder. `SavedView.config` is
// opaque Json the server never validates, so `normalizeViewConfig` is the ONLY defense between a
// hand-edited/stale row and the board's rendering + its outgoing query — the cases below pin the
// leaf's real contracts: recover-don't-trust, new-columns-never-vanish, and stale-sort-falls-back
// (an unrecognized `sort` sent to the API is a 400, so falling back here is what keeps an old
// saved view usable at all).

const filtersWith = (patch: Partial<BoardFilters>): BoardFilters => ({
  ...defaultViewConfig().filters, ...patch,
});
const SORT_DEFAULT: SortState = { sort: "orderNumber", dir: "desc" };

describe("defaultViewConfig", () => {
  it("shows every column, visible, in BOARD_COLUMNS (spec §11) order", () => {
    const { columns } = defaultViewConfig();
    expect(columns).toEqual(BOARD_COLUMNS.map((c) => ({ key: c.key, visible: true })));
  });

  it("starts with empty filters and the orderNumber-desc sort orderByFor defaults to", () => {
    const config = defaultViewConfig();
    expect(config.filters).toEqual({
      search: "", status: [], customerId: "",
      receivedFrom: "", receivedTo: "", requestFrom: "", requestTo: "",
      includeVoided: false,
    });
    expect(config.sort).toBe("orderNumber");
    expect(config.dir).toBe("desc");
  });

  it("returns fresh objects per call — the page's lazy useState initializers mutate nothing shared", () => {
    const a = defaultViewConfig();
    const b = defaultViewConfig();
    a.columns[0].visible = false;
    a.filters.status.push("OPEN");
    expect(b.columns[0].visible).toBe(true);
    expect(b.filters.status).toEqual([]);
  });
});

describe("normalizeViewConfig", () => {
  it("recovers the full default from a non-object config (null, undefined, a bare string)", () => {
    for (const input of [null, undefined, "not-a-config", 42]) {
      expect(normalizeViewConfig(input)).toEqual(defaultViewConfig());
    }
  });

  it("keeps a saved column arrangement's order and visibility", () => {
    const saved = [
      { key: "customer", visible: true },
      { key: "orderNumber", visible: false },
    ];
    const { columns } = normalizeViewConfig({ columns: saved });
    expect(columns[0]).toEqual({ key: "customer", visible: true });
    expect(columns[1]).toEqual({ key: "orderNumber", visible: false });
  });

  it("appends a column the saved value never mentions, visible, at the end — a new column can never vanish from an old view", () => {
    const saved = BOARD_COLUMNS.filter((c) => c.key !== "vsNumber").map((c) => ({ key: c.key, visible: false }));
    const { columns } = normalizeViewConfig({ columns: saved });
    expect(columns).toHaveLength(BOARD_COLUMNS.length);
    expect(columns[columns.length - 1]).toEqual({ key: "vsNumber", visible: true });
  });

  it("drops unrecognized and duplicate column entries (first occurrence wins), and malformed ones", () => {
    const { columns } = normalizeViewConfig({
      columns: [
        { key: "customer", visible: false },
        { key: "sinceRemovedColumn", visible: true },
        { key: "customer", visible: true },
        null,
        "customer",
        { visible: true },
      ],
    });
    expect(columns.filter((c) => c.key === "customer")).toEqual([{ key: "customer", visible: false }]);
    expect(columns).toHaveLength(BOARD_COLUMNS.length);
    expect(columns.map((c) => c.key)).not.toContain("sinceRemovedColumn");
  });

  it("treats a missing or non-boolean `visible` as visible — only an explicit false hides", () => {
    const { columns } = normalizeViewConfig({
      columns: [{ key: "customer" }, { key: "po", visible: 0 }, { key: "qty", visible: false }],
    });
    expect(columns.find((c) => c.key === "customer")?.visible).toBe(true);
    expect(columns.find((c) => c.key === "po")?.visible).toBe(true);
    expect(columns.find((c) => c.key === "qty")?.visible).toBe(false);
  });

  it("passes well-formed filters through and falls back PER FIELD on wrong types", () => {
    const { filters } = normalizeViewConfig({
      filters: {
        search: "acme", status: ["OPEN", "SHIPPED"], customerId: "c1",
        receivedFrom: "2026-08-01", receivedTo: 99, requestFrom: "2026-08-02",
        requestTo: "2026-08-03", includeVoided: "yes",
      },
    });
    expect(filters).toEqual(filtersWith({
      search: "acme", status: ["OPEN", "SHIPPED"], customerId: "c1",
      receivedFrom: "2026-08-01", receivedTo: "", requestFrom: "2026-08-02",
      requestTo: "2026-08-03", includeVoided: false,
    }));
  });

  it("filters unknown statuses out of a saved status list, and defaults a non-array to []", () => {
    expect(normalizeViewConfig({ filters: { status: ["OPEN", "VOIDED", 3] } }).filters.status).toEqual(["OPEN"]);
    expect(normalizeViewConfig({ filters: { status: "OPEN" } }).filters.status).toEqual([]);
  });

  it("keeps a sort key some column actually declares, and falls back on anything else", () => {
    expect(normalizeViewConfig({ sort: "customerCode" }).sort).toBe("customerCode");
    // A real column KEY that has no sortKey (qty is a derived sum) is still not a sort key.
    expect(normalizeViewConfig({ sort: "qty" }).sort).toBe("orderNumber");
    expect(normalizeViewConfig({ sort: "dropTable" }).sort).toBe("orderNumber");
    expect(normalizeViewConfig({ sort: 7 }).sort).toBe("orderNumber");
  });

  it('normalizes dir to "asc" only on the exact string, else "desc"', () => {
    expect(normalizeViewConfig({ dir: "asc" }).dir).toBe("asc");
    expect(normalizeViewConfig({ dir: "ASC" }).dir).toBe("desc");
    expect(normalizeViewConfig({}).dir).toBe("desc");
  });

  it("round-trips the exact config shape the page saves", () => {
    const config: ViewConfig = {
      columns: [{ key: "orderNumber", visible: true }, ...defaultViewConfig().columns.slice(1)],
      filters: filtersWith({ search: "po-1", status: ["REOPENED"], includeVoided: true }),
      sort: "requestDate", dir: "asc",
    };
    expect(normalizeViewConfig(JSON.parse(JSON.stringify(config)))).toEqual(config);
  });
});

describe("buildOrderQuery", () => {
  it("emits only sort/dir for the default board — every empty filter key is omitted, not sent blank", () => {
    expect(buildOrderQuery(defaultViewConfig().filters, SORT_DEFAULT)).toBe("sort=orderNumber&dir=desc");
  });

  it("trims search, and omits it entirely when whitespace-only", () => {
    expect(new URLSearchParams(buildOrderQuery(filtersWith({ search: "  1002  " }), SORT_DEFAULT)).get("search"))
      .toBe("1002");
    expect(buildOrderQuery(filtersWith({ search: "   " }), SORT_DEFAULT)).toBe("sort=orderNumber&dir=desc");
  });

  it("joins statuses with commas, the shape parseOrderFilter splits back", () => {
    const params = new URLSearchParams(buildOrderQuery(filtersWith({ status: ["OPEN", "SHIPPED"] }), SORT_DEFAULT));
    expect(params.get("status")).toBe("OPEN,SHIPPED");
  });

  it('sends includeVoided as "1" only when on', () => {
    expect(new URLSearchParams(buildOrderQuery(filtersWith({ includeVoided: true }), SORT_DEFAULT)).get("includeVoided"))
      .toBe("1");
    expect(buildOrderQuery(filtersWith({ includeVoided: false }), SORT_DEFAULT)).not.toContain("includeVoided");
  });

  it("carries every set filter and the sort pair on a representative view", () => {
    const query = buildOrderQuery(
      filtersWith({
        search: "acme", status: ["OPEN"], customerId: "c1",
        receivedFrom: "2026-08-01", receivedTo: "2026-08-05",
        requestFrom: "2026-08-10", requestTo: "2026-08-20",
      }),
      { sort: "requestDate", dir: "asc" },
    );
    const params = new URLSearchParams(query);
    expect(Object.fromEntries(params)).toEqual({
      search: "acme", status: "OPEN", customerId: "c1",
      receivedFrom: "2026-08-01", receivedTo: "2026-08-05",
      requestFrom: "2026-08-10", requestTo: "2026-08-20",
      sort: "requestDate", dir: "asc",
    });
  });
});
