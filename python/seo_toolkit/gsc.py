"""Search Console opportunities straight from the hub's Postgres (search_performance_daily).

Same rules as lib/analytics/insights.ts for striking distance and low CTR, exported as CSV
for spreadsheets/BI. Needs `pip install seo-toolkit[db]` and DATABASE_URL (a read-only role
is enough; RLS still applies when connecting as an app user).
"""
from __future__ import annotations

import csv
import os
from typing import Dict, List, TextIO

EXPECTED_CTR = [0, 0.28, 0.15, 0.11, 0.08, 0.07, 0.05, 0.04, 0.03, 0.025, 0.02]

QUERY = """
select query, page, sum(clicks) as clicks, sum(impressions) as impressions,
       sum(position * impressions) / nullif(sum(impressions), 0) as position
  from public.search_performance_daily
 where website_id = %(website)s and date >= current_date - %(days)s
 group by query, page
"""


def opportunities(rows: List[Dict], min_impressions: int = 50) -> List[Dict]:
    out = []
    for r in rows:
        imp, clicks, pos = int(r["impressions"]), int(r["clicks"]), float(r["position"] or 0)
        if imp >= min_impressions and 8 <= pos <= 20:
            out.append({**r, "type": "striking_distance", "position": round(pos, 1)})
        rounded = round(pos)
        if imp >= min_impressions * 2 and 1 <= rounded <= 5 and clicks / imp < EXPECTED_CTR[rounded] * 0.5:
            out.append({**r, "type": "low_ctr", "position": round(pos, 1), "ctr": round(100 * clicks / imp, 1), "expected_ctr": round(100 * EXPECTED_CTR[rounded], 1)})
    return sorted(out, key=lambda x: -int(x["impressions"]))


def fetch(website_id: str, days: int = 28) -> List[Dict]:
    import psycopg  # optional dependency
    from psycopg.rows import dict_row

    with psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as conn:
        return list(conn.execute(QUERY, {"website": website_id, "days": days}))


def write_csv(rows: List[Dict], out: TextIO) -> None:
    fields = ["type", "query", "page", "clicks", "impressions", "position", "ctr", "expected_ctr"]
    w = csv.DictWriter(out, fieldnames=fields, extrasaction="ignore")
    w.writeheader()
    for r in rows:
        # Neutralise spreadsheet formulas in user-controlled text (CSV injection).
        w.writerow({k: ("'" + v if isinstance(v, str) and v[:1] in "=+-@" else v) for k, v in r.items()})
