'use strict';

const crypto = require('crypto');
const { query, transaction } = require('./database');
const { runResearch } = require('./researchService');
const { normalizeCompanyName, normalizeWebsite, validateCompanyName } = require('./validation');

async function createRun(companyId) {
  return transaction(async (connection) => {
    const [rows] = await connection.execute(
      'SELECT official_website FROM companies WHERE id = ? FOR UPDATE',
      [companyId],
    );
    if (!rows.length) {
      const error = new Error('Company not found.');
      error.status = 404;
      throw error;
    }
    if (!rows[0].official_website) {
      const error = new Error('Add and confirm the company official website before starting research.');
      error.status = 400;
      throw error;
    }
    const [insert] = await connection.execute(
      'INSERT INTO research_runs (company_id, status, progress_message) VALUES (?, "queued", "Waiting to start")',
      [companyId],
    );
    await connection.execute(
      'UPDATE companies SET research_status = "queued" WHERE id = ?',
      [companyId],
    );
    return { id: insert.insertId, companyId, website: rows[0].official_website };
  });
}

async function recoverInterruptedRuns() {
  return transaction(async (connection) => {
    const [runs] = await connection.execute(
      `UPDATE research_runs
       SET status = 'failed', progress_message = 'Interrupted by server restart',
           error_summary = COALESCE(error_summary, 'Server restarted before research completed.'),
           completed_at = NOW()
       WHERE status IN ('queued', 'running')`,
    );
    await connection.execute(
      `UPDATE companies SET research_status = 'failed', last_researched_at = NOW()
       WHERE research_status IN ('queued', 'running')`,
    );
    return runs.affectedRows;
  });
}

async function updateProgress(runId, event) {
  const step = event.step === 'processing_documents' ? 'Processing discovered documents' : 'Crawling confirmed company website';
  await query(
    `UPDATE research_runs
     SET status = 'running', progress_message = ?, pages_visited = ?, documents_discovered = ?
     WHERE id = ?`,
    [
      step,
      Math.max(0, Number(event.pages_visited) || 0),
      Math.max(0, Number(event.documents_discovered) || 0),
      runId,
    ],
  );
}

function evidenceHash(finding) {
  return crypto.createHash('sha256')
    .update([
      finding.field_name,
      finding.value,
      finding.financial_year || '',
      finding.source_url,
      finding.page_number || '',
      finding.excerpt,
    ].join('\n'))
    .digest('hex');
}

async function saveResearchResult(companyId, runId, result) {
  const counts = {
    documentsDiscovered: Number(result.documents_discovered) || 0,
    documentsProcessed: Number(result.documents_processed) || 0,
    findings: Array.isArray(result.findings) ? result.findings : [],
  };
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  return transaction(async (connection) => {
    const documentIds = new Map();
    for (const document of result.documents || []) {
      const urlHash = crypto.createHash('sha256').update(document.url).digest('hex');
      await connection.execute(
        `INSERT INTO documents
          (company_id, research_run_id, source_url, url_hash, title, file_type, content_hash,
           storage_name, extracted_text, processing_status, processing_error, downloaded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           research_run_id = VALUES(research_run_id),
           title = VALUES(title),
           file_type = VALUES(file_type),
           content_hash = VALUES(content_hash),
           storage_name = COALESCE(VALUES(storage_name), storage_name),
           extracted_text = VALUES(extracted_text),
           processing_status = VALUES(processing_status),
           processing_error = VALUES(processing_error),
           downloaded_at = COALESCE(VALUES(downloaded_at), downloaded_at)`,
        [
          companyId,
          runId,
          document.url,
          urlHash,
          (document.title || document.url).slice(0, 500),
          document.file_type || 'unknown',
          document.content_hash || null,
          document.storage_name || null,
          document.text || null,
          document.status || 'discovered',
          document.error || null,
          document.content_hash ? new Date() : null,
        ],
      );
      const [rows] = await connection.execute(
        'SELECT id FROM documents WHERE company_id = ? AND url_hash = ?',
        [companyId, urlHash],
      );
      if (rows.length) documentIds.set(document.url, rows[0].id);
    }
    for (const finding of counts.findings) {
      const digest = evidenceHash(finding);
      await connection.execute(
        `INSERT IGNORE INTO findings
          (company_id, research_run_id, document_id, field_name, finding_value,
           financial_year, source_url, page_number, supporting_excerpt, extraction_method,
           review_status, evidence_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?)`,
        [
          companyId,
          runId,
          documentIds.get(finding.source_url) || null,
          finding.field_name,
          finding.value,
          finding.financial_year || null,
          finding.source_url,
          finding.page_number || null,
          finding.excerpt,
          ['pattern', 'model', 'manual'].includes(finding.extraction_method)
            ? finding.extraction_method
            : 'keyword',
          digest,
        ],
      );
    }
    const status = ['completed', 'partially_completed', 'failed'].includes(result.status)
      ? result.status
      : 'partially_completed';
    const summary = errors.length ? errors.slice(0, 30).join('\n').slice(0, 10000) : null;
    await connection.execute(
      `UPDATE research_runs
       SET status = ?, progress_message = ?, pages_visited = ?, documents_discovered = ?,
           documents_processed = ?, findings_count = ?, error_summary = ?,
           warning_summary = ?, completed_at = NOW()
       WHERE id = ?`,
      [
        status,
        status === 'completed' ? 'Research completed; findings await human review' : `Research ${status.replace('_', ' ')}`,
        Number(result.pages_visited) || 0,
        counts.documentsDiscovered,
        counts.documentsProcessed,
        counts.findings.length,
        summary,
        warnings.slice(0, 30).join('\n').slice(0, 10000) || null,
        runId,
      ],
    );
    await connection.execute(
      'UPDATE companies SET research_status = ?, last_researched_at = NOW() WHERE id = ?',
      [status, companyId],
    );
    return { ...result, status };
  });
}

async function executeResearchRun(run, onProgress = () => {}) {
  let lastWrite = 0;
  let progressQueue = Promise.resolve();
  try {
    await transaction(async (connection) => {
      await connection.execute(
        `UPDATE research_runs SET status = 'running', progress_message = 'Crawling confirmed company website',
           started_at = NOW() WHERE id = ?`,
        [run.id],
      );
      await connection.execute(
        'UPDATE companies SET research_status = "running" WHERE id = ?',
        [run.companyId],
      );
    });
    const result = await runResearch(run.companyName, run.website, {
      onProgress(event) {
        onProgress(event);
        if (event.step === 'processing_documents' || (event.pages_visited || 0) % 5 === 0) {
          const now = Date.now();
          if (now - lastWrite > 1000) {
            lastWrite = now;
            progressQueue = progressQueue.then(() => updateProgress(run.id, event)).catch((error) => {
              console.error(`Could not update research progress for run ${run.id}: ${error.message}`);
            });
          }
        }
      },
    });
    await progressQueue;
    return await saveResearchResult(run.companyId, run.id, result);
  } catch (error) {
    try {
      await transaction(async (connection) => {
        await connection.execute(
          `UPDATE research_runs SET status = 'failed', progress_message = 'Research failed',
            error_summary = ?, completed_at = NOW() WHERE id = ?`,
          [String(error.message || 'Research failed').slice(0, 10000), run.id],
        );
        await connection.execute(
          'UPDATE companies SET research_status = "failed", last_researched_at = NOW() WHERE id = ?',
          [run.companyId],
        );
      });
    } catch (persistError) {
      console.error(`Could not persist failure for research run ${run.id}: ${persistError.message}`);
    }
    throw error;
  }
}

async function findOrCreateCompany(companyName, website) {
  const name = validateCompanyName(companyName);
  const normalized = normalizeCompanyName(name);
  const officialWebsite = website ? normalizeWebsite(website) : null;
  return transaction(async (connection) => {
    const [matches] = await connection.execute(
      'SELECT id, company_name, official_website FROM companies WHERE normalized_name = ? FOR UPDATE',
      [normalized],
    );
    if (matches.length) {
      if (officialWebsite && officialWebsite !== matches[0].official_website) {
        await connection.execute(
          'UPDATE companies SET official_website = ? WHERE id = ?',
          [officialWebsite, matches[0].id],
        );
      }
      return { ...matches[0], official_website: officialWebsite || matches[0].official_website };
    }
    const [insert] = await connection.execute(
      'INSERT INTO companies (company_name, normalized_name, official_website) VALUES (?, ?, ?)',
      [name, normalized, officialWebsite],
    );
    return { id: insert.insertId, company_name: name, official_website: officialWebsite };
  });
}

module.exports = { createRun, executeResearchRun, findOrCreateCompany, recoverInterruptedRuns };
