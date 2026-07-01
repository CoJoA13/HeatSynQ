import { ListCard, MonoId, StatusPill } from "@/components/patterns";
import { standardCategoryMeta } from "@/lib/domain/enums";
import { isReviewDue } from "@/lib/logic/standards";
import { formatDate } from "@/lib/utils";
import type { Standard } from "@/lib/domain";

export function StandardsList({ standards, asOf }: { standards: Standard[]; asOf: string }) {
  return (
    <ListCard
      headers={["STANDARD", "TITLE", "CATEGORY", "REVIEWED", "NEXT REVIEW"]}
      rows={standards.map((s) => {
        const cat = standardCategoryMeta[s.category];
        return [
          <MonoId key="code">{s.code}</MonoId>,
          s.title,
          <StatusPill key="cat" tone={cat.tone}>{cat.label}</StatusPill>,
          <span key="rev" className="font-mono">{formatDate(s.reviewedAt)}</span>,
          <span key="next" className="flex items-center gap-2 font-mono">
            {formatDate(s.nextReviewAt)}
            {isReviewDue(s, asOf) && <StatusPill tone="danger">Overdue</StatusPill>}
          </span>,
        ];
      })}
    />
  );
}
