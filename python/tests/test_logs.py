import io
import unittest
from unittest import mock

from seo_toolkit import cli, gsc, logs

GOOGLE = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
LOG = "\n".join([
    f'66.249.66.1 - - [10/Nov/2026:10:00:00 +0000] "GET / HTTP/1.1" 200 100 "-" "{GOOGLE}"',
    f'66.249.66.1 - - [10/Nov/2026:10:00:01 +0000] "GET /old HTTP/1.1" 404 10 "-" "{GOOGLE}"',
    f'66.249.66.1 - - [11/Nov/2026:10:00:02 +0000] "GET /shop?color=red&size=m HTTP/1.1" 200 10 "-" "{GOOGLE}"',
    f'1.2.3.4 - - [11/Nov/2026:10:00:03 +0000] "GET /promo HTTP/1.1" 301 0 "-" "{GOOGLE}"',
    '5.6.7.8 - - [11/Nov/2026:10:00:04 +0000] "GET /a HTTP/1.1" 200 5 "-" "Mozilla/5.0 (compatible; GPTBot/1.2)"',
    "not a log line",
])


class LogTests(unittest.TestCase):
    def test_parse_and_summary(self):
        r = logs.analyze(LOG.splitlines())
        self.assertEqual((r.lines_total, r.lines_parsed), (6, 5))
        self.assertEqual(r.google_hits, 4)
        self.assertEqual(r.bots["GPTBot"], 1)
        w = r.waste()
        self.assertEqual((w["redirects"], w["client_errors"], w["parameter_urls"]), (1, 1, 1))
        self.assertEqual(w["percent"], 75)
        self.assertEqual(set(r.parameters), {"color", "size"})
        self.assertEqual(r.to_dict()["google"]["by_day"], {"2026-11-10": 2, "2026-11-11": 2})

    def test_dns_verification_excludes_fake_googlebot(self):
        with mock.patch.object(logs, "is_verified_googlebot", side_effect=lambda ip: ip.startswith("66.249.")):
            r = logs.analyze(LOG.splitlines(), verify_dns=True)
        self.assertEqual(r.google_hits, 3)
        self.assertEqual(r.google_spoofed, 1)

    def test_verify_requires_google_hostname(self):
        logs.is_verified_googlebot.cache_clear()
        with mock.patch("socket.gethostbyaddr", return_value=("evil.example.com", [], [])):
            self.assertFalse(logs.is_verified_googlebot("66.249.66.9"))
        logs.is_verified_googlebot.cache_clear()
        with mock.patch("socket.gethostbyaddr", return_value=("crawl-66-249-66-10.googlebot.com", [], [])), \
             mock.patch("socket.getaddrinfo", return_value=[(0, 0, 0, "", ("66.249.66.10", 0))]):
            self.assertTrue(logs.is_verified_googlebot("66.249.66.10"))

    def test_uncrawled(self):
        r = logs.analyze(LOG.splitlines())
        self.assertEqual(logs.uncrawled(["https://s.example/", "https://s.example/never\n"], r), ["https://s.example/never"])

    def test_cli_json(self):
        import json, os, tempfile
        with tempfile.TemporaryDirectory() as d:
            src, out = os.path.join(d, "a.log"), os.path.join(d, "r.json")
            with open(src, "w") as fh:
                fh.write(LOG)
            with mock.patch("sys.stdout", new_callable=io.StringIO) as stdout:
                self.assertEqual(cli.main(["logs", src, "--json", out]), 0)
            self.assertIn("Crawl waste: 75%", stdout.getvalue())
            with open(out) as fh:
                self.assertEqual(json.load(fh)["google"]["hits"], 4)


class GscTests(unittest.TestCase):
    def test_opportunities_and_csv(self):
        rows = [
            {"query": "dental implants", "page": "/i", "clicks": 10, "impressions": 900, "position": 11.2},
            {"query": "=cmd", "page": "/w", "clicks": 2, "impressions": 400, "position": 2.1},
            {"query": "brand", "page": "/", "clicks": 100, "impressions": 300, "position": 1.0},
        ]
        found = gsc.opportunities(rows)
        self.assertEqual([f["type"] for f in found], ["striking_distance", "low_ctr"])
        buf = io.StringIO()
        gsc.write_csv(found, buf)
        self.assertIn("'=cmd", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
