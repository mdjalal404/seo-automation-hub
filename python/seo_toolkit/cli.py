"""seo-toolkit command line.

  python -m seo_toolkit logs access.log.gz [--verify-dns] [--sitemap-urls urls.txt] [--json out.json]
  python -m seo_toolkit opportunities --website <uuid> [--days 28] > opportunities.csv
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import List, Optional

from seo_toolkit import gsc, logs


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(prog="seo-toolkit", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    lp = sub.add_parser("logs", help="crawl-budget analysis of access logs")
    lp.add_argument("files", nargs="+")
    lp.add_argument("--verify-dns", action="store_true", help="exclude fake Googlebots (reverse + forward DNS)")
    lp.add_argument("--sitemap-urls", help="text file with one URL per line; reports URLs Googlebot never requested")
    lp.add_argument("--json", help="write the full report to this file")
    op = sub.add_parser("opportunities", help="striking-distance and low-CTR queries from the hub database (CSV)")
    op.add_argument("--website", required=True)
    op.add_argument("--days", type=int, default=28)
    args = p.parse_args(argv)

    if args.cmd == "logs":
        def lines():
            for f in args.files:
                yield from logs.open_lines(f)

        report = logs.analyze(lines(), verify_dns=args.verify_dns)
        data = report.to_dict()
        if args.sitemap_urls:
            with open(args.sitemap_urls, encoding="utf-8") as fh:
                missing = logs.uncrawled(fh, report)
            data["uncrawled"] = {"count": len(missing), "sample": missing[:100]}
        g = data["google"]
        print(f"Parsed {data['lines_parsed']:,} of {data['lines_total']:,} lines")
        print(f"Googlebot requests: {g['hits']:,} ({g['unique_urls']:,} URLs)" + (f", {g['spoofed_excluded']:,} fake excluded" if args.verify_dns else ""))
        print(f"Crawl waste: {g['waste']['percent']}% ({g['waste']['total']:,} requests to redirects, errors, parameter URLs)")
        for name, hits in list(data["bots"].items())[:10]:
            print(f"  {name:<22} {hits:>10,}")
        if "uncrawled" in data:
            print(f"Sitemap URLs never crawled: {data['uncrawled']['count']:,}")
        if args.json:
            with open(args.json, "w", encoding="utf-8") as fh:
                json.dump(data, fh, indent=2)
        return 0

    rows = gsc.opportunities(gsc.fetch(args.website, args.days))
    gsc.write_csv(rows, sys.stdout)
    return 0
