'use strict';

const crypto = require('crypto');
const { query, transaction } = require('./database');
const { runResearch } = require('./researchService');
const { normalizeCompanyName, normalizeWebsite, validateCompanyName } = require('./validation');
const { parseMoney } = require('./money');

async function createRun(companyId) {
  return transaction(async (connection) => {
    const [rows] = await connection.execute(
      'SELECT official_website, official_website_verified_at, company_name FROM companies WHERE id = ? FOR UPDATE',
      [companyId],
    );
    if (!rows.length) {
      const error = new Error('Company not found.');
      error.status = 404;
      throw error;
    }
    if (!rows[0].official_website || !rows[0].official_website_verified_at) {
      const error = new Error('Add and confirm the company official website before starting research.');
      error.status = 400;
      throw error;
    }
    const confirmedWebsite = normalizeWebsite(rows[0].official_website);
    const [activeRuns] = await connection.execute(
      'SELECT id, status FROM research_runs WHERE company_id = ? AND status IN ("queued", "running") LIMIT 1',
      [companyId],
    );
    if (activeRuns.length) {
      return { id: activeRuns[0].id, companyId, website: confirmedWebsite,
        companyName: rows[0].company_name, status: activeRuns[0].status, existing: true };
    }
    const [insert] = await connection.execute(
      `INSERT INTO research_runs (company_id, status, progress_message, confirmed_domain)
       VALUES (?, "queued", "Waiting to start", ?)`,
      [companyId, confirmedWebsite],
    );
    await connection.execute(
      `INSERT INTO research_run_events (research_run_id, event_type, step, message, source_url)
       VALUES (?, 'run_queued', 'queued', 'Waiting to start', ?)` ,
      [insert.insertId, confirmedWebsite],
    );
    await connection.execute(
      'UPDATE companies SET research_status = "queued" WHERE id = ?',
      [companyId],
    );
    return { id: insert.insertId, companyId, website: confirmedWebsite,
      companyName: rows[0].company_name, status: 'queued', existing: false };
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
  const labels = {
    crawling: 'Crawling confirmed company website',
    processing_documents: 'Processing discovered documents',
    extracting: 'Extracting CSR evidence',
  };
  const step = labels[event.step] || 'Research in progress';
  let message = String(event.message || (
    event.step === 'crawling' ? `Visited page ${Number(event.pages_visited) || 0}: ${event.current_url || ''}` : step
  )).trim();
  if (message.length > 1000) {
    message = message.slice(0, 997) + '...';
  }
  try {
    await query(
      `UPDATE research_runs
       SET status = IF(? = 'completed', status, 'running'), progress_message = ?, pages_visited = GREATEST(pages_visited, ?),
           documents_discovered = GREATEST(documents_discovered, ?),
           documents_processed = GREATEST(documents_processed, ?), findings_count = GREATEST(findings_count, ?)
       WHERE id = ?`,
      [
        event.step,
        message,
        Math.max(0, Number(event.pages_visited) || 0),
        Math.max(0, Number(event.documents_discovered) || 0),
        Math.max(0, Number(event.documents_processed) || 0),
        Math.max(0, Number(event.findings_count) || 0),
        runId,
      ],
    );
  } catch (error) {
    console.error(`Could not update research progress message for run ${runId}: ${error.message}`);
    try {
      await query(
        `UPDATE research_runs
         SET status = IF(? = 'completed', status, 'running'), progress_message = 'Research in progress',
             pages_visited = GREATEST(pages_visited, ?),
             documents_discovered = GREATEST(documents_discovered, ?),
             documents_processed = GREATEST(documents_processed, ?), findings_count = GREATEST(findings_count, ?)
         WHERE id = ?`,
        [
          event.step,
          Math.max(0, Number(event.pages_visited) || 0),
          Math.max(0, Number(event.documents_discovered) || 0),
          Math.max(0, Number(event.documents_processed) || 0),
          Math.max(0, Number(event.findings_count) || 0),
          runId,
        ],
      );
    } catch {
      // Best effort fallback
    }
    throw error;
  }
  const details = { ...event };
  delete details.current_url;
  delete details.message;
  try {
    await query(
      `INSERT INTO research_run_events (research_run_id, event_type, step, message, source_url, details)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [runId, String(event.event_type || event.step || 'progress').slice(0, 60),
        String(event.step || 'research').slice(0, 40), message,
        event.current_url ? String(event.current_url).slice(0, 2048) : null,
        JSON.stringify(details)],
    );
  } catch (eventError) {
    console.error(`Could not record progress event for run ${runId}: ${eventError.message}`);
  }
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
      const title = (document.title || document.url).slice(0, 500);
      const documentType = document.document_type || (
        /brsr|business responsibility/i.test(title) ? 'brsr'
          : /annual report/i.test(title) ? 'annual_report'
            : /csr policy/i.test(title) ? 'csr_policy'
              : null
      );
      const linkText = document.link_text ? String(document.link_text).slice(0, 1000) : null;
      await connection.execute(
        `INSERT INTO documents
          (company_id, research_run_id, source_url, source_page_url, link_text, url_hash, title, file_type, document_type,
           financial_year, publication_date, content_hash,
           storage_name, extracted_text, processing_status, processing_error, validation_result, downloaded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           title = VALUES(title),
           link_text = COALESCE(VALUES(link_text), link_text),
           file_type = VALUES(file_type),
           document_type = COALESCE(VALUES(document_type), document_type),
           financial_year = COALESCE(VALUES(financial_year), financial_year),
           publication_date = COALESCE(VALUES(publication_date), publication_date),
           content_hash = VALUES(content_hash),
           storage_name = COALESCE(VALUES(storage_name), storage_name),
           extracted_text = VALUES(extracted_text),
           processing_status = VALUES(processing_status),
           processing_error = VALUES(processing_error),
           source_page_url = COALESCE(VALUES(source_page_url), source_page_url),
           validation_result = VALUES(validation_result),
           downloaded_at = COALESCE(VALUES(downloaded_at), downloaded_at)`,
        [
          companyId,
          runId,
          document.url,
          document.source_page_url || null,
          linkText,
          urlHash,
          title,
          document.file_type || 'unknown',
          documentType,
          document.financial_year || null,
          document.publication_date || null,
          document.content_hash || null,
          document.storage_name || null,
          document.extracted_text || null,
          document.status || 'discovered',
          document.error || null,
          document.validation_result || null,
          document.status === 'processed' ? new Date() : null,
        ],
      );
      const [rows] = await connection.execute(
        'SELECT id FROM documents WHERE company_id = ? AND url_hash = ?',
        [companyId, urlHash],
      );
      if (rows.length) {
        documentIds.set(document.url, rows[0].id);
        await connection.execute(
          'INSERT IGNORE INTO research_run_documents (research_run_id, document_id) VALUES (?, ?)',
          [runId, rows[0].id],
        );
      }
    }
    for (const finding of counts.findings) {
      const digest = evidenceHash(finding);
      const monetary = /_amount$/.test(finding.field_name || '')
        ? parseMoney(finding.value)
        : { numeric: null, currency: null, unit: null };
      const category = /_amount$/.test(finding.field_name || '') ? 'financial'
        : /focus_area|project|partner/.test(finding.field_name || '') ? 'programmatic' : 'general';
      await connection.execute(
        `INSERT IGNORE INTO findings
          (company_id, research_run_id, document_id, field_name, finding_value, original_value,
           finding_category, numeric_value, currency, unit, relevant_focus_area, financial_year, source_url, page_number,
           supporting_excerpt, extraction_method, provenance, review_status, evidence_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'extracted', 'pending_review', ?)`,
        [
          companyId,
          runId,
          documentIds.get(finding.source_url) || null,
          finding.field_name,
          finding.value,
          finding.value,
          category,
          monetary.numeric,
          monetary.currency,
          monetary.unit,
          finding.field_name === 'csr_focus_area' ? finding.value : null,
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
      const [findingRows] = await connection.execute(
        'SELECT id FROM findings WHERE company_id = ? AND evidence_hash = ?',
        [companyId, digest],
      );
      if (findingRows.length) {
        await connection.execute(
          'INSERT IGNORE INTO research_run_findings (research_run_id, finding_id) VALUES (?, ?)',
          [runId, findingRows[0].id],
        );
      }
    }
    const status = ['completed', 'partially_completed', 'failed'].includes(result.status)
      ? result.status
      : 'partially_completed';
    const summary = errors.length ? errors.slice(0, 30).join('\n').slice(0, 10000) : null;
    const progressMessage = String(
      result.summary || (status === 'completed'
        ? 'Report discovery completed; document contents have not been reviewed.'
        : `Research ${status.replace('_', ' ')}`)
    ).trim().slice(0, 2000);
    try {
      await connection.execute(
        `UPDATE research_runs
         SET status = ?, progress_message = ?, pages_visited = ?, documents_discovered = ?,
             documents_processed = ?, findings_count = ?, error_summary = ?,
             warning_summary = ?, summary = ?, completed_at = NOW()
         WHERE id = ?`,
        [
          status,
          progressMessage,
          Number(result.pages_visited) || 0,
          counts.documentsDiscovered,
          counts.documentsProcessed,
          counts.findings.length,
          summary,
          warnings.slice(0, 30).join('\n').slice(0, 10000) || null,
          result.summary || `${counts.documentsProcessed} valid reports saved; report contents have not been reviewed.`,
          runId,
        ],
      );
    } catch (saveError) {
      console.error(`Could not save research result summary for run ${runId}: ${saveError.message}`);
      warnings.push(`Progress storage notice: ${saveError.message}`);
      await connection.execute(
        `UPDATE research_runs
         SET status = ?, progress_message = ?, pages_visited = ?, documents_discovered = ?,
             documents_processed = ?, findings_count = ?, error_summary = ?,
             warning_summary = ?, summary = ?, completed_at = NOW()
         WHERE id = ?`,
        [
          status,
          `Research ${status.replace('_', ' ')}`,
          Number(result.pages_visited) || 0,
          counts.documentsDiscovered,
          counts.documentsProcessed,
          counts.findings.length,
          summary,
          warnings.slice(0, 30).join('\n').slice(0, 10000) || null,
          `Research ${status.replace('_', ' ')}`,
          runId,
        ],
      );
    }
    await connection.execute(
      'UPDATE companies SET research_status = ?, last_researched_at = NOW() WHERE id = ?',
      [status, companyId],
    );
    return { ...result, status };
  });
}

async function executeResearchRun(run, onProgress = () => {}) {
  let progressQueue = Promise.resolve();
  let progressUpdateWarning = null;
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
      await connection.execute(
        `INSERT INTO research_run_events (research_run_id, event_type, step, message, source_url)
         VALUES (?, 'run_started', 'running', 'Opening the confirmed official website', ?)` ,
        [run.id, run.website],
      );
    });
    const result = await runResearch(run.companyName, run.website, {
      onProgress(event) {
        onProgress(event);
        progressQueue = progressQueue.then(() => updateProgress(run.id, event)).catch((error) => {
          console.error(`Could not update research progress for run ${run.id}: ${error.message}`);
          progressUpdateWarning = `Progress update notice: ${error.message}`;
        });
      },
    });
    await progressQueue;
    if (progressUpdateWarning) {
      result.warnings = result.warnings || [];
      result.warnings.push(progressUpdateWarning);
    }
    const saved = await saveResearchResult(run.companyId, run.id, result);
    try {
      await updateProgress(run.id, { step: 'completed', event_type: 'run_completed',
        message: `Research ${saved.status.replaceAll('_', ' ')}; ${saved.documents_processed || 0} documents processed and ${saved.findings?.length || 0} findings saved for review` });
    } catch (error) {
      console.error(`Could not record completion event for run ${run.id}: ${error.message}`);
    }
    return saved;
  } catch (error) {
    try {
      await transaction(async (connection) => {
        await connection.execute(
          `UPDATE research_runs SET status = 'failed', progress_message = 'Research failed',
            error_summary = ?, completed_at = NOW() WHERE id = ?`,
          [String(error.message || 'Research failed').slice(0, 10000), run.id],
        );
        await connection.execute(
          `INSERT INTO research_run_events (research_run_id, event_type, step, message)
           VALUES (?, 'run_failed', 'failed', ?)`,
          [run.id, String(error.message || 'Research failed').slice(0, 1000)],
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
          'UPDATE companies SET official_website = ?, official_website_verified_at = NOW() WHERE id = ?',
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

module.exports = {
  createRun,
  executeResearchRun,
  findOrCreateCompany,
  recoverInterruptedRuns,
  saveResearchResult,
};
