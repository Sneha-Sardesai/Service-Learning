from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from pypdf import PdfWriter

RESEARCH_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RESEARCH_DIR))

import crawler
from document_extractor import process_documents
from report_discovery import discover_reports
from information_extractor import extract_findings, extract_with_gemini
import research
from research import resolve_website, run_research


class FakeRaw:
    def __init__(self, body: bytes):
        self.body = body

    def read(self, size: int = -1, decode_content: bool = False) -> bytes:
        return self.body[:size]


class FakeResponse:
    def __init__(self, url: str, body: bytes = b"", status: int = 200, content_type: str = "text/html"):
        self.url = url
        self.body = body
        self.status_code = status
        self.headers = {"Content-Type": content_type, "Content-Length": str(len(body))}
        self.raw = FakeRaw(body)
        self.encoding = "utf-8"
        self.closed = False

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise crawler.requests.HTTPError(f"HTTP {self.status_code}")

    def iter_content(self, chunk_size: int):
        for position in range(0, len(self.body), chunk_size):
            yield self.body[position:position + chunk_size]

    def close(self) -> None:
        self.closed = True


class FakeSession:
    def __init__(self, pages: dict[str, FakeResponse]):
        self.pages = pages
        self.headers = {}
        self.requested = []

    def get(self, url: str, **_kwargs) -> FakeResponse:
        self.requested.append(url)
        return self.pages.get(url, FakeResponse(url, status=404, content_type="text/plain"))


class ResearchTests(unittest.TestCase):
    def test_json_output_escapes_non_ascii_for_windows_pipe_encoding(self):
        output = io.StringIO()
        with (
            patch.object(sys, "argv", ["research.py", "Example Company", "--website", "https://example.test", "--json"]),
            patch("research.resolve_website", return_value="https://example.test/"),
            patch("research.run_research", return_value={
                "status": "completed",
                "findings": [{"value": "₹ 1 crore"}],
            }),
            redirect_stdout(output),
        ):
            self.assertEqual(research.main(), 0)
        serialized = output.getvalue()
        self.assertIn(r"\u20b9", serialized)
        self.assertEqual(json.loads(serialized)["findings"][0]["value"], "₹ 1 crore")

    def test_url_normalization_and_ssrf_guards(self):
        self.assertEqual(
            crawler.normalize_url("HTTPS://Example.COM/report#page"),
            "https://example.com/report",
        )
        for url in (
            "file:///etc/passwd",
            "http://127.0.0.1",
            "http://10.0.0.2",
            "http://user:pass@example.com",
            "https://example.com:8443",
        ):
            with self.subTest(url=url), self.assertRaises(crawler.UnsafeUrlError):
                crawler.normalize_url(url)
        with self.assertRaises(crawler.UnsafeUrlError):
            resolve_website("Example", "file:///etc/passwd")
        self.assertFalse(crawler.host_allowed("https://www.example.com", "example.com"))
        self.assertTrue(
            crawler.host_allowed(
                "https://www.example.com",
                "example.com",
                {"example.com", "www.example.com"},
            )
        )
        self.assertFalse(crawler.host_allowed("https://example.com.evil", "example.com"))

    def test_private_dns_addresses_are_rejected(self):
        with patch.object(
            crawler.socket,
            "getaddrinfo",
            return_value=[(None, None, None, None, ("192.168.1.2", 0))],
        ):
            self.assertFalse(crawler.is_public_host("internal.example"))

    def test_crawler_prioritizes_internal_links_deduplicates_and_rejects_external(self):
        root = "https://company.example/"
        pages = {
            "https://company.example/robots.txt": FakeResponse(
                "https://company.example/robots.txt", status=404, content_type="text/plain"
            ),
            root: FakeResponse(
                root,
                b'<title>Company</title><a href="/csr">CSR policy</a>'
                b'<a href="/csr">Duplicate CSR</a><a href="/report.pdf">Annual Report</a>'
                b'<a href="https://evil.example/report">CSR report</a>',
            ),
            "https://company.example/csr": FakeResponse(
                "https://company.example/csr",
                b"<title>CSR</title><p>Community health and education programmes.</p>",
            ),
        }
        session = FakeSession(pages)
        with patch.object(crawler, "is_public_host", return_value=True), patch.object(crawler.time, "sleep"):
            result = crawler.OfficialSiteCrawler(root, max_pages=10, session=session).crawl()
        self.assertEqual(result["pages_visited"], 2)
        self.assertEqual(len([page for page in result["pages"] if page["url"].endswith("/csr")]), 1)
        self.assertEqual(len(result["documents"]), 1)
        self.assertTrue(result["documents"][0]["url"].endswith("/report.pdf"))
        self.assertFalse(any("evil.example" in url for url in session.requested))

    def test_large_site_uses_sitemap_to_find_deep_csr_material_before_irrelevant_links(self):
        root = "https://company.example/"
        irrelevant = "".join(f'<a href="/products/item-{n}">Product {n}</a>' for n in range(80))
        locs = "".join(f"<url><loc>https://company.example/products/item-{n}</loc></url>" for n in range(80))
        locs += "<url><loc>https://company.example/archive/community/sustainability-report-2025</loc></url>"
        pages = {
            "https://company.example/robots.txt": FakeResponse("https://company.example/robots.txt", b"User-agent: *\nAllow: /\nSitemap: https://company.example/sitemap.xml\n", content_type="text/plain"),
            root: FakeResponse(root, f"<title>Company</title>{irrelevant}".encode()),
            "https://company.example/sitemap.xml": FakeResponse("https://company.example/sitemap.xml", f"<urlset>{locs}</urlset>".encode(), content_type="application/xml"),
            "https://company.example/archive/community/sustainability-report-2025": FakeResponse("https://company.example/archive/community/sustainability-report-2025", b"<title>2025 Sustainability Report</title><h1>Community investment and ESG</h1>"),
        }
        session = FakeSession(pages)
        events = []
        with patch.object(crawler, "is_public_host", return_value=True), patch.object(crawler.time, "sleep"):
            result = crawler.OfficialSiteCrawler(root, max_pages=2, max_depth=4, session=session).crawl(events.append)
        self.assertEqual(result["stop_reason"], "page_limit")
        self.assertEqual(result["pages_visited"], 2)
        self.assertIn("https://company.example/archive/community/sustainability-report-2025", result["pages_visited_urls"])
        self.assertEqual(result["relevant_pages_found"], 1)
        self.assertIn("https://company.example/sitemap.xml", result["sitemaps_checked"])
        self.assertTrue(any(event["event_type"] == "page_prioritized" and "sitemap" in event["message"] for event in events))

    def test_site_without_sitemap_uses_link_fallback(self):
        root = "https://company.example/"
        pages = {
            "https://company.example/robots.txt": FakeResponse("https://company.example/robots.txt", status=404, content_type="text/plain"),
            root: FakeResponse(root, b'<title>Home</title><a href="/about">About</a><a href="/csr">CSR programme</a>'),
            "https://company.example/csr": FakeResponse("https://company.example/csr", b"<title>Community CSR</title>"),
        }
        with patch.object(crawler, "is_public_host", return_value=True), patch.object(crawler.time, "sleep"):
            result = crawler.OfficialSiteCrawler(root, max_pages=5, session=FakeSession(pages)).crawl()
        self.assertEqual(result["stop_reason"], "completed")
        self.assertEqual(result["relevant_pages_found"], 1)
        self.assertIn("https://company.example/csr", result["pages_visited_urls"])

    def test_tracking_parameters_and_duplicate_links_are_normalized(self):
        self.assertEqual(
            crawler.normalize_url("https://company.example/csr?utm_source=newsletter&b=2&a=1#section"),
            "https://company.example/csr?a=1&b=2",
        )
        root = "https://company.example/"
        pages = {
            "https://company.example/robots.txt": FakeResponse("https://company.example/robots.txt", status=404, content_type="text/plain"),
            root: FakeResponse(root, b'<title>Home</title><a href="/csr?utm_source=a">CSR</a><a href="/csr?utm_source=b">CSR duplicate</a>'),
            "https://company.example/csr": FakeResponse("https://company.example/csr", b"<title>CSR report page</title>"),
        }
        session = FakeSession(pages)
        with patch.object(crawler, "is_public_host", return_value=True), patch.object(crawler.time, "sleep"):
            result = crawler.OfficialSiteCrawler(root, max_pages=5, session=session).crawl()
        self.assertEqual(session.requested.count("https://company.example/csr"), 1)
        self.assertEqual(result["pages_visited_urls"].count("https://company.example/csr"), 1)

    def test_root_to_www_redirect_is_allowed_for_validated_counterpart(self):
        root = "https://company.example/"
        www = "https://www.company.example/"
        redirect = FakeResponse(root, status=301)
        redirect.headers["Location"] = www
        pages = {
            "https://company.example/robots.txt": FakeResponse("https://company.example/robots.txt", status=404, content_type="text/plain"),
            root: redirect,
            "https://www.company.example/robots.txt": FakeResponse("https://www.company.example/robots.txt", status=404, content_type="text/plain"),
            www: FakeResponse(www, b"<title>Company</title>"),
        }
        session = FakeSession(pages)
        with patch.object(crawler, "is_public_host", return_value=True), patch.object(crawler.time, "sleep"):
            result = crawler.OfficialSiteCrawler(root, session=session).crawl()
        self.assertEqual(result["pages_visited"], 1)
        self.assertTrue(any(url.startswith("https://www.company.example") for url in session.requested))

    def test_external_report_candidate_stays_blocked_until_exact_host_is_allowlisted(self):
        root = "https://company.example/"
        external = "https://reports.examplecdn.com/csr-2025.pdf"
        pages = {
            "https://company.example/robots.txt": FakeResponse("https://company.example/robots.txt", status=404, content_type="text/plain"),
            root: FakeResponse(root, f'<title>CSR Reports</title><a href="{external}">Sustainability Report</a>'.encode()),
        }
        with patch.object(crawler, "is_public_host", return_value=True), patch.object(crawler.time, "sleep"):
            blocked = crawler.OfficialSiteCrawler(root, session=FakeSession(pages)).crawl()
            allowed = crawler.OfficialSiteCrawler(root, allowed_external_hosts=["reports.examplecdn.com"], session=FakeSession(pages)).crawl()
        self.assertEqual(blocked["documents"], [])
        self.assertEqual(blocked["blocked_external_candidates"][0]["url"], external)
        self.assertEqual(allowed["documents"][0]["url"], external)
        self.assertFalse(allowed["blocked_external_candidates"])

    def test_page_depth_and_duration_budgets_have_distinct_stop_reasons(self):
        root = "https://company.example/"
        pages = {
            "https://company.example/robots.txt": FakeResponse("https://company.example/robots.txt", status=404, content_type="text/plain"),
            root: FakeResponse(root, b'<title>Home</title><a href="/sustainability">Sustainability</a>'),
            "https://company.example/sustainability": FakeResponse("https://company.example/sustainability", b"<title>Sustainability</title>"),
        }
        with patch.object(crawler, "is_public_host", return_value=True), patch.object(crawler.time, "sleep"):
            page_limited = crawler.OfficialSiteCrawler(root, max_pages=1, session=FakeSession(pages)).crawl()
            depth_limited = crawler.OfficialSiteCrawler(root, max_depth=0, session=FakeSession(pages)).crawl()
            duration_crawler = crawler.OfficialSiteCrawler(root, max_duration_seconds=10, session=FakeSession(pages))
            class Clock:
                now = 0
                def __call__(self):
                    self.now += 6
                    return self.now
            duration_crawler._clock = Clock()
            duration_limited = duration_crawler.crawl()
        self.assertEqual(page_limited["stop_reason"], "page_limit")
        self.assertEqual(depth_limited["stop_reason"], "depth_limit")
        self.assertEqual(duration_limited["stop_reason"], "duration_limit")

    def test_no_relevant_material_is_distinguished_from_budget_stop(self):
        root = "https://company.example/"
        pages = {
            "https://company.example/robots.txt": FakeResponse("https://company.example/robots.txt", status=404, content_type="text/plain"),
            root: FakeResponse(root, b"<title>Products</title><p>Browse our product catalog.</p>"),
        }
        with patch.object(crawler, "is_public_host", return_value=True), patch.object(crawler.time, "sleep"):
            result = crawler.OfficialSiteCrawler(root, session=FakeSession(pages)).crawl()
        self.assertEqual(result["stop_reason"], "no_relevant_material")
        self.assertEqual(result["pages_visited"], 1)

    def test_sitemap_robots_restrictions_and_request_failures_are_reported(self):
        root = "https://company.example/"
        pages = {
            "https://company.example/robots.txt": FakeResponse("https://company.example/robots.txt", b"User-agent: *\nDisallow: /sitemap.xml\nSitemap: https://company.example/sitemap.xml\n", content_type="text/plain"),
            root: FakeResponse(root, b"<title>Company</title>"),
        }
        events = []
        session = FakeSession(pages)
        with patch.object(crawler, "is_public_host", return_value=True), patch.object(crawler.time, "sleep"):
            result = crawler.OfficialSiteCrawler(root, session=session).crawl(events.append)
        self.assertNotIn("https://company.example/sitemap.xml", session.requested)
        self.assertTrue(any(event["event_type"] == "sitemap_skipped" for event in events))
        self.assertEqual(result["stop_reason"], "no_relevant_material")

        class FailingSession(FakeSession):
            def get(self, url: str, **_kwargs):
                self.requested.append(url)
                raise crawler.requests.ConnectionError("mock connection failure")
        with patch.object(crawler, "is_public_host", return_value=True), patch.object(crawler.time, "sleep"):
            failed = crawler.OfficialSiteCrawler(root, session=FailingSession({})).crawl()
        self.assertTrue(failed["errors"])
        self.assertEqual(failed["pages_visited"], 1)

    def test_redirect_destination_is_checked_before_request(self):
        root = "https://company.example/"
        pages = {
            "https://company.example/robots.txt": FakeResponse(root + "robots.txt", status=404),
            root: FakeResponse(root, status=302),
        }
        pages[root].headers["Location"] = "http://127.0.0.1/private"
        session = FakeSession(pages)
        with patch.object(crawler, "is_public_host", return_value=True), patch.object(crawler.time, "sleep"):
            site = crawler.OfficialSiteCrawler(root, session=session)
            with self.assertRaises(crawler.UnsafeUrlError):
                site._request(root)
        self.assertFalse(any("127.0.0.1" in url for url in session.requested))

    def test_robots_disallow_rules_are_respected(self):
        root = "https://company.example/private"
        pages = {
            "https://company.example/robots.txt": FakeResponse(
                "https://company.example/robots.txt",
                b"User-agent: *\nDisallow: /private\n",
                content_type="text/plain",
            ),
            root: FakeResponse(root, b"<title>Private</title>"),
        }
        session = FakeSession(pages)
        with patch.object(crawler, "is_public_host", return_value=True), patch.object(crawler.time, "sleep"):
            result = crawler.OfficialSiteCrawler(root, session=session).crawl()
        self.assertEqual(result["pages"], [])
        self.assertTrue(any("robots.txt" in error for error in result["errors"]))
        self.assertNotIn(root, session.requested)

    def test_document_extraction_reports_scanned_and_corrupt_pdfs_and_uses_cache(self):
        writer = PdfWriter()
        writer.add_blank_page(width=72, height=72)
        buffer = io.BytesIO()
        writer.write(buffer)
        pdf = buffer.getvalue()

        class Crawler:
            def __init__(self, content):
                self.content = content
                self.calls = 0

            def _request(self, url):
                self.calls += 1
                return FakeResponse(url, self.content, content_type="application/pdf")

        with tempfile.TemporaryDirectory() as directory:
            site = Crawler(pdf)
            source = [{"url": "https://company.example/report.pdf", "title": "CSR report", "file_type": "application/pdf"}]
            first, errors = process_documents(site, source, "Example", storage=Path(directory))
            second, _ = process_documents(site, source, "Example", storage=Path(directory))
            self.assertEqual(first[0]["status"], "scanned_or_empty")
            self.assertIn("OCR", first[0]["error"])
            self.assertEqual(second[0]["status"], "scanned_or_empty")
            self.assertEqual(site.calls, 1)
            self.assertTrue(first[0]["storage_name"])
            self.assertTrue(errors)

            corrupt = Crawler(b"%PDF-not-a-valid-pdf")
            malformed, _ = process_documents(
                corrupt,
                [{"url": "https://company.example/bad.pdf", "title": "Bad PDF", "file_type": "application/pdf"}],
                "Example",
                storage=Path(directory),
            )
            self.assertEqual(malformed[0]["status"], "failed")

    def test_unsupported_document_is_recorded_without_execution(self):
        class Crawler:
            def __init__(self):
                self.calls = 0

            def _request(self, url):
                self.calls += 1
                return FakeResponse(url, b"binary-data", content_type="application/octet-stream")

        with tempfile.TemporaryDirectory() as directory:
            crawler = Crawler()
            source = [{"url": "https://company.example/report.docx", "title": "Report", "file_type": "application/vnd.openxmlformats"}]
            documents, errors = process_documents(crawler, source, "Example", storage=Path(directory))
            repeated, _ = process_documents(crawler, source, "Example", storage=Path(directory))
        self.assertEqual(documents[0]["status"], "unsupported")
        self.assertEqual(repeated[0]["status"], "unsupported")
        self.assertEqual(crawler.calls, 1)
        self.assertTrue(errors)

    def test_deterministic_findings_preserve_field_financial_year_and_evidence(self):
        findings = extract_findings([{
            "url": "https://company.example/annual.pdf",
            "title": "Annual report",
            "status": "processed",
            "pages": [{
                "page": 14,
                "text": (
                    "CSR expenditure was Rs. 1,000 crore for FY 2023-24. "
                    "Unspent CSR amount was INR 2.5 crore for FY 2022-23. "
                    "CSR obligation was INR 10 crore for FY 2024-25."
                ),
            }],
        }])
        amounts = {item["field_name"]: item for item in findings if item["field_name"].endswith("_amount")}
        self.assertEqual(amounts["csr_expenditure_amount"]["value"], "Rs. 1,000 crore")
        self.assertEqual(amounts["csr_expenditure_amount"]["financial_year"], "2023-24")
        self.assertEqual(amounts["csr_expenditure_amount"]["page_number"], 14)
        self.assertEqual(amounts["unspent_csr_amount"]["value"], "INR 2.5 crore")
        self.assertEqual(amounts["csr_obligation_amount"]["value"], "INR 10 crore")
        self.assertEqual(amounts["csr_obligation_amount"]["source_url"], "https://company.example/annual.pdf")

    def test_extractor_ignores_generic_sustainability_and_keeps_specific_csr_fields(self):
        findings = extract_findings([{
            "url": "https://company.example/report.pdf",
            "title": "Annual report",
            "status": "processed",
            "pages": [{"page": 8, "text": (
                "Our sustainability strategy supports long-term growth. "
                "The CSR policy establishes the company's community programmes. "
                "CSR budget was INR 2 crore for FY 2023-24."
            )}],
        }])
        self.assertNotIn("csr_observation", {item["field_name"] for item in findings})
        policy = next(item for item in findings if item["field_name"] == "csr_policy_reference")
        budget = next(item for item in findings if item["field_name"] == "csr_budget_amount")
        self.assertIn(policy["value"], policy["excerpt"])
        self.assertEqual(budget["value"], "INR 2 crore")
        self.assertEqual(budget["financial_year"], "2023-24")
        self.assertEqual(budget["page_number"], 8)

    def test_company_revenue_stays_separate_from_csr_spend(self):
        findings = extract_findings([{
            "url": "https://company.example/report.pdf",
            "title": "Annual report",
            "status": "processed",
            "pages": [{"page": 20, "text": (
                "Turnover was INR 500 crore for FY 2023-24. "
                "CSR expenditure was INR 2 crore for FY 2023-24. "
                "Turnover was INR 500 crore and CSR expenditure was INR 2 crore."
            )}],
        }])
        revenue = [item for item in findings if item["field_name"] == "turnover_amount"]
        expenditure = [item for item in findings if item["field_name"] == "csr_expenditure_amount"]
        self.assertEqual(revenue[0]["value"], "INR 500 crore")
        self.assertEqual(expenditure[0]["value"], "INR 2 crore")
        self.assertEqual(revenue[0]["financial_year"], "2023-24")

    def test_gemini_disabled_uses_local_path_without_a_key(self):
        with patch.dict(os.environ, {"GEMINI_API_KEY": ""}):
            findings, warning = extract_with_gemini([])
        self.assertEqual(findings, [])
        self.assertIsNone(warning)

    def test_pipeline_discovers_reports_without_extracting_fields_or_calling_gemini(self):
        class Crawler:
            def __init__(self, website, **_options):
                self.website = website

            def crawl(self, progress=None):
                if progress:
                    progress({"step": "crawling", "pages_visited": 1})
                return {
                    "pages": [{
                        "url": "https://company.example/csr",
                        "title": "CSR focus areas",
                        "text": "CSR focus areas include community development.",
                        "relevance": 2,
                    }],
                    "documents": [],
                    "errors": [],
                    "pages_visited": 1,
                    "warnings": [],
                }

        with patch("research.OfficialSiteCrawler", Crawler), patch("information_extractor.extract_with_gemini", side_effect=AssertionError("Gemini must not run")):
            result = run_research("Example Company", "https://company.example")
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["pages_visited"], 1)
        self.assertEqual(result["documents_processed"], 0)
        self.assertEqual(result["findings"], [])
        self.assertEqual(result["extraction_status"], "not_started")

    def test_report_candidates_record_invalid_download_and_irrelevant_skip(self):
        class Crawler:
            def _request(self, _url):
                return FakeResponse("https://company.example/reports/csr.pdf", b"<html>error page</html>", content_type="application/pdf")

        candidates = [
            {"url": "https://company.example/reports/csr.pdf", "title": "CSR report", "source_page_url": "https://company.example/sustainability"},
            {"url": "https://company.example/files/random.pdf", "title": "download", "source_page_url": "https://company.example/contact"},
        ]
        with tempfile.TemporaryDirectory() as folder:
            reports, errors = discover_reports(Crawler(), candidates, "Example Company", storage=Path(folder))
        self.assertEqual([item["status"] for item in reports], ["failed", "skipped"])
        self.assertEqual(reports[0]["validation_result"], "invalid")
        self.assertIn("not a PDF", reports[0]["error"])
        self.assertIn("not related", reports[1]["error"])
        self.assertEqual(reports[0]["source_page_url"], candidates[0]["source_page_url"])
        self.assertEqual(len(errors), 1)

    def test_unknown_company_does_not_guess_a_domain_and_json_error_is_machine_readable(self):
        self.assertIsNone(resolve_website("Unknown Example Company", None))
        process = subprocess.run(
            [sys.executable, str(RESEARCH_DIR / "research.py"), "Unknown Example Company", "--json"],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(process.returncode, 2)
        self.assertIn("No confirmed official website", json.loads(process.stdout)["error"])


if __name__ == "__main__":
    unittest.main()
