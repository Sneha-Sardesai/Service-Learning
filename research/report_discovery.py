"""Discover and validate first-party CSR and company reports without extraction."""

from __future__ import annotations

import hashlib
import io
import re
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

from pypdf import PdfReader

from document_extractor import DEFAULT_STORAGE, MAX_DOCUMENT_BYTES, MAX_DOCUMENTS, MAX_TOTAL_BYTES, _atomic_write, _safe_title

REPORT_TERMS = ("csr", "corporate social responsibility", "sustainability", "esg", "brsr",
                "business responsibility", "annual report", "integrated report", "community",
                "social impact", "corporate responsibility", "annual-report",
                "sustainability-report", "csr-report", "brsr-report",
                "business-responsibility", "community-program")

UNHELPFUL_LINK_TEXTS = {
    "leer el informe", "read more", "read report", "read the report", "view report",
    "see report", "download", "download report", "download pdf", "download file",
    "download the report", "descargar", "descargar informe", "click here", "here",
    "link", "more", "pdf", "report", "document", "file", "view", "details",
    "open", "annual report", "csr report", "sustainability report", "esg report",
    "brsr", "brsr report", "leer informe", "ver informe", "informe",
}


def clean_filename_title(url: str) -> str | None:
    try:
        path = urlparse(url).path
        filename = Path(path).name
        if not filename:
            return None
        stem = Path(filename).stem
        lowered = stem.lower()
        if lowered in {"report", "download", "document", "file", "pdf", "annualreport", "csr"}:
            return None
        if re.match(r"^[0-9a-f]{16,64}$", lowered) or re.match(r"^\d+$", lowered):
            return None
        cleaned = re.sub(r"[-_]+", " ", stem).strip()
        if len(cleaned) >= 3 and not cleaned.lower().endswith(".pdf"):
            return cleaned
    except Exception:
        pass
    return None


def is_meaningful_title(title: str | None) -> bool:
    if not title:
        return False
    stripped = title.strip()
    if len(stripped) < 3:
        return False
    if stripped.lower() in UNHELPFUL_LINK_TEXTS:
        return False
    if stripped.startswith("http://") or stripped.startswith("https://"):
        return False
    if stripped.lower().endswith(".pdf"):
        return False
    return True


def derive_report_title(metadata_title: str | None, filename_title: str | None,
                        source_page_title: str | None, link_text: str | None,
                        url: str) -> str:
    """
    Derives the displayed report title from PDF metadata, document filename, or page title.
    If no better title exists, returns 'Untitled report'.
    """
    if is_meaningful_title(metadata_title):
        clean_meta = re.sub(r"^(Microsoft Word - |PowerPoint Presentation - )", "", metadata_title.strip(), flags=re.I).strip()
        if is_meaningful_title(clean_meta):
            return clean_meta[:500]

    fn_title = filename_title or clean_filename_title(url)
    if is_meaningful_title(fn_title):
        return fn_title[:500]

    if is_meaningful_title(source_page_title):
        return source_page_title.strip()[:500]

    if is_meaningful_title(link_text):
        return link_text.strip()[:500]

    return "Untitled report"


def discover_reports(crawler, discovered: list[dict], company_name: str, *, progress: Callable | None = None,
                     storage: Path | None = None) -> tuple[list[dict], list[str]]:
    base = storage or DEFAULT_STORAGE
    company_dir = base / hashlib.sha256(company_name.casefold().encode("utf-8")).hexdigest()[:16]
    reports, errors = [], []
    total_bytes = 0

    for item in discovered[:MAX_DOCUMENTS]:
        url = item["url"]
        raw_link_text = (item.get("title") or "").strip()
        candidate_title = clean_filename_title(url) or (item.get("source_page_title") if is_meaningful_title(item.get("source_page_title")) else None)
        initial_title = candidate_title or (raw_link_text if is_meaningful_title(raw_link_text) else "Untitled report")
        display_label = initial_title if initial_title != "Untitled report" else f"Untitled report ({url})"

        context = f"{raw_link_text} {url} {item.get('source_page_title', '')} {item.get('source_page_url', '')}".casefold()
        relevant = any(term in context for term in REPORT_TERMS) or item.get("source_page_relevant", False)

        record = {
            "url": url,
            "source_page_url": item.get("source_page_url"),
            "link_text": raw_link_text or None,
            "title": initial_title[:500],
            "file_type": "application/pdf",
            "status": "discovered",
            "validation_result": "checking: pending download and validation",
            "content_hash": None,
            "storage_name": None,
            "error": None,
        }

        if not relevant:
            record.update(
                status="skipped",
                validation_result="skipped",
                error="PDF was not related to company responsibility or reporting (not linked from a CSR, BRSR, sustainability, ESG, annual report, or community page)."
            )
            reports.append(record)
            if progress:
                progress({
                    "step": "report_skipped",
                    "event_type": "report_skipped",
                    "current_url": url,
                    "link_text": raw_link_text or None,
                    "message": f"Skipped candidate file {display_label}: link was not related to company responsibility or reporting."
                })
            continue

        response = None
        try:
            if progress:
                progress({
                    "step": "report_download",
                    "event_type": "report_download_started",
                    "current_url": url,
                    "link_text": raw_link_text or None,
                    "message": f"Downloading and checking candidate file: {display_label}"
                })
            response = crawler._request(url)
            if response.status_code < 200 or response.status_code >= 300:
                raise ValueError(f"HTTP request failed with status {response.status_code}.")
            chunks, size = [], 0
            for chunk in response.iter_content(64 * 1024):
                if chunk:
                    size += len(chunk)
                    if size > MAX_DOCUMENT_BYTES or total_bytes + size > MAX_TOTAL_BYTES:
                        raise ValueError("Report exceeded the configured download size limit.")
                    chunks.append(chunk)
            content = b"".join(chunks)
            total_bytes += size
            if not content:
                raise ValueError("The downloaded file is empty.")
            if not content.startswith(b"%PDF-"):
                raise ValueError("Response content is not a PDF document.")
            company_dir.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256(content).hexdigest()
            filename = _safe_title(digest) + ".pdf"
            path = company_dir / filename
            reader = PdfReader(io.BytesIO(content))
            if reader.is_encrypted or len(reader.pages) == 0:
                raise ValueError("PDF is encrypted or contains no pages.")
            sample = " ".join((page.extract_text() or "") for page in reader.pages[:20])[:100_000]
            document_context = f"{raw_link_text} {reader.metadata.title or ''} {sample}".casefold()
            if not any(term in document_context for term in REPORT_TERMS):
                raise ValueError("PDF content does not appear to be a CSR or company responsibility report.")
            if not path.exists():
                _atomic_write(path, content)

            final_title = derive_report_title(
                reader.metadata.title,
                clean_filename_title(url),
                item.get("source_page_title"),
                raw_link_text,
                url,
            )
            record.update(
                title=final_title[:500],
                status="processed",
                validation_result=f"valid PDF; {len(reader.pages)} page(s)",
                content_hash=digest,
                storage_name=path.relative_to(base).as_posix()
            )
            reports.append(record)
            if progress:
                progress({
                    "step": "report_checked",
                    "event_type": "report_validated",
                    "current_url": url,
                    "link_text": raw_link_text or None,
                    "title": final_title,
                    "documents_processed": sum(r["status"] == "processed" for r in reports),
                    "documents_discovered": len(discovered),
                    "message": f"Validated and saved report: {final_title} ({len(reader.pages)} page(s))"
                })
        except Exception as error:
            reason = str(error) if isinstance(error, (OSError, ValueError)) else f"Could not validate PDF ({type(error).__name__})."
            record.update(status="failed", validation_result="invalid", error=reason[:1000])
            errors.append(f"{url}: {reason}")
            reports.append(record)
            if progress:
                progress({
                    "step": "report_checked",
                    "event_type": "report_failed",
                    "current_url": url,
                    "link_text": raw_link_text or None,
                    "title": initial_title,
                    "message": f"Failed validating candidate file {display_label}: {reason}"
                })
        finally:
            if response is not None:
                response.close()

    for item in discovered[MAX_DOCUMENTS:]:
        raw_link_text = (item.get("title") or "").strip()
        candidate_title = clean_filename_title(item["url"]) or (item.get("source_page_title") if is_meaningful_title(item.get("source_page_title")) else None)
        title = candidate_title or (raw_link_text if is_meaningful_title(raw_link_text) else "Untitled report")
        display_label = title if title != "Untitled report" else f"Untitled report ({item['url']})"
        reports.append({
            "url": item["url"],
            "source_page_url": item.get("source_page_url"),
            "link_text": raw_link_text or None,
            "title": title[:500],
            "file_type": "application/pdf",
            "status": "skipped",
            "validation_result": "skipped",
            "error": "Per-run report limit reached."
        })
        if progress:
            progress({
                "step": "report_skipped",
                "event_type": "report_skipped",
                "current_url": item["url"],
                "link_text": raw_link_text or None,
                "message": f"Skipped candidate file {display_label}: per-run report limit reached."
            })
    return reports, errors
