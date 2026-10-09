import { useEffect, useState } from 'react';
import { api } from './api';
import './index.css';

const emptyCompany = { company_name: '', industry: '', official_website: '', notes: '' };
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
  const [saving, setSaving] = useState(false);
  const [document, setDocument] = useState(null);
  const [findingEdits, setFindingEdits] = useState({});
  const [unavailableField, setUnavailableField] = useState('');

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
    const timer = setTimeout(() => {
      if (page === 'companies') loadCompanies().catch((requestError) => setError(requestError.message));
    }, 200);
    return () => clearTimeout(timer);
  }, [search, industryFilter, statusFilter, companyPage, page]);

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
    setCompanyDialog({ mode: 'create' });
  }

  function openEditCompany(company) {
    setCompanyForm({
      company_name: company.company_name || '',
      industry: company.industry || '',
      official_website: company.official_website || '',
      notes: company.notes || '',
    });
    setCompanyDialog({ mode: 'edit', company });
  }

  async function saveCompany(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const isEdit = companyDialog.mode === 'edit';
      await api(isEdit ? `/companies/${companyDialog.company.id}` : '/companies', {
        method: isEdit ? 'PATCH' : 'POST',
        body: JSON.stringify(companyForm),
      });
      setCompanyDialog(null);
      setNotice(isEdit ? 'Company details updated.' : 'Company added to the directory.');
      await Promise.all([loadCompanies(), loadDashboard()]);
      if (selectedCompany && isEdit) await loadProfile(selectedCompany.id);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
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
    try {
      const response = await api(`/companies/${company.id}/research`, { method: 'POST' });
      setNotice(`Research run ${response.research_run.id} was queued.`);
      setPage('research');
      setSelectedCompany(company);
      await Promise.all([loadDashboard(), loadCompanies()]);
      await loadProfile(company.id);
    } catch (requestError) {
      setError(requestError.message);
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
    }
  }

  async function markUnavailable() {
    if (!unavailableField || !profile) return;
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
          <button className={page === 'research' ? 'nav-item active' : 'nav-item'} onClick={() => navigate('research')}>
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
            }} />
          )}

          {dashboard && page === 'companies' && (
            <section>
              <div className="page-heading">
                <div><p className="eyebrow">RESEARCH DIRECTORY</p><h1>Companies</h1><p className="muted">Manage official sources and review company research history.</p></div>
                <button className="button button-primary" onClick={openNewCompany}>＋ Add company</button>
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

          {dashboard && page === 'research' && (
            <section>
              <div className="page-heading"><div><p className="eyebrow">ACTIVITY</p><h1>Research runs</h1><p className="muted">Live status for website discovery and document processing.</p></div><button className="button button-outline" onClick={() => void loadDashboard()}>Refresh status</button></div>
              <ResearchRuns runs={dashboard.recent_runs || []} onCompany={(run) => {
                void openProfileById(run.company_id);
              }} />
              <div className="callout"><strong>How this works</strong><p>The researcher stays on the confirmed company website, follows crawl limits, respects robots.txt, and records errors instead of guessing when a source cannot be reached.</p></div>
            </section>
          )}

          {dashboard && page === 'profile' && (
            <CompanyProfile
              profile={profile}
              onBack={() => navigate('companies')}
              onEdit={() => profile && openEditCompany(profile.company)}
              onDelete={() => profile && deleteCompany(profile.company)}
              onResearch={() => profile && startResearch(profile.company)}
              onDocument={showDocument}
              onSaveFinding={saveFinding}
              findingEdits={findingEdits}
              setFindingEdits={setFindingEdits}
              unavailableField={unavailableField}
              setUnavailableField={setUnavailableField}
              onMarkUnavailable={markUnavailable}
            />
          )}
        </div>
      </main>

      {companyDialog && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCompanyDialog(null); }}>
          <form className="modal-card" onSubmit={saveCompany}>
            <div className="modal-heading"><div><p className="eyebrow">{companyDialog.mode === 'edit' ? 'COMPANY DETAILS' : 'NEW RECORD'}</p><h2>{companyDialog.mode === 'edit' ? 'Edit company' : 'Add company'}</h2></div><button type="button" className="icon-button" onClick={() => setCompanyDialog(null)} aria-label="Close">×</button></div>
            <label>Company name <span className="required">*</span><input autoFocus required maxLength="200" value={companyForm.company_name} onChange={(event) => setCompanyForm({ ...companyForm, company_name: event.target.value })} /></label>
            <label>Industry<input maxLength="160" value={companyForm.industry} onChange={(event) => setCompanyForm({ ...companyForm, industry: event.target.value })} placeholder="e.g. Automotive" /></label>
            <label>Confirmed official website<input type="text" inputMode="url" value={companyForm.official_website} onChange={(event) => setCompanyForm({ ...companyForm, official_website: event.target.value })} placeholder="https://www.company.com" /><small>Enter the confirmed domain; the crawler will not guess one.</small></label>
            <label>Research notes<textarea rows="3" maxLength="10000" value={companyForm.notes} onChange={(event) => setCompanyForm({ ...companyForm, notes: event.target.value })} /></label>
            <div className="modal-actions"><button type="button" className="button button-outline" onClick={() => setCompanyDialog(null)}>Cancel</button><button className="button button-primary" disabled={saving}>{saving ? 'Saving…' : 'Save company'}</button></div>
          </form>
        </div>
      )}

      {document && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDocument(null); }}>
          <div className="modal-card document-modal">
            <div className="modal-heading"><div><p className="eyebrow">SOURCE DOCUMENT</p><h2>{document.title}</h2></div><button className="icon-button" onClick={() => setDocument(null)} aria-label="Close">×</button></div>
            <a className="source-link" href={document.source_url} target="_blank" rel="noreferrer">{document.source_url} ↗</a>
            <Status value={document.processing_status} />
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

function Dashboard({ dashboard, onPage, onCompany }) {
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
      <ResearchRuns runs={dashboard.recent_runs || []} onCompany={onCompany} />
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
            <td><button className="company-link" onClick={() => onOpen(company)}>{company.company_name}</button><small className="table-subtitle">{company.official_website || 'Official website not set'}</small></td>
            <td>{company.industry || '—'}</td>
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

function ResearchRuns({ runs, onCompany }) {
  if (!runs.length) return <div className="empty-state compact-empty"><p>No research runs yet. Add a company and confirm its official website to start.</p></div>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Company</th><th>Status</th><th>Progress</th><th>Pages</th><th>Documents</th><th>Findings</th><th>Started</th></tr></thead>
        <tbody>{runs.map((run) => (
          <tr key={run.id}>
            <td><button className="company-link" onClick={() => onCompany(run)}>{run.company_name}</button><small className="table-subtitle">Run #{run.id}</small></td>
            <td><Status value={run.status} /></td>
            <td className="progress-cell">{run.progress_message || '—'}{run.error_summary && <small className="error-detail">{run.error_summary.split('\n')[0]}</small>}{run.warning_summary && <small className="warning-detail">{run.warning_summary.split('\n')[0]}</small>}</td>
            <td>{run.pages_visited || 0}</td>
            <td>{run.documents_processed || 0} / {run.documents_discovered || 0}</td>
            <td>{run.findings_count || 0}</td>
            <td>{formatDate(run.created_at)}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function CompanyProfile({
  profile,
  onBack,
  onEdit,
  onDelete,
  onResearch,
  onDocument,
  onSaveFinding,
  findingEdits,
  setFindingEdits,
  unavailableField,
  setUnavailableField,
  onMarkUnavailable,
}) {
  if (!profile) return <div className="loading-card">Loading company profile…</div>;
  const { company, research_runs: runs, documents, findings } = profile;
  return (
    <section>
      <button className="back-link" onClick={onBack}>← Company directory</button>
      <div className="profile-heading">
        <div><p className="eyebrow">COMPANY PROFILE</p><h1>{company.company_name}</h1><div className="profile-meta"><Status value={company.research_status} />{company.industry && <span>{company.industry}</span>}<span>Last researched {formatDate(company.last_researched_at)}</span></div></div>
        <div className="profile-actions"><button className="button button-outline" onClick={onEdit}>Edit details</button><button className="button button-primary" disabled={!company.official_website} onClick={onResearch}>Start research</button><button className="button button-quiet-danger" onClick={onDelete}>Delete</button></div>
      </div>
      <div className="profile-grid">
        <article className="info-card"><p className="eyebrow">OFFICIAL SOURCE</p>{company.official_website ? <a className="source-link" href={company.official_website} target="_blank" rel="noreferrer">{company.official_website} ↗</a> : <p className="muted">No official website recorded. Add one before starting research.</p>}<p className="notes">{company.notes || 'No researcher notes.'}</p></article>
        <article className="info-card"><p className="eyebrow">RESEARCH SUMMARY</p><div className="mini-stats"><span><strong>{runs.length}</strong> runs</span><span><strong>{documents.length}</strong> sources</span><span><strong>{findings.filter((finding) => finding.review_status === 'pending_review').length}</strong> to review</span></div></article>
      </div>
      <div className="section-heading"><div><p className="eyebrow">SOURCE MATERIAL</p><h2>Discovered documents and pages</h2></div></div>
      {documents.length ? <div className="document-list">{documents.map((item) => (
        <article className="document-row" key={item.id}>
          <span className="doc-icon">{item.file_type?.includes('pdf') ? 'PDF' : 'WEB'}</span>
          <div className="doc-description"><strong>{item.title}</strong><a href={item.source_url} target="_blank" rel="noreferrer">{item.source_url} ↗</a></div>
          <Status value={item.processing_status} />
          <button className="button button-outline button-small" onClick={() => onDocument(item.id)}>View text</button>
        </article>
      ))}</div> : <div className="empty-state compact-empty"><p>No source documents recorded. Start research to crawl the confirmed website.</p></div>}

      <div className="section-heading"><div><p className="eyebrow">HUMAN REVIEW</p><h2>Extracted findings</h2></div></div>
      <div className="unavailable-form"><span>Record information not found</span><select value={unavailableField} onChange={(event) => setUnavailableField(event.target.value)} aria-label="Field not found"><option value="">Select a CSR field…</option>{unavailableFields.map((field) => <option value={field} key={field}>{field}</option>)}</select><button className="button button-outline button-small" disabled={!unavailableField} onClick={onMarkUnavailable}>Mark unavailable</button></div>
      {findings.length ? <div className="finding-list">{findings.map((finding) => {
        const edit = findingEdits[finding.id] || {};
        return (
          <article className="finding-card" key={finding.id}>
            <div className="finding-top"><div><span className="field-name">{finding.field_name.replaceAll('_', ' ')}</span>{finding.extraction_method && <span className="method-tag">{finding.extraction_method} extraction</span>}</div><Status value={edit.review_status || finding.review_status} /></div>
            <label>Extracted information<textarea rows="2" value={edit.finding_value ?? finding.finding_value} onChange={(event) => setFindingEdits((current) => ({ ...current, [finding.id]: { ...current[finding.id], finding_value: event.target.value } }))} /></label>
            <div className="finding-meta"><label>Financial year<input value={edit.financial_year ?? finding.financial_year ?? ''} placeholder="Not stated" onChange={(event) => setFindingEdits((current) => ({ ...current, [finding.id]: { ...current[finding.id], financial_year: event.target.value } }))} /></label><label>Review decision<select value={edit.review_status || finding.review_status} onChange={(event) => setFindingEdits((current) => ({ ...current, [finding.id]: { ...current[finding.id], review_status: event.target.value } }))}>{['pending_review', 'approved', 'rejected', 'unavailable'].map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}</select></label><button className="button button-primary button-small" onClick={() => onSaveFinding(finding)}>Save review</button></div>
            <blockquote>{finding.supporting_excerpt}</blockquote>
            {finding.source_url ? <a className="source-link" href={finding.source_url} target="_blank" rel="noreferrer">{finding.source_url}{finding.page_number ? ` · page ${finding.page_number}` : ''} ↗</a> : <span className="muted">Manually recorded; no source evidence available.</span>}
          </article>
        );
      })}</div> : <div className="empty-state compact-empty"><p>No findings have been extracted. The local pipeline reports only text supported by discovered pages or documents.</p></div>}

      <div className="section-heading"><div><p className="eyebrow">HISTORY</p><h2>Research runs</h2></div></div>
      <ResearchRuns runs={runs.map((run) => ({ ...run, company_name: company.company_name }))} onCompany={() => {}} />
    </section>
  );
}

export default App;
