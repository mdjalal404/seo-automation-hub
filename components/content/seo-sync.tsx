import type { SeoSyncState } from "@/lib/cms/types";

const FIELDS = [
  ["meta_title", "Meta title"],
  ["meta_description", "Meta description"],
  ["canonical_url", "Canonical URL"],
] as const;

function Cell({ v }: { v: boolean | null | undefined }) {
  if (v === true) return <span className="text-emerald-700">Yes</span>;
  if (v === false) return <span className="text-red-700">No</span>;
  return <span className="text-muted-foreground">—</span>;
}

/** Distinguishes stored here / sent to WordPress / confirmed by its API / verified on the live page. */
export function SeoSyncTable({ sync, values }: { sync: SeoSyncState; values: Record<string, string> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid="seo-sync">
        <thead className="text-left text-xs text-muted-foreground">
          <tr><th className="py-1 font-medium">Field</th><th className="px-1 font-medium" title="Stored in this app">Stored</th><th className="px-1 font-medium" title="Sent to WordPress">Sent</th><th className="px-1 font-medium" title="Confirmed by the WordPress API">Confirmed</th><th className="px-1 font-medium" title="Verified on the rendered live page">Live</th></tr>
        </thead>
        <tbody>
          {FIELDS.map(([key, label]) => {
            const s = sync[key];
            return (
              <tr key={key} className="border-t align-top">
                <td className="py-1.5">{label}{s?.note ? <p className="text-xs text-amber-700">{s.note}</p> : null}</td>
                <td className="px-1"><Cell v={values[key] ? true : null} /></td>
                <td className="px-1"><Cell v={s ? s.sent : null} /></td>
                <td className="px-1"><Cell v={s ? s.confirmed : null} /></td>
                <td className="px-1"><Cell v={s?.verified} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
