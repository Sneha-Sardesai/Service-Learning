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
  priority: '',
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
    ['Record type', 'Run ID', 'Company', 'Official website', 'Run status', 'Started', 'Completed', 'Field / title', 'Reviewed value / source URL', 'Original extracted value', 'Financial year', 'Review status', 'Reviewer notes', 'Evidence excerpt', 'Processing status', 'Processing error'],
    ['Run', run.id, company?.company_name, company?.official_website, run.status, run.created_at, run.completed_at, '', '', '', '', '', '', '', '', ''],
    ...findings.map((finding) => [
      'Finding', run.id, company?.company_name, company?.official_website, run.status, run.created_at, run.completed_at,
      finding.field_name, finding.finding_value, finding.original_value, finding.financial_year,
      finding.review_status, finding.reviewer_notes, finding.supporting_excerpt, '', '',
    ]),
    ...documents.map((item) => [
      'Document', run.id, company?.company_name, company?.official_website, run.status, run.created_at, run.completed_at,
      item.title, item.source_url, '', '', '', '', '', item.processing_status, item.processing_error,
    ]),
  ];
  downloadCsv(`research-run-${run.id}-report.csv`, rows);
}

function Status({ value }) {
  return <span className={`status status-${value || 'not_started'}`}>{statusLabels[value] || value || 'Unknown'}</span>;
}

function App() {
  const [page, setPage] = useState('dashboard');
  const [dashboard, setDashboard] = useState(null);
  const [companies, setCompanies] = useState([]);
  const [industries, setIndustries] = useState([]);
  const [profile, setProfile] = useState(null);
  const [selectedCompany, setSelectedCompany] = useState(null);
  const [loading, setLoading] = useState(true);
  const [databaseState, setDatabaseState] = useState('checking');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [industryFilter, setIndustryFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [companyPage, setCompanyPage] = useState(1);
  const [companyPages, setCompanyPages] = useState(1);
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
  const [importBusy, setImportBusy] = useState(false);
  const submissions = useRef(new Set());

  async function loadDashboard() {
    const data = await api('/dashboard');
    setDashboard(data);
  }

  async function loadCompanies() {
    const params = new URLSearchParams();
    if (search.trim()) params.set('q', search.trim());
    if (industryFilter) params.set('industry', industryFilter);
    if (statusFilter) params.set('research_status', statusFilter);
    params.set('page', String(companyPage));
    const data = await api(`/companies${params.size ? `?${params}` : ''}`);
    setCompanies(data.companies);
    setIndustries(data.industries || []);
    setCompanyPages(data.pagination?.total_pages || 1);
  }

  async function loadProfile(id) {
    const data = await api(`/companies/${id}`);
    setProfile(data);
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
      await Promise.all([loadDashboard(), loadCompanies()]);
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
    if (!companyDialog || !companyName) {
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
            ? data.suggested_website
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
  }, [search, industryFilter, statusFilter, companyPage, page]);

  useEffect(() => {
    if (page === 'research') void loadResearchHistory(researchPage);
  }, [page]);

  const hasActiveHistoryRuns = researchRuns.some((run) => ['queued', 'running'].includes(run.status));
  useEffect(() => {
    if (page !== 'research' || !hasActiveHistoryRuns) return undefined;
    const timer = window.setInterval(() => void loadResearchHistory(researchPage), 2000);
    return () => window.clearInterval(timer);
  }, [page, hasActiveHistoryRuns, researchPage]);

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
      priority: company.priority || '',
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
    if (websiteChanged && companyForm.official_website.trim() && !websiteConfirmed) {
      setError('Confirm that this is the company’s official website before saving it.');
      return;
    }
    submissions.current.add('company');
    setSaving(true);
    setError('');
    try {
      const isEdit = companyDialog.mode === 'edit';
      if (!isEdit) {
        const params = new URLSearchParams({
          name: companyForm.company_name.trim(),
          ...(companyForm.cin.trim() ? { cin: companyForm.cin.trim() } : {}),
        });
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
      const result = await api(isEdit ? `/companies/${companyDialog.company.id}` : '/companies', {
        method: isEdit ? 'PATCH' : 'POST',
        body: JSON.stringify({
          ...companyForm,
          confirm_official_website: websiteConfirmed,
        }),
      });
      setCompanyDialog(null);
      setNotice(isEdit
        ? 'Company details updated.'
        : `Company added and research run ${result.research_run.id} queued.`);
      if (!isEdit && result.research_run) {
        setPage('research');
        setResearchPage(1);
      }
      await Promise.all([loadCompanies(), loadDashboard()]);
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
      setNotice(`Research run ${response.research_run.id} was queued.`);
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
                <div><p className="eyebrow">RESEARCH DIRECTORY</p><h1>Companies</h1><p className="muted">Manage official sources and review company research history.</p></div>
                <div className="page-actions"><button className="button button-outline" onClick={() => { setImportOpen(true); setImportFile(null); setImportScan(null); setImportPreview(null); }}>Import spreadsheet</button><button className="button button-primary" onClick={openNewCompany}>＋ Add company</button></div>
              </div>
              <div className="filter-bar">
                <label className="search-box"><span>⌕</span><input value={search} onChange={(event) => { setCompanyPage(1); setSearch(event.target.value); }} placeholder="Search company name…" /></label>
                <select value={industryFilter} onChange={(event) => { setCompanyPage(1); setIndustryFilter(event.target.value); }} aria-label="Filter by industry">
                  <option value="">All industries</option>
                  {industries.map((industry) => <option key={industry}>{industry}</option>)}
                </select>
                <select value={statusFilter} onChange={(event) => { setCompanyPage(1); setStatusFilter(event.target.value); }} aria-label="Filter by research status">
                  <option value="">All research statuses</option>
                  {['not_started', 'queued', 'running', 'completed', 'partially_completed', 'failed'].map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}
                </select>
              </div>
              <CompanyTable companies={companies} onOpen={openProfile} onEdit={openEditCompany} onDelete={deleteCompany} onResearch={startResearch} />
              {companyPages > 1 && <div className="pagination"><span>Page {companyPage} of {companyPages}</span><div><button className="button button-outline button-small" disabled={companyPage <= 1} onClick={() => setCompanyPage((current) => current - 1)}>Previous</button><button className="button button-outline button-small" disabled={companyPage >= companyPages} onClick={() => setCompanyPage((current) => current + 1)}>Next</button></div></div>}
            </section>
          )}

          {page === 'research' && (
            <section>
              <div className="page-heading"><div><p className="eyebrow">ACTIVITY</p><h1>Research runs</h1><p className="muted">Persisted run history and current document-processing status.</p></div><div className="page-actions"><button className="button button-outline" onClick={() => void exportAllResearchHistory()} disabled={exportingHistory}>{exportingHistory ? 'Preparing CSV…' : 'Export all CSV'}</button><button className="button button-outline" onClick={() => void loadResearchHistory(researchPage)} disabled={researchLoading}>{researchLoading ? 'Refreshing…' : 'Refresh history'}</button></div></div>
              {researchError && <div className="alert alert-error" role="alert">{researchError}<button onClick={() => setResearchError('')} aria-label="Dismiss history error">×</button></div>}
              {researchLoading && researchRuns.length === 0 ? <div className="loading-card">Loading saved research runs…</div> : null}
              {!researchLoading && !researchError && researchRuns.length === 0 ? <div className="empty-state"><h2>No saved research runs</h2><p>Start a run from a company profile after confirming its official website.</p><button className="button button-outline" onClick={() => navigate('companies')}>Browse companies</button></div> : null}
              {researchRuns.length > 0 && <ResearchRuns runs={researchRuns} onDetails={(run) => void openRunDetail(run.id)} onCompany={(run) => {
                void openProfileById(run.company_id);
              }} />}
              {researchRuns.length > 0 && <div className="pagination"><span>Page {researchPagination.page || researchPage} of {researchPagination.total_pages || 1}{researchPagination.total != null ? ` · ${researchPagination.total} runs` : ''}</span><div><button className="button button-outline button-small" disabled={researchLoading || researchPage <= 1} onClick={() => void loadResearchHistory(researchPage - 1)}>Previous</button><button className="button button-outline button-small" disabled={researchLoading || researchPage >= (researchPagination.total_pages || 1)} onClick={() => void loadResearchHistory(researchPage + 1)}>Next</button></div></div>}
              <div className="callout"><strong>How this works</strong><p>The researcher stays on the confirmed company website, follows crawl limits, respects robots.txt, and records errors instead of guessing when a source cannot be reached.</p></div>
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
            <label>CIN<input maxLength="21" value={companyForm.cin} onChange={(event) => setCompanyForm({ ...companyForm, cin: event.target.value })} /></label>
            <label>Industry<input maxLength="160" value={companyForm.industry} onChange={(event) => setCompanyForm({ ...companyForm, industry: event.target.value })} placeholder="e.g. Automotive" /></label>
            <label>Headquarters / city<input maxLength="160" value={companyForm.city} onChange={(event) => setCompanyForm({ ...companyForm, city: event.target.value })} /></label>
            <label>Confirmed official website {companyDialog.mode === 'create' && <span className="required">*</span>}<input type="text" inputMode="url" required={companyDialog.mode === 'create'} value={companyForm.official_website} onChange={(event) => { setCompanyForm({ ...companyForm, official_website: event.target.value }); setWebsiteConfirmed(false); }} placeholder="https://www.company.com" /><small>Enter a researcher-confirmed domain; the crawler will not guess one.</small></label>
            {suggestionLoading && <p className="suggestion-note" role="status">Checking for a domain suggestion…</p>}
            {!suggestionLoading && domainSuggestion && <div className="domain-suggestion"><div><strong>Registry suggestion</strong><span>{domainSuggestion}</span><small>Suggestion only. Verify the domain before saving or researching.</small></div><button type="button" className="button button-outline button-small" onClick={() => { setCompanyForm((current) => ({ ...current, official_website: domainSuggestion })); setWebsiteConfirmed(false); }}>Use suggestion</button></div>}
            {!suggestionLoading && suggestionError && <p className="suggestion-note" role="status">{suggestionError}</p>}
            {!suggestionLoading && !suggestionError && !domainSuggestion && companyDialog && companyForm.company_name.trim() && <p className="suggestion-note">No domain suggestion was returned for this name.</p>}
            {companyForm.official_website.trim() && (companyDialog.mode === 'create' || companyForm.official_website.trim() !== (companyDialog.company.official_website || '').trim() || !companyDialog.company.official_website_verified_at) && <label className="checkbox-label"><input type="checkbox" checked={websiteConfirmed} onChange={(event) => setWebsiteConfirmed(event.target.checked)} />I confirm this is the company’s official website and is suitable as a research starting point.</label>}
            <label>Contact email<input type="email" maxLength="254" value={companyForm.contact_email} onChange={(event) => setCompanyForm({ ...companyForm, contact_email: event.target.value })} /></label>
            <label>Contact phone<input maxLength="40" value={companyForm.contact_phone} onChange={(event) => setCompanyForm({ ...companyForm, contact_phone: event.target.value })} /></label>
            <label>CSR contact name<input maxLength="200" value={companyForm.contact_name} onChange={(event) => setCompanyForm({ ...companyForm, contact_name: event.target.value })} /></label>
            <label>Contact designation<input maxLength="160" value={companyForm.contact_designation} onChange={(event) => setCompanyForm({ ...companyForm, contact_designation: event.target.value })} /></label>
            <label>Research priority<input maxLength="80" value={companyForm.priority} onChange={(event) => setCompanyForm({ ...companyForm, priority: event.target.value })} /></label>
            <label>Research notes<textarea rows="3" maxLength="10000" value={companyForm.notes} onChange={(event) => setCompanyForm({ ...companyForm, notes: event.target.value })} /></label>
            <div className="modal-actions"><button type="button" className="button button-outline" disabled={saving} onClick={() => setCompanyDialog(null)}>Cancel</button><button className="button button-primary" disabled={saving || (companyDialog.mode === 'create' && !companyForm.official_website.trim()) || (Boolean(companyForm.official_website.trim()) && (companyDialog.mode === 'create' || companyForm.official_website.trim() !== (companyDialog.company.official_website || '').trim() || !companyDialog.company.official_website_verified_at) && !websiteConfirmed)}>{saving ? 'Saving…' : companyDialog.mode === 'create' ? 'Add and start research' : 'Save company'}</button></div>
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

function CompanyTable({ companies, onOpen, onEdit, onDelete, onResearch }) {
  if (!companies.length) return <div className="empty-state"><h2>No companies yet</h2><p>Add a company and its confirmed official website to begin.</p></div>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Company</th><th>Industry</th><th>Research status</th><th>Documents</th><th>Last researched</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{companies.map((company) => (
          <tr key={company.id}>
            <td><button className="company-link" onClick={() => onOpen(company)}>{company.company_name}</button><small className="table-subtitle">{company.official_website || (company.website_candidate ? `Unverified: ${company.website_candidate}` : 'Official website not set')}</small></td>
            <td>{[company.industry, company.city].filter(Boolean).join(' · ') || '—'}</td>
            <td><Status value={company.research_status} /></td>
            <td>{company.document_count ?? 0}</td>
            <td>{formatDate(company.last_researched_at)}</td>
            <td><div className="row-actions"><button title="Start research" disabled={!company.official_website} onClick={() => onResearch(company)}>Research</button><button title="Edit company" onClick={() => onEdit(company)}>Edit</button><button title="Delete company" className="danger-text" onClick={() => onDelete(company)}>Delete</button></div></td>
          </tr>
        ))}</tbody>
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
            <td><button className="company-link" onClick={() => onCompany(run)}>{run.company_name}</button><small className="table-subtitle">Run #{run.id}</small></td>
            <td><Status value={run.status} /></td>
            <td className="progress-cell">{run.progress_message || '—'}{run.error_summary && <small className="error-detail">{run.error_summary.split('\n')[0]}</small>}{run.warning_summary && <small className="warning-detail">{run.warning_summary.split('\n')[0]}</small>}</td>
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
  const { research_run: run, company, documents = [], findings = [] } = detail;
  return (
    <section>
      <div className="page-heading no-print">
        <div><button className="back-link" onClick={onBack}>← All research runs</button><p className="eyebrow">SAVED RUN REPORT · #{run.id}</p><h1>{company?.company_name || `Research run ${run.id}`}</h1><p className="muted">Started {formatDate(run.created_at)} · {documents.length} documents · {findings.length} findings</p></div>
        <div className="page-actions"><button className="button button-outline" onClick={() => downloadRunCsv(detail)}>Export report CSV</button><button className="button button-primary" onClick={() => window.print()}>Print report</button></div>
      </div>
      <article className="info-card print-report">
        <div className="report-title"><p className="eyebrow">RESEARCH REPORT</p><h1>{company?.company_name || `Research run ${run.id}`}</h1><p className="muted">Run #{run.id} · Started {formatDate(run.created_at)}{run.completed_at ? ` · Completed ${formatDate(run.completed_at)}` : ''}</p></div>
        <div className="profile-meta"><Status value={run.status} />{company?.industry && <span>{company.industry}</span>}{company?.official_website && <a className="source-link" href={company.official_website} target="_blank" rel="noreferrer">{company.official_website} ↗</a>}</div>
        {run.progress_message && <p className="report-message">{run.progress_message}</p>}
        {run.warning_summary && <p className="warning-detail report-notice">Warnings: {run.warning_summary}</p>}
        {run.error_summary && <p className="error-detail report-notice">Errors: {run.error_summary}</p>}
        <div className="report-stats"><span><strong>{run.pages_visited ?? 0}</strong> pages visited</span><span><strong>{documents.length}</strong> saved documents</span><span><strong>{findings.length}</strong> findings</span></div>
        <div className="section-heading"><div><p className="eyebrow">SOURCE MATERIAL</p><h2>Documents and pages</h2></div></div>
        {documents.length ? <div className="report-list">{documents.map((item) => (
          <article className="report-item" key={item.id}>
            <div className="finding-top"><strong>{item.title || item.source_url || `Document ${item.id}`}</strong><Status value={item.processing_status || item.status} /></div>
            {item.source_url && <a className="source-link" href={item.source_url} target="_blank" rel="noreferrer">{item.source_url} ↗</a>}
            {item.processing_error && <p className="error-detail report-notice">{item.processing_error}</p>}
            {item.extracted_text && <details><summary>View extracted text</summary><pre className="document-text">{item.extracted_text}</pre></details>}
          </article>
        ))}</div> : <p className="muted">No documents were saved for this run.</p>}
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
  const { company, research_runs: runs, documents, findings } = profile;
  return (
    <section>
      <button className="back-link" onClick={onBack}>← Company directory</button>
      <div className="profile-heading">
        <div><p className="eyebrow">COMPANY PROFILE</p><h1>{company.company_name}</h1><div className="profile-meta"><Status value={company.research_status} />{company.industry && <span>{company.industry}</span>}{company.city && <span>{company.city}</span>}{company.cin && <span>CIN {company.cin}</span>}<span>Last researched {formatDate(company.last_researched_at)}</span></div></div>
        <div className="profile-actions"><button className="button button-outline" onClick={onEdit}>Edit details</button><button className="button button-primary" disabled={!company.official_website} onClick={onResearch}>Start research</button><button className="button button-quiet-danger" onClick={onDelete}>Delete</button></div>
      </div>
      <div className="profile-grid">
        <article className="info-card"><p className="eyebrow">OFFICIAL SOURCE</p>{company.official_website ? <><a className="source-link" href={company.official_website} target="_blank" rel="noreferrer">{company.official_website} ↗</a><p className="muted">{company.official_website_verified_at ? `Domain confirmed ${formatDate(company.official_website_verified_at)}` : 'Legacy domain recorded; confirmation date unavailable.'}</p></> : <><p className="muted">No confirmed official website recorded. Add one before starting research.</p>{company.website_candidate && <p className="suggestion-note">Unverified imported candidate: {company.website_candidate}</p>}</>}<p className="notes">{company.notes || 'No researcher notes.'}</p>{(company.contact_name || company.contact_designation || company.contact_email || company.contact_phone) && <div className="contact-details"><p className="eyebrow">CSR CONTACT</p>{company.contact_name && <p>{company.contact_name}{company.contact_designation ? ` · ${company.contact_designation}` : ''}</p>}{company.contact_email && <p>{company.contact_email}</p>}{company.contact_phone && <p>{company.contact_phone}</p>}</div>}</article>
        <article className="info-card"><p className="eyebrow">RESEARCH SUMMARY</p><div className="mini-stats"><span><strong>{runs.length}</strong> runs</span><span><strong>{documents.length}</strong> sources</span><span><strong>{findings.filter((finding) => finding.review_status === 'pending_review').length}</strong> to review</span></div></article>
      </div>
      <div className="section-heading"><div><p className="eyebrow">SOURCE MATERIAL</p><h2>Discovered documents and pages</h2></div></div>
      {documents.length ? <div className="document-list">{documents.map((item) => (
        <article className="document-row" key={item.id}>
          <span className="doc-icon">{item.file_type?.includes('pdf') ? 'PDF' : 'WEB'}</span>
          <div className="doc-description"><strong>{item.title}</strong><a href={item.source_url} target="_blank" rel="noreferrer">{item.source_url} ↗</a></div>
          <Status value={item.processing_status || item.status} />
          {item.processing_error && <span className="error-detail">{item.processing_error}</span>}
          <button className="button button-outline button-small" onClick={() => onDocument(item.id)}>View text</button>
        </article>
      ))}</div> : <div className="empty-state compact-empty"><p>No source documents recorded. Start research to crawl the confirmed website.</p></div>}

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
