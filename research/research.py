"""Research an explicitly confirmed company website and emit evidence-linked results."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Callable

from crawler import OfficialSiteCrawler, UnsafeUrlError
from report_discovery import discover_reports

DOMAIN_FILE = Path(__file__).with_name("company_domains.json")


def normalize_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.casefold()).strip()


def load_domains() -> dict:
    try:
        with DOMAIN_FILE.open(encoding="utf-8") as file:
            data = json.load(file)
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Could not read {DOMAIN_FILE.name}: {error}") from error
    if not isinstance(data, dict):
        raise RuntimeError(f"{DOMAIN_FILE.name} must contain a JSON object.")
    return data


def resolve_website(company_name: str, supplied_url: str | None) -> str | None:
    if supplied_url:
        candidate = supplied_url.strip()
        if re.match(r"^[a-z][a-z0-9+.-]*:", candidate, re.IGNORECASE) and not re.match(
            r"^https?://", candidate, re.IGNORECASE
        ):
            raise UnsafeUrlError("Website must use http:// or https://.")
        if not re.match(r"^https?://", candidate, re.IGNORECASE):
            candidate = "https://" + candidate
        return OfficialSiteCrawler(candidate).website
    normalized = normalize_name(company_name)
    for company, details in load_domains().items():
        if not isinstance(details, dict):
            continue
        names = [company, *details.get("aliases", [])]
        if normalized in {normalize_name(name) for name in names}:
            return OfficialSiteCrawler(details["website"]).website
    return None


def run_research(
    company_name: str,
    website: str,
    *,
    max_pages: int = 80,
    max_depth: int = 4,
    max_duration_seconds: int = 900,
    progress: Callable[[dict], None] | None = None,
) -> dict:
    crawler = OfficialSiteCrawler(
        website,
        max_pages=max_pages,
        max_depth=max_depth,
        timeout=int(os.getenv("CRAWL_TIMEOUT_SECONDS", "15")),
        max_duration_seconds=max_duration_seconds,
        max_bytes=int(os.getenv("MAX_HTML_BYTES", str(3_000_000))),
        user_agent=os.getenv(
            "CRAWL_USER_AGENT",
            "ServiceLearningCSRResearcher/1.0 (educational research)",
        ),
    )
    if progress:
        progress({"step": "opening_website", "event_type": "website_opening", "message": f"Opening the confirmed official website: {crawler.website}"})
    result = crawler.crawl(progress=progress)
    documents, download_errors = discover_reports(crawler, result["documents"], company_name, progress=progress)
    errors = result["errors"] + download_errors
    warnings = list(result["warnings"])
    stop_reason = result.get("stop_reason", "completed")
    sitemaps_checked = result.get("sitemaps_checked", [])
    pages_visited_urls = result.get("pages_visited_urls", [])
    relevant_pages_found = result.get("relevant_pages_found", sum(page.get("relevance", 0) > 0 for page in result.get("pages", [])))
    if any(item.get("error") == "Per-run report limit reached." for item in documents):
        warnings.append("Per-run report limit reached; remaining report candidates were recorded as skipped.")
    blocked_count = len(result.get("blocked_external_candidates", []))
    if blocked_count:
        warnings.append(f"{blocked_count} candidate link(s) were left blocked because their host is not approved.")
    valid_documents = sum(item["status"] == "processed" for item in documents)
    partial_stops = {"page_limit", "depth_limit", "duration_limit"}
    status = "completed" if not errors and not warnings else (
        "partially_completed" if result["pages"] or valid_documents else "failed"
    )
    if stop_reason in partial_stops:
        status = "partially_completed"
    if stop_reason == "no_relevant_material" and not errors:
        status = "completed"
    blocked_summary = f" {blocked_count} candidate link(s) were left blocked because their host is not approved." if blocked_count else ""
    crawl_totals = (
        f"{result['pages_visited']} pages visited; {len(sitemaps_checked)} sitemap(s) checked; "
        f"{relevant_pages_found} relevant page(s); {len(documents)} report candidate(s); "
        f"{valid_documents} validated report(s) saved; {len(errors)} error(s); stop reason: {stop_reason}."
    )
    if status == "completed":
        if stop_reason == "no_relevant_material":
            summary = f"No relevant CSR or reporting material was found. {crawl_totals}{blocked_summary}"
        else:
            summary = f"Report discovery completed. {crawl_totals}{blocked_summary} Contents have not been reviewed."
    elif status == "partially_completed":
        summary = f"Report discovery is incomplete. {crawl_totals}{blocked_summary} Next action: increase the indicated crawl budget, fix failed URLs, or review blocked hosts before retrying. Contents have not been reviewed."
    else:
        summary = f"Report discovery could not complete meaningful work. {crawl_totals}{blocked_summary}"
    if progress:
        progress({"step": "finished", "event_type": "crawl_finished", "pages_visited": result["pages_visited"],
                  "documents_discovered": len(documents), "documents_processed": valid_documents,
                  "stop_reason": stop_reason, "relevant_pages_found": relevant_pages_found,
                  "sitemaps_checked": sitemaps_checked,
                  "pages_visited_urls": pages_visited_urls,
                  "candidate_documents_found": len(documents),
                  "errors": [str(error)[:1000] for error in errors[:30]],
                  "blocked_external_candidates": result.get("blocked_external_candidates", []),
                  "errors_count": len(errors),
                  "message": f"Report discovery finished: {valid_documents} validated reports saved from {len(documents)} candidates; {relevant_pages_found} relevant pages, {len(sitemaps_checked)} sitemaps checked; stop reason: {stop_reason}."})
    return {
        "company_name": company_name,
        "official_website": crawler.website,
        "status": status,
        "pages_visited": result["pages_visited"],
        "pages_visited_urls": pages_visited_urls,
        "sitemaps_checked": sitemaps_checked,
        "relevant_pages_found": relevant_pages_found,
        "candidate_documents_found": len(documents),
        "blocked_external_candidates": result.get("blocked_external_candidates", []),
        "skipped_links": result.get("skipped_links", []),
        "stop_reason": stop_reason,
        "duration_seconds": result.get("duration_seconds", 0),
        "documents_discovered": len(documents),
        "documents_processed": valid_documents,
        "documents": documents,
        "findings": [],
        "errors": errors,
        "warnings": warnings,
        "summary": summary,
        "extraction_status": "not_started",
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Find CSR material on a company's confirmed official website."
    )
    parser.add_argument("company", nargs="+", help="Company name")
    parser.add_argument(
        "--website",
        help="Confirmed official website URL; required when no registry entry exists",
    )
    parser.add_argument("--max-pages", type=int, default=int(os.getenv("MAX_CRAWL_PAGES", "80")))
    parser.add_argument("--max-depth", type=int, default=int(os.getenv("MAX_CRAWL_DEPTH", "4")))
    parser.add_argument("--max-duration-seconds", type=int, default=int(os.getenv("CRAWL_MAX_DURATION_SECONDS", "900")))
    parser.add_argument("--json", action="store_true", help="Output machine-readable research results")
    args = parser.parse_args()
    name = " ".join(args.company).strip()
    if not name or len(name) > 200:
        parser.error("Company name must be between 1 and 200 characters.")
    if not 1 <= args.max_pages <= 200:
        parser.error("--max-pages must be between 1 and 200")
    if not 0 <= args.max_depth <= 8:
        parser.error("--max-depth must be between 0 and 8")
    if not 10 <= args.max_duration_seconds <= 1800:
        parser.error("--max-duration-seconds must be between 10 and 1800")
    try:
        website = resolve_website(name, args.website)
        if not website:
            message = (
                f"No confirmed official website is configured for {name}. "
                "Supply --website https://official.example or add a verified registry entry."
            )
            if args.json:
                print(json.dumps({"error": message}))
                return 2
            print(message)
            return 2
        result = run_research(
            name,
            website,
            max_pages=args.max_pages,
            max_depth=args.max_depth,
            max_duration_seconds=args.max_duration_seconds,
            progress=(
                (lambda event: print(json.dumps({"event": "progress", **event}), flush=True))
                if args.json else None
            ),
        )
    except (ValueError, RuntimeError, UnsafeUrlError) as error:
        if args.json:
            print(json.dumps({"error": str(error)}))
        else:
            print(f"Research could not start: {error}", file=sys.stderr)
        return 2
    except Exception as error:
        if args.json:
            print(json.dumps({"error": f"Research failed: {type(error).__name__}"}))
        else:
            print(f"Research failed: {type(error).__name__}: {error}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(result, ensure_ascii=True))
    else:
        print(f"CSR company research: {name}")
        print(f"Starting from: {website}")
        print(f"Inspected {result['pages_visited']} pages.")
        print(f"Discovered {result['documents_discovered']} relevant pages/documents.")
        print(f"Processed {result['documents_processed']} documents; found {len(result['findings'])} reviewable findings.")
        for document in result["documents"]:
            print(f"- {document['title']}: {document['url']} ({document['status']})")
        for finding in result["findings"]:
            year = f" ({finding['financial_year']})" if finding.get("financial_year") else ""
            page = f", page {finding['page_number']}" if finding.get("page_number") else ""
            print(f"\n[{finding['field_name']}]{year}: {finding['value']}")
            print(f"Source: {finding['source_url']}{page}")
            print(f"Evidence: {finding['excerpt']}")
        for error in result["errors"]:
            print(f"Warning: {error}")
        for warning in result["warnings"]:
            print(f"Note: {warning}")
        print("Findings are research suggestions and require human review.")
        if not result["documents"]:
            print("No relevant documents were found. Confirm the official domain or increase crawl limits.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
