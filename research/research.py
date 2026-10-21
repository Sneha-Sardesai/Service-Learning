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
from document_extractor import process_documents, save_page
from information_extractor import extract_findings, extract_with_gemini

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
    max_pages: int = 40,
    max_depth: int = 3,
    progress: Callable[[dict], None] | None = None,
) -> dict:
    crawler = OfficialSiteCrawler(
        website,
        max_pages=max_pages,
        max_depth=max_depth,
        timeout=int(os.getenv("CRAWL_TIMEOUT_SECONDS", "15")),
        max_bytes=int(os.getenv("MAX_HTML_BYTES", str(3_000_000))),
        user_agent=os.getenv(
            "CRAWL_USER_AGENT",
            "ServiceLearningCSRResearcher/1.0 (educational research)",
        ),
    )
    result = crawler.crawl(progress=progress)
    if progress:
        progress({
            "step": "processing_documents",
            "pages_visited": result["pages_visited"],
            "documents_discovered": len(result["documents"]),
        })
    processed, download_errors = process_documents(crawler, result["documents"], company_name)
    relevant_pages = []
    for page in result["pages"]:
        if page["relevance"] <= 0:
            continue
        saved_page = save_page(page, company_name)
        relevant_pages.append({
            "url": page["url"],
            "title": page["title"],
            "file_type": "text/html",
            "status": "processed" if page["text"] else "empty",
            "content_hash": saved_page["content_hash"],
            "storage_name": saved_page["storage_name"],
            "text": page["text"],
            "pages": [],
            "error": None,
        })
    documents = relevant_pages + processed
    findings = extract_findings(documents)
    errors = result["errors"] + download_errors
    model_findings, model_warning = extract_with_gemini(documents)
    finding_keys = {
        (item["field_name"], item["value"], item["source_url"], item["page_number"])
        for item in findings
    }
    for finding in model_findings:
        key = (finding["field_name"], finding["value"], finding["source_url"], finding["page_number"])
        if key not in finding_keys:
            findings.append(finding)
            finding_keys.add(key)
    warnings = list(result["warnings"])
    if model_warning:
        warnings.append(model_warning)
    status = "completed" if not errors else ("partially_completed" if documents else "failed")
    return {
        "company_name": company_name,
        "official_website": crawler.website,
        "status": status,
        "pages_visited": result["pages_visited"],
        "documents_discovered": len(result["documents"]) + len(relevant_pages),
        "documents_processed": sum(item["status"] == "processed" for item in documents),
        "documents": documents,
        "findings": findings,
        "errors": errors,
        "warnings": warnings,
        "extraction_status": "pending_review" if findings else "no_findings",
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
    parser.add_argument("--max-pages", type=int, default=int(os.getenv("MAX_CRAWL_PAGES", "40")))
    parser.add_argument("--max-depth", type=int, default=int(os.getenv("MAX_CRAWL_DEPTH", "3")))
    parser.add_argument("--json", action="store_true", help="Output machine-readable research results")
    args = parser.parse_args()
    name = " ".join(args.company).strip()
    if not name or len(name) > 200:
        parser.error("Company name must be between 1 and 200 characters.")
    if not 1 <= args.max_pages <= 200:
        parser.error("--max-pages must be between 1 and 200")
    if not 0 <= args.max_depth <= 8:
        parser.error("--max-depth must be between 0 and 8")
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
