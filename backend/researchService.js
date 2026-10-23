'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

const scriptPath = path.join(__dirname, '..', 'research', 'research.py');
const projectRoot = path.dirname(__dirname);

function stderrSummary(stderr) {
  const known = String(stderr || '').split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^(ModuleNotFoundError|ImportError|SyntaxError|IndentationError):/.test(line));
  return known
    ? known.slice(0, 240)
    : 'Python research engine returned invalid output. Verify the Python version and installed requirements.';
}

function pythonExecutable() {
  const venvPython = path.join(projectRoot, '.venv', 'Scripts', 'python.exe');
  const configured = String(process.env.PYTHON_EXECUTABLE || '').trim().replace(/^(['"])(.*)\1$/, '$2');
  if (configured && fs.existsSync(configured)) return configured;
  return fs.existsSync(venvPython) ? venvPython : (process.platform === 'win32' ? 'python' : 'python3');
}

function runResearch(companyName, website = '', options = {}) {
  if (typeof companyName !== 'string' || !companyName.trim()) {
    return Promise.reject(new TypeError('companyName must be a non-empty string.'));
  }
  if (typeof website !== 'string') {
    return Promise.reject(new TypeError('website must be a URL string.'));
  }
  const configuredTimeout = Number(process.env.RESEARCH_TIMEOUT_MS || 20 * 60 * 1000);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 30_000
    ? Math.min(configuredTimeout, 35 * 60 * 1000)
    : 20 * 60 * 1000;
  const configuredCrawlSeconds = Number(options.maxDurationSeconds ?? process.env.CRAWL_MAX_DURATION_SECONDS ?? 900);
  const safeCrawlSeconds = Number.isFinite(configuredCrawlSeconds)
    ? Math.max(10, Math.min(configuredCrawlSeconds, 1800, Math.floor((timeoutMs - 30_000) / 1000)))
    : Math.max(10, Math.min(900, Math.floor((timeoutMs - 30_000) / 1000)));
  const args = [
    scriptPath,
    companyName.trim(),
    '--json',
    '--max-pages',
    String(options.maxPages ?? process.env.MAX_CRAWL_PAGES ?? 80),
    '--max-depth',
    String(options.maxDepth ?? process.env.MAX_CRAWL_DEPTH ?? 4),
    '--max-duration-seconds',
    String(safeCrawlSeconds),
  ];
  if (website.trim()) args.push('--website', website.trim());

  return new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable(), args, {
      cwd: projectRoot,
      windowsHide: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let result;
    let stdoutDiagnostics = '';
    let stderr = '';
    let outputBytes = 0;
    const outputLimit = 30 * 1024 * 1024;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const timeout = setTimeout(() => {
      child.kill();
      fail(new Error('Research timed out. Reduce crawl limits or try again later.'));
    }, timeoutMs);
    const lines = readline.createInterface({ input: child.stdout });

    lines.on('line', (line) => {
      outputBytes += Buffer.byteLength(line);
      if (outputBytes > outputLimit) {
        child.kill();
        fail(new Error('Research output exceeded its safety limit.'));
        return;
      }
      try {
        const event = JSON.parse(line);
        if (event && typeof event === 'object' && event.event === 'progress') {
          try {
            if (options.onProgress) options.onProgress(event);
          } catch (error) {
            child.kill();
            fail(new Error(`Research progress handling failed: ${error.message}`));
          }
        } else if (event && typeof event === 'object'
          && (event.error || (typeof event.status === 'string'
            && Array.isArray(event.documents)
            && Array.isArray(event.findings)))) {
          result = event;
        } else if (line.trim()) {
          stdoutDiagnostics += `${line}\n`;
        }
      } catch {
        if (line.trim()) stdoutDiagnostics += `${line}\n`;
      }
    });
    child.stderr.on('data', (chunk) => {
      if (Buffer.byteLength(stderr) < 64 * 1024) stderr += chunk.toString();
    });
    child.once('error', (error) => {
      fail(new Error(
        `Could not start the Python research engine. Check PYTHON_EXECUTABLE and the virtual environment. ${error.code || ''}`.trim(),
      ));
    });
    child.once('close', (code) => {
      if (settled) return;
      clearTimeout(timeout);
      settled = true;
      if (!result) {
        reject(new Error(stderrSummary(stderr || stdoutDiagnostics)));
        return;
      }
      if (code !== 0 || result.error) {
        reject(new Error(result.error || stderr.trim() || `Python research engine exited with status ${code}.`));
        return;
      }
      resolve(result);
    });
  });
}

module.exports = { runResearch };
