import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CertDefaults } from "./cert-defaults";
import type { Customer, Specification } from "@/lib/domain";

const base = { createdAt: "", updatedAt: "", version: 0 };
const SPECS = [
  { ...base, id: "spec-ams2759-3", code: "AMS 2759/3", title: "Carburize & harden", rev: "K", owner: "SAE" },
] as unknown as Specification[];
const CUSTOMERS = [
  { ...base, id: "cust-apex", name: "Apex Aerospace", defaultCertSpecId: "spec-ams2759-3", defaultCertCopies: 2 },
  { ...base, id: "cust-vulcan", name: "Vulcan Forge", defaultCertSpecId: null, defaultCertCopies: 0 },
  { ...base, id: "cust-delta", name: "Delta Gear Works", defaultCertSpecId: null, defaultCertCopies: 1 },
] as unknown as Customer[];

describe("CertDefaults", () => {
  it("resolves spec codes, dashes null specs, shows raw copies", () => {
    render(<CertDefaults customers={CUSTOMERS} specifications={SPECS} />);
    expect(screen.getByTestId("cert-default-row-cust-apex")).toHaveTextContent("Apex Aerospace");
    expect(screen.getByText("AMS 2759/3")).toBeInTheDocument();
    const vulcanRow = screen.getByTestId("cert-default-row-cust-vulcan").closest("tr")!;
    expect(Array.from(vulcanRow.querySelectorAll("td")).map((td) => td.textContent)).toEqual(["Vulcan Forge", "—", "0"]);
    // raw seed truth: copies can be nonzero with a null spec
    const deltaRow = screen.getByTestId("cert-default-row-cust-delta").closest("tr")!;
    expect(Array.from(deltaRow.querySelectorAll("td")).map((td) => td.textContent)).toEqual(["Delta Gear Works", "—", "1"]);
  });

  it("shows the formats/inserts framing note", () => {
    render(<CertDefaults customers={CUSTOMERS} specifications={SPECS} />);
    expect(screen.getByText("Cert formats and form / message inserts aren't modeled yet — customer defaults only.")).toBeInTheDocument();
  });
});
