"""Safe download and text extraction for discovered first-party documents."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import time
from typing import Callable
from pathlib import Path

from pypdf import PdfReader

DEFAULT_STORAGE = Path(
    os.getenv("DOCUMENT_STORAGE_DIR") or str(Path(__file__).with_name("documents"))
).resolve()
MAX_DOCUMENT_BYTES = max(100_000, min(int(os.getenv("MAX_DOCUMENT_BYTES", str(20 * 1024 * 1024))), 100 * 1024 * 1024))
MAX_TOTAL_BYTES = max(100_000, min(int(os.getenv("MAX_TOTAL_DOCUMENT_BYTES", str(60 * 1024 * 1024))), 200 * 1024 * 1024))
MAX_DOCUMENTS = max(1, min(int(os.getenv("MAX_DOCUMENTS_PER_RUN", "12")), 100))
CACHE_TTL_SECONDS = max(0, min(int(os.getenv("DOCUMENT_CACHE_TTL_SECONDS", "86400")), 30 * 86400))


def _safe_title(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-.")[:100] or "company-document"


def _atomic_write(destination: Path, content: bytes) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=destination.parent,
            prefix=".csr-",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(content)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_path, destination)
    except OSError:
        if temporary_path and temporary_path.exists():
            temporary_path.unlink()
        raise


def _extract(path: Path, file_type: str) -> tuple[str, list[dict], str | None]:
    if file_type == "application/pdf":
        reader = PdfReader(str(path))
        if reader.is_encrypted:
            return "", [], "PDF is encrypted."
        pages = [
            {"page": index + 1, "text": page.extract_text() or ""}
            for index, page in enumerate(reader.pages[:200])
        ]
        text = "\n".join(item["text"] for item in pages).strip()
        return text, pages, None if text else "No selectable text found; OCR may be needed for scanned pages."
    from bs4 import BeautifulSoup

    content = path.read_bytes()
    soup = BeautifulSoup(content, "html.parser")
    for chrome in soup.find_all((
        "nav", "header", "footer", "script", "style", "noscript", "aside", "form"
    )):
        chrome.decompose()
    main = soup.find("main") or soup.find("article") or soup.body or soup
    text = " ".join(main.stripped_strings)
    return text, [], None if text else "HTML page contained no extractable text."


def save_page(page: dict, company_name: str, *, storage: Path | None = None) -> dict:
    base = storage or DEFAULT_STORAGE
    company_dir = base / hashlib.sha256(company_name.casefold().encode("utf-8")).hexdigest()[:16]
    content = (page.get("text") or "").encode("utf-8")
    digest = hashlib.sha256(content).hexdigest()
    filename = _safe_title(digest) + ".txt"
    company_dir.mkdir(parents=True, exist_ok=True)
    destination = company_dir / filename
    if not destination.exists():
        _atomic_write(destination, content)
    return {
        "storage_name": path_to_storage_name(destination, base),
        "content_hash": digest,
    }


def path_to_storage_name(path: Path, storage_root: Path) -> str:
    return path.relative_to(storage_root).as_posix()


def process_documents(
    crawler,
    discovered: list[dict],
    company_name: str,
    *,
    storage: Path | None = None,
    progress: Callable[[dict], None] | None = None,
) -> tuple[list[dict], list[str]]:
    base = storage or DEFAULT_STORAGE
    company_dir = base / hashlib.sha256(company_name.casefold().encode("utf-8")).hexdigest()[:16]
    output: list[dict] = []
    errors: list[str] = []
    total_bytes = 0
    manifest_path = company_dir / "index.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(manifest, dict):
            manifest = {}
    except (OSError, json.JSONDecodeError):
        manifest = {}

    def cached_file(url: str) -> tuple[Path, str, str] | None:
        item = manifest.get(url)
        if not isinstance(item, dict):
            return None
        saved_at = item.get("saved_at")
        if not isinstance(saved_at, (int, float)) or time.time() - saved_at > CACHE_TTL_SECONDS:
            return None
        name = item.get("name", "")
        digest = item.get("hash", "")
        kind = item.get("file_type", "")
        if (
            Path(name).name != name
            or not re.fullmatch(r"[a-f0-9]{64}\.(pdf|html)", name)
            or not re.fullmatch(r"[a-f0-9]{64}", digest)
            or kind not in ("application/pdf", "text/html")
        ):
            return None
        candidate = company_dir / name
        if not candidate.is_file() or candidate.stat().st_size > MAX_DOCUMENT_BYTES:
            return None
        actual = hashlib.sha256(candidate.read_bytes()).hexdigest()
        if actual != digest:
            return None
        return candidate, digest, kind

    def is_cached_unsupported(url: str) -> dict | None:
        item = manifest.get(url)
        if (
            isinstance(item, dict)
            and item.get("status") == "unsupported"
            and isinstance(item.get("saved_at"), (int, float))
            and time.time() - item["saved_at"] <= CACHE_TTL_SECONDS
        ):
            return item
        return None

    for item in discovered[:MAX_DOCUMENTS]:
        record = {
            "url": item["url"],
            "title": item.get("title") or item["url"],
            "file_type": item.get("file_type") or "unknown",
            "status": "discovered",
            "content_hash": None,
            "text": "",
            "pages": [],
            "error": None,
        }
        response = None
        if progress:
            progress({"step": "processing_documents", "event_type": "document_started",
                      "title": record["title"], "current_url": item["url"]})
        try:
            unsupported = is_cached_unsupported(item["url"]) if CACHE_TTL_SECONDS else None
            if unsupported:
                record.update(
                    file_type=unsupported.get("file_type", "unknown"),
                    status="unsupported",
                    error=unsupported.get("error", "Unsupported document type."),
                )
                errors.append(f"{item['url']}: {record['error']}")
                output.append(record)
                continue
            cached = cached_file(item["url"]) if CACHE_TTL_SECONDS else None
            if cached:
                path, digest, kind = cached
            else:
                response = crawler._request(item["url"])
                response.raise_for_status()
                content_length = response.headers.get("Content-Length")
                if content_length and int(content_length) > MAX_DOCUMENT_BYTES:
                    raise ValueError("Document exceeded the configured download limit.")
                chunks = []
                size = 0
                for chunk in response.iter_content(64 * 1024):
                    if not chunk:
                        continue
                    size += len(chunk)
                    if size > MAX_DOCUMENT_BYTES or total_bytes + size > MAX_TOTAL_BYTES:
                        raise ValueError("Document or total download limit exceeded.")
                    chunks.append(chunk)
                content = b"".join(chunks)
                total_bytes += size
                content_type = response.headers.get("Content-Type", "").split(";", 1)[0].casefold()
                if content.startswith(b"%PDF-"):
                    kind = "application/pdf"
                    extension = ".pdf"
                elif content_type in ("text/html", "application/xhtml+xml"):
                    kind = "text/html"
                    extension = ".html"
                else:
                    error_message = (
                        f"Unsupported document type ({content_type or item.get('file_type') or 'unknown'})."
                    )
                    manifest[item["url"]] = {
                        "status": "unsupported",
                        "file_type": content_type or item.get("file_type") or "application/octet-stream",
                        "error": error_message,
                        "saved_at": time.time(),
                    }
                    _atomic_write(manifest_path, json.dumps(manifest).encode("utf-8"))
                    record.update(
                        file_type=content_type or item.get("file_type") or "application/octet-stream",
                        status="unsupported",
                        error=error_message,
                    )
                    errors.append(f"{item['url']}: {record['error']}")
                    output.append(record)
                    continue
                digest = hashlib.sha256(content).hexdigest()
                company_dir.mkdir(parents=True, exist_ok=True)
                filename = _safe_title(digest) + extension
                path = company_dir / filename
                if not path.exists():
                    _atomic_write(path, content)
                manifest[item["url"]] = {
                    "name": filename,
                    "hash": digest,
                    "file_type": kind,
                    "saved_at": time.time(),
                }
                _atomic_write(manifest_path, json.dumps(manifest).encode("utf-8"))
            record.update({
                "file_type": kind,
                "content_hash": digest,
                "storage_name": path_to_storage_name(path, base),
            })
            try:
                text, page_texts, extraction_error = _extract(path, kind)
                if text:
                    record.update(status="processed", text=text[:500_000], pages=page_texts)
                elif extraction_error == "PDF is encrypted.":
                    record.update(status="encrypted", error=extraction_error)
                elif kind == "application/pdf" and extraction_error:
                    record.update(status="scanned_or_empty", error=extraction_error)
                else:
                    record.update(status="empty", error=extraction_error)
            except (OSError, ValueError, KeyError) as error:
                record.update(status="failed", error=f"Document extraction failed: {type(error).__name__}.")
            else:
                if kind == "text/html" and text:
                    from bs4 import BeautifulSoup

                    soup = BeautifulSoup(path.read_bytes(), "html.parser")
                    if soup.title:
                        record["title"] = soup.title.get_text(" ", strip=True)[:500]
            if record["error"]:
                errors.append(f"{item['url']}: {record['error']}")
        except (OSError, ValueError, TypeError) as error:
            message = "Local document storage operation failed." if isinstance(error, OSError) else str(error)
            record.update(status="failed", error=message)
            errors.append(f"{item['url']}: {message}")
        except Exception as error:
            record.update(status="failed", error=f"Processing failed: {type(error).__name__}.")
            errors.append(f"{item['url']}: {type(error).__name__}")
        finally:
            if response is not None:
                response.close()
        output.append(record)
        if progress:
            progress({"step": "processing_documents", "event_type": "document_processed",
                      "title": record["title"], "current_url": item["url"],
                      "processing_status": record["status"], "documents_processed": len(output),
                      "message": f"{record['status']}: {record['title']}"})
    return output, errors
