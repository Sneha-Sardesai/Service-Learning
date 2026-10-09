"""Bounded, robots-aware crawler for an explicitly confirmed company website."""

from __future__ import annotations

import heapq
import ipaddress
import os
import socket
import time
from typing import Callable
from urllib.parse import urldefrag, urljoin, urlparse, urlunparse
from urllib.robotparser import RobotFileParser

import requests
from bs4 import BeautifulSoup

KEYWORDS = (
    "csr", "corporate social responsibility", "sustainability", "esg",
    "brsr", "business responsibility", "annual report", "integrated report",
    "governance", "csr policy", "social impact", "community",
)
USER_AGENT = "ServiceLearningCSRResearcher/1.0 (educational research)"
REDIRECT_CODES = {301, 302, 303, 307, 308}
DOCUMENT_TYPES = {
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}


class UnsafeUrlError(ValueError):
    pass


def normalize_url(value: str) -> str:
    parsed = urlparse(value.strip())
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise UnsafeUrlError("URL must include an http:// or https:// host.")
    if parsed.username or parsed.password:
        raise UnsafeUrlError("URLs containing credentials are not allowed.")
    if parsed.port not in (None, 80, 443):
        raise UnsafeUrlError("Non-standard URL ports are not allowed.")
    host = parsed.hostname.casefold().rstrip(".")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        raise UnsafeUrlError("IP-address URLs are not allowed; enter the official domain.")
    path = parsed.path or "/"
    normalized = urlunparse((parsed.scheme, host, path, "", parsed.query, ""))
    if len(normalized) > 2048:
        raise UnsafeUrlError("URL exceeds the supported length.")
    return normalized


def is_public_host(host: str) -> bool:
    try:
        addresses = [ipaddress.ip_address(host)]
    except ValueError:
        try:
            addresses = [
                ipaddress.ip_address(item[4][0])
                for item in socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
            ]
        except (OSError, ValueError):
            return False
    return bool(addresses) and all(address.is_global for address in addresses)


def host_allowed(url: str, root_host: str, approved_hosts: set[str] | None = None) -> bool:
    host = (urlparse(url).hostname or "").casefold().rstrip(".")
    approved = approved_hosts or {root_host.casefold().rstrip(".")}
    return host in approved


def relevance(text: str) -> int:
    lowered = text.casefold()
    return sum(keyword in lowered for keyword in KEYWORDS)


class OfficialSiteCrawler:
    def __init__(
        self,
        website: str,
        *,
        max_pages: int = 40,
        max_depth: int = 3,
        timeout: int = 15,
        max_bytes: int = 3_000_000,
        user_agent: str = USER_AGENT,
        allowed_subdomains: list[str] | None = None,
        session: requests.Session | None = None,
    ):
        self.website = normalize_url(website)
        self.root_host = urlparse(self.website).hostname or ""
        configured_hosts = allowed_subdomains
        if configured_hosts is None:
            configured_hosts = [
                host.strip()
                for host in os.getenv("CRAWL_ALLOWED_SUBDOMAINS", "").split(",")
                if host.strip()
            ]
        self.approved_hosts = {self.root_host.casefold().rstrip(".")}
        for subdomain in configured_hosts:
            host = subdomain.casefold().strip().rstrip(".")
            if any(character in host for character in ("/", ":", "@", "?", "#")):
                raise ValueError("Approved subdomains must be host names without URL paths or ports.")
            if host == self.root_host.casefold().rstrip("."):
                continue
            if not host.endswith("." + self.root_host.casefold().rstrip(".")):
                raise ValueError("Approved subdomains must belong to the confirmed company domain.")
            self.approved_hosts.add(host)
        self.max_pages = max(1, min(max_pages, 200))
        self.max_depth = max(0, min(max_depth, 8))
        self.timeout = max(3, min(timeout, 60))
        self.max_bytes = max(100_000, min(max_bytes, 20_000_000))
        self.user_agent = user_agent
        self.session = session or requests.Session()
        self.session.headers.update({"User-Agent": user_agent})
        self._robots: dict[str, RobotFileParser] = {}
        self._last_request = 0.0
        self._delay = max(0.0, min(float(os.getenv("CRAWL_MIN_DELAY_SECONDS", "1")), 10.0))

    def _robots_parser(self, url: str) -> RobotFileParser:
        origin = urlunparse((*urlparse(url)[:2], "", "", "", ""))
        if origin in self._robots:
            return self._robots[origin]
        robots_url = origin + "/robots.txt"
        parser = RobotFileParser(robots_url)
        try:
            response = self._request(robots_url, check_robots=False)
            if response.status_code in (404, 410):
                parser.parse([])
            elif response.status_code < 400:
                body = response.raw.read(500_001, decode_content=True)
                if len(body) > 500_000:
                    parser.parse(["User-agent: *", "Disallow: /"])
                else:
                    parser.parse(body.decode(response.encoding or "utf-8", errors="replace").splitlines())
            else:
                parser.parse(["User-agent: *", "Disallow: /"])
            response.close()
        except (requests.RequestException, UnsafeUrlError):
            parser.parse(["User-agent: *", "Disallow: /"])
        delay = parser.crawl_delay(self.user_agent) or parser.crawl_delay("*")
        if delay:
            delay_seconds = float(delay)
            if delay_seconds > 300:
                parser.parse(["User-agent: *", "Disallow: /"])
            else:
                self._delay = max(self._delay, delay_seconds)
        self._robots[origin] = parser
        return parser

    def _request(self, url: str, *, check_robots: bool = True) -> requests.Response:
        current = normalize_url(url)
        if not host_allowed(current, self.root_host, self.approved_hosts):
            raise UnsafeUrlError("URL is outside the confirmed company domain.")
        for _ in range(6):
            host = urlparse(current).hostname or ""
            if not is_public_host(host):
                raise UnsafeUrlError("URL host does not resolve to a public address.")
            if check_robots and not self._robots_parser(current).can_fetch(self.user_agent, current):
                raise UnsafeUrlError("URL is disallowed by robots.txt.")
            wait = self._delay - (time.monotonic() - self._last_request)
            if wait > 0:
                time.sleep(wait)
            response = self.session.get(
                current, timeout=self.timeout, allow_redirects=False, stream=True
            )
            self._last_request = time.monotonic()
            if response.status_code not in REDIRECT_CODES:
                response.url = current
                return response
            location = response.headers.get("Location")
            response.close()
            if not location:
                raise requests.RequestException("Redirect omitted its destination.")
            current = normalize_url(urljoin(current, location))
            if not host_allowed(current, self.root_host, self.approved_hosts):
                raise UnsafeUrlError("Redirect points outside the confirmed company domain.")
        raise requests.RequestException("Too many redirects.")

    def crawl(self, progress: Callable[[dict], None] | None = None) -> dict:
        pages: list[dict] = []
        documents: dict[str, dict] = {}
        errors: list[str] = []
        visited: set[str] = set()
        queued: set[str] = set()
        frontier: list[tuple[int, int, str, int]] = []
        pages_visited = 0
        sequence = 0
        heapq.heappush(frontier, (0, sequence, self.website, 0))
        queued.add(self.website)

        while frontier and pages_visited < self.max_pages:
            _priority, _order, url, depth = heapq.heappop(frontier)
            if url in visited:
                continue
            visited.add(url)
            pages_visited += 1
            if progress:
                progress({"step": "crawling", "pages_visited": pages_visited, "current_url": url})
            try:
                response = self._request(url)
                if response.status_code >= 400:
                    response.close()
                    response.raise_for_status()
                final_url = normalize_url(response.url)
                if not host_allowed(final_url, self.root_host, self.approved_hosts):
                    response.close()
                    raise UnsafeUrlError("Response URL left the confirmed domain.")
                if final_url != url and final_url in visited:
                    response.close()
                    continue
                visited.add(final_url)
                content_type = response.headers.get("Content-Type", "").casefold()
                if "pdf" in content_type or final_url.casefold().endswith(".pdf"):
                    documents.setdefault(final_url, self._document_link(final_url, "", "application/pdf"))
                    response.close()
                    continue
                if "html" not in content_type and "xhtml" not in content_type:
                    response.close()
                    continue
                body = response.raw.read(self.max_bytes + 1, decode_content=True)
                response.close()
                if len(body) > self.max_bytes:
                    errors.append(f"{url}: HTML page exceeded the size limit.")
                    continue
                soup = BeautifulSoup(body, "html.parser")
                title = soup.title.get_text(" ", strip=True) if soup.title else final_url
                page_text = " ".join(soup.stripped_strings)[:100_000]
                pages.append({
                    "url": final_url,
                    "title": title[:500],
                    "text": page_text,
                    "relevance": relevance(f"{title} {final_url} {page_text[:3000]}"),
                })
                for anchor in soup.find_all("a", href=True):
                    href = (anchor.get("href") or "").strip()
                    if not href or href.startswith(("#", "mailto:", "tel:", "javascript:", "data:")):
                        continue
                    try:
                        target = normalize_url(urljoin(final_url, href))
                    except UnsafeUrlError:
                        continue
                    if not host_allowed(target, self.root_host, self.approved_hosts):
                        continue
                    label = anchor.get_text(" ", strip=True)
                    target_text = f"{label} {href} {target}"
                    score = relevance(target_text)
                    extension = next(
                        (ext for ext in DOCUMENT_TYPES if urlparse(target).path.casefold().endswith(ext)),
                        None,
                    )
                    if extension or "pdf" in anchor.get("type", "").casefold():
                        file_type = DOCUMENT_TYPES.get(extension, "application/pdf")
                        documents.setdefault(target, self._document_link(target, label, file_type))
                    elif depth < self.max_depth and target not in queued and target not in visited:
                        queued.add(target)
                        sequence += 1
                        heapq.heappush(frontier, (-score, sequence, target, depth + 1))
            except (requests.RequestException, UnsafeUrlError, OSError) as error:
                errors.append(f"{url}: {error}")
        pages.sort(key=lambda item: (-item["relevance"], item["url"]))
        docs = sorted(documents.values(), key=lambda item: (-relevance(item["title"] + item["url"]), item["url"]))
        return {
            "pages": pages,
            "documents": docs,
            "errors": errors,
            "pages_visited": pages_visited,
            "warnings": [],
        }

    @staticmethod
    def _document_link(url: str, title: str, file_type: str) -> dict:
        return {
            "url": url,
            "title": (title or url.rsplit("/", 1)[-1] or url)[:500],
            "file_type": file_type,
        }


def crawl(website: str, **options) -> dict:
    return OfficialSiteCrawler(website, **options).crawl()
