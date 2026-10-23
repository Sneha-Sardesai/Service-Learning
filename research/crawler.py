"""Bounded, robots-aware crawler for an explicitly confirmed company website."""

from __future__ import annotations

import heapq
import ipaddress
import os
import re
import socket
import time
import xml.etree.ElementTree as ET
from typing import Callable
from urllib.parse import parse_qsl, urlencode, urldefrag, urljoin, urlparse, urlunparse
from urllib.robotparser import RobotFileParser

import requests
from bs4 import BeautifulSoup

KEYWORDS = (
    "corporate social responsibility", "business responsibility", "sustainability",
    "annual report", "integrated report", "responsibility report", "csr report",
    "esg report", "brsr", "csr", "sustainability report", "esg", "social impact",
    "csr policy", "community", "corporate responsibility", "annual-report",
    "sustainability-report", "csr-report", "brsr-report", "business-responsibility",
    "community-program", "investor relations", "investors", "sustainability-reporting",
)
TRACKING_KEYS = {"gclid", "dclid", "fbclid", "msclkid", "_ga", "_gl", "mc_cid", "mc_eid"}
LOW_VALUE_PATH = re.compile(
    r"(?:^|/)(?:search|calendar|events-calendar|tag|author|category|product|products|"
    r"cart|checkout|login|sign-in|privacy|terms|contact|careers?|press|media|news|blog|about)(?:/|$)", re.I
)
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
SITEMAP_LIMIT = 20
SITEMAP_BYTES = 2_000_000
DOCUMENT_CANDIDATE_LIMIT = 500


class UnsafeUrlError(ValueError):
    pass


class CrawlBudgetExceeded(RuntimeError):
    pass


def bounded_int(value: int | str, default: int, low: int, high: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return max(low, min(number, high))


def bounded_duration(value: int | str, default: int = 900) -> int:
    return bounded_int(value, default, 10, 1800)


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
    path = re.sub(r"/{2,}", "/", parsed.path or "/")
    query = []
    for key, item in parse_qsl(parsed.query, keep_blank_values=True):
        lowered = key.casefold()
        if lowered.startswith("utm_") or lowered in TRACKING_KEYS:
            continue
        query.append((key, item))
    query.sort(key=lambda pair: (pair[0].casefold(), pair[1]))
    normalized = urlunparse((parsed.scheme.casefold(), host, path, "", urlencode(query, doseq=True), ""))
    if len(normalized) > 2048:
        raise UnsafeUrlError("URL exceeds the supported length.")
    return normalized


def is_public_host(host: str) -> bool:
    try:
        addresses = [ipaddress.ip_address(host)]
    except ValueError:
        try:
            addresses = [ipaddress.ip_address(item[4][0]) for item in socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)]
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


def link_priority(url: str, anchor: str = "", context: str = "", *, from_sitemap: bool = False) -> int:
    parsed = urlparse(url)
    path = parsed.path.casefold().replace("_", "-")
    terms = f"{path} {anchor} {url}"
    score = relevance(terms) * 8
    if score and context:
        score += min(relevance(context), 5) * 2
    if re.search(r"/sustainab|/csr|/esg|/brsr|/responsib|/community|/annual-report|/integrated-report", path):
        score += 24
    if re.search(r"/investor|/investors|/shareholder|/financial-report", path):
        score += 12
    if any(path.endswith(ext) for ext in DOCUMENT_TYPES):
        score += 22 if relevance(terms) else -30
    if LOW_VALUE_PATH.search(path) and not relevance(terms):
        score -= 35
    if re.search(r"(?:^|/)(?:page|page-\d+|\d{4}/\d{1,2})(?:/|$)", path) or re.search(r"(?:^|&)(?:page|p|offset|sort|sort_by|filter|category|tag)=", parsed.query, re.I):
        score -= 24
    if from_sitemap:
        score += 18
    return score


def _origin(url: str) -> str:
    parsed = urlparse(url)
    return urlunparse((parsed.scheme, parsed.netloc, "", "", "", ""))


class OfficialSiteCrawler:
    def __init__(
        self,
        website: str,
        *,
        max_pages: int = 80,
        max_depth: int = 4,
        timeout: int = 15,
        max_duration_seconds: int = 900,
        max_bytes: int = 3_000_000,
        user_agent: str = "ServiceLearningCSRResearcher/1.0 (educational research)",
        allowed_subdomains: list[str] | None = None,
        allowed_external_hosts: list[str] | None = None,
        session: requests.Session | None = None,
    ):
        self.website = normalize_url(website)
        self.root_host = urlparse(self.website).hostname or ""
        configured_hosts = allowed_subdomains
        if configured_hosts is None:
            configured_hosts = [host.strip() for host in os.getenv("CRAWL_ALLOWED_SUBDOMAINS", "").split(",") if host.strip()]
        self.approved_hosts = {self.root_host.casefold().rstrip(".")}
        # The only implicit alternate host is the validated www counterpart.
        bare = self.root_host[4:] if self.root_host.startswith("www.") else self.root_host
        self.approved_hosts.update({bare, f"www.{bare}"})
        for subdomain in configured_hosts:
            host = subdomain.casefold().strip().rstrip(".")
            if any(character in host for character in ("/", ":", "@", "?", "#")):
                raise ValueError("Approved subdomains must be host names without URL paths or ports.")
            if host == self.root_host.casefold().rstrip("."):
                continue
            if not host.endswith("." + bare) and host not in {bare, f"www.{bare}"}:
                raise ValueError("Approved subdomains must belong to the confirmed company domain.")
            self.approved_hosts.add(host)
        external = allowed_external_hosts
        if external is None:
            external = [host.strip() for host in os.getenv("CRAWL_ALLOWED_EXTERNAL_HOSTS", "").split(",") if host.strip()]
        self.allowed_external_hosts = set()
        for raw_host in external:
            host = raw_host.casefold().strip().rstrip(".")
            if not host or any(character in host for character in ("/", ":", "@", "?", "#")):
                raise ValueError("External host approvals must be exact hostnames, without paths or ports.")
            if host in self.approved_hosts:
                continue
            self.allowed_external_hosts.add(host)
        self.request_hosts = self.approved_hosts | self.allowed_external_hosts
        self.max_pages = bounded_int(max_pages, 80, 1, 200)
        self.max_depth = bounded_int(max_depth, 4, 0, 8)
        self.timeout = bounded_int(timeout, 15, 3, 60)
        self.max_duration_seconds = bounded_duration(max_duration_seconds)
        self.max_bytes = bounded_int(max_bytes, 3_000_000, 100_000, 20_000_000)
        self.user_agent = user_agent
        self.session = session or requests.Session()
        self.session.headers.update({"User-Agent": user_agent})
        self._robots: dict[str, RobotFileParser] = {}
        self._sitemap_hints: dict[str, list[str]] = {}
        self._last_request = 0.0
        self._clock = time.monotonic
        self._delay = max(0.0, min(float(os.getenv("CRAWL_MIN_DELAY_SECONDS", "1")), 10.0))
        self._deadline: float | None = None
        self._progress: Callable[[dict], None] | None = None
        self._skipped_links: list[dict] = []
        self._blocked_candidates: list[dict] = []

    def _remaining(self) -> float:
        if self._deadline is None:
            return float(self.timeout)
        remaining = self._deadline - self._clock()
        if remaining <= 0:
            raise CrawlBudgetExceeded("Crawl duration limit reached.")
        return remaining

    def _emit(self, event_type: str, message: str, *, step: str = "crawling", **details) -> None:
        if self._progress:
            self._progress({"step": step, "event_type": event_type, "message": message, **details})

    def _robots_parser(self, url: str) -> RobotFileParser:
        origin = _origin(url)
        if origin in self._robots:
            return self._robots[origin]
        robots_url = origin + "/robots.txt"
        parser = RobotFileParser(robots_url)
        self._sitemap_hints[origin] = []
        try:
            response = self._request(robots_url, check_robots=False)
            if response.status_code in (404, 410):
                parser.parse([])
            elif response.status_code < 400:
                body = response.raw.read(500_001, decode_content=True)
                if len(body) > 500_000:
                    parser.parse(["User-agent: *", "Disallow: /"])
                else:
                    lines = body.decode(response.encoding or "utf-8", errors="replace").splitlines()
                    parser.parse(lines)
                    self._sitemap_hints[origin] = [line.split(":", 1)[1].strip() for line in lines if line.strip().casefold().startswith("sitemap:") and ":" in line]
            else:
                parser.parse(["User-agent: *", "Disallow: /"])
            response.close()
        except CrawlBudgetExceeded:
            raise
        except (requests.RequestException, UnsafeUrlError):
            parser.parse(["User-agent: *", "Disallow: /"])
        self._robots[origin] = parser
        delay = parser.crawl_delay(self.user_agent) or parser.crawl_delay("*")
        if delay:
            delay_seconds = float(delay)
            if delay_seconds > 300:
                parser.parse(["User-agent: *", "Disallow: /"])
            else:
                self._delay = max(self._delay, delay_seconds)
        return parser

    def _request(self, url: str, *, check_robots: bool = True) -> requests.Response:
        current = normalize_url(url)
        if not host_allowed(current, self.root_host, self.request_hosts):
            raise UnsafeUrlError("URL is outside the confirmed company domain and approved hosts.")
        for _ in range(6):
            remaining = self._remaining()
            host = urlparse(current).hostname or ""
            if not is_public_host(host):
                raise UnsafeUrlError("URL host does not resolve to a public address.")
            if check_robots and not self._robots_parser(current).can_fetch(self.user_agent, current):
                raise UnsafeUrlError("URL is disallowed by robots.txt.")
            wait = self._delay - (self._clock() - self._last_request)
            if wait > 0:
                time.sleep(min(wait, self._remaining()))
            response = self.session.get(current, timeout=max(1, min(self.timeout, int(self._remaining()))), allow_redirects=False, stream=True)
            self._last_request = self._clock()
            if response.status_code not in REDIRECT_CODES:
                response.url = current
                return response
            location = response.headers.get("Location")
            response.close()
            if not location:
                raise requests.RequestException("Redirect omitted its destination.")
            redirected = normalize_url(urljoin(current, location))
            if not host_allowed(redirected, self.root_host, self.request_hosts):
                raise UnsafeUrlError("Redirect points outside the confirmed domain and approved hosts.")
            current = redirected
        raise requests.RequestException("Too many redirects.")

    def _read_sitemap(self, sitemap_url: str) -> tuple[list[str], list[str]]:
        try:
            url = normalize_url(sitemap_url)
            if not host_allowed(url, self.root_host, self.approved_hosts):
                self._emit("sitemap_skipped", f"Skipped external sitemap host: {url}", current_url=url)
                return [], []
            if not self._robots_parser(url).can_fetch(self.user_agent, url):
                self._emit("sitemap_skipped", f"Sitemap disallowed by robots.txt: {url}", current_url=url)
                return [], []
            response = self._request(url)
            if response.status_code >= 400:
                response.close()
                self._emit("sitemap_checked", f"Sitemap unavailable (HTTP {response.status_code}): {url}", current_url=url)
                return [], []
            body = response.raw.read(SITEMAP_BYTES + 1, decode_content=True)
            response.close()
            if len(body) > SITEMAP_BYTES:
                self._emit("sitemap_skipped", f"Sitemap exceeded the {SITEMAP_BYTES}-byte limit: {url}", current_url=url)
                return [], []
            root = ET.fromstring(body)
            tag = root.tag.rsplit("}", 1)[-1].casefold()
            locations = [item.text.strip() for item in root.iter() if item.tag.rsplit("}", 1)[-1].casefold() == "loc" and item.text and item.text.strip()]
            self._emit("sitemap_checked", f"Checked sitemap ({len(locations)} entries): {url}", current_url=url, sitemap_entries=len(locations))
            if tag == "sitemapindex":
                return [], locations
            return locations, []
        except CrawlBudgetExceeded:
            raise
        except (requests.RequestException, UnsafeUrlError, ET.ParseError, OSError, ValueError) as error:
            self._emit("sitemap_checked", f"Sitemap could not be used: {sitemap_url} ({str(error)[:160]})", current_url=sitemap_url)
            return [], []

    def _discover_sitemaps(self) -> tuple[list[str], list[str]]:
        origin = _origin(self.website)
        try:
            self._robots_parser(self.website)
        except CrawlBudgetExceeded:
            return [], []
        hints = list(self._sitemap_hints.get(origin, []))
        for path in ("/sitemap.xml", "/sitemap_index.xml"):
            hints.append(origin + path)
        queue = []
        seen = set()
        found, checked = [], []
        while hints and len(checked) < SITEMAP_LIMIT:
            raw = hints.pop(0)
            try:
                url = normalize_url(urljoin(origin + "/", raw))
            except UnsafeUrlError:
                self._emit("sitemap_skipped", f"Skipped invalid sitemap URL: {raw}", current_url=str(raw)[:2048])
                continue
            if url in seen:
                continue
            seen.add(url)
            if not host_allowed(url, self.root_host, self.approved_hosts):
                self._emit("sitemap_skipped", f"Skipped sitemap outside confirmed company host: {url}", current_url=url)
                continue
            checked.append(url)
            urls, children = self._read_sitemap(url)
            found.extend(urls)
            queue.extend(children)
            if not hints and queue:
                hints, queue = queue, []
            if self._deadline is not None and self._clock() >= self._deadline:
                break
        return found, checked

    def crawl(self, progress: Callable[[dict], None] | None = None) -> dict:
        self._deadline = self._clock() + self.max_duration_seconds
        self._progress = progress
        self._skipped_links = []
        self._blocked_candidates = []
        start_time = self._clock()
        pages: list[dict] = []
        documents: dict[str, dict] = {}
        errors: list[str] = []
        visited: set[str] = set()
        queued: set[str] = set()
        frontier: list[tuple[int, int, str, int]] = []
        pages_visited = 0
        depth_blocked = 0
        sequence = 0
        stop_reason = None
        pages_attempted: list[str] = []

        try:
            sitemap_urls, sitemaps_checked = self._discover_sitemaps()
        except CrawlBudgetExceeded:
            sitemap_urls, sitemaps_checked = [], []
            stop_reason = "duration_limit"

        def add_url(raw_url: str, score: int, depth: int, *, sitemap: bool = False, source: str | None = None) -> None:
            nonlocal sequence, depth_blocked
            try:
                url = normalize_url(raw_url)
            except UnsafeUrlError:
                return
            if not host_allowed(url, self.root_host, self.approved_hosts):
                parsed = urlparse(url)
                if any(ext == parsed.path.casefold()[-len(ext):] for ext in (".pdf",) if parsed.path.casefold().endswith(ext)) or relevance(url) > 0:
                    candidate = {"url": url, "source_page_url": source, "reason": "External host is not approved; verify the company relationship and allowlist the exact host before crawling."}
                    if candidate not in self._blocked_candidates:
                        self._blocked_candidates.append(candidate)
                        self._emit("candidate_host_blocked", f"Report candidate is on an unapproved host; left uncrawled: {url}", step="candidate_found", current_url=url, source_page_url=source)
                return
            if url in queued or url in visited:
                return
            if depth > self.max_depth:
                depth_blocked += 1
                return
            sequence += 1
            queued.add(url)
            heapq.heappush(frontier, (-score, sequence, url, depth))
            self._emit("page_prioritized", f"Prioritized {'sitemap' if sitemap else 'link'} page (score {score}, depth {depth}): {url}", current_url=url, priority_score=score, depth=depth)

        add_url(self.website, 1000, 0)
        for raw_url in sitemap_urls:
            try:
                url = normalize_url(urljoin(self.website, raw_url))
            except UnsafeUrlError:
                continue
            score = link_priority(url, from_sitemap=True)
            if urlparse(url).path.casefold().endswith(".pdf"):
                if host_allowed(url, self.root_host, self.approved_hosts) and relevance(url):
                    documents.setdefault(url, self._document_link(url, "", "application/pdf", None, "Sitemap entry", bool(relevance(url))))
                    self._emit("report_candidate_found", f"Found a sitemap report candidate: {url}", step="candidate_found", current_url=url, documents_discovered=len(documents))
                elif not host_allowed(url, self.root_host, self.approved_hosts):
                    add_url(url, score, 1, sitemap=True)
            else:
                add_url(url, score, 1, sitemap=True)

        while frontier and pages_visited < self.max_pages:
            if self._clock() >= self._deadline:
                stop_reason = "duration_limit"
                break
            _priority, _order, url, depth = heapq.heappop(frontier)
            if url in visited:
                continue
            visited.add(url)
            pages_visited += 1
            pages_attempted.append(url)
            self._emit("page_visited", f"Visiting prioritized page {pages_visited}/{self.max_pages} at depth {depth}: {url}", current_url=url, pages_visited=pages_visited, depth=depth)
            try:
                response = self._request(url)
                if response.status_code >= 400:
                    response.close()
                    response.raise_for_status()
                final_url = normalize_url(response.url)
                if not host_allowed(final_url, self.root_host, self.request_hosts):
                    response.close()
                    raise UnsafeUrlError("Response URL left the confirmed domain and approved hosts.")
                if final_url != url and final_url in visited:
                    response.close()
                    continue
                visited.add(final_url)
                content_type = response.headers.get("Content-Type", "").casefold()
                if "pdf" in content_type or final_url.casefold().endswith(".pdf"):
                    documents.setdefault(final_url, self._document_link(final_url, "", "application/pdf", url, "", False))
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
                headings = " ".join(item.get_text(" ", strip=True) for item in soup.find_all(["h1", "h2", "h3"]))[:5000]
                metadata = " ".join((tag.get("content") or "") for tag in soup.find_all("meta") if tag.get("name", "").casefold() in {"description", "keywords"})[:3000]
                for chrome in soup.find_all(("nav", "header", "footer", "script", "style", "noscript", "aside", "form")):
                    chrome.decompose()
                content = soup.find("main") or soup.find("article") or soup.body or soup
                page_text = " ".join(content.stripped_strings)[:100_000]
                body_non_nav = " ".join(t.strip() for t in content.find_all(string=True) if t.parent.name not in ("a", "button", "nav", "header", "footer"))
                body_relevance = relevance(f"{title} {headings} {metadata} {body_non_nav[:6000]}")
                page_score = link_priority(final_url, title) + body_relevance * 8
                pages.append({"url": final_url, "title": title[:500], "text": page_text,
                              "relevance": page_score, "depth": depth})
                for anchor in soup.find_all("a", href=True):
                    href = (anchor.get("href") or "").strip()
                    if not href or href.startswith(("#", "mailto:", "tel:", "javascript:", "data:")):
                        continue
                    try:
                        target = normalize_url(urljoin(final_url, href))
                    except UnsafeUrlError:
                        continue
                    label = anchor.get_text(" ", strip=True)
                    anchor_context = f"{label} {href} {title} {headings} {metadata}"
                    score = link_priority(target, label, f"{title} {headings} {metadata}")
                    extension = next((ext for ext in DOCUMENT_TYPES if urlparse(target).path.casefold().endswith(ext)), None)
                    source_page_relevant = relevance(f"{final_url} {title} {headings} {metadata}") > 0
                    looks_report = relevance(f"{target} {label}") > 0 or source_page_relevant
                    official_host = host_allowed(target, self.root_host, self.approved_hosts)
                    approved_report_host = urlparse(target).hostname in self.allowed_external_hosts
                    if not official_host and not (approved_report_host and extension == ".pdf"):
                        if extension == ".pdf" or looks_report:
                            candidate = {"url": target, "source_page_url": final_url,
                                         "source_page_title": title[:500],
                                         "reason": "External host is not approved; verify the company relationship and allowlist the exact host before crawling."}
                            if candidate not in self._blocked_candidates:
                                self._blocked_candidates.append(candidate)
                                self._emit("candidate_host_blocked", f"Possible report link on an unapproved host; left uncrawled: {target}", step="candidate_found", current_url=target, source_page_url=final_url)
                        continue
                    if extension == ".pdf" or "pdf" in anchor.get("type", "").casefold():
                        if not looks_report:
                            if len(self._skipped_links) < 500:
                                self._skipped_links.append({"url": target, "source_page_url": final_url, "reason": "unrelated_document_link"})
                            self._emit("link_skipped", f"Skipped a PDF link without a CSR or reporting context: {target}", current_url=target, source_page_url=final_url)
                            continue
                        if target in documents or len(documents) >= DOCUMENT_CANDIDATE_LIMIT:
                            continue
                        if target not in documents:
                            documents[target] = self._document_link(target, label, "application/pdf", final_url, title, source_page_relevant or relevance(f"{target} {label}") > 0)
                            self._emit("report_candidate_found", f"Found a possible report on {final_url}: {label or target}", step="candidate_found", current_url=target, documents_discovered=len(documents))
                    elif depth < self.max_depth:
                        if LOW_VALUE_PATH.search(urlparse(target).path) and not relevance(anchor_context):
                            if len(self._skipped_links) < 500:
                                self._skipped_links.append({"url": target, "source_page_url": final_url, "reason": "low_value_navigation"})
                            self._emit("link_skipped", f"Skipped low-value navigation link: {target}", current_url=target, source_page_url=final_url)
                            continue
                        add_url(target, score, depth + 1, source=final_url)
                    else:
                        depth_blocked += 1
            except CrawlBudgetExceeded:
                stop_reason = "duration_limit"
                break
            except (requests.RequestException, UnsafeUrlError, OSError) as error:
                errors.append(f"{url}: {error}")

        if stop_reason is None:
            if frontier and pages_visited >= self.max_pages:
                stop_reason = "page_limit"
            elif depth_blocked:
                stop_reason = "depth_limit"
            elif not any(page["relevance"] > 0 for page in pages) and not documents:
                stop_reason = "no_relevant_material"
            else:
                stop_reason = "completed"
        if stop_reason in {"page_limit", "depth_limit", "duration_limit"}:
            message = {
                "page_limit": f"Crawl stopped at the configured page budget ({self.max_pages} pages). Increase MAX_CRAWL_PAGES or narrow the site path if you need more coverage.",
                "depth_limit": f"Crawl stopped at the configured depth budget ({self.max_depth}). Increase MAX_CRAWL_DEPTH if relevant pages are linked more deeply.",
                "duration_limit": f"Crawl stopped at the configured duration budget ({self.max_duration_seconds} seconds). Increase CRAWL_MAX_DURATION_SECONDS or reduce request delays.",
            }[stop_reason]
            self._emit("crawl_limit_reached", message, step="limit_reached", stop_reason=stop_reason, pages_visited=pages_visited)
        elif stop_reason == "no_relevant_material":
            self._emit("no_relevant_material", "Crawl finished without finding relevant CSR, ESG, sustainability, annual-report, BRSR, or community material.", step="finished")
        pages.sort(key=lambda item: (-item["relevance"], item["url"]))
        docs = sorted(documents.values(), key=lambda item: (-link_priority(item["url"], item["title"]), item["url"]))
        warnings = []
        if stop_reason in {"page_limit", "depth_limit", "duration_limit"}:
            warnings.append({
                "page_limit": f"Crawl page limit reached ({self.max_pages}); additional prioritized pages were not visited.",
                "depth_limit": f"Crawl depth limit reached ({self.max_depth}); deeper links were not visited.",
                "duration_limit": f"Crawl duration limit reached ({self.max_duration_seconds} seconds); additional pages were not visited.",
            }[stop_reason])
        return {
            "pages": pages,
            "documents": docs,
            "errors": errors,
            "warnings": warnings,
            "pages_visited": pages_visited,
            "pages_visited_urls": pages_attempted,
            "sitemaps_checked": sitemaps_checked,
            "relevant_pages_found": sum(page["relevance"] > 0 for page in pages),
            "candidate_documents_found": len(docs),
            "blocked_external_candidates": self._blocked_candidates,
            "skipped_links": self._skipped_links,
            "stop_reason": stop_reason,
            "duration_seconds": round(self._clock() - start_time, 2),
        }

    @staticmethod
    def _document_link(url: str, title: str, file_type: str, source_page_url: str | None = None,
                       source_page_title: str = "", source_page_relevant: bool = False) -> dict:
        return {
            "url": url,
            "title": (title or url.rsplit("/", 1)[-1] or url)[:500],
            "file_type": file_type,
            "source_page_url": source_page_url,
            "source_page_title": source_page_title,
            "source_page_relevant": source_page_relevant,
        }


def crawl(website: str, **options) -> dict:
    return OfficialSiteCrawler(website, **options).crawl()
