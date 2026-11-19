"""Streaming access-log analysis for crawl budget (same rules as lib/audit/logs.ts).

Handles multi-GB Apache/Nginx "combined" logs (plain or .gz) in constant memory apart from
capped per-URL counters, and can verify that "Googlebot" requests really come from Google
using the reverse-then-forward DNS check Google documents.
"""
from __future__ import annotations

import gzip
import ipaddress
import re
import socket
from collections import Counter
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Dict, Iterable, Iterator, List, Optional, Set, TextIO

LINE = re.compile(r'^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+)(?: [^"]*)?" (\d{3}) (\S+)(?: "([^"]*)" "([^"]*)")?')
MONTHS = {m: f"{i:02d}" for i, m in enumerate(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}
ASSET = re.compile(r"\.(css|js|mjs|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|map|mp4|webm|pdf|zip)$", re.I)
MAX_URLS = 200_000

BOTS = [
    ("Googlebot Smartphone", re.compile(r"Googlebot/[\d.]+.*Mobile|Mobile.*Googlebot/", re.I), "search"),
    ("Googlebot Desktop", re.compile(r"Googlebot/", re.I), "search"),
    ("Googlebot Image", re.compile(r"Googlebot-Image", re.I), "search"),
    ("Bingbot", re.compile(r"bingbot", re.I), "search"),
    ("YandexBot", re.compile(r"YandexBot", re.I), "search"),
    ("Applebot", re.compile(r"Applebot/", re.I), "search"),
    ("GPTBot", re.compile(r"GPTBot", re.I), "ai"),
    ("OAI-SearchBot", re.compile(r"OAI-SearchBot", re.I), "ai"),
    ("ChatGPT-User", re.compile(r"ChatGPT-User", re.I), "ai"),
    ("ClaudeBot", re.compile(r"ClaudeBot", re.I), "ai"),
    ("Claude-SearchBot", re.compile(r"Claude-SearchBot", re.I), "ai"),
    ("Claude-User", re.compile(r"Claude-User", re.I), "ai"),
    ("PerplexityBot", re.compile(r"PerplexityBot|Perplexity-User", re.I), "ai"),
    ("CCBot", re.compile(r"CCBot", re.I), "ai"),
    ("AhrefsBot", re.compile(r"AhrefsBot", re.I), "other"),
    ("SemrushBot", re.compile(r"SemrushBot", re.I), "other"),
]


@dataclass
class Hit:
    ip: str
    date: str
    method: str
    path: str
    status: int
    bytes: int
    ua: str


def parse_line(line: str) -> Optional[Hit]:
    m = LINE.match(line)
    if not m:
        return None
    ip, ts, method, path, status, size, _ref, ua = m.groups()
    d = re.match(r"(\d{2})/(\w{3})/(\d{4})", ts)
    date = f"{d.group(3)}-{MONTHS.get(d.group(2), '01')}-{d.group(1)}" if d else ""
    return Hit(ip, date, method, path, int(status), 0 if size == "-" else int(size), ua or "")


def bot_of(ua: str):
    for name, pattern, group in BOTS:
        if pattern.search(ua):
            return name, group
    return None


@lru_cache(maxsize=50_000)
def is_verified_googlebot(ip: str) -> bool:
    """Reverse DNS must end in googlebot.com/google.com/googleusercontent.com and resolve back to the IP."""
    try:
        ipaddress.ip_address(ip)
        host = socket.gethostbyaddr(ip)[0].lower()
        if not host.endswith((".googlebot.com", ".google.com", ".googleusercontent.com")):
            return False
        return ip in {info[4][0] for info in socket.getaddrinfo(host, None)}
    except (OSError, ValueError):
        return False


@dataclass
class Report:
    lines_total: int = 0
    lines_parsed: int = 0
    bots: Counter = field(default_factory=Counter)
    google_hits: int = 0
    google_spoofed: int = 0
    status: Counter = field(default_factory=Counter)
    sections: Counter = field(default_factory=Counter)
    days: Counter = field(default_factory=Counter)
    parameters: Counter = field(default_factory=Counter)
    parameter_hits: int = 0
    asset_hits: int = 0
    urls: Counter = field(default_factory=Counter)
    url_status: Dict[str, int] = field(default_factory=dict)

    def waste(self) -> Dict[str, int]:
        def between(lo: int, hi: int) -> int:
            return sum(n for s, n in self.status.items() if lo <= int(s) < hi)

        w = {"redirects": between(300, 400), "client_errors": between(400, 500), "server_errors": between(500, 600), "parameter_urls": self.parameter_hits}
        w["total"] = sum(w.values())
        w["percent"] = min(100, round(100 * w["total"] / self.google_hits)) if self.google_hits else 0
        return w

    def to_dict(self) -> dict:
        return {
            "lines_total": self.lines_total,
            "lines_parsed": self.lines_parsed,
            "bots": dict(self.bots.most_common()),
            "google": {
                "hits": self.google_hits,
                "spoofed_excluded": self.google_spoofed,
                "unique_urls": len(self.urls),
                "by_status": dict(self.status),
                "by_section": dict(self.sections.most_common(25)),
                "by_day": dict(sorted(self.days.items())),
                "top_parameters": dict(self.parameters.most_common(15)),
                "asset_hits": self.asset_hits,
                "waste": self.waste(),
                "top_urls": [{"url": u, "hits": n, "status": self.url_status.get(u)} for u, n in self.urls.most_common(25)],
                "error_urls": [{"url": u, "hits": n, "status": self.url_status[u]} for u, n in self.urls.most_common() if self.url_status.get(u, 200) >= 400][:25],
            },
        }


def analyze(lines: Iterable[str], verify_dns: bool = False) -> Report:
    r = Report()
    for line in lines:
        if not line.strip():
            continue
        r.lines_total += 1
        hit = parse_line(line)
        if not hit:
            continue
        r.lines_parsed += 1
        bot = bot_of(hit.ua)
        if not bot:
            continue
        name, _group = bot
        if name.startswith("Googlebot") and verify_dns and not is_verified_googlebot(hit.ip):
            r.google_spoofed += 1
            r.bots["Fake Googlebot"] += 1
            continue
        r.bots[name] += 1
        if not name.startswith("Googlebot"):
            continue
        r.google_hits += 1
        r.status[str(hit.status)] += 1
        if hit.date:
            r.days[hit.date] += 1
        path, _, query = hit.path.partition("?")
        r.sections["/" + (path.split("/")[1] if "/" in path else "")] += 1
        if query:
            r.parameter_hits += 1
            for pair in query.split("&"):
                r.parameters[pair.split("=")[0] or "(empty)"] += 1
        if ASSET.search(path):
            r.asset_hits += 1
        if hit.path in r.urls or len(r.urls) < MAX_URLS:
            r.urls[hit.path] += 1
            r.url_status[hit.path] = hit.status
    return r


def open_lines(path: str) -> Iterator[str]:
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8", errors="replace") as fh:  # type: ignore[operator]
        yield from fh


def uncrawled(urls: Iterable[str], report: Report) -> List[str]:
    """URLs (e.g. from a sitemap) that Googlebot never requested in the log window."""
    from urllib.parse import urlsplit

    seen: Set[str] = set(report.urls)
    out = []
    for u in urls:
        p = urlsplit(u.strip())
        path = p.path + ("?" + p.query if p.query else "")
        if u.strip() and path not in seen and p.path not in seen:
            out.append(u.strip())
    return out
