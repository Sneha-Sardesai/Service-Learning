import { useEffect, useRef, useState } from 'react';
import { api, upload } from './api';
import './index.css';

const emptyCompany = {
  company_name: '',
  cin: '',
  industry: '',
  city: '',
  official_website: '',
  contact_email: '',
  contact_phone: '',
  contact_name: '',
  contact_designation: '',
  notes: '',
};
const statusLabels = {
  not_started: 'Not researched',
  queued: 'Queued',
  running: 'Researching',
  completed: 'Completed',
  partially_completed: 'Partial',
  failed: 'Failed',
  pending_review: 'Needs review',
  approved: 'Approved',
  rejected: 'Rejected',
  unavailable: 'Unavailable',
  scanned_or_empty: 'Scanned / empty',
  encrypted: 'Encrypted',
  unsupported: 'Unsupported',
  checking: 'Checking file',
  discovered: 'Candidate found',
  processing: 'Checking file',
  processed: 'Valid report',
  valid_pdf: 'Valid PDF',
  skipped: 'Skipped',
  ready_to_research: 'Ready to research',
  needs_manual_review: 'Needs manual review',
  waiting_for_website: 'Waiting for website',
  needs_domain: 'Needs domain',
};
const unavailableFields = [
  'CSR policy',
  'CSR committee',
  'CSR focus areas',
  'CSR projects',
  'CSR obligation amount',
  'CSR expenditure amount',
  'Unspent CSR amount',
];

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
}

function formatTimestamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function runNumber(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id >= 0 ? id % 10 : '—';
}

function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[\t\r ]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function downloadCsv(filename, rows) {
  const csv = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function downloadHistoryCsv(runs) {
  const columns = ['Run ID', 'Company', 'Status', 'Started', 'Completed', 'Pages visited', 'Documents discovered', 'Documents processed', 'Findings', 'Progress', 'Warnings', 'Errors'];
  downloadCsv('research-run-history.csv', [
    columns,
    ...runs.map((run) => [
      run.id, run.company_name, run.status, run.created_at, run.completed_at,
      run.pages_visited, run.documents_discovered, run.documents_processed,
      run.findings_count, run.progress_message, run.warning_summary, run.error_summary,
    ]),
  ]);
}

function downloadRunCsv(detail) {
  const { research_run: run, company, documents = [], findings = [] } = detail;
  const rows = [
    ['Record type', 'Run ID', 'Company', 'Official website', 'Run status', 'Started', 'Completed', 'Field / title', 'Value / source URL', 'Original extracted value', 'Financial year', 'Category', 'Numeric value', 'Currency', 'Unit', 'Provenance', 'Review status', 'Reviewer notes', 'Source evidence', 'Processing status', 'Processing error'],
    ['Run', run.id, company?.company_name, company?.official_website, run.status, run.created_at, run.completed_at, '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    ...findings.map((finding) => [
      'Finding', run.id, company?.company_name, company?.official_website, run.status, run.created_at, run.completed_at,
      finding.field_name, finding.finding_value, finding.original_value, finding.financial_year,
      finding.finding_category, finding.numeric_value, finding.currency, finding.unit, finding.provenance,
      finding.review_status, finding.reviewer_notes,
      `${finding.supporting_excerpt}${finding.source_url ? `\n${finding.source_url}` : ''}${finding.page_number ? ` · page ${finding.page_number}` : ''}`,
      '', '',
    ]),
    ...documents.map((item) => [
      'Document', run.id, company?.company_name, company?.official_website, run.status, run.created_at, run.completed_at,
      item.title, item.source_url, ...Array(10).fill(''), item.processing_status, item.processing_error,
    ]),
  ];
  downloadCsv(`research-run-${run.id}-report.csv`, rows);
}

function Status({ value, label }) {
  return <span className={`status status-${value || 'not_started'}`}>{label || statusLabels[value] || value || 'Unknown'}</span>;
}

function deriveRunStopInfo(run) {
  if (!run || !['failed', 'partially_completed'].includes(run.status)) return null;
  const isPartial = run.status === 'partially_completed';
  const err = (run.error_summary || '').toLowerCase();
  const prog = (run.progress_message || '').toLowerCase();

  let reason = run.error_summary?.split('\n')[0] || run.progress_message || (isPartial ? 'Research crawl reached limit with partial document extraction.' : 'Research run encountered an unrecoverable error.');
  let nextStep = 'Verify the company official website and retry the research run.';

  if (err.includes('data too long') || err.includes('progress_message') || prog.includes('data too long')) {
    reason = 'The progress message exceeded the previous column length limit in the database.';
    nextStep = 'Database migration 011 has expanded the progress message column to TEXT. You can now safely re-run research for this company.';
  } else if (err.includes('official website') || err.includes('needs_domain') || prog.includes('needs_domain')) {
    reason = 'No confirmed official website with verification source was recorded.';
    nextStep = 'Edit the company profile, confirm its official corporate website URL and verification source, then retry the research run.';
  } else if (err.includes('403') || err.includes('blocked') || err.includes('cloudflare') || err.includes('anti-bot') || prog.includes('403')) {
    reason = 'The corporate web server rejected automated crawler requests (HTTP 403 / anti-bot challenge).';
    nextStep = 'Manually open the corporate investor/CSR portal, download the annual CSR or BRSR report PDF, and use the spreadsheet or document import to record findings.';
  } else if (err.includes('timeout') || err.includes('econnrefused') || err.includes('network') || err.includes('getaddrinfo') || prog.includes('timeout')) {
    reason = 'Network connection to the corporate domain timed out or was refused.';
    nextStep = 'Check that the official website URL is online and reachable in your browser, then retry the research run.';
  } else if (isPartial) {
    reason = run.summary || 'Crawl completed within page budget; some candidate reports were skipped or could not be fully parsed.';
    nextStep = 'Review the discovered documents list below. If a desired report was skipped, check its direct URL or upload the report file directly.';
  }
  return { isPartial, reason, nextStep };
}

function App() {
  const [page, setPage] = useState('dashboard');
  const [dashboard, setDashboard] = useState(null);
  const [companies, setCompanies] = useState([]);
  const [companiesLoading, setCompaniesLoading] = useState(false);
  const [selectedCompanyIds, setSelectedCompanyIds] = useState([]);
  const [batchResults, setBatchResults] = useState([]);
  const [industries, setIndustries] = useState([]);
  const [locations, setLocations] = useState([]);
  const [profile, setProfile] = useState(null);
  const [selectedCompany, setSelectedCompany] = useState(null);
  const [loading, setLoading] = useState(true);
  const [databaseState, setDatabaseState] = useState('checking');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState(() => new URLSearchParams(window.location.search).get('q') || '');
  const [industryFilter, setIndustryFilter] = useState(() => new URLSearchParams(window.location.search).get('industry') || '');
  const [statusFilter, setStatusFilter] = useState('');
  const [cityFilter, setCityFilter] = useState(() => new URLSearchParams(window.location.search).get('city') || '');
  const [focusFilter, setFocusFilter] = useState(() => new URLSearchParams(window.location.search).getAll('focus'));
  const [focusMode, setFocusMode] = useState(() => new URLSearchParams(window.location.search).get('focus_mode') || 'any');
  const [turnoverOperator, setTurnoverOperator] = useState(() => new URLSearchParams(window.location.search).get('turnover_operator') || '');
  const [turnoverAmount, setTurnoverAmount] = useState(() => new URLSearchParams(window.location.search).get('turnover_amount') || '');
  const [turnoverAmountTo, setTurnoverAmountTo] = useState(() => new URLSearchParams(window.location.search).get('turnover_amount_to') || '');
  const [contactFilter, setContactFilter] = useState(() => new URLSearchParams(window.location.search).get('contact') || '');
  const [viewAllCompanies, setViewAllCompanies] = useState(() => new URLSearchParams(window.location.search).get('view_all') === '1');
  const [focusAreas, setFocusAreas] = useState([]);
  const [turnoverBases, setTurnoverBases] = useState([]);
  const [turnoverBasis, setTurnoverBasis] = useState(() => new URLSearchParams(window.location.search).get('turnover_basis') || '');
  const [interpretedFilters, setInterpretedFilters] = useState({});
  const [companyPage, setCompanyPage] = useState(1);
  const [companyPages, setCompanyPages] = useState(1);
  const [companyTotal, setCompanyTotal] = useState(0);
  const [companyDialog, setCompanyDialog] = useState(null);
  const [companyForm, setCompanyForm] = useState(emptyCompany);
  const [websiteConfirmed, setWebsiteConfirmed] = useState(false);
  const [domainSuggestion, setDomainSuggestion] = useState(null);
  const [suggestionLoading, setSuggestionLoading] = useState(false);
  const [suggestionError, setSuggestionError] = useState('');
  const [researchDialog, setResearchDialog] = useState(null);
  const [researchConfirmed, setResearchConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [researching, setResearching] = useState(false);
  const [document, setDocument] = useState(null);
  const [findingEdits, setFindingEdits] = useState({});
  const [savingFinding, setSavingFinding] = useState({});
  const [findingHistory, setFindingHistory] = useState({});
  const [markingUnavailable, setMarkingUnavailable] = useState(false);
  const [unavailableField, setUnavailableField] = useState('');
  const [researchRuns, setResearchRuns] = useState([]);
  const [researchPagination, setResearchPagination] = useState({});
  const [researchPage, setResearchPage] = useState(1);
  const [researchLoading, setResearchLoading] = useState(false);
  const [researchError, setResearchError] = useState('');
  const [exportingHistory, setExportingHistory] = useState(false);
  const [runDetail, setRunDetail] = useState(null);
  const [runDetailLoading, setRunDetailLoading] = useState(false);
  const [runDetailError, setRunDetailError] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importScan, setImportScan] = useState(null);
  const [importMappings, setImportMappings] = useState({});
  const [importPreview, setImportPreview] = useState(null);
  const [importResolutions, setImportResolutions] = useState({});
  const [websiteStatusFilter, setWebsiteStatusFilter] = useState('');
  const [domainSummary, setDomainSummary] = useState(null);
  const [bulkReviewOpen, setBulkReviewOpen] = useState(false);
  const [bulkReviewItems, setBulkReviewItems] = useState([]);
  const [bulkReviewLoading, setBulkReviewLoading] = useState(false);
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const submissions = useRef(new Set());

  async function loadDashboard() {
    const data = await api('/dashboard');
    setDashboard(data);
  }

  async function loadDomainSummary() {
    try {
      const summary = await api('/companies/domain-summary');
      setDomainSummary(summary);
    } catch {
      // best-effort
    }
  }

  async function openBulkReview() {
    setBulkReviewLoading(true);
    setBulkReviewOpen(true);
    setError('');
    try {
      const data = await api('/companies?website_status=needs_manual_review&limit=100');
      setBulkReviewItems((data.companies || []).map((c) => ({
        id: c.id,
        company_name: c.company_name,
        industry: c.industry,
        city: c.city,
        candidate: c.website_candidate || '',
        notes: c.notes || '',
        selected: Boolean(c.website_candidate),
      })));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBulkReviewLoading(false);
    }
  }

  async function submitBulkReview() {
    const selected = bulkReviewItems.filter((item) => item.selected && item.candidate.trim());
    if (!selected.length) {
      setError('Select at least one company with a valid candidate URL to confirm.');
      return;
    }
    setBulkSubmitting(true);
    setError('');
    try {
      const confirmations = selected.map((item) => ({
        id: item.id,
        website: item.candidate.trim(),
        verification_source: item.candidate.trim(),
      }));
      const res = await api('/companies/bulk-confirm-websites', {
        method: 'POST',
        body: JSON.stringify({ confirmations }),
      });
      setNotice(`Successfully confirmed ${res.confirmed_count} company official website${res.confirmed_count === 1 ? '' : 's'}.`);
      setBulkReviewOpen(false);
      await Promise.all([loadCompanies(), loadDashboard(), loadDomainSummary()]);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBulkSubmitting(false);
    }
  }

  async function loadCompanies() {
    if (!viewAllCompanies && !search.trim() && !industryFilter && !cityFilter && !focusFilter.length && !(turnoverOperator && turnoverAmount && turnoverBasis) && !contactFilter && !statusFilter && !websiteStatusFilter) {
      setCompanies([]);
      setCompanyPages(1);
      setCompanyTotal(0);
      setCompaniesLoading(false);
      return;
    }
    const params = new URLSearchParams();
    if (search.trim()) params.set('q', search.trim());
    if (industryFilter) params.set('industry', industryFilter);
    if (cityFilter) params.set('city', cityFilter);
    if (websiteStatusFilter) params.set('website_status', websiteStatusFilter);
    for (const area of focusFilter) params.append('focus', area);
    if (focusFilter.length) params.set('focus_mode', focusMode);
    if (turnoverOperator && turnoverAmount && turnoverBasis && (turnoverOperator !== 'between' || turnoverAmountTo)) {
      params.set('turnover_operator', turnoverOperator);
      params.set('turnover_amount', turnoverAmount);
      if (turnoverOperator === 'between') params.set('turnover_amount_to', turnoverAmountTo);
    }
    if (turnoverBasis) {
      const [currency, unit] = turnoverBasis.split('|');
      params.set('turnover_currency', currency);
      params.set('turnover_unit', unit);
    }
    if (contactFilter) params.set('contact', contactFilter);
    if (statusFilter) params.set('research_status', statusFilter);
    params.set('page', String(companyPage));
    setCompaniesLoading(true);
    try {
      const data = await api(`/companies${params.size ? `?${params}` : ''}`);
      setCompanies(data.companies);
      setIndustries(data.industries || []);
      setLocations(data.locations || []);
      setFocusAreas(data.focus_areas || []);
      setInterpretedFilters(data.interpreted_filters || {});
      setCompanyPages(data.pagination?.total_pages || 1);
      setCompanyTotal(data.pagination?.total || 0);
    } finally {
      setCompaniesLoading(false);
    }
  }

  async function loadProfile(id) {
    const [data, provenance] = await Promise.all([
      api(`/companies/${id}`),
      api(`/companies/${id}/source-values`).catch(() => ({ source_values: [] })),
    ]);
    setProfile({ ...data, source_values: provenance.source_values || [] });
  }

  async function loadResearchHistory(nextPage = researchPage) {
    if (submissions.current.has('history-load')) return;
    submissions.current.add('history-load');
    setResearchLoading(true);
    setResearchError('');
    try {
      const data = await api(`/research?page=${nextPage}&limit=20`);
      setResearchRuns(data.research_runs || []);
      setResearchPagination(data.pagination || {});
      setResearchPage(nextPage);
    } catch (requestError) {
      setResearchError(requestError.message);
    } finally {
      setResearchLoading(false);
      submissions.current.delete('history-load');
    }
  }

  async function exportAllResearchHistory() {
    if (submissions.current.has('history-export')) return;
    submissions.current.add('history-export');
    setExportingHistory(true);
    setResearchError('');
    try {
      const first = await api('/research?page=1&limit=20');
      const allRuns = first.research_runs || [];
      const totalPages = first.pagination?.total_pages || 1;
      for (let pageNumber = 2; pageNumber <= totalPages; pageNumber += 1) {
        const next = await api(`/research?page=${pageNumber}&limit=20`);
        allRuns.push(...(next.research_runs || []));
      }
      downloadHistoryCsv(allRuns);
    } catch (requestError) {
      setResearchError(requestError.message);
    } finally {
      setExportingHistory(false);
      submissions.current.delete('history-export');
    }
  }

  async function openRunDetail(id) {
    setRunDetail(null);
    setRunDetailError('');
    setRunDetailLoading(true);
    setPage('researchDetail');
    try {
      const data = await api(`/research/${id}`);
      setRunDetail(data);
    } catch (requestError) {
      setRunDetailError(requestError.message);
    } finally {
      setRunDetailLoading(false);
    }
  }

  async function refreshHome() {
    setError('');
    setLoading(true);
    let healthError = '';
    const health = await api('/health').catch((requestError) => {
      healthError = requestError.message;
      return null;
    });
    setDatabaseState(health?.database === 'available' ? 'connected' : 'unavailable');
    try {
      await Promise.all([loadDashboard(), loadCompanies(), loadDomainSummary()]);
    } catch (requestError) {
      setError(healthError || requestError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshHome();
  }, []);

  useEffect(() => {
    const companyName = companyForm.company_name.trim();
    if (!companyDialog || companyDialog.mode !== 'edit' || !companyName) {
      setDomainSuggestion(null);
      setSuggestionError('');
      setSuggestionLoading(false);
      return undefined;
    }

    let active = true;
    setDomainSuggestion(null);
    setSuggestionError('');
    setSuggestionLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ company_name: companyName });
        const data = await api(`/company-domain-suggestions?${params}`);
        if (active) {
          setDomainSuggestion(typeof data.suggested_website === 'string' && data.suggested_website.trim()
            ? { website: data.suggested_website, source_url: data.source_url || null, verification_note: data.verification_note || null }
            : null);
        }
      } catch {
        if (active) {
          setDomainSuggestion(null);
          setSuggestionError('Domain suggestions are temporarily unavailable.');
        }
      } finally {
        if (active) setSuggestionLoading(false);
      }
    }, 300);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [companyDialog?.mode, companyForm.company_name]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (page === 'companies') loadCompanies().catch((requestError) => setError(requestError.message));
    }, 200);
    return () => clearTimeout(timer);
  }, [search, industryFilter, statusFilter, websiteStatusFilter, cityFilter, focusFilter, focusMode, turnoverOperator, turnoverAmount, turnoverAmountTo, turnoverBasis, contactFilter, viewAllCompanies, companyPage, page]);

  useEffect(() => {
    if (page !== 'companies') return;
    api('/companies/options').then((options) => {
      setIndustries(options.industries || []);
      setLocations(options.locations || []);
      setFocusAreas(options.focus_areas || []);
      const bases = options.turnover_bases || [];
      setTurnoverBases(bases);
      if (bases.length === 1) setTurnoverBasis((current) => current || `${bases[0].turnover_currency || ''}|${bases[0].turnover_unit || ''}`);
    }).catch((requestError) => setError(requestError.message));
  }, [page]);

  useEffect(() => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({ q: search, industry: industryFilter, city: cityFilter, turnover_operator: turnoverOperator, turnover_amount: turnoverAmount, turnover_amount_to: turnoverAmountTo, turnover_basis: turnoverBasis, contact: contactFilter })) {
      if (value) params.set(key, value);
    }
    for (const area of focusFilter) params.append('focus', area);
    if (focusFilter.length && focusMode !== 'any') params.set('focus_mode', focusMode);
    if (viewAllCompanies) params.set('view_all', '1');
    const next = `${window.location.pathname}${params.size ? `?${params}` : ''}`;
    window.history.replaceState({}, '', next);
  }, [search, industryFilter, cityFilter, focusFilter, focusMode, turnoverOperator, turnoverAmount, turnoverAmountTo, turnoverBasis, contactFilter, viewAllCompanies]);

  useEffect(() => {
    if (page === 'research') void loadResearchHistory(researchPage);
  }, [page]);

  const hasActiveHistoryRuns = researchRuns.some((run) => ['queued', 'running'].includes(run.status));
  useEffect(() => {
    if (page !== 'research' || !hasActiveHistoryRuns) return undefined;
    const timer = window.setInterval(() => void loadResearchHistory(researchPage), 2000);
    return () => window.clearInterval(timer);
  }, [page, hasActiveHistoryRuns, researchPage]);

  const activeDetailId = ['queued', 'running'].includes(runDetail?.research_run?.status)
    ? runDetail.research_run.id : null;
  useEffect(() => {
    if (page !== 'researchDetail' || !activeDetailId) return undefined;
    let alive = true;
    const timer = window.setInterval(async () => {
      try {
        const data = await api(`/research/${activeDetailId}`);
        if (alive) setRunDetail(data);
      } catch (requestError) {
        if (alive) setRunDetailError(requestError.message);
      }
    }, 1500);
    return () => { alive = false; window.clearInterval(timer); };
  }, [page, activeDetailId]);

  const profileRunState = profile?.research_runs
    ?.map((run) => `${run.id}:${run.status}`)
    .join('|') || '';
  useEffect(() => {
    if (page !== 'profile' || !selectedCompany) return undefined;
    let alive = true;
    const refresh = () => loadProfile(selectedCompany.id)
      .catch((requestError) => { if (alive) setError(requestError.message); });
    void refresh();
    const active = profile?.research_runs?.some((run) => ['queued', 'running'].includes(run.status));
    const timer = active ? window.setInterval(() => void refresh(), 2000) : null;
    return () => {
      alive = false;
      if (timer) window.clearInterval(timer);
    };
  }, [page, selectedCompany?.id, profileRunState]);

  const hasActiveRuns = dashboard?.recent_runs?.some((run) => ['queued', 'running'].includes(run.status));
  useEffect(() => {
    if (!hasActiveRuns) return undefined;
    const timer = window.setInterval(() => {
      loadDashboard().catch((requestError) => setError(requestError.message));
    }, 2000);
    return () => window.clearInterval(timer);
  }, [hasActiveRuns]);

  const batchStatusCounts = batchResults.reduce((counts, item) => {
    const status = researchRuns.find((run) => Number(run.id) === Number(item.run_id))?.status || item.status;
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});

  function navigate(nextPage) {
    setError('');
    setNotice('');
    setPage(nextPage);
  }

  function openNewCompany() {
    setCompanyForm(emptyCompany);
    setWebsiteConfirmed(false);
    setCompanyDialog({ mode: 'create' });
  }

  function openEditCompany(company) {
    setCompanyForm({
      company_name: company.company_name || '',
      cin: company.cin || '',
      industry: company.industry || '',
      city: company.city || '',
      official_website: company.official_website || '',
      contact_email: company.contact_email || '',
      contact_phone: company.contact_phone || '',
      contact_name: company.contact_name || '',
      contact_designation: company.contact_designation || '',
      notes: company.notes || '',
    });
    setWebsiteConfirmed(false);
    setCompanyDialog({ mode: 'edit', company });
  }

  async function saveCompany(event) {
    event.preventDefault();
    if (submissions.current.has('company')) return;
    const websiteChanged = companyDialog.mode === 'create'
      ? Boolean(companyForm.official_website.trim())
      : companyForm.official_website.trim() !== (companyDialog.company.official_website || '').trim();
    if (companyDialog.mode === 'edit' && websiteChanged && companyForm.official_website.trim() && !websiteConfirmed) {
      setError('Confirm that this is the company’s official website before saving it.');
      return;
    }
    submissions.current.add('company');
    setSaving(true);
    setError('');
    try {
      const isEdit = companyDialog.mode === 'edit';
      if (!isEdit) {
        const params = new URLSearchParams({ name: companyForm.company_name.trim() });
        const { matches = [] } = await api(`/companies/matches?${params}`);
        if (matches.length) {
          if (window.confirm(`${matches[0].company_name} is already in the registry. Open that existing company instead?`)) {
            setCompanyDialog(null);
            await openProfile(matches[0]);
            return;
          }
          throw new Error('A matching company already exists. Select the existing registry record to continue.');
        }
      }
      const saved = await api(isEdit ? `/companies/${companyDialog.company.id}` : '/companies', {
        method: isEdit ? 'PATCH' : 'POST',
        body: JSON.stringify(isEdit ? {
          ...companyForm,
          confirm_official_website: websiteConfirmed,
        } : {
          company_name: companyForm.company_name.trim(),
          official_website: companyForm.official_website.trim(),
          confirm_official_website: true,
        }),
      });
      setCompanyDialog(null);
      setNotice(isEdit
        ? 'Company details updated.'
        : `Company added; research run ${runNumber(saved.research_run.id)} is queued using its confirmed official website.`);
      if (!isEdit) {
        setViewAllCompanies(true);
        setCompanyPage(1);
        setPage('companies');
      }
      await Promise.all([isEdit ? loadCompanies() : Promise.resolve(), loadDashboard()]);
      if (selectedCompany && isEdit) await loadProfile(selectedCompany.id);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
      submissions.current.delete('company');
    }
  }

  async function scanImport(file, sheet) {
      setImportBusy(true);
      setError('');
      try {
        const scanned = await upload('/imports/scan', file, { sheet });
        setImportFile(file);
        setImportScan(scanned);
        setImportMappings(scanned.suggested_mappings || {});
        setImportPreview(null);
        setImportResolutions({});
      } catch (requestError) {
        setError(requestError.message);
      } finally {
        setImportBusy(false);
      }
    }

  async function previewImport() {
      if (!importFile || !importScan) return;
      setImportBusy(true);
      setError('');
      try {
        const data = await upload('/imports/preview', importFile, {
          mappings: importMappings,
          sheet: importScan.selected_sheet,
        });
        setImportPreview(data);
        setImportResolutions({});
      } catch (requestError) {
        setError(requestError.message);
      } finally {
        setImportBusy(false);
      }
    }

  async function confirmImport() {
      if (!importFile || !importPreview || importBusy) return;
      setImportBusy(true);
      setError('');
      try {
        const result = await upload('/imports/confirm', importFile, {
          mappings: importMappings,
          sheet: importScan.selected_sheet,
          resolutions: importResolutions,
        });
        setImportOpen(false);
        setNotice(`Import batch ${result.import_batch.id} saved: ${result.import_batch.imported_rows} rows, ${result.import_batch.error_rows} validation errors.`);
        await Promise.all([loadCompanies(), loadDashboard()]);
      } catch (requestError) {
        setError(requestError.message);
      } finally {
        setImportBusy(false);
    }
  }

  async function deleteCompany(company) {
    if (!window.confirm(`Delete ${company.company_name} and its research history? This cannot be undone.`)) return;
    try {
      await api(`/companies/${company.id}`, { method: 'DELETE' });
      setNotice('Company and its stored research history were deleted.');
      if (selectedCompany?.id === company.id) {
        setSelectedCompany(null);
        setProfile(null);
        setPage('companies');
      }
      await Promise.all([loadCompanies(), loadDashboard()]);
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function openProfile(company) {
    setSelectedCompany(company);
    setProfile(null);
    navigate('profile');
    try {
      const data = await api(`/companies/${company.id}`);
      setProfile(data);
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function openProfileById(id) {
    setSelectedCompany({ id });
    setProfile(null);
    navigate('profile');
    try {
      const data = await api(`/companies/${id}`);
      setSelectedCompany(data.company);
      setProfile(data);
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function startResearch(company) {
    if (!company.official_website) {
      setError('Add the confirmed official website before starting a research run.');
      openEditCompany(company);
      return;
    }
    setResearchConfirmed(false);
    setResearchDialog(company);
  }

  async function confirmResearch() {
    const company = researchDialog;
    if (!company || !researchConfirmed || submissions.current.has(`research-${company.id}`)) return;
    submissions.current.add(`research-${company.id}`);
    setResearching(true);
    setError('');
    try {
      const response = await api(`/companies/${company.id}/research`, {
        method: 'POST',
        body: JSON.stringify({ confirm_official_website: true }),
      });
      setNotice(response.research_run.already_active
        ? `Research run ${runNumber(response.research_run.id)} is already ${response.research_run.status}.`
        : `Research run ${runNumber(response.research_run.id)} was queued.`);
      setPage('research');
      setResearchPage(1);
      setSelectedCompany(company);
      await Promise.all([loadDashboard(), loadCompanies()]);
      await loadProfile(company.id);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setResearching(false);
      submissions.current.delete(`research-${company.id}`);
      setResearchDialog(null);
    }
  }

  async function startBatchResearch() {
    if (!selectedCompanyIds.length) return;
    if (selectedCompanyIds.length > 25) {
      setError('A batch can include up to 25 companies. Reduce your selection and start another batch.');
      return;
    }
    const confirmed = window.confirm(`Queue research for ${selectedCompanyIds.length} selected companies that have saved official domains? Companies without confirmed domains will be listed and skipped.`);
    if (!confirmed) return;
    setResearching(true);
    try {
      const result = await api('/research/batch', {
        method: 'POST',
        body: JSON.stringify({ company_ids: selectedCompanyIds, confirm_official_websites: true }),
      });
      const queued = result.summary?.queued || 0;
      const skipped = (result.summary?.needs_domain || 0) + (result.summary?.already_running || 0) + (result.summary?.failed || 0);
      const details = (result.results || []).filter((item) => item.status !== 'queued').map((item) => `${item.company_name || `Company ${item.company_id}`}: ${item.message || item.status}`).join(' · ');
      setBatchResults(result.results || []);
      setNotice(`Batch queued ${queued} run${queued === 1 ? '' : 's'}; ${skipped} skipped or failed.${details ? ` ${details}` : ''}`);
      setSelectedCompanyIds([]);
      setPage('research');
      setResearchPage(1);
      await Promise.all([loadDashboard(), loadCompanies()]);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setResearching(false);
    }
  }

  async function openDocument(id) {
    try {
      const data = await api(`/documents/${id}`);
      setDocument(data.document);
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function saveFinding(finding) {
    if (submissions.current.has(`finding-${finding.id}`)) return;
    submissions.current.add(`finding-${finding.id}`);
    setSavingFinding((current) => ({ ...current, [finding.id]: true }));
    const edit = findingEdits[finding.id] || {};
    try {
      await api(`/findings/${finding.id}/review`, {
        method: 'PATCH',
        body: JSON.stringify({
          finding_value: edit.finding_value ?? finding.finding_value,
          financial_year: edit.financial_year ?? finding.financial_year,
          review_status: edit.review_status || finding.review_status,
          reviewer_notes: edit.reviewer_notes ?? finding.reviewer_notes ?? '',
        }),
      });
      setNotice('Finding review saved.');
      setFindingEdits((current) => {
        const next = { ...current };
        delete next[finding.id];
        return next;
      });
      await Promise.all([loadProfile(profile.company.id), loadDashboard()]);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      submissions.current.delete(`finding-${finding.id}`);
      setSavingFinding((current) => ({ ...current, [finding.id]: false }));
    }
  }

  async function loadFindingHistory(findingId) {
    try {
      const data = await api(`/findings/${findingId}/history`);
      setFindingHistory((current) => ({ ...current, [findingId]: data.history || [] }));
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function markUnavailable() {
    if (!unavailableField || !profile || submissions.current.has('mark-unavailable')) return;
    submissions.current.add('mark-unavailable');
    setMarkingUnavailable(true);
    try {
      await api(`/companies/${profile.company.id}/findings`, {
        method: 'POST',
        body: JSON.stringify({ field_name: unavailableField }),
      });
      setUnavailableField('');
      setNotice(`${unavailableField} marked unavailable for this company.`);
      await Promise.all([loadProfile(profile.company.id), loadDashboard()]);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setMarkingUnavailable(false);
      submissions.current.delete('mark-unavailable');
    }
  }

  async function showDocument(documentId) {
    const item = profile.documents.find((candidate) => candidate.id === documentId);
    if (!item) return;
    if (item.extracted_text !== undefined) {
      setDocument(item);
      return;
    }
    await openDocument(documentId);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#" onClick={(event) => { event.preventDefault(); navigate('dashboard'); }}>
          <span className="brand-mark">SL</span>
          <span><strong>Fieldnotes</strong><small>CSR research workspace</small></span>
        </a>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          <button className={page === 'dashboard' ? 'nav-item active' : 'nav-item'} onClick={() => navigate('dashboard')}>
            <span>◫</span> Overview
          </button>
          <button className={page === 'companies' || page === 'profile' ? 'nav-item active' : 'nav-item'} onClick={() => navigate('companies')}>
            <span>▦</span> Companies
          </button>
          <button className={page === 'research' || page === 'researchDetail' ? 'nav-item active' : 'nav-item'} onClick={() => navigate('research')}>
            <span>◷</span> Research runs
          </button>
        </nav>
        <div className="sidebar-bottom">
          <span className={`connection-dot connection-${databaseState}`} />
          <span>{databaseState === 'connected' ? 'MySQL connected' : databaseState === 'checking' ? 'Checking connection' : 'MySQL setup required'}</span>
          <small>Human review required</small>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb">Service learning <span>/</span> {page === 'profile' ? 'Company profile' : pageLabel(page)}</div>
          <div className="topbar-actions">
            <span className="review-note">Research suggestions require verification</span>
            <button className="button button-primary button-small" onClick={openNewCompany}>＋ Add company</button>
          </div>
        </header>

        <div className="content">
          {error && <div className="alert alert-error" role="alert">{error}<button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
          {notice && <div className="alert alert-success" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss notice">×</button></div>}
          {loading && !dashboard && <div className="loading-card">Connecting to the research database…</div>}
          {!loading && !dashboard && error && <div className="empty-state"><h2>Database connection required</h2><p>{error}</p><button className="button button-outline" onClick={() => void refreshHome()}>Retry connection</button></div>}

          {dashboard && page === 'dashboard' && (
            <Dashboard dashboard={dashboard} onPage={navigate} onCompany={(run) => {
              void openProfileById(run.company_id);
            }} onDetails={(run) => void openRunDetail(run.id)} />
          )}

          {dashboard && page === 'companies' && (
            <section>
              <div className="page-heading">
                <div><p className="eyebrow">COMPANY DIRECTORY</p><h1>Find companies</h1><p className="muted">Search companies, review their official sources, and track report discovery.</p></div>
                <div className="page-actions">
                  <button className="button button-outline" onClick={() => void openBulkReview()}>
                    Bulk review candidates ({domainSummary?.needs_manual_review ?? '—'})
                  </button>
                  <button className="button button-outline" onClick={() => { setImportOpen(true); setImportFile(null); setImportScan(null); setImportPreview(null); }}>Import spreadsheet</button>
                  <button className="button button-primary" onClick={openNewCompany}>＋ Add company</button>
                </div>
              </div>
              <div className="readiness-filter-chips">
                <button
                  type="button"
                  className={`readiness-chip ${websiteStatusFilter === '' ? 'active' : ''}`}
                  onClick={() => { setCompanyPage(1); setWebsiteStatusFilter(''); }}
                >
                  All companies <span className="chip-count">{domainSummary?.total ?? companyTotal}</span>
                </button>
                <button
                  type="button"
                  className={`readiness-chip ${websiteStatusFilter === 'ready_to_research' ? 'active' : ''}`}
                  onClick={() => { setCompanyPage(1); setWebsiteStatusFilter('ready_to_research'); }}
                >
                  Ready to research <span className="chip-count">{domainSummary?.ready_to_research ?? '—'}</span>
                </button>
                <button
                  type="button"
                  className={`readiness-chip ${websiteStatusFilter === 'needs_manual_review' ? 'active' : ''}`}
                  onClick={() => { setCompanyPage(1); setWebsiteStatusFilter('needs_manual_review'); }}
                >
                  Needs manual review <span className="chip-count">{domainSummary?.needs_manual_review ?? '—'}</span>
                </button>
                <button
                  type="button"
                  className={`readiness-chip ${websiteStatusFilter === 'waiting_for_website' ? 'active' : ''}`}
                  onClick={() => { setCompanyPage(1); setWebsiteStatusFilter('waiting_for_website'); }}
                >
                  Waiting for website <span className="chip-count">{domainSummary?.waiting_for_website ?? '—'}</span>
                </button>
              </div>
              <div className="filter-bar">
                <label className="search-box"><span>⌕</span><input value={search} onChange={(event) => { setCompanyPage(1); setSearch(event.target.value); }} placeholder="Search company name…" /></label>
                <select value={industryFilter} onChange={(event) => { setCompanyPage(1); setIndustryFilter(event.target.value); }} aria-label="Filter by industry">
                  <option value="">All industries</option>
                  {industries.map((industry) => <option key={industry}>{industry}</option>)}
                </select>
                <select value={cityFilter} onChange={(event) => { setCompanyPage(1); setCityFilter(event.target.value); }} aria-label="Filter by location">
                  <option value="">All locations</option>{locations.map((city) => <option key={city}>{city}</option>)}
                </select>
              </div>
              {Object.keys(interpretedFilters).length > 0 && <div className="interpreted-filters"><strong>Interpreted from your query</strong>{Object.entries(interpretedFilters).map(([key, value]) => <span className="filter-chip" key={key}>{key.replaceAll('_', ' ')}: {value}</span>)}<small>Edit available fields in Advanced filters.</small></div>}
              <div className="page-actions"><span className="muted">Starting a run uses each selected company’s confirmed official website.</span><button className="button button-outline" disabled={!selectedCompanyIds.length || researching} onClick={() => void startBatchResearch()}>{researching ? 'Queueing…' : 'Start research for selection'}</button></div>
              <details className="advanced-filters"><summary>Advanced filters</summary><div className="advanced-filter-grid">
                <div className="focus-area-filter">
                  <strong>CSR focus areas</strong>
                  <div className="focus-area-toolbar"><label>Match<select value={focusMode} onChange={(event) => { setCompanyPage(1); setFocusMode(event.target.value); }}><option value="any">any selected area</option><option value="all">all selected areas</option></select></label><button className="text-button" type="button" disabled={!focusFilter.length} onClick={() => { setCompanyPage(1); setFocusFilter([]); }}>Clear selected</button></div>
                  {focusFilter.length > 0 && <div className="focus-selected-values">{focusFilter.map((area) => <button type="button" className="focus-selected-chip" key={area} onClick={() => { setCompanyPage(1); setFocusFilter((current) => current.filter((item) => item !== area)); }}>{area}<span aria-hidden="true"> ×</span><span className="sr-only">Remove {area}</span></button>)}</div>}
                  <div className="focus-area-options" aria-label="Select CSR focus areas">{focusAreas.map((area) => <label key={area}><input type="checkbox" checked={focusFilter.includes(area)} onChange={() => { setCompanyPage(1); setFocusFilter((current) => current.includes(area) ? current.filter((item) => item !== area) : [...current, area]); }} />{area}</label>)}</div>
                </div>
                <label>Annual turnover comparison<select value={turnoverOperator} onChange={(event) => { setCompanyPage(1); setTurnoverOperator(event.target.value); }}><option value="">No turnover condition</option><option value="gt">Greater than</option><option value="gte">Greater than or equal to</option><option value="lt">Less than</option><option value="lte">Less than or equal to</option><option value="between">Between</option></select></label>
                {turnoverOperator && <><label>{turnoverOperator === 'between' ? `From amount${turnoverBasis ? ` (${turnoverBasis.replace('|', ' · ')})` : ''}` : `Amount${turnoverBasis ? ` (${turnoverBasis.replace('|', ' · ')})` : ''}`}<input type="number" min="0" step="any" value={turnoverAmount} onChange={(event) => { setCompanyPage(1); setTurnoverAmount(event.target.value); }} placeholder="Enter amount" /></label>{turnoverOperator === 'between' && <label>{`To amount${turnoverBasis ? ` (${turnoverBasis.replace('|', ' · ')})` : ''}`}<input type="number" min="0" step="any" value={turnoverAmountTo} onChange={(event) => { setCompanyPage(1); setTurnoverAmountTo(event.target.value); }} placeholder="Enter upper amount" /></label>}<label>Currency and unit<select value={turnoverBasis} onChange={(event) => setTurnoverBasis(event.target.value)}><option value="">Select currency / unit</option>{turnoverBases.map((basis, index) => <option key={`${basis.turnover_currency}-${basis.turnover_unit}-${index}`} value={`${basis.turnover_currency || ''}|${basis.turnover_unit || ''}`}>{[basis.turnover_currency, basis.turnover_unit].filter(Boolean).join(' · ') || 'Unspecified currency / unit'}</option>)}</select></label></>}
                <label>CSR contact<select value={contactFilter} onChange={(event) => setContactFilter(event.target.value)}><option value="">Any contact status</option><option value="present">Has CSR contact</option><option value="missing_email">Missing CSR email</option></select></label>
              </div><small>Filters combine with AND. Turnover uses the selected source currency and unit without conversion. Companies with missing turnover remain available unless a turnover comparison is active.</small></details>
              <div className="page-actions discovery-actions"><span className="muted">{viewAllCompanies || companies.length ? `${companyTotal} matching companies` : 'Search to begin, or choose View all companies.'}</span><div><button className="button button-outline button-small" onClick={() => { setSearch(''); setIndustryFilter(''); setStatusFilter(''); setCityFilter(''); setFocusFilter([]); setFocusMode('any'); setTurnoverOperator(''); setTurnoverAmount(''); setTurnoverAmountTo(''); setTurnoverBasis(''); setContactFilter(''); setCompanyPage(1); setViewAllCompanies(false); }}>Clear filters</button><button className="button button-primary button-small" onClick={() => { setViewAllCompanies(true); setCompanyPage(1); }}>View all companies</button></div></div>
              {companiesLoading ? <div className="loading-card">Searching the company database…</div> : !viewAllCompanies && !search && !industryFilter && !cityFilter && !focusFilter.length && !(turnoverOperator && turnoverAmount && turnoverBasis) && !contactFilter ? <div className="empty-state"><h2>Search the company data</h2><p>Try “IT companies in Pune”, “education”, or a company name. Use View all companies when you need the full directory.</p></div> : <CompanyTable companies={companies} selectedIds={selectedCompanyIds} onToggle={(id) => setSelectedCompanyIds((ids) => ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id])} onOpen={openProfile} onEdit={openEditCompany} onDelete={deleteCompany} onResearch={startResearch} />}
              {companyPages > 1 && <div className="pagination"><span>Page {companyPage} of {companyPages}</span><div><button className="button button-outline button-small" disabled={companyPage <= 1} onClick={() => setCompanyPage((current) => current - 1)}>Previous</button><button className="button button-outline button-small" disabled={companyPage >= companyPages} onClick={() => setCompanyPage((current) => current + 1)}>Next</button></div></div>}
            </section>
          )}

          {page === 'research' && (
            <section>
              <div className="page-heading"><div><p className="eyebrow">ACTIVITY</p><h1>Research runs</h1><p className="muted">Persisted run history and current document-processing status.</p></div><div className="page-actions"><button className="button button-outline" onClick={() => void exportAllResearchHistory()} disabled={exportingHistory}>{exportingHistory ? 'Preparing CSV…' : 'Export all CSV'}</button><button className="button button-outline" onClick={() => void loadResearchHistory(researchPage)} disabled={researchLoading}>{researchLoading ? 'Refreshing…' : 'Refresh history'}</button></div></div>
              {batchResults.length > 0 && <><div className="section-heading"><div><p className="eyebrow">LATEST BATCH</p><h2>{batchStatusCounts.completed || 0} completed · {batchStatusCounts.partially_completed || 0} partial · {batchStatusCounts.failed || 0} failed · {batchStatusCounts.queued || 0} queued · {batchStatusCounts.running || 0} running · {batchStatusCounts.needs_domain || 0} need a domain · {batchStatusCounts.already_running || 0} already running</h2></div></div><div className="table-wrap"><table><thead><tr><th>Company</th><th>Run ID</th><th>Status</th><th>Details</th></tr></thead><tbody>{batchResults.map((item) => { const savedRun = researchRuns.find((run) => Number(run.id) === Number(item.run_id)); return <tr key={item.company_id}><td>{item.company_name || `Company ${item.company_id}`}</td><td>{item.run_id ? runNumber(item.run_id) : '—'}</td><td><Status value={savedRun?.status || item.status} /></td><td>{item.message || savedRun?.error_summary || savedRun?.progress_message || 'Queued for research'}</td></tr>; })}</tbody></table></div></>}
              {researchError && <div className="alert alert-error" role="alert">{researchError}<button onClick={() => setResearchError('')} aria-label="Dismiss history error">×</button></div>}
              {researchLoading && researchRuns.length === 0 ? <div className="loading-card">Loading saved research runs…</div> : null}
              {!researchLoading && !researchError && researchRuns.length === 0 ? <div className="empty-state"><h2>No saved research runs</h2><p>Add a company with its confirmed official website to queue report discovery.</p><button className="button button-outline" onClick={() => navigate('companies')}>Browse companies</button></div> : null}
              {researchRuns.length > 0 && <ResearchRuns runs={researchRuns} onDetails={(run) => void openRunDetail(run.id)} onCompany={(run) => {
                void openProfileById(run.company_id);
              }} />}
              {researchRuns.length > 0 && <div className="pagination"><span>Page {researchPagination.page || researchPage} of {researchPagination.total_pages || 1}{researchPagination.total != null ? ` · ${researchPagination.total} runs` : ''}</span><div><button className="button button-outline button-small" disabled={researchLoading || researchPage <= 1} onClick={() => void loadResearchHistory(researchPage - 1)}>Previous</button><button className="button button-outline button-small" disabled={researchLoading || researchPage >= (researchPagination.total_pages || 1)} onClick={() => void loadResearchHistory(researchPage + 1)}>Next</button></div></div>}
            </section>
          )}

          {page === 'researchDetail' && (
            <ResearchRunDetail
              detail={runDetail}
              loading={runDetailLoading}
              error={runDetailError}
              onBack={() => navigate('research')}
              onCompany={(id) => void openProfileById(id)}
            />
          )}

          {dashboard && page === 'profile' && (
            <CompanyProfile
              profile={profile}
              onBack={() => navigate('companies')}
              onEdit={() => profile && openEditCompany(profile.company)}
              onDelete={() => profile && deleteCompany(profile.company)}
              onResearch={() => profile && startResearch(profile.company)}
              onRunDetails={(run) => void openRunDetail(run.id)}
              onDocument={showDocument}
              onSaveFinding={saveFinding}
              onFindingHistory={loadFindingHistory}
              findingHistory={findingHistory}
              savingFinding={savingFinding}
              findingEdits={findingEdits}
              setFindingEdits={setFindingEdits}
              unavailableField={unavailableField}
              setUnavailableField={setUnavailableField}
              onMarkUnavailable={markUnavailable}
              markingUnavailable={markingUnavailable}
            />
          )}
        </div>
      </main>

      {companyDialog && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setCompanyDialog(null); }}>
          <form className="modal-card" onSubmit={saveCompany}>
            <div className="modal-heading"><div><p className="eyebrow">{companyDialog.mode === 'edit' ? 'COMPANY DETAILS' : 'NEW RECORD'}</p><h2>{companyDialog.mode === 'edit' ? 'Edit company' : 'Add company'}</h2></div><button type="button" className="icon-button" disabled={saving} onClick={() => setCompanyDialog(null)} aria-label="Close">×</button></div>
            <label>Company name <span className="required">*</span><input autoFocus required maxLength="200" value={companyForm.company_name} onChange={(event) => { setCompanyForm({ ...companyForm, company_name: event.target.value }); setWebsiteConfirmed(false); setDomainSuggestion(null); }} /></label>
            {companyDialog.mode === 'create' ? <label>Official website <span className="required">*</span><input type="text" inputMode="url" required value={companyForm.official_website} onChange={(event) => setCompanyForm({ ...companyForm, official_website: event.target.value })} placeholder="https://www.company.com" /></label> : <div className="company-edit-fields">
              <label>Industry<input maxLength="160" value={companyForm.industry} onChange={(event) => setCompanyForm({ ...companyForm, industry: event.target.value })} placeholder="e.g. Automotive" /></label>
              <label>Headquarters / city<input maxLength="160" value={companyForm.city} onChange={(event) => setCompanyForm({ ...companyForm, city: event.target.value })} /></label>
              <label>Confirmed official website<input type="text" inputMode="url" value={companyForm.official_website} onChange={(event) => { setCompanyForm({ ...companyForm, official_website: event.target.value }); setWebsiteConfirmed(false); }} placeholder="https://www.company.com" /></label>
              {suggestionLoading && <p className="suggestion-note" role="status">Checking for a domain suggestion…</p>}
              {!suggestionLoading && domainSuggestion && <div className="domain-suggestion"><strong>Official source suggestion: {domainSuggestion.website}</strong><button type="button" className="button button-outline button-small" onClick={() => setCompanyForm((current) => ({ ...current, official_website: domainSuggestion.website }))}>Use suggestion</button></div>}
              {!suggestionLoading && suggestionError && <p className="suggestion-note" role="status">{suggestionError}</p>}
              {companyForm.official_website.trim() && (companyForm.official_website.trim() !== (companyDialog.company.official_website || '').trim() || !companyDialog.company.official_website_verified_at) && <label className="checkbox-label"><input type="checkbox" checked={websiteConfirmed} onChange={(event) => setWebsiteConfirmed(event.target.checked)} />I confirm this is the company’s official website and is suitable as a research starting point.</label>}
              <label>Contact email<input type="email" maxLength="254" value={companyForm.contact_email} onChange={(event) => setCompanyForm({ ...companyForm, contact_email: event.target.value })} /></label>
              <label>Contact phone<input maxLength="40" value={companyForm.contact_phone} onChange={(event) => setCompanyForm({ ...companyForm, contact_phone: event.target.value })} /></label>
              <label>CSR contact name<input maxLength="200" value={companyForm.contact_name} onChange={(event) => setCompanyForm({ ...companyForm, contact_name: event.target.value })} /></label>
              <label>Contact designation<input maxLength="160" value={companyForm.contact_designation} onChange={(event) => setCompanyForm({ ...companyForm, contact_designation: event.target.value })} /></label>
              <label>Research notes<textarea rows="3" maxLength="10000" value={companyForm.notes} onChange={(event) => setCompanyForm({ ...companyForm, notes: event.target.value })} /></label>
            </div>}
            <div className="modal-actions"><button type="button" className="button button-outline" disabled={saving} onClick={() => setCompanyDialog(null)}>Cancel</button><button className="button button-primary" disabled={saving || (companyDialog.mode === 'create' && (!companyForm.company_name.trim() || !companyForm.official_website.trim())) || (companyDialog.mode === 'edit' && Boolean(companyForm.official_website.trim()) && (companyForm.official_website.trim() !== (companyDialog.company.official_website || '').trim() || !companyDialog.company.official_website_verified_at) && !websiteConfirmed)}>{saving ? 'Saving…' : companyDialog.mode === 'create' ? 'Add company' : 'Save company'}</button></div>
          </form>
        </div>
      )}

      {importOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !importBusy) setImportOpen(false); }}>
          <div className="modal-card import-dialog">
            <div className="modal-heading"><div><p className="eyebrow">COMPANY REGISTRY</p><h2>Import spreadsheet</h2></div><button type="button" className="icon-button" disabled={importBusy} onClick={() => setImportOpen(false)} aria-label="Close">×</button></div>
            <p className="muted">CSV, XLS and XLSX are supported. Scan and preview do not write to MySQL. Imported domains remain candidates until a researcher confirms them.</p>
            <label>Spreadsheet file<input type="file" accept=".csv,.xls,.xlsx" disabled={importBusy} onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void scanImport(file);
            }} /></label>
            {importScan && <>
              {importScan.sheets.length > 1 && <label>Worksheet<select value={importScan.selected_sheet} disabled={importBusy} onChange={(event) => void scanImport(importFile, event.target.value)}>{importScan.sheets.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>}
              <p className="suggestion-note">{importScan.filename} · {importScan.headers.length} columns · {importPreview ? `${importPreview.row_count} data rows` : 'Choose a mapping for each relevant column.'}</p>
              <div className="mapping-list">{importScan.headers.map((header) => (
                <label key={header}><span title={header}>{header || '(empty header)'}</span><select value={importMappings[header] || ''} onChange={(event) => { setImportMappings((current) => ({ ...current, [header]: event.target.value })); setImportPreview(null); }}><option value="">Ignore column</option>{importScan.import_fields.map((field) => <option key={field} value={field}>{field.replaceAll('_', ' ')}</option>)}</select></label>
              ))}</div>
              <div className="modal-actions"><button className="button button-outline" disabled={importBusy || !Object.values(importMappings).includes('company_name')} onClick={() => void previewImport()}>{importBusy ? 'Working…' : 'Preview and validate'}</button></div>
            </>}
            {importPreview && <>
              <p className="muted">Valid rows: {importPreview.valid_rows} · Rows with errors: {importPreview.error_rows}. Review matches and skip any rows you do not want merged.</p>
              <div className="table-wrap import-preview"><table><thead><tr><th>Row</th><th>Company</th><th>Resolution</th><th>Validation</th></tr></thead><tbody>{importPreview.rows.slice(0, 200).map((row) => <tr key={row.row_number}><td>{row.row_number}</td><td>{row.mapped.company_name || '—'}</td><td>{row.validation_errors.length ? 'Invalid' : <select aria-label={`Resolve row ${row.row_number}`} value={importResolutions[row.row_number] || 'use_existing'} onChange={(event) => setImportResolutions((current) => ({ ...current, [row.row_number]: event.target.value }))}><option value="use_existing">{row.matched_company ? `Merge: ${row.matched_company.company_name}` : row.duplicate_of_row ? `Merge row ${row.duplicate_of_row}` : 'Create or merge'}</option><option value="skip">Skip this row</option></select>}</td><td>{row.validation_errors.join('; ') || (row.duplicate_of_row ? `Duplicate of row ${row.duplicate_of_row}` : '')}</td></tr>)}</tbody></table></div>
              {importPreview.rows.length > 200 && <p className="suggestion-note">Showing first 200 of {importPreview.rows.length} rows. All rows are included in validation and import.</p>}
              <div className="modal-actions"><button className="button button-outline" disabled={importBusy} onClick={() => setImportPreview(null)}>Back to mappings</button><button className="button button-primary" disabled={importBusy} onClick={() => void confirmImport()}>{importBusy ? 'Importing…' : 'Confirm import'}</button></div>
            </>}
          </div>
        </div>
      )}

      {researchDialog && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !researching) setResearchDialog(null); }}>
          <div className="modal-card">
            <div className="modal-heading"><div><p className="eyebrow">CONFIRM RESEARCH</p><h2>Start a research run?</h2></div><button type="button" className="icon-button" disabled={researching} onClick={() => setResearchDialog(null)} aria-label="Close">×</button></div>
            <p className="muted">The researcher will use only the saved official website for <strong>{researchDialog.company_name}</strong>:</p>
            <p className="source-link">{researchDialog.official_website}</p>
            <label className="checkbox-label"><input type="checkbox" checked={researchConfirmed} onChange={(event) => setResearchConfirmed(event.target.checked)} />I have checked this official website and authorize a research run.</label>
            <div className="modal-actions"><button type="button" className="button button-outline" disabled={researching} onClick={() => setResearchDialog(null)}>Cancel</button><button type="button" className="button button-primary" disabled={!researchConfirmed || researching} onClick={() => void confirmResearch()}>{researching ? 'Starting…' : 'Start research'}</button></div>
          </div>
        </div>
      )}

      {bulkReviewOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !bulkSubmitting) setBulkReviewOpen(false); }}>
          <div className="modal-card bulk-modal-card">
            <div className="modal-heading">
              <div>
                <p className="eyebrow">BULK WEBSITE REVIEW</p>
                <h2>Review candidate websites ({bulkReviewItems.length} companies)</h2>
              </div>
              <button type="button" className="icon-button" disabled={bulkSubmitting} onClick={() => setBulkReviewOpen(false)} aria-label="Close">×</button>
            </div>
            <p className="muted">Review candidate websites identified from authoritative sources. Uncheck any companies that require further investigation, edit candidate URLs if necessary, and confirm verified websites in bulk.</p>
            {bulkReviewLoading ? (
              <div className="loading-card">Loading companies needing manual review…</div>
            ) : !bulkReviewItems.length ? (
              <div className="empty-state"><p>No companies currently need manual review. All companies are either confirmed or waiting for candidate URLs.</p></div>
            ) : (
              <>
                <div className="page-actions" style={{ justifyContent: 'space-between', margin: '10px 0' }}>
                  <div>
                    <button type="button" className="button button-outline button-small" onClick={() => setBulkReviewItems((items) => items.map((item) => ({ ...item, selected: true })))}>Select all</button>
                    <button type="button" className="button button-outline button-small" style={{ marginLeft: 6 }} onClick={() => setBulkReviewItems((items) => items.map((item) => ({ ...item, selected: false })))}>Deselect all</button>
                  </div>
                  <span className="muted">{bulkReviewItems.filter((i) => i.selected).length} selected for confirmation</span>
                </div>
                <div className="bulk-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th style={{ width: 40 }}>Select</th>
                        <th style={{ width: 180 }}>Company</th>
                        <th style={{ width: 140 }}>Location / Industry</th>
                        <th>Candidate website</th>
                        <th style={{ width: 180 }}>Review notes / source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bulkReviewItems.map((item, index) => (
                        <tr key={item.id}>
                          <td>
                            <input
                              type="checkbox"
                              checked={item.selected}
                              onChange={(e) => {
                                const checked = e.target.checked;
                                setBulkReviewItems((items) => items.map((it, idx) => idx === index ? { ...it, selected: checked } : it));
                              }}
                            />
                          </td>
                          <td>
                            <strong>{item.company_name}</strong>
                          </td>
                          <td>{[item.industry, item.city].filter(Boolean).join(' · ') || '—'}</td>
                          <td>
                            <input
                              type="url"
                              className="bulk-candidate-input"
                              value={item.candidate}
                              placeholder="https://www.example.com/"
                              onChange={(e) => {
                                const val = e.target.value;
                                setBulkReviewItems((items) => items.map((it, idx) => idx === index ? { ...it, candidate: val } : it));
                              }}
                            />
                            {item.candidate && (
                              <a href={item.candidate} target="_blank" rel="noreferrer" className="source-link" style={{ display: 'inline-block', marginTop: 2 }}>
                                Test link ↗
                              </a>
                            )}
                          </td>
                          <td><small className="muted">{item.notes ? item.notes.replace(/^Website verification:\s*/, '') : 'Manual review'}</small></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="modal-actions">
                  <button type="button" className="button button-outline" disabled={bulkSubmitting} onClick={() => setBulkReviewOpen(false)}>Cancel</button>
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={bulkSubmitting || !bulkReviewItems.some((i) => i.selected && i.candidate.trim())}
                    onClick={() => void submitBulkReview()}
                  >
                    {bulkSubmitting ? 'Confirming…' : `Confirm ${bulkReviewItems.filter((i) => i.selected && i.candidate.trim()).length} selected websites`}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {document && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDocument(null); }}>
          <div className="modal-card document-modal">
            <div className="modal-heading"><div><p className="eyebrow">SOURCE DOCUMENT</p><h2>{document.title}</h2></div><button className="icon-button" onClick={() => setDocument(null)} aria-label="Close">×</button></div>
            <a className="source-link" href={document.source_url} target="_blank" rel="noreferrer">{document.source_url} ↗</a>
            <Status value={document.processing_status || document.status} />
            {document.processing_error && <p className="muted">{document.processing_error}</p>}
            <pre className="document-text">{document.extracted_text || 'No extractable text is stored for this source.'}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

function pageLabel(page) {
  return { dashboard: 'Overview', companies: 'Companies', research: 'Research runs' }[page] || 'Workspace';
}

function Dashboard({ dashboard, onPage, onCompany, onDetails }) {
  const metrics = [
    ['Total companies', dashboard.total_companies, 'In the research directory'],
    ['Researched', dashboard.researched_companies, 'With at least one run'],
    ['Pending research', dashboard.pending_companies, 'Not started or failed'],
    ['Documents', dashboard.documents_discovered, 'Sources recorded'],
    ['Awaiting review', dashboard.findings_awaiting_review, 'Evidence needs a person'],
  ];
  return (
    <section>
      <div className="welcome-row"><div><p className="eyebrow">CSR RESEARCH WORKSPACE</p><h1>Research, with evidence.</h1><p className="muted">A source-first workspace for company CSR research and human review.</p></div><button className="button button-primary" onClick={() => onPage('companies')}>Browse companies <span>→</span></button></div>
      <div className="metric-grid">{metrics.map(([label, value, hint]) => <article className="metric-card" key={label}><span>{label}</span><strong>{value ?? '—'}</strong><small>{hint}</small></article>)}</div>
      <div className="section-heading"><div><p className="eyebrow">LATEST ACTIVITY</p><h2>Recent research runs</h2></div><button className="text-button" onClick={() => onPage('research')}>All runs <span>→</span></button></div>
      <ResearchRuns runs={dashboard.recent_runs || []} onCompany={onCompany} onDetails={onDetails} />
      <div className="callout"><span className="callout-icon">i</span><div><strong>Research assistance, not verification</strong><p>Extracted information retains source evidence and stays pending until a researcher reviews it.</p></div></div>
    </section>
  );
}

function CompanyTable({ companies, selectedIds = [], onToggle = () => {}, onOpen, onEdit, onDelete, onResearch }) {
  if (!companies.length) return <div className="empty-state"><h2>No companies match</h2><p>Adjust the search or clear a filter to broaden the results.</p></div>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Select</th><th>Company</th><th>Website status</th><th>Industry / location</th><th>Turnover</th><th>CSR focus areas</th><th>CSR contact</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{companies.map((company) => {
          const isReady = company.website_readiness === 'ready_to_research' || (Boolean(company.official_website) && Boolean(company.official_website_verified_at));
          const isReview = company.website_readiness === 'needs_manual_review' || (!isReady && Boolean(company.website_candidate || (company.notes && company.notes.includes('MANUAL_REVIEW'))));
          return (
            <tr key={company.id}>
              <td><input type="checkbox" aria-label={`Select ${company.company_name}`} checked={selectedIds.includes(company.id)} onChange={() => onToggle(company.id)} /></td>
              <td>
                <button className="company-link" onClick={() => onOpen(company)}>{company.company_name}</button>
                <small className="table-subtitle">
                  {company.official_website ? company.official_website : (company.website_candidate ? <span className="candidate-tag">Candidate: {company.website_candidate}</span> : 'Official website not set')}
                </small>
              </td>
              <td>
                {isReady && <span className="readiness-badge readiness-ready">Ready to research</span>}
                {isReview && <span className="readiness-badge readiness-review">Needs manual review</span>}
                {!isReady && !isReview && <span className="readiness-badge readiness-waiting">Waiting for website</span>}
              </td>
              <td>{[company.industry, company.city].filter(Boolean).join(' · ') || '—'}</td>
              <td>{company.turnover_original || (company.turnover_amount == null ? '—' : `${company.turnover_amount} ${company.turnover_unit || ''} ${company.turnover_currency || ''}`)}</td>
              <td>{company.focus_areas || '—'}</td>
              <td>{company.contact_name || company.contact_email || 'Missing'}</td>
              <td>
                <div className="row-actions">
                  {['queued', 'running'].includes(company.research_status) ? (
                    <span className="muted">Research {company.research_status}</span>
                  ) : (
                    <button
                      disabled={!isReady}
                      title={!isReady ? 'Confirm official website in company profile or bulk review before researching' : 'Start report discovery'}
                      onClick={() => onResearch(company)}
                    >
                      Research
                    </button>
                  )}
                  <button title="Edit company" onClick={() => onEdit(company)}>Edit</button>
                  <button title="Delete company" className="danger-text" onClick={() => onDelete(company)}>Delete</button>
                </div>
              </td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}

function ResearchRuns({ runs, onCompany, onDetails }) {
  if (!runs.length) return <div className="empty-state compact-empty"><p>No research runs yet. Add a company and confirm its official website to start.</p></div>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Company</th><th>Status</th><th>Progress</th><th>Pages</th><th>Documents</th><th>Findings</th><th>Started</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{runs.map((run) => (
          <tr key={run.id}>
            <td><button className="company-link" onClick={() => onCompany(run)}>{run.company_name}</button><small className="table-subtitle">Run #{runNumber(run.id)}</small></td>
            <td><Status value={run.status} /></td>
            <td className="progress-cell">
              {run.progress_message || '—'}
              {run.status === 'failed' && <small className="error-detail">Stopped: {run.error_summary?.split('\n')[0] || 'Run failed'}</small>}
              {run.status === 'partially_completed' && <small className="warning-detail">Partial crawl: {run.summary || 'Some documents skipped'}</small>}
              {run.warning_summary && <small className="warning-detail">{run.warning_summary.split('\n')[0]}</small>}
            </td>
            <td>{run.pages_visited || 0}</td>
            <td>{run.documents_processed || 0} / {run.documents_discovered || 0}</td>
            <td>{run.findings_count || 0}</td>
            <td>{formatDate(run.created_at)}</td>
            <td><div className="row-actions"><button onClick={() => onDetails?.(run)}>Open report</button></div></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function ResearchRunDetail({ detail, loading, error, onBack, onCompany }) {
  if (loading) return <div className="loading-card">Loading the saved research report…</div>;
  if (error) return <div className="empty-state"><h2>Could not load this research run</h2><p>{error}</p><button className="button button-outline" onClick={onBack}>Back to run history</button></div>;
  if (!detail?.research_run) return <div className="empty-state"><h2>Research run unavailable</h2><p>The saved run detail response did not include a research run.</p><button className="button button-outline" onClick={onBack}>Back to run history</button></div>;
  const { research_run: run, company, documents = [], findings = [], events = [] } = detail;
  const stopInfo = deriveRunStopInfo(run);

  return (
    <section>
      <div className="page-heading no-print">
        <div><button className="back-link" onClick={onBack}>← All research runs</button><p className="eyebrow">SAVED RUN REPORT · #{runNumber(run.id)}</p><h1>{company?.company_name || `Research run ${runNumber(run.id)}`}</h1><p className="muted">Started {formatDate(run.created_at)} · {documents.length} report candidates · {findings.length} existing findings</p></div>
        <div className="page-actions"><button className="button button-outline" onClick={() => downloadRunCsv(detail)}>Export report CSV</button><button className="button button-primary" onClick={() => window.print()}>Print report</button></div>
      </div>
      <article className="info-card print-report">
        <div className="report-title"><p className="eyebrow">RESEARCH REPORT</p><h1>{company?.company_name || `Research run ${runNumber(run.id)}`}</h1><p className="muted">Run #{runNumber(run.id)} · Started {formatDate(run.created_at)}{run.completed_at ? ` · Completed ${formatDate(run.completed_at)}` : ''}</p></div>
        <div className="profile-meta"><Status value={run.status} />{company?.industry && <span>{company.industry}</span>}{company?.official_website && <a className="source-link" href={company.official_website} target="_blank" rel="noreferrer">{company.official_website} ↗</a>}</div>
        {stopInfo && (
          <div className={`run-stop-box ${stopInfo.isPartial ? 'partial' : ''}`}>
            <h3><span>{stopInfo.isPartial ? '⚠️' : '⛔'}</span> Run {stopInfo.isPartial ? 'Partially Completed' : 'Stopped'}</h3>
            <div className="run-stop-reason"><strong>Specific reason:</strong> {stopInfo.reason}</div>
            <div className="run-next-step"><strong>Practical next step:</strong> {stopInfo.nextStep}</div>
          </div>
        )}
        {run.progress_message && <p className="report-message">{run.progress_message}</p>}
        {run.summary && <p className="muted">{run.summary}</p>}
        {run.warning_summary && <p className="warning-detail report-notice">Warnings: {run.warning_summary}</p>}
        {run.error_summary && <p className="error-detail report-notice">Errors: {run.error_summary}</p>}
        <div className="report-stats"><span><strong>{run.pages_visited ?? 0}</strong> pages visited</span><span><strong>{run.documents_processed ?? documents.length}</strong> of {run.documents_discovered ?? documents.length} documents processed</span><span><strong>{run.findings_count ?? findings.length}</strong> candidate findings</span></div>
        <div className="section-heading"><div><p className="eyebrow">RESEARCH ACTIVITY</p><h2>{['queued', 'running'].includes(run.status) ? 'Research is running' : 'Research timeline'}</h2></div>{['queued', 'running'].includes(run.status) && <span className="live-indicator">Live · refreshes automatically</span>}</div>
        {events.length ? <ol className="report-list activity-list">{events.slice().reverse().map((event) => <li className="report-item activity-item" key={event.id}><div className="finding-top"><strong>{event.message}</strong><span className="muted">{formatTimestamp(event.created_at)}</span></div>{event.source_url && <a className="source-link" href={event.source_url} target="_blank" rel="noreferrer">{event.source_url}</a>}</li>)}</ol> : <p className="muted">Activity will appear as the crawler visits pages and processes documents.</p>}
        <div className="section-heading"><div><p className="eyebrow">DISCOVERED DOCUMENTS</p><h2>Report candidates & evidence</h2></div></div>
        {documents.length ? <div className="report-list">{documents.map((item) => {
          const isChecking = ['discovered', 'processing'].includes(item.processing_status);
          const isValid = item.processing_status === 'processed' && (item.validation_result === 'valid_pdf' || !item.validation_result);
          const isSkipped = item.processing_status === 'skipped';
          const isFailed = item.processing_status === 'failed';
          const title = item.title && item.title.trim() && item.title !== item.source_url ? item.title : 'Untitled report';
          return (
            <article className="report-item" key={item.id}>
              <div className="finding-top">
                <strong>{title}</strong>
                {isChecking && <Status value="checking" label="Checking candidate file" />}
                {isValid && <Status value="valid_pdf" label="Valid PDF report" />}
                {isSkipped && <Status value="skipped" label={`Skipped (${item.validation_result || item.processing_error || 'unsupported'})`} />}
                {isFailed && <Status value="failed" label={`Failed (${item.processing_error || 'error'})`} />}
              </div>
              {item.link_text && (
                <div className="link-evidence">
                  <span className="evidence-tag">Link text evidence:</span> "{item.link_text}"
                </div>
              )}
              <p className="muted">File type: {item.file_type || 'unknown'} · {item.validation_result || 'Validation pending'}</p>
              {item.download_available && <a className="button button-outline button-small" href={`/api/documents/${item.id}/download`} download>Download validated report</a>}
              {item.source_page_url && <a className="source-link" href={item.source_page_url} target="_blank" rel="noreferrer">Source page: {item.source_page_url} ↗</a>}
              {item.source_url && <span className="source-link">Source URL: {item.source_url}</span>}
              {item.processing_error && <p className="error-detail report-notice">{item.processing_error}</p>}
              {item.extracted_text && <details><summary>View extracted text</summary><pre className="document-text">{item.extracted_text}</pre></details>}
            </article>
          );
        })}</div> : <p className="muted">No documents were saved for this run.</p>}
        <div className="section-heading"><div><p className="eyebrow">HUMAN REVIEW</p><h2>Findings and evidence</h2></div></div>
        {findings.length ? <div className="report-list">{findings.map((finding) => (
          <article className="report-item" key={finding.id}>
            <div className="finding-top"><strong className="field-name">{(finding.field_name || 'Finding').replaceAll('_', ' ')}</strong><Status value={finding.review_status} /></div>
            <p className="report-value">{finding.finding_value || 'No reviewed value recorded.'}</p>
            {finding.original_value != null && finding.original_value !== finding.finding_value && <p className="original-value"><strong>Original extracted value</strong><span>{finding.original_value}</span></p>}
            {finding.financial_year && <p className="muted">Financial year: {finding.financial_year}</p>}
            {finding.reviewer_notes && <p className="reviewer-notes"><strong>Reviewer notes</strong><br />{finding.reviewer_notes}</p>}
            {finding.supporting_excerpt && <blockquote>{finding.supporting_excerpt}</blockquote>}
            {finding.source_url && <a className="source-link" href={finding.source_url} target="_blank" rel="noreferrer">{finding.source_url}{finding.page_number ? ` · page ${finding.page_number}` : ''} ↗</a>}
          </article>
        ))}</div> : <p className="muted">No findings were saved for this run.</p>}
        {company?.id && <button className="button button-outline no-print" onClick={() => onCompany(company.id)}>Open company profile</button>}
      </article>
    </section>
  );
}

function CompanyProfile({
  profile,
  onBack,
  onEdit,
  onDelete,
  onResearch,
  onRunDetails,
  onDocument,
  onSaveFinding,
  onFindingHistory,
  findingHistory,
  savingFinding,
  findingEdits,
  setFindingEdits,
  unavailableField,
  setUnavailableField,
  onMarkUnavailable,
  markingUnavailable,
}) {
  if (!profile) return <div className="loading-card">Loading company profile…</div>;
  const { company, research_runs: runs, documents, findings, source_values: sourceValues = [] } = profile;
  const isReady = company.website_readiness === 'ready_to_research' || (Boolean(company.official_website) && Boolean(company.official_website_verified_at));
  return (
    <section>
      <button className="back-link" onClick={onBack}>← Company directory</button>
      <div className="profile-heading">
        <div>
          <p className="eyebrow">COMPANY PROFILE</p>
          <h1>{company.company_name}</h1>
          <div className="profile-meta">
            <Status value={company.research_status} />
            {isReady ? (
              <span className="readiness-badge readiness-ready">Ready to research</span>
            ) : company.website_candidate || (company.notes && company.notes.includes('MANUAL_REVIEW')) ? (
              <span className="readiness-badge readiness-review">Needs manual review</span>
            ) : (
              <span className="readiness-badge readiness-waiting">Waiting for website</span>
            )}
            {company.industry && <span>{company.industry}</span>}
            {company.city && <span>{company.city}</span>}
            {company.cin && <span>CIN {company.cin}</span>}
            <span>Last researched {formatDate(company.last_researched_at)}</span>
          </div>
        </div>
        <div className="profile-actions">
          <button className="button button-outline" onClick={onEdit}>Edit details</button>
          {['queued', 'running'].includes(company.research_status) ? (
            <span className="muted">Research {company.research_status}</span>
          ) : (
            <button className="button button-outline" disabled={!isReady} title={!isReady ? 'Confirm official website in profile before starting research' : 'Start report discovery'} onClick={onResearch}>
              Start research
            </button>
          )}
          <button className="button button-quiet-danger" onClick={onDelete}>Delete</button>
        </div>
      </div>
      <div className="profile-grid">
        <article className="info-card"><p className="eyebrow">OFFICIAL SOURCE</p>{company.official_website ? <><a className="source-link" href={company.official_website} target="_blank" rel="noreferrer">{company.official_website} ↗</a><p className="muted">{company.official_website_verified_at ? `Domain confirmed ${formatDate(company.official_website_verified_at)}` : 'Legacy domain recorded; confirmation date unavailable.'}</p></> : <><p className="muted">No confirmed official website recorded. Add one before starting research.</p>{company.website_candidate && <p className="suggestion-note">Unverified candidate: {company.website_candidate}</p>}</>}<p className="notes">{company.notes || 'No researcher notes.'}</p>{(company.contact_name || company.contact_designation || company.contact_email || company.contact_phone) && <div className="contact-details"><p className="eyebrow">CSR CONTACT</p>{company.contact_name && <p>{company.contact_name}{company.contact_designation ? ` · ${company.contact_designation}` : ''}</p>}{company.contact_email && <p>{company.contact_email}</p>}{company.contact_phone && <p>{company.contact_phone}</p>}</div>}</article>
        <article className="info-card"><p className="eyebrow">RESEARCH SUMMARY</p><div className="mini-stats"><span><strong>{runs.length}</strong> runs</span><span><strong>{documents.length}</strong> sources</span><span><strong>{findings.filter((finding) => finding.review_status === 'pending_review').length}</strong> to review</span></div></article>
      </div>
      {sourceValues.length > 0 && <><div className="section-heading"><div><p className="eyebrow">IMPORTED SOURCE DATA</p><h2>Workbook values and provenance</h2></div></div><div className="table-wrap"><table><thead><tr><th>Source</th><th>Worksheet</th><th>Source row</th><th>Field</th><th>Original value</th></tr></thead><tbody>{sourceValues.map((item, index) => <tr key={`${item.source_workbook}-${item.source_worksheet}-${item.source_row}-${item.source_column}-${index}`}><td>{item.source_workbook}</td><td>{item.source_worksheet}</td><td>{item.source_row}</td><td>{item.source_column}</td><td>{item.original_value}</td></tr>)}</tbody></table></div></>}
      <div className="section-heading"><div><p className="eyebrow">SOURCE MATERIAL</p><h2>Discovered documents and pages</h2></div></div>
      {documents.length ? <div className="document-list">{documents.map((item) => {
        const isChecking = ['discovered', 'processing'].includes(item.processing_status);
        const isValid = item.processing_status === 'processed' && (item.validation_result === 'valid_pdf' || !item.validation_result);
        const isSkipped = item.processing_status === 'skipped';
        const isFailed = item.processing_status === 'failed';
        const title = item.title && item.title.trim() && item.title !== item.source_url ? item.title : 'Untitled report';
        return (
          <article className="document-row" key={item.id}>
            <span className="doc-icon">{item.file_type?.includes('pdf') ? 'PDF' : 'WEB'}</span>
            <div className="doc-description">
              <strong>{title}</strong>
              {item.link_text && (
                <div className="link-evidence">
                  <span className="evidence-tag">Link text evidence:</span> "{item.link_text}"
                </div>
              )}
              <span className="source-link">Report URL: {item.source_url}</span>
            </div>
            {isChecking && <Status value="checking" label="Checking candidate file" />}
            {isValid && <Status value="valid_pdf" label="Valid PDF report" />}
            {isSkipped && <Status value="skipped" label={`Skipped (${item.validation_result || item.processing_error || 'unsupported'})`} />}
            {isFailed && <Status value="failed" label={`Failed (${item.processing_error || 'error'})`} />}
            {item.download_available && <a className="button button-outline button-small" href={`/api/documents/${item.id}/download`} download>Download validated report</a>}
            {item.source_page_url && <a className="source-link" href={item.source_page_url} target="_blank" rel="noreferrer">Source page: {item.source_page_url} ↗</a>}
            {item.validation_result && <small className="muted">Validation: {item.validation_result}</small>}
            {item.processing_error && <span className="error-detail">{item.processing_error}</span>}
            {item.extracted_text && <button className="button button-outline button-small" onClick={() => onDocument(item.id)}>View text</button>}
          </article>
        );
      })}</div> : <div className="empty-state compact-empty"><p>No report candidates have been recorded for this company.</p></div>}

      <div className="section-heading"><div><p className="eyebrow">HUMAN REVIEW</p><h2>Extracted findings</h2></div></div>
      <div className="unavailable-form"><span>Record information not found</span><select value={unavailableField} onChange={(event) => setUnavailableField(event.target.value)} aria-label="Field not found"><option value="">Select a CSR field…</option>{unavailableFields.map((field) => <option value={field} key={field}>{field}</option>)}</select><button className="button button-outline button-small" disabled={!unavailableField || markingUnavailable} onClick={onMarkUnavailable}>{markingUnavailable ? 'Saving…' : 'Mark unavailable'}</button></div>
      {findings.length ? <div className="finding-list">{findings.map((finding) => {
        const edit = findingEdits[finding.id] || {};
        return (
          <article className="finding-card" key={finding.id}>
            <div className="finding-top"><div><span className="field-name">{finding.field_name.replaceAll('_', ' ')}</span>{finding.extraction_method && <span className="method-tag">{finding.extraction_method} extraction</span>}{finding.provenance && <span className="method-tag">{finding.provenance.replaceAll('_', ' ')}</span>}</div><Status value={edit.review_status || finding.review_status} /></div>
            {(finding.numeric_value !== null || finding.currency || finding.unit) && <p className="muted">Structured amount: {finding.numeric_value ?? '—'} {finding.currency || ''} {finding.unit || ''}</p>}
            {finding.original_value != null && finding.original_value !== (edit.finding_value ?? finding.finding_value) && <div className="original-value"><strong>Original extracted value</strong><span>{finding.original_value}</span></div>}
            <label>Reviewed finding value<textarea rows="2" value={edit.finding_value ?? finding.finding_value ?? ''} onChange={(event) => setFindingEdits((current) => ({ ...current, [finding.id]: { ...current[finding.id], finding_value: event.target.value } }))} /></label>
            <div className="finding-meta"><label>Financial year<input value={edit.financial_year ?? finding.financial_year ?? ''} placeholder="Not stated" onChange={(event) => setFindingEdits((current) => ({ ...current, [finding.id]: { ...current[finding.id], financial_year: event.target.value } }))} /></label><label>Review decision<select value={edit.review_status || finding.review_status} onChange={(event) => setFindingEdits((current) => ({ ...current, [finding.id]: { ...current[finding.id], review_status: event.target.value } }))}>{['pending_review', 'approved', 'rejected', 'unavailable'].map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}</select></label><button className="button button-primary button-small" disabled={savingFinding[finding.id]} onClick={() => onSaveFinding(finding)}>{savingFinding[finding.id] ? 'Saving…' : 'Save review'}</button></div>
            <label>Reviewer notes<textarea rows="2" value={edit.reviewer_notes ?? finding.reviewer_notes ?? ''} placeholder="Add review context, corrections, or follow-up notes" onChange={(event) => setFindingEdits((current) => ({ ...current, [finding.id]: { ...current[finding.id], reviewer_notes: event.target.value } }))} /></label>
            <button className="text-button" onClick={() => void onFindingHistory(finding.id)}>Review history</button>
            {findingHistory[finding.id] && <ol className="review-history">{findingHistory[finding.id].map((item) => <li key={item.id}><strong>{statusLabels[item.decision] || item.decision}</strong> · {formatDate(item.reviewed_at)}{item.reviewer_identity ? ` · ${item.reviewer_identity}` : ''}<span>{item.previous_value || '—'} → {item.revised_value || '—'}</span>{item.reason && <small>{item.reason}</small>}</li>)}</ol>}
            <blockquote>{finding.supporting_excerpt}</blockquote>
            {finding.source_url ? <a className="source-link" href={finding.source_url} target="_blank" rel="noreferrer">{finding.source_url}{finding.page_number ? ` · page ${finding.page_number}` : ''} ↗</a> : <span className="muted">Manually recorded; no source evidence available.</span>}
          </article>
        );
      })}</div> : <div className="empty-state compact-empty"><p>No findings have been extracted. The local pipeline reports only text supported by discovered pages or documents.</p></div>}

      <div className="section-heading"><div><p className="eyebrow">HISTORY</p><h2>Research runs</h2></div></div>
      <ResearchRuns runs={runs.map((run) => ({ ...run, company_name: company.company_name }))} onCompany={() => {}} onDetails={onRunDetails} />
    </section>
  );
}

export default App;

