from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from pypdf import PdfWriter

RESEARCH_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RESEARCH_DIR))

import crawler
from document_extractor import process_documents
from information_extractor import extract_findings, extract_with_gemini
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
        return self.pages[url]


class ResearchTests(unittest.TestCase):
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

    def test_gemini_disabled_uses_local_path_without_a_key(self):
        with patch.dict(os.environ, {"GEMINI_API_KEY": ""}):
            findings, warning = extract_with_gemini([])
        self.assertEqual(findings, [])
        self.assertIsNone(warning)

    def test_pipeline_combines_page_discovery_extraction_and_evidence(self):
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

        with (
            patch("research.OfficialSiteCrawler", Crawler),
            patch("research.save_page", return_value={"storage_name": "sample.txt", "content_hash": "a" * 64}),
            patch("research.extract_with_gemini", return_value=([], None)),
        ):
            result = run_research("Example Company", "https://company.example")
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["pages_visited"], 1)
        self.assertEqual(result["documents_processed"], 1)
        self.assertTrue(result["findings"])
        self.assertEqual(result["findings"][0]["source_url"], "https://company.example/csr")
        self.assertEqual(result["findings"][0]["extraction_method"], "keyword")

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
