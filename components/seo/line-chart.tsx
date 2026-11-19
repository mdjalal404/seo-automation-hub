/** Dependency-free SVG line chart for daily series (server-rendered, accessible summary). */
export function LineChart({ points, series, height = 180 }: {
  points: { date: string; [k: string]: number | string }[];
  series: { key: string; label: string; color: string }[];
  height?: number;
}) {
  const width = 720;
  const pad = { l: 8, r: 8, t: 12, b: 22 };
  if (!points.length) return null;
  const x = (i: number) => pad.l + (i / Math.max(1, points.length - 1)) * (width - pad.l - pad.r);
  return (
    <figure className="w-full">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label={series.map((s) => s.label).join(" and ") + " per day"}>
        <line x1={pad.l} x2={width - pad.r} y1={height - pad.b} y2={height - pad.b} className="stroke-border" />
        {series.map((s) => {
          const max = Math.max(1, ...points.map((p) => Number(p[s.key]) || 0));
          const y = (v: number) => pad.t + (1 - v / max) * (height - pad.t - pad.b);
          const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(Number(p[s.key]) || 0).toFixed(1)}`).join(" ");
          return <path key={s.key} d={d} fill="none" stroke={s.color} strokeWidth={2} vectorEffect="non-scaling-stroke" />;
        })}
        {[0, Math.floor((points.length - 1) / 2), points.length - 1].map((i) => (
          <text key={i} x={x(i)} y={height - 6} textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"} className="fill-muted-foreground text-[11px]">{points[i].date.slice(5)}</text>
        ))}
      </svg>
      <figcaption className="mt-1 flex flex-wrap gap-4 text-xs text-muted-foreground">
        {series.map((s) => <span key={s.key} className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4" style={{ background: s.color }} />{s.label} (scaled independently)</span>)}
      </figcaption>
    </figure>
  );
}
