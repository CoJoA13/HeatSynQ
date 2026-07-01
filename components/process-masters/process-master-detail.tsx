import { DetailHeader, StatusPill, MonoId, ListCard, SummaryRail, EmptyState } from "@/components/patterns";
import type { ProcessMaster, Part } from "@/lib/domain";

const TRACK_LABEL: Record<string, string> = {
  track_in: "Track in", track_in_out: "Track in-out", track_out: "Track out", inspect: "Inspect", none: "—",
};

export function ProcessMasterDetail({
  processMaster: pm,
  usedByParts,
}: {
  processMaster: ProcessMaster;
  usedByParts: Part[];
}) {
  return (
    <div>
      <DetailHeader
        backHref="/process-masters"
        backLabel="Process Master"
        title={<span className="flex items-center gap-2"><MonoId>{pm.code}</MonoId><span>{pm.name}</span></span>}
        subtitle={pm.description}
        statusPill={<StatusPill tone="success">Active · rev {pm.rev}</StatusPill>}
      />
      <div className="grid grid-cols-[1fr_260px] gap-6">
        <div className="space-y-6">
          <div>
            <div className="mb-2 font-semibold">Steps</div>
            <ListCard
              headers={["#", "OPERATION", "WORK CENTER", "PARAMETERS", "TRACK"]}
              rows={pm.steps.map((s) => [
                <span key="n" className="font-mono">{s.n}</span>,
                s.op,
                s.equip,
                s.params.length ? s.params.join(" · ") : "—",
                <span key="track" className="text-text-muted text-xs">{TRACK_LABEL[s.track] ?? "—"}</span>,
              ])}
            />
          </div>
          <div>
            <div className="mb-2 font-semibold">Used by</div>
            {usedByParts.length === 0 ? (
              <EmptyState title="No parts use this recipe" />
            ) : (
              <ListCard
                headers={["PART", "DESCRIPTION"]}
                rows={usedByParts.map((p) => [<MonoId key="p">{p.partNumber}</MonoId>, p.description])}
              />
            )}
          </div>
        </div>
        <SummaryRail title="Inspection">
          <dl className="space-y-2 text-[13px]">
            <div className="flex justify-between"><dt className="text-text-muted">Surface hardness</dt><dd className="font-mono">{pm.surfaceHardness}</dd></div>
            <div className="flex justify-between"><dt className="text-text-muted">Case depth</dt><dd className="font-mono">{pm.caseDepth}</dd></div>
            <div className="flex justify-between"><dt className="text-text-muted">Scale</dt><dd>{pm.hardnessScale}</dd></div>
          </dl>
        </SummaryRail>
      </div>
    </div>
  );
}
