# CSR Research Dashboard

This React/Vite client uses the Express API at `/api`. During development, Vite proxies API requests to `http://127.0.0.1:5000`. Vite reads the repository-root `.env` file through `envDir: '..'`; `VITE_API_BASE_URL` defaults to `/api`.

Install dependencies once from this directory:

**CMD:**

```cmd
npm ci
```

**PowerShell:**

```powershell
npm ci
```

If PowerShell blocks its npm shim, use `npm.cmd` in place of `npm`.

Start the frontend from this directory:

**CMD:**

```cmd
npm run start
```

**PowerShell:**

```powershell
npm run start
```

If necessary, use `npm.cmd run start` in PowerShell. Open the URL Vite prints (normally `http://localhost:5173`). Run `npm run build` from this directory to build `dist/`; there is no frontend test script. Start the backend in another terminal and configure MySQL before using database-backed features.

See the repository [README](../README.md) for the full Windows installation guide, CMD/PowerShell instructions, environment variables, database setup, API, tests, and troubleshooting.

## Researcher workflow

Use the workspace to manage company records and confirm official websites before saving them. An exact-match domain registry result may be offered as a suggestion, but it is never saved or used for research unless a researcher selects and confirms it. Starting a research run requires a separate confirmation. Run history is loaded from the persisted research endpoint and can be paged, opened as a report, printed, or exported to CSV. Company profiles provide evidence-backed finding review, reviewer notes, and source-document status. Exported reports reflect the data returned by the API; review findings and source evidence before relying on them.
