# CSR Company Research Tool

## Project Overview

This repository contains three separate components:

- **React frontend:** a minimal Vite-powered React page. It is not currently connected to the backend.
- **Node.js/Express backend:** serves `GET /` and `POST /api/research`. Its CLI accepts a company name in the terminal.
- **Python research component:** receives the company name from Node.js, searches Bing for five company and CSR-related queries, and prints the search results.

The current Python code does not call Gemini or another AI service. `.env.example` documents a Gemini API key for configuration, but the current application does not read or use that key.

## Prerequisites

- Node.js and npm. Vite 8 requires Node.js `^20.19.0` or `>=22.12.0`.
- Python 3 and pip. The project does not pin a Python version.
- Git, to clone the repository.

## Installation

Clone the repository and enter its directory:

```sh
git clone <repository-url>
cd Service-Learning
```

Install backend dependencies from `backend/`:

```sh
cd backend
npm install
cd ..
```

Install frontend dependencies from `frontend/`:

```sh
cd frontend
npm install
cd ..
```

Install Python dependencies from the project root. A virtual environment is recommended:

```sh
python -m venv .venv
```

Activate it using the command for your shell:

```cmd
.venv\Scripts\activate.bat
```

```powershell
.\.venv\Scripts\Activate.ps1
```

```sh
source .venv/bin/activate
```

Then, from the project root, install the Python dependencies:

```sh
pip install -r requirements.txt
```

The Node research service runs Python using the `python` command, so make sure the selected Python environment is active and `python` is available on `PATH` when running the backend or CLI.

## Environment Setup

Create a local `.env` file by copying `.env.example`:

```cmd
copy .env.example .env
```

```powershell
cp .env.example .env
```

Replace the placeholder with your own Gemini API key:

```env
GEMINI_API_KEY=your_actual_key_here
```

The root `.gitignore` excludes `.env`; it contains local secrets and must never be committed. `.env.example` contains only a placeholder and is safe to commit. The current application does not yet use the Gemini key.

## Running the Project

Run each command from the directory listed above it. Use separate terminals when running more than one component.

Start the backend server:

```sh
cd backend
npm start
```

Start the backend with automatic restarts:

```sh
cd backend
npm run devstart
```

Run the interactive company research CLI:

```sh
cd backend
npm run cli
```

Start the React development server:

```sh
cd frontend
npm start
```

## Architecture

The frontend is currently a standalone React page and is not wired to the backend. The backend can be used through its Express route or terminal CLI:

```text
React frontend (currently standalone)

CLI
    -> researchService.js
    -> research/research.py
    -> Bing search results via requests

POST /api/research
    -> Express/Node backend
    -> researchService.js
    -> research/research.py
    -> Bing search results via requests
```

The shared Node research service starts the Python process and captures its output. The Python component currently performs Bing searches and prints results. No Gemini/AI service is currently called.

## Dependency Files

- `backend/package.json` declares backend Node dependencies; `backend/package-lock.json` records their resolved versions.
- `frontend/package.json` declares frontend Node dependencies; `frontend/package-lock.json` records their resolved versions.
- Root `requirements.txt` lists `google-genai`, `python-dotenv`, and `requests`. The current Python source imports `requests`; Gemini and dotenv are not yet imported by the current source.
- `.env` is for local secrets and is ignored by Git; `.env.example` documents the environment variable name without containing a real key.
- Do not delete or ignore either Node `package-lock.json`; commit both lockfiles so installs use the recorded dependency versions.