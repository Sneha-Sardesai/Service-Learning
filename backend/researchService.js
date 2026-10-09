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
  if (process.env.PYTHON_EXECUTABLE) return process.env.PYTHON_EXECUTABLE;
  const venvPython = path.join(projectRoot, '.venv', 'Scripts', 'python.exe');
  return fs.existsSync(venvPython) ? venvPython : (process.platform === 'win32' ? 'python' : 'python3');
}

function runResearch(companyName, website = '', options = {}) {
  if (typeof companyName !== 'string' || !companyName.trim()) {
    return Promise.reject(new TypeError('companyName must be a non-empty string.'));
  }
  if (typeof website !== 'string') {
    return Promise.reject(new TypeError('website must be a URL string.'));
  }
  const args = [
    scriptPath,
    companyName.trim(),
    '--json',
    '--max-pages',
    String(options.maxPages || process.env.MAX_CRAWL_PAGES || 40),
    '--max-depth',
    String(options.maxDepth || process.env.MAX_CRAWL_DEPTH || 3),
  ];
  if (website.trim()) args.push('--website', website.trim());

  return new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable(), args, {
      cwd: projectRoot,
      windowsHide: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdoutBuffer = '';
    let stderr = '';
    let outputBytes = 0;
    const timeoutMs = Number(process.env.RESEARCH_TIMEOUT_MS || 10 * 60 * 1000);
    const outputLimit = 30 * 1024 * 1024;
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Research timed out. Reduce crawl limits or try again later.'));
    }, timeoutMs);
    const lines = readline.createInterface({ input: child.stdout });

    lines.on('line', (line) => {
      outputBytes += Buffer.byteLength(line);
      if (outputBytes > outputLimit) {
        child.kill();
        reject(new Error('Research output exceeded its safety limit.'));
        return;
      }
      try {
        const event = JSON.parse(line);
        if (event.event === 'progress') {
          if (options.onProgress) options.onProgress(event);
        } else if (event.error) {
          stdoutBuffer = JSON.stringify(event);
        } else {
          stdoutBuffer = line;
        }
      } catch {
        stdoutBuffer += `${line}\n`;
      }
    });
    child.stderr.on('data', (chunk) => {
      if (Buffer.byteLength(stderr) < 64 * 1024) stderr += chunk.toString();
    });
    child.once('error', () => {
      clearTimeout(timeout);
      reject(new Error('Could not start the Python research engine. Check PYTHON_EXECUTABLE and the virtual environment.'));
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      let result;
      try {
        result = JSON.parse(stdoutBuffer.trim());
      } catch {
        reject(new Error(stderrSummary(stderr)));
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
