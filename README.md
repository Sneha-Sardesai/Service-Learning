# CSR Company Research and Management System

A source-first web application and CLI for maintaining a company directory, crawling confirmed official websites for CSR/ESG/BRSR material, extracting document text, and recording evidence-linked findings for human review.

The system does not use a search engine to guess a company's official website. Local crawling and deterministic extraction work without a Gemini key. It is a research aid: extracted information is not legally verified and should not be used without checking the cited source.

## What works

- Company directory with name search, industry/status filters, create/edit/delete, duplicate-name protection, and official website links.
- Asynchronous research runs with status polling, crawl limits, recorded errors, document counts, and database persistence.
- Same-site HTML crawler that prioritizes CSR, sustainability, ESG, BRSR, annual report, governance, and social-impact material.
- Robots.txt checks, crawl delays, explicit subdomain allow-list, same-site redirect checks, public-IP/DNS checks, request timeouts, page/download-size caps, and URL de-duplication.
- Bounded PDF/HTML download and text extraction, page-level PDF evidence, content-addressed cache, and clear scanned/encrypted/unsupported document statuses.
- Local pattern/keyword extraction for CSR amounts and source-linked observations. Gemini JSON structuring is optional, validates evidence against submitted source text, and does not overwrite reviewed findings.
- Findings can be edited, approved, rejected, or marked unavailable. Each finding retains its source URL, excerpt, extraction method, review state, and financial year when present.
- MySQL-backed normalized tables for companies, research runs, documents, and findings.

## Architecture

```text
React + Vite
  -> Express REST API
     -> MySQL (parameterized queries and transactions)
     -> shared research workflow
        -> Python 3
           -> confirmed-domain crawler
           -> safe PDF/HTML extraction
           -> deterministic evidence extraction
           -> optional Gemini structuring
```

The CLI and web app use the same Python researcher and persistence workflow. API research runs return immediately and can be polled while crawling and extraction proceed.

## Folder structure

```text
backend/
  cli.js                    Interactive CLI
  server.js                 Express API
  database.js               MySQL connection pool and transactions
  researchWorkflow.js       Shared persisted research-run workflow
  researchService.js        Node-to-Python process bridge
  validation.js             Company and website validation
  test/                     Node API and validation tests
frontend/
  src/App.jsx               Dashboard, directory, profile, reviews
  src/api.js                REST client
research/
  research.py               Python CLI / JSON research entry point
  crawler.py                Bounded, robots-aware official-site crawler
  document_extractor.py     Document download, cache, and text extraction
  information_extractor.py  Local and optional Gemini extraction
  company_domains.json      Small sample registry; verify before use
  tests/                    Mocked Python tests
database/
  schema.sql                MySQL schema
  seed.sql                  Intentionally contains no fake research rows
```

## Prerequisites

- Windows 10/11 and PowerShell (commands below are PowerShell commands)
- Node.js 20.19+ or 22.12+ (required by the installed Vite version), with npm
- Python 3.10+
- MySQL 8+
- Internet access to company official websites when running a crawl

## Install from the project root

Open PowerShell in the repository root:

```powershell
py -3 --version
node --version
npm.cmd --version
```

Create a virtual environment and install the crawler/document dependencies:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Install Node dependencies in each app folder:

```powershell
Set-Location backend
npm.cmd install
Set-Location ..\frontend
npm.cmd install
Set-Location ..
```

For optional Gemini structuring only:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-gemini.txt
```

## Environment configuration

Create a local `.env` without replacing an existing one:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
```

Set the MySQL connection values in `.env`. The example values are placeholders; use the credentials for your local MySQL setup.

```dotenv
DB_HOST=localhost
DB_PORT=3306
DB_NAME=csr_research
DB_USER=csr_app
DB_PASSWORD=your_local_mysql_password
```

Gemini is optional. Leave `GEMINI_API_KEY` blank to use only the local extraction pipeline. Never commit `.env` or paste API keys into source code.
`VITE_API_BASE_URL` defaults to `/api`; keep that relative value when using the supplied Vite proxy.

Useful crawl settings in `.env`:

| Setting | Default | Purpose |
|---|---:|---|
| `MAX_CRAWL_PAGES` | 40 | Maximum HTML pages per run (clamped at 200) |
| `MAX_CRAWL_DEPTH` | 3 | Maximum link depth (clamped at 8) |
| `CRAWL_TIMEOUT_SECONDS` | 15 | Per-request timeout |
| `CRAWL_USER_AGENT` | ServiceLearningCSRResearcher/1.0 | Request user-agent |
| `CRAWL_MIN_DELAY_SECONDS` | 1 | Minimum delay between requests (robots crawl-delay can increase it) |
| `CRAWL_ALLOWED_SUBDOMAINS` | empty | Comma-separated hostnames explicitly approved in addition to the confirmed host |
| `MAX_HTML_BYTES` | 3 MB | Per-page HTML size cap |
| `MAX_DOCUMENT_BYTES` | 20 MB | Per-document download cap |
| `MAX_TOTAL_DOCUMENT_BYTES` | 60 MB | Total downloaded document cap per run |
| `MAX_DOCUMENTS_PER_RUN` | 12 | Maximum documents processed in one run |
| `DOCUMENT_CACHE_TTL_SECONDS` | 86400 | Reuse a locally cached URL/content hash for up to one day |
| `DOCUMENT_STORAGE_DIR` | `research/documents` | Local document storage; ignored by Git |
| `RESEARCH_TIMEOUT_MS` | 600000 | Maximum Node-to-Python research time |

Subdomains are not automatically trusted. Add an exact hostname to `CRAWL_ALLOWED_SUBDOMAINS` only after confirming that it is controlled by the company, for example `reports.example.com,investors.example.com`.

## MySQL schema setup

The schema script creates the `csr_research` database and its tables. From the project root, with MySQL installed and running:

```powershell
& 'C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe' -u root -p -e "SOURCE database/schema.sql"
```

If MySQL's `bin` directory is already on `PATH`, the shorter command is `mysql -u root -p -e "SOURCE database/schema.sql"`.

Create a restricted local app account from the MySQL prompt (replace the placeholder password yourself):

```sql
CREATE USER 'csr_app'@'localhost' IDENTIFIED BY 'replace-with-your-local-password';
GRANT SELECT, INSERT, UPDATE, DELETE ON csr_research.* TO 'csr_app'@'localhost';
```

Put that account in `.env`. `database/seed.sql` intentionally adds no fictional company or research facts; add real records through the application. If you change the schema later, back up your local database and apply a reviewed migration rather than deleting existing data.

## Run the application

Use two PowerShell terminals from the repository root.

Terminal 1 — API:

```powershell
Set-Location backend
npm.cmd start
```

The API listens at `http://localhost:5000`. For auto-restart during backend development:

```powershell
npm.cmd run devstart
```

Terminal 2 — React app:

```powershell
Set-Location frontend
npm.cmd run dev
```

Open the Vite URL printed in that terminal, normally `http://localhost:5173`. Vite proxies `/api` to the Express backend.
The dashboard shows a setup state rather than sample metrics until the backend can connect to MySQL.

The same commands can be launched from the root with npm's `--prefix` option:

```powershell
npm.cmd --prefix backend start
npm.cmd --prefix frontend run dev
```

Build the frontend for a production bundle:

```powershell
Set-Location frontend
npm.cmd run build
```

The frontend is a development server/build only; serve the generated `frontend/dist` behind a configured web server in a deployment. This starter does not configure production hosting or authentication.

## Use the CLI

With MySQL configured, from `backend/`:

```powershell
npm.cmd run cli
```

Enter a company name and its confirmed official website. For a configured sample mapping, the CLI asks you to confirm it explicitly. The CLI saves company, run, documents, and findings to the same database when MySQL is configured.

Without MySQL configured, the CLI can still crawl a supplied domain, but it clearly reports that this run will not be saved.

The Python researcher can also be run directly from the project root:

```powershell
.\.venv\Scripts\python.exe research\research.py "Example Company" --website https://www.example.com
.\.venv\Scripts\python.exe research\research.py "Example Company" --website https://www.example.com --json
```

An unknown company never gets an automatically guessed domain. Supply the confirmed official website or add a reviewed entry to `research/company_domains.json`. The included Tata Motors entry is a sample mapping and must be checked by the researcher before use; it is not a universal verification.

## Use the web application

1. Open the dashboard and choose **Add company**.
2. Enter the display name and, after confirming it is the company's official site, enter its URL. Company records can be created before a URL is known, but research stays disabled until a site is confirmed.
3. Open the company profile or use **Research** in the directory to queue a run.
4. Follow the run's status and source counts in **Research runs** or the company profile.
5. Open source documents, compare findings with the supporting excerpt and URL, edit the value/year if needed, then approve, reject, or mark a field unavailable.

The company table supports name search, industry/status filters, and pagination. Deleting a company requires confirmation and cascades through its MySQL research history.

## How crawling and document processing work

1. A researcher saves the confirmed official website to the company profile.
2. The crawler requests that host, checks its `robots.txt`, and follows internal links up to the configured page/depth limits.
3. Pages and links are prioritized by CSR, corporate social responsibility, sustainability, ESG, BRSR, annual report, governance, and social-impact terms.
4. By default, only the confirmed host is crawled. Explicitly approved subdomains can be listed in `.env`.
5. Redirect targets are validated before following; URL credentials, IP literal URLs, local/private DNS targets, non-standard ports, and off-domain redirects are rejected.
6. Relevant HTML text and PDF contents are stored locally in a content-addressed directory and in the MySQL document record. Repeated downloads can be reused from the local cache during its configured TTL.
7. PDF extraction retains page numbers where available. Scanned or encrypted PDFs are reported; OCR is not implemented. Office files are recorded as unsupported and are never executed.
8. Local extraction records literal, source-supported amounts and relevant CSR passages. An optional Gemini request can structure a small set of relevant passages; output is schema-checked and rejected if its cited excerpt is not present in source text.
9. Findings remain `pending_review` until a researcher edits and approves/rejects them, or manually records information as unavailable.

Network failures, robots restrictions, rate limits, unsupported file types, and extraction errors are attached to the run/document rather than silently treated as successful evidence.

## REST API

All endpoints are prefixed with `/api`; JSON errors use `{ "error": "..." }`.

| Method and path | Purpose |
|---|---|
| `GET /api/health` | API/MySQL setup status |
| `GET /api/dashboard` | Real company, research, document, review counts, and recent runs |
| `GET /api/companies?q=&industry=&research_status=&page=` | Search/filter a paginated directory (50 records/page); also returns available industries |
| `POST /api/companies` | Add a company; website may be added later |
| `GET /api/companies/:id` | Profile, research history, documents, findings |
| `PATCH /api/companies/:id` | Edit company details/domain |
| `DELETE /api/companies/:id` | Delete company and related database records |
| `POST /api/companies/:id/research` | Queue an asynchronous research run (returns `202`) |
| `GET /api/research/:id` | Poll run status, counts, progress, and errors |
| `GET /api/research/:id/documents` | List sources for a run |
| `GET /api/documents/:id` | Read extracted text and processing status for a source |
| `GET /api/companies/:id/findings` | List company findings |
| `POST /api/companies/:id/findings` | Manually mark a field unavailable |
| `PATCH /api/findings/:id/review` | Edit a finding and set its review state |
| `POST /api/research` | Compatibility endpoint accepting `companyName` and a confirmed `website` |

Company deletion cascades to its database research records; local cached documents are not automatically removed. Do not expose the unauthenticated development API to an untrusted network.
When the backend restarts, persisted runs left queued/running by a prior process are marked failed with an interruption message; they do not remain stuck as active jobs.

## Tests

Run the focused automated suites from the project root:

```powershell
Set-Location backend
npm.cmd test
Set-Location ..
.\.venv\Scripts\python.exe -m unittest discover -s research\tests -v
Set-Location frontend
npm.cmd run build
```

The crawler tests use mocked responses and temporary files; they do not crawl live websites or call Gemini. Node API tests validate failures before database access. Database CRUD/integration tests require a configured local MySQL server; no live service or credentials are bundled.

## Limitations and troubleshooting

- A crawl only starts from the domain a researcher confirms. It does not use Google Search grounding, a search API, or domain guessing.
- Robots rules, crawl delays, off-host redirects, private DNS targets, configured size limits, and page limits may prevent discovery. Review the run's errors and confirm the domain/subdomain configuration.
- A discovered link is not proof that a document is current or accurate. Humans must verify the source and financial year.
- Local deterministic extraction is intentionally conservative and may miss tables, amounts without explicit currency, committee names, or scanned-PDF text.
- Gemini is optional and can be disabled, unavailable, malformed, or over quota without invalidating a crawl or local findings.
- There is no OCR, authentication, multi-user access control, production hosting configuration, or automatic deletion of local cached files.
- If the dashboard reports missing MySQL configuration, copy `.env.example` to `.env` and set the DB values. If it reports a missing schema, start MySQL and run `database/schema.sql`.
- If research cannot start a Python process, verify `.venv\Scripts\python.exe` and the requirements. Set `PYTHON_EXECUTABLE` in `.env` only if Python is installed elsewhere.
- If Vite cannot reach the API, verify Express is running on port 5000. If you change `PORT`, also update the proxy in `frontend/vite.config.js`.
- A PDF marked empty/scanned may need separate OCR processing; this project does not claim to read its image-only pages.
