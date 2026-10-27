'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api';
type User = { id: string; name: string; email: string; role: 'ADMIN' | 'COLLECTOR' | 'BORROWER'; borrower_id?: string; borrowerId?: string; privacy_consent_at?: string | null };
type Row = Record<string, any>;
type Section = 'Overview' | 'Borrowers' | 'Loans' | 'Payments' | 'Reports' | 'Users' | 'Audit log' | 'Settings' | 'My loan' | 'My profile';

const cash = (n: unknown) => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(Number(n || 0));
const shortDate = (n: unknown) => n ? new Date(String(n).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const titleCase = (value: unknown) => String(value || '—').replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

export default function Home() {
  const [token, setToken] = useState('');
  const [user, setUser] = useState<User | null>(null);
  const [section, setSection] = useState<Section>('Overview');
  const [rows, setRows] = useState<Row[]>([]);
  const [dashboard, setDashboard] = useState<Row>({});
  const [reports, setReports] = useState<Row | null>(null);
  const [settings, setSettings] = useState<Row>({ monthly_rate: 10, penalty_rate: 0 });
  const [borrowers, setBorrowers] = useState<Row[]>([]);
  const [loans, setLoans] = useState<Row[]>([]);
  const [modal, setModal] = useState('');
  const [editingBorrower, setEditingBorrower] = useState<Row | null>(null);
  const [detail, setDetail] = useState<Row | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);

  const api = useCallback(async (path: string, options: RequestInit = {}) => {
    const headers: Record<string, string> = { ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    if (!(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    Object.assign(headers, options.headers || {});
    const response = await fetch(`${API}${path}`, { ...options, headers });
    const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) {
        localStorage.removeItem('alivio_token');
        setToken('');
        setUser(null);
      }
      throw new Error(data.error || 'Unable to complete this request.');
    }
    return data;
  }, [token]);

  const loadDashboard = useCallback(async () => setDashboard(await api('/dashboard')), [api]);
  const loadSection = useCallback(async (target: Section) => {
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      if (target === 'Overview') await loadDashboard();
      if (target === 'Borrowers') setRows((await api('/borrowers')).borrowers);
      if (target === 'Loans' || target === 'My loan') setRows((await api('/loans')).loans);
      if (target === 'Payments') setRows((await api('/payments')).payments);
      if (target === 'Reports') setReports(await api('/reports'));
      if (target === 'Users') setRows((await api('/users')).users);
      if (target === 'Audit log') setRows((await api('/audit-logs?limit=150')).logs);
      if (target === 'Settings') setSettings((await api('/settings')).settings);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to load this section.'); }
    finally { setLoading(false); }
  }, [api, loadDashboard, token]);

  useEffect(() => {
    const saved = localStorage.getItem('alivio_token');
    if (!saved) return;
    fetch(`${API}/auth/me`, { headers: { Authorization: `Bearer ${saved}` } })
      .then(async (response) => {
        if (!response.ok) throw new Error('Session expired');
        const data = await response.json();
        setToken(saved);
        setUser(data.user);
      })
      .catch(() => localStorage.removeItem('alivio_token'));
  }, []);

  useEffect(() => { if (user && token) void loadSection(section); }, [user, token, section, loadSection]);

  const borrower = user?.role === 'BORROWER';
  const nav: Section[] = borrower
    ? ['Overview', 'My loan', 'Payments', 'My profile']
    : user?.role === 'COLLECTOR'
      ? ['Overview', 'Borrowers', 'Loans', 'Payments', 'Reports', 'My profile']
      : ['Overview', 'Borrowers', 'Loans', 'Payments', 'Reports', 'Users', 'Audit log', 'Settings', 'My profile'];

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError('');
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      const response = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to sign in.');
      localStorage.setItem('alivio_token', data.token); setToken(data.token); setUser(data.user);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to sign in.'); }
    finally { setBusy(false); }
  }

  async function openForm(name: string) {
    setError('');
    try {
      if (name === 'loan') setBorrowers((await api('/borrowers')).borrowers);
      if (name === 'payment') setLoans((await api('/loans')).loans.filter((item: Row) => item.status === 'ACTIVE'));
      if (name === 'loan') setSettings((await api('/settings')).settings);
      setModal(name);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to load form data.'); }
  }

  async function downloadDocument(path: string, filename: string) {
    try {
      const response = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Unable to download this document.');
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to download this document.'); }
  }

  async function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    setError('');
    try {
      const paths: Record<string, [string, string]> = {
        borrower: ['/borrowers', 'POST'], loan: ['/loans', 'POST'], payment: ['/payments', 'POST'], user: ['/users', 'POST'],
        profile: ['/auth/profile', 'PUT'], password: ['/auth/password', 'PUT']
      };
      const [path, method] = modal === 'borrower-edit' && editingBorrower
        ? [`/borrowers/${editingBorrower.id}`, 'PUT']
        : paths[modal];
      await api(path, { method, body: JSON.stringify(values) });
      setModal('');
      setEditingBorrower(null);
      await loadSection(section);
      await loadDashboard();
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to save changes.'); }
  }

  async function action(type: string, row?: Row) {
    setError('');
    try {
      if (type === 'delete' && row) {
        if (!window.confirm(`Delete ${row.first_name} ${row.last_name}?`)) return;
        await api(`/borrowers/${row.id}`, { method: 'DELETE' }); await loadSection(section);
      } else if (type === 'close' && row) {
        if (!window.confirm(`Close loan ${row.loan_number}?`)) return;
        await api(`/loans/${row.id}/close`, { method: 'POST', body: '{}' }); await loadSection(section);
      } else if (type === 'renew' && row) {
        const principal = window.prompt('Renewal principal (PHP)', Number(row.balance || 0).toFixed(2));
        if (!principal) return;
        await api(`/loans/${row.id}/renew`, { method: 'POST', body: JSON.stringify({ principal, monthlyRate: row.monthly_rate, termMonths: row.term_months, startDate: new Date().toISOString().slice(0, 10) }) });
        await loadSection(section);
      } else if (type === 'statement' && row) {
        setDetail({ type: 'statement', ...(await api(`/loans/${row.id}/statement`)) });
      } else if (type === 'receipt' && row) {
        setDetail({ type: 'receipt', ...(await api(`/receipts/${row.id}`)).receipt });
      } else if (type === 'toggle-user' && row) {
        await api(`/users/${row.id}`, { method: 'PATCH', body: JSON.stringify({ active: !row.active }) }); await loadSection(section);
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to complete the action.'); }
  }

  async function exportCsv() {
    if (!reports) return;
    const csv = ['Date,Payments,Collected', ...(reports.collections || []).map((row: Row) => `${row.date},${row.payment_count},${row.collected}`)].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'alivio-collections.csv'; link.click(); URL.revokeObjectURL(url);
  }

  const filtered = useMemo(() => search ? rows.filter((row) => Object.values(row).some((v) => String(v ?? '').toLowerCase().includes(search.toLowerCase()))) : rows, [rows, search]);

  if (!user) return <main className="login-page">
    <div className="login-brand"><Brand /> <span>ALIVIO</span></div>
    <section className="login-card"><div className="eyebrow">LENDING MANAGEMENT SYSTEM</div><h1>Welcome back</h1><p>Sign in to manage your account and loan activity.</p>
      {error && <div className="alert">{error}</div>}
      <form className="stack-form" onSubmit={login}><label>Email address<input name="email" type="email" autoComplete="username" placeholder="name@example.com" required /></label><label>Password<input name="password" type="password" autoComplete="current-password" placeholder="Enter your password" required /></label><button className="button primary full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'} <span>→</span></button></form>
      <div className="login-note"><i /> Secure, role-based access</div>
    </section><div className="login-footer">ALIVIO Lending · Your financial partner</div>
  </main>;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><Brand /><span>ALIVIO</span></div><div className="workspace-label">WORKSPACE</div>
      <nav>{nav.map((item) => <button key={item} className={`nav-item ${section === item ? 'selected' : ''}`} onClick={() => { setSection(item); setSearch(''); setError(''); }}><NavIcon name={item} /><span>{item}</span></button>)}</nav>
      <div className="sidebar-bottom"><div className="help-card"><span className="help-icon">?</span><strong>Need a hand?</strong><span>Contact your account administrator.</span></div>
        <div className="profile-button"><div className="avatar">{user.name.slice(0, 1).toUpperCase()}</div><div className="profile-meta"><strong>{user.name}</strong><span>{titleCase(user.role)}</span></div>
          <button className="logout" aria-label="Sign out" onClick={() => { localStorage.removeItem('alivio_token'); setToken(''); setUser(null); }}>↪</button>
        </div>
      </div>
    </aside>
    <main className="main-area">
      <header className="topbar"><div className="breadcrumbs"><span>ALIVIO</span><b>/</b><strong>{section}</strong></div><div className="top-actions"><span>{new Date().toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric' })}</span><div className="top-avatar">{user.name.slice(0, 1).toUpperCase()}</div></div></header>
      <div className="content">
        {error && <div className="alert page-alert">{error}<button onClick={() => setError('')}>×</button></div>}
        {borrower && !user.privacy_consent_at && <div className="consent-banner"><div><strong>Data privacy consent</strong><p>I agree to the collection, processing, and storage of my personal information for lending purposes, in accordance with the Philippine Data Privacy Act.</p></div><button className="button primary" onClick={async () => { try { await api('/auth/privacy-consent', { method: 'POST', body: JSON.stringify({ accepted: true }) }); setUser({ ...user, privacy_consent_at: new Date().toISOString() }); await loadSection(section); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to record consent.'); } }}>I agree</button></div>}
        {section === 'Overview' && <Overview user={user} data={dashboard} isBorrower={Boolean(borrower)} navigate={setSection} />}
        {section === 'Borrowers' && <section><Heading title="Borrowers" subtitle="Manage borrower profiles and their lending records." action={<button className="button primary" onClick={() => void openForm('borrower')}>＋ Add borrower</button>} /><Search value={search} change={setSearch} placeholder="Search borrowers…" /><Table rows={filtered} columns={[
          { key: 'name', title: 'BORROWER', render: (r) => <Person name={`${r.first_name} ${r.last_name}`} sub={r.email} /> },
          { key: 'phone', title: 'PHONE' }, { key: 'loan_count', title: 'LOANS' }, { key: 'balance', title: 'OUTSTANDING', render: (r) => cash(r.balance) },
          { key: 'account_active', title: 'PORTAL', render: (r) => <Status value={r.account_active === false ? 'INACTIVE' : 'ACTIVE'} /> },
          { key: 'actions', title: '', render: (r) => <RowActions view={() => setDetail({ type: 'borrower', ...r })} deleteAction={user.role === 'ADMIN' ? () => void action('delete', r) : undefined} /> }
        ]} empty="No borrowers yet. Add a borrower to get started." /></section>}
        {(section === 'Loans' || section === 'My loan') && <section><Heading title={borrower ? 'My loan' : 'Loan management'} subtitle={borrower ? 'Review your current loan, schedule, and balance.' : 'Create loans, monitor repayment, and manage renewals.'} action={!borrower ? <><button className="button secondary" onClick={() => void openForm('payment')}>＋ Record payment</button><button className="button primary" onClick={() => void openForm('loan')}>＋ Create loan</button></> : undefined} /><Search value={search} change={setSearch} placeholder="Search loan number or borrower…" /><Table rows={filtered} columns={[
          { key: 'loan_number', title: 'LOAN NUMBER', render: (r) => <button className="link-button" onClick={() => void action('statement', r)}>{r.loan_number}</button> },
          ...(!borrower ? [{ key: 'borrower', title: 'BORROWER', render: (r: Row) => `${r.first_name} ${r.last_name}` }] : []),
          { key: 'principal', title: 'PRINCIPAL', render: (r) => cash(r.principal) }, { key: 'monthly_rate', title: 'RATE', render: (r) => `${r.monthly_rate}% / mo` },
          { key: 'term_months', title: 'TERM', render: (r) => `${r.term_months} months` }, { key: 'balance', title: 'BALANCE', render: (r) => cash(r.balance) },
          { key: 'next_due_date', title: 'NEXT DUE', render: (r) => shortDate(r.next_due_date) }, { key: 'status', title: 'STATUS', render: (r) => <Status value={loanDueStatus(r)} /> },
          { key: 'actions', title: '', render: (r) => <RowActions view={() => void action('statement', r)} more={!borrower && r.status === 'ACTIVE' ? () => setDetail({ type: 'loan-actions', ...r }) : undefined} /> }
        ]} empty="No loans found." /></section>}
        {section === 'Payments' && <section><Heading title={borrower ? 'Payment history' : 'Payments & receipts'} subtitle={borrower ? 'View your payment history and official receipts.' : 'Record payments and access official receipts.'} action={!borrower ? <button className="button primary" onClick={() => void openForm('payment')}>＋ Record payment</button> : undefined} /><Search value={search} change={setSearch} placeholder="Search receipt or loan…" /><Table rows={filtered} columns={[
          { key: 'receipt_number', title: 'RECEIPT', render: (r) => <button className="link-button" onClick={() => void action('receipt', r)}>{r.receipt_number}</button> },
          ...(!borrower ? [{ key: 'borrower', title: 'BORROWER', render: (r: Row) => `${r.first_name} ${r.last_name}` }] : []),
          { key: 'loan_number', title: 'LOAN' }, { key: 'amount', title: 'AMOUNT', render: (r) => cash(r.amount) }, { key: 'payment_method', title: 'METHOD', render: (r) => titleCase(r.payment_method) },
          { key: 'paid_at', title: 'DATE PAID', render: (r) => new Date(r.paid_at).toLocaleDateString('en-PH') },
          { key: 'actions', title: '', render: (r) => <RowActions view={() => void action('receipt', r)} /> }
        ]} empty="No payments recorded yet." /></section>}
        {section === 'Reports' && reports && <Reports reports={reports} exportCsv={() => void exportCsv()} />}
        {section === 'Users' && <section><Heading title="User access" subtitle="Manage administrator and collector accounts." action={<button className="button primary" onClick={() => setModal('user')}>＋ Add user</button>} /><Table rows={filtered} columns={[
          { key: 'name', title: 'NAME', render: (r) => <Person name={r.name} sub={r.email} /> }, { key: 'role', title: 'ROLE', render: (r) => titleCase(r.role) },
          { key: 'created_at', title: 'CREATED', render: (r) => shortDate(r.created_at) }, { key: 'active', title: 'STATUS', render: (r) => <Status value={r.active ? 'ACTIVE' : 'INACTIVE'} /> },
          { key: 'actions', title: '', render: (r) => <button className="text-action" onClick={() => void action('toggle-user', r)}>{r.active ? 'Deactivate' : 'Reactivate'}</button> }
        ]} empty="No users found." /></section>}
        {section === 'Audit log' && <section><Heading title="Audit log" subtitle="A record of account access and important system activity." /><Table rows={filtered} columns={[
          { key: 'created_at', title: 'WHEN', render: (r) => new Date(r.created_at).toLocaleString() }, { key: 'user_name', title: 'USER' },
          { key: 'action', title: 'ACTION', render: (r) => titleCase(r.action) }, { key: 'entity_type', title: 'RECORD', render: (r) => `${titleCase(r.entity_type)} ${r.entity_id ? `· ${String(r.entity_id).slice(0, 8)}` : ''}` }, { key: 'ip_address', title: 'IP ADDRESS' }
        ]} empty="No activity recorded." /></section>}
        {section === 'Settings' && <Settings settings={settings} save={async (value) => { try { const data = await api('/settings', { method: 'PUT', body: JSON.stringify(value) }); setSettings(data.settings); setError(''); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to save settings.'); } }} />}
        {section === 'My profile' && <section><Heading title="My profile" subtitle="Manage your contact details and account password." /><div className="settings-card profile-card"><div className="profile-large">{user.name.slice(0, 1)}</div><div><h2>{user.name}</h2><p>{user.email} · {titleCase(user.role)} account</p><button className="button secondary" onClick={() => setModal('profile')}>Edit contact details</button><button className="button secondary" onClick={() => setModal('password')}>Change password</button>{borrower && (user.borrower_id || user.borrowerId) && <button className="button secondary" onClick={() => void downloadDocument(`/borrowers/${user.borrower_id || user.borrowerId}/documents/contract`, 'loan-agreement')}>Download loan agreement</button>}</div></div></section>}
        {loading && <div className="loading-bar" />}
      </div>
      <footer className="page-footer"><span>© {new Date().getFullYear()} ALIVIO Lending</span><span>Secure lending management</span></footer>
    </main>
    {modal && <Modal title={modalTitle(modal)} close={() => { setModal(''); setEditingBorrower(null); setError(''); }}>{error && <div className="alert modal-alert">{error}</div>}<EntryForm type={modal} borrowers={borrowers} loans={loans} user={user} defaultRate={Number(settings.monthly_rate || 10)} initial={editingBorrower} submit={submitForm} /></Modal>}
    {detail && <Modal title={detail.type === 'statement' ? 'Statement of account' : detail.type === 'receipt' ? 'Official receipt' : detail.type === 'borrower' ? 'Borrower profile' : 'Loan actions'} close={() => setDetail(null)} wide>
      {detail.type === 'statement' ? <Statement data={detail} /> : detail.type === 'receipt' ? <Receipt receipt={detail} /> : detail.type === 'borrower' ? <BorrowerDetail data={detail} api={api} download={downloadDocument} canManageAccounts={user.role === 'ADMIN'} onEdit={() => { setEditingBorrower(detail); setDetail(null); setModal('borrower-edit'); }} onAccountChange={async (active) => { try { await api(`/borrowers/${detail.id}/account`, { method: 'PATCH', body: JSON.stringify({ active }) }); await loadSection(section); setDetail(null); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to update borrower access.'); } }} /> :
        <div className="action-menu"><button className="button secondary" onClick={() => void action('statement', detail)}>View / print SOA</button><button className="button secondary" onClick={() => { const loan = detail; setDetail(null); void action('renew', loan); }}>Renew loan</button><button className="button danger" onClick={() => { const loan = detail; setDetail(null); void action('close', loan); }}>Close loan</button></div>}
    </Modal>}
  </div>;
}

function Brand() { return <span className="brand-mark"><i /><i /><i /></span>; }
function NavIcon({ name }: { name: string }) { return <span className="nav-icon">{({ Overview: '◫', Borrowers: '♙', Loans: '▤', 'My loan': '▤', Payments: '↔', Reports: '▥', Users: '♧', 'Audit log': '◷', Settings: '⚙', 'My profile': '♙' } as Record<string, string>)[name]}</span>; }
function Heading({ title, subtitle, action }: { title: string; subtitle: string; action?: React.ReactNode }) { return <div className="page-heading"><div><div className="eyebrow">ALIVIO WORKSPACE</div><h1>{title}</h1><p>{subtitle}</p></div><div className="heading-actions">{action}</div></div>; }
function Search({ value, change, placeholder }: { value: string; change: (value: string) => void; placeholder: string }) { return <div className="table-toolbar"><div className="search-field"><span>⌕</span><input value={value} onChange={(e) => change(e.target.value)} placeholder={placeholder} /></div><span className="record-count">Records are protected by role-based access</span></div>; }
type Col = { key: string; title: string; render?: (row: Row) => React.ReactNode };
function Table({ rows, columns, empty }: { rows: Row[]; columns: Col[]; empty: string }) { return <div className="table-wrap"><table><thead><tr>{columns.map((c) => <th key={c.key}>{c.title}</th>)}</tr></thead><tbody>{rows.map((r, i) => <tr key={r.id || i}>{columns.map((c) => <td key={c.key}>{c.render ? c.render(r) : r[c.key] || '—'}</td>)}</tr>)}{!rows.length && <tr><td className="empty-cell" colSpan={columns.length}><span>▤</span><strong>{empty}</strong></td></tr>}</tbody></table></div>; }
function Status({ value }: { value: unknown }) { const raw = String(value || '').toUpperCase(); const color = raw === 'ACTIVE' || raw === 'CURRENT' ? 'green' : raw === 'OVERDUE' ? 'red' : raw === 'DUE SOON' || raw === 'RENEWED' ? 'yellow' : 'gray'; return <span className={`status-pill ${color}`}><i />{titleCase(raw)}</span>; }
function loanDueStatus(row: Row) {
  if (row.status !== 'ACTIVE') return row.status;
  if (!row.next_due_date) return 'CURRENT';
  const daysUntilDue = Math.ceil((new Date(String(row.next_due_date).slice(0, 10) + 'T00:00:00').getTime() - new Date(new Date().toDateString()).getTime()) / 86400000);
  return daysUntilDue < 0 ? 'OVERDUE' : daysUntilDue <= 7 ? 'DUE SOON' : 'CURRENT';
}
function Person({ name, sub }: { name: string; sub: string }) { return <div className="person-cell"><div className="table-avatar">{name.slice(0, 1)}</div><div><strong>{name}</strong><small>{sub}</small></div></div>; }
function RowActions({ view, deleteAction, more }: { view?: () => void; deleteAction?: () => void; more?: () => void }) { return <div className="row-actions">{view && <button title="View" onClick={view}>↗</button>}{more && <button title="Actions" onClick={more}>•••</button>}{deleteAction && <button title="Delete" onClick={deleteAction}>×</button>}</div>; }

function Overview({ user, data, isBorrower, navigate }: { user: User; data: Row; isBorrower: boolean; navigate: (section: Section) => void }) {
  const cards = isBorrower
    ? [['Outstanding balance', cash(data.outstandingBalance), 'Across your active loans', 'blue', '₱'], ['Active loans', data.activeLoans || 0, 'Currently in repayment', 'green', '↗'], ['Due this week', data.dueThisWeek || 0, 'Installments to plan for', 'yellow', '◷'], ['Overdue accounts', data.overdueAccounts || 0, 'Please contact our team', 'red', '!']]
    : [['Total borrowers', data.totalBorrowers || 0, 'Registered borrower profiles', 'blue', '♙'], ['Active loans', data.activeLoans || 0, 'Currently in repayment', 'green', '↗'], ['Due today', data.dueToday || 0, 'Accounts requiring follow-up', 'yellow', '◷'], ['Overdue accounts', data.overdueAccounts || 0, 'Require collection follow-up', 'red', '!']];
  return <section><div className="welcome-row"><div><div className="eyebrow">YOUR LENDING OVERVIEW</div><h1>{isBorrower ? `Hello, ${user.name.split(' ')[0]}` : `Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}, ${user.name.split(' ')[0]}`}</h1><p>Here&apos;s what&apos;s happening with your {isBorrower ? 'account' : 'lending portfolio'} today.</p></div><span className="date-chip">◷ &nbsp; {new Date().toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric' })}</span></div>
    <div className="stat-grid">{cards.map(([heading, value, note, color, icon]) => <div className="stat-card" key={heading}><div className="stat-top"><span>{heading}</span><span className={`stat-icon ${color}`}>{icon}</span></div><strong>{value}</strong><small>{note}</small></div>)}</div>
    {!isBorrower && <div className="overview-grid"><div className="panel"><div className="panel-heading"><div><h2>Collections this month</h2><p>Payments received in the current month</p></div><span className="subtle-tag">THIS MONTH</span></div><div className="collection-amount">{cash(data.collectionsThisMonth)}</div><div className="collection-track"><span /></div><div className="track-caption"><span>Month-to-date collections</span><b>PHP</b></div></div><div className="panel"><div className="panel-heading"><div><h2>Portfolio snapshot</h2><p>Current lending position</p></div></div><div className="balance-row"><span>Outstanding balance</span><strong>{cash(data.outstandingBalance)}</strong></div><div className="balance-row"><span>Expected interest income</span><strong>{cash(data.interestIncome)}</strong></div><button className="panel-link" onClick={() => navigate('Reports')}>View portfolio reports <span>→</span></button></div></div>}
    <div className="panel quick-panel"><div className="panel-heading"><div><h2>{isBorrower ? 'Your account' : 'Quick actions'}</h2><p>{isBorrower ? 'View loan details and payment activity.' : 'Jump straight into a common task.'}</p></div></div><div className="quick-actions">
      {(isBorrower ? [['My loan', 'Balance and payment schedule', 'My loan'], ['Payment history', 'Payments and receipts', 'Payments']] : [['Manage borrowers', 'Profiles and borrower details', 'Borrowers'], ['Manage loans', 'Schedules and payments', 'Loans'], ['View reports', 'Collections and summaries', 'Reports']]).map(([title, sub, target], i) => <button key={target} onClick={() => navigate(target as Section)}><span className={`quick-icon tone-${i}`}>{['♙', '▤', '▥'][i]}</span><span><strong>{title}</strong><small>{sub}</small></span><b>→</b></button>)}
    </div></div><div className="compliance-note">✓ &nbsp; Simple monthly interest · clear payment schedules · secure borrower access</div></section>;
}

function Reports({ reports, exportCsv }: { reports: Row; exportCsv: () => void }) {
  const collected = (reports.collections || []).reduce((sum: number, r: Row) => sum + Number(r.collected), 0);
  return <section><Heading title="Reports" subtitle="Collections, outstanding balances, overdue accounts, and interest earnings." action={<button className="button secondary" onClick={exportCsv}>↓ Export collections CSV</button>} />
    <div className="report-summary"><div><span>Collections this period</span><strong>{cash(collected)}</strong></div><div><span>Expected interest income</span><strong>{cash(reports.interest?.expected_interest)}</strong></div><div><span>Interest originated this month</span><strong>{cash(reports.interest?.this_month)}</strong></div></div>
    <div className="panel report-panel"><div className="panel-heading"><div><h2>Daily collections</h2><p>Payments grouped by date</p></div></div><Table rows={reports.collections || []} columns={[{ key: 'date', title: 'DATE', render: (r) => shortDate(r.date) }, { key: 'payment_count', title: 'PAYMENTS' }, { key: 'collected', title: 'COLLECTED', render: (r) => cash(r.collected) }]} empty="No collections in this period." /></div>
    <div className="report-grid"><div className="panel report-panel"><div className="panel-heading"><div><h2>Outstanding balances</h2><p>Active loan amounts remaining</p></div></div><Table rows={reports.outstanding || []} columns={[{ key: 'borrower', title: 'BORROWER', render: (r) => `${r.first_name} ${r.last_name}` }, { key: 'loan_number', title: 'LOAN' }, { key: 'balance', title: 'BALANCE', render: (r) => cash(r.balance) }]} empty="No active balances." /></div>
      <div className="panel report-panel"><div className="panel-heading"><div><h2>Overdue accounts</h2><p>Past-due unpaid installments</p></div></div><Table rows={reports.overdue || []} columns={[{ key: 'borrower', title: 'BORROWER', render: (r) => `${r.first_name} ${r.last_name}` }, { key: 'oldest_due', title: 'OLDEST DUE', render: (r) => shortDate(r.oldest_due) }, { key: 'overdue_balance', title: 'OVERDUE', render: (r) => cash(r.overdue_balance) }]} empty="No overdue accounts." /></div></div>
  </section>;
}

function Settings({ settings, save }: { settings: Row; save: (value: Row) => void }) {
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget).entries()); save(data); }
  return <section><Heading title="System settings" subtitle="Configure interest and penalty defaults for new lending." />
    <form className="settings-card settings-form" onSubmit={submit}><div className="settings-intro"><span className="settings-icon">⚙</span><div><h2>Loan calculation defaults</h2><p>Existing loans are not recalculated when defaults change.</p></div></div>
      <div className="form-grid"><label>Default monthly interest (%)<input name="monthly_rate" type="number" min="0" max="100" step="0.01" defaultValue={Number(settings.monthly_rate || 10)} required /><small>Simple interest: principal × rate × term</small></label><label>Monthly overdue penalty (%)<input name="penalty_rate" type="number" min="0" max="100" step="0.01" defaultValue={Number(settings.penalty_rate || 0)} required /><small>Saved as the configured penalty rate</small></label></div>
      <div className="settings-footer"><span>Changes apply to new loans.</span><button className="button primary">Save settings</button></div>
    </form><div className="settings-card disclosure-card"><div className="settings-intro"><span className="settings-icon">ⓘ</span><div><h2>Truth in Lending disclosure</h2><p>Review and explain these loan figures before disbursement.</p></div></div><div className="disclosure-list"><span>Principal</span><span>Monthly interest rate</span><span>Finance charge / total interest</span><span>Total amount payable</span><span>Installment payment schedule</span></div></div>
  </section>;
}

function Modal({ title, children, close, wide = false }: { title: string; children: React.ReactNode; close: () => void; wide?: boolean }) {
  return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}><div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true"><div className="modal-header"><div><div className="eyebrow">ALIVIO LENDING</div><h2>{title}</h2></div><button className="close-button" onClick={close}>×</button></div>{children}</div></div>;
}
function modalTitle(name: string) { return ({ borrower: 'Add borrower', 'borrower-edit': 'Edit borrower', loan: 'Create loan', payment: 'Record payment', user: 'Add team member', profile: 'Edit contact details', password: 'Change password' } as Record<string, string>)[name] || 'Details'; }

function EntryForm({ type, borrowers, loans, user, defaultRate, initial, submit }: { type: string; borrowers: Row[]; loans: Row[]; user: User | null; defaultRate: number; initial: Row | null; submit: (event: FormEvent<HTMLFormElement>) => void }) {
  const today = new Date().toISOString().slice(0, 10);
  return <form className="stack-form modal-form" onSubmit={submit}>
    {type === 'borrower' && <div className="form-grid"><label>First name<input name="firstName" required autoFocus /></label><label>Last name<input name="lastName" required /></label><label>Email<input name="email" type="email" required /></label><label>Phone number<input name="phone" type="tel" /></label><label className="span-two">Address<textarea name="address" rows={2} /></label><label className="span-two">Initial portal password<input name="password" type="password" minLength={10} required /><small>At least 10 characters; share securely with borrower.</small></label></div>}
    {type === 'borrower-edit' && initial && <div className="form-grid"><label>First name<input name="firstName" defaultValue={initial.first_name} required autoFocus /></label><label>Last name<input name="lastName" defaultValue={initial.last_name} required /></label><label>Email<input name="email" type="email" defaultValue={initial.email} required /></label><label>Phone number<input name="phone" type="tel" defaultValue={initial.phone || ''} /></label><label className="span-two">Address<textarea name="address" rows={2} defaultValue={initial.address || ''} /></label></div>}
    {type === 'loan' && <><label>Borrower<select name="borrowerId" required defaultValue=""><option value="" disabled>Select borrower</option>{borrowers.map((r) => <option key={r.id} value={r.id}>{r.first_name} {r.last_name} — {r.email}</option>)}</select></label><div className="form-grid"><label>Principal (PHP)<input name="principal" type="number" min="0.01" step="0.01" required /></label><label>Monthly interest (%)<input name="monthlyRate" type="number" min="0" step="0.01" defaultValue={defaultRate} required /></label><label>Term (months)<input name="termMonths" type="number" min="1" max="120" required /></label><label>Start date<input name="startDate" type="date" defaultValue={today} required /></label></div><div className="calculation-note"><strong>Simple interest</strong><span>Interest = principal × monthly rate × term. Equal monthly installments are generated.</span></div></>}
    {type === 'payment' && <><label>Loan<select name="loanId" required defaultValue=""><option value="" disabled>Select active loan</option>{loans.map((r) => <option key={r.id} value={r.id}>{r.loan_number} — {r.first_name} {r.last_name} — {cash(r.balance)}</option>)}</select></label><div className="form-grid"><label>Amount paid (PHP)<input name="amount" type="number" min="0.01" step="0.01" required /></label><label>Payment method<select name="paymentMethod"><option value="CASH">Cash</option><option value="BANK_TRANSFER">Bank transfer</option><option value="GCASH">GCash</option><option value="CHECK">Check</option><option value="OTHER">Other</option></select></label><label className="span-two">Reference / notes<input name="reference" /></label></div></>}
    {type === 'user' && <div className="form-grid"><label>Full name<input name="name" required /></label><label>Email<input name="email" type="email" required /></label><label>Role<select name="role"><option value="COLLECTOR">Collector</option><option value="ADMIN">Admin</option></select></label><label>Password<input name="password" type="password" minLength={10} required /></label></div>}
    {type === 'profile' && <><label>Full name<input name="name" defaultValue={user?.name} required /></label>{user?.role === 'BORROWER' && <label>Phone number<input name="phone" /></label>}</>}
    {type === 'password' && <><label>Current password<input name="currentPassword" type="password" required /></label><label>New password<input name="newPassword" type="password" minLength={10} required /></label></>}
    <div className="modal-actions"><span>All fields are validated before saving.</span><button className="button primary">Save</button></div>
  </form>;
}

function Statement({ data }: { data: Row }) {
  const loan = data.loan || {};
  return <div className="print-document"><div className="document-actions"><button className="button primary" onClick={() => window.print()}>Print / Save as PDF</button></div><div className="document-brand"><Brand /><strong>ALIVIO LENDING</strong><span>STATEMENT OF ACCOUNT</span></div>
    <div className="document-person"><div><small>BORROWER</small><strong>{loan.first_name} {loan.last_name}</strong><span>{loan.borrower_email}</span><span>{loan.borrower_phone}</span></div><div><small>LOAN NUMBER</small><strong>{loan.loan_number}</strong><span>Issued {new Date().toLocaleDateString('en-PH')}</span><Status value={loan.status} /></div></div>
    <div className="document-summary">{[['PRINCIPAL', cash(loan.principal)], ['MONTHLY RATE', `${loan.monthly_rate}%`], ['FINANCE CHARGE', cash(loan.interest)], ['TOTAL PAYABLE', cash(loan.total_due)], ['OUTSTANDING', cash(loan.balance)]].map(([k, v]) => <div key={k}><small>{k}</small><strong>{v}</strong></div>)}</div>
    <div className="document-section"><h3>Payment schedule</h3><Table rows={data.installments || []} columns={[{ key: 'installment_number', title: 'NO.' }, { key: 'due_date', title: 'DUE DATE', render: (r) => shortDate(r.due_date) }, { key: 'amount', title: 'AMOUNT DUE', render: (r) => cash(r.amount) }, { key: 'paid_amount', title: 'PAID', render: (r) => cash(r.paid_amount) }, { key: 'remaining', title: 'REMAINING', render: (r) => cash(Number(r.amount) - Number(r.paid_amount)) }]} empty="No schedule." /></div>
    <div className="document-section"><h3>Payment history</h3><Table rows={data.payments || []} columns={[{ key: 'receipt_number', title: 'RECEIPT' }, { key: 'paid_at', title: 'DATE PAID', render: (r) => shortDate(r.paid_at) }, { key: 'payment_method', title: 'METHOD', render: (r) => titleCase(r.payment_method) }, { key: 'amount', title: 'AMOUNT', render: (r) => cash(r.amount) }]} empty="No payments recorded." /></div>
    <p className="document-footnote">This statement is provided for account reference. Contact ALIVIO Lending if you believe any information is incorrect.</p></div>;
}

function Receipt({ receipt }: { receipt: Row }) {
  return <div className="print-document receipt-document"><div className="document-actions"><button className="button primary" onClick={() => window.print()}>Print / Save as PDF</button></div><div className="document-brand"><Brand /><strong>ALIVIO LENDING</strong><span>OFFICIAL RECEIPT</span></div><div className="receipt-number">{receipt.receipt_number}</div>
    <div className="receipt-lines"><div><span>Received from</span><strong>{receipt.first_name} {receipt.last_name}</strong></div><div><span>Amount paid</span><strong className="receipt-amount">{cash(receipt.amount)}</strong></div><div><span>Date paid</span><strong>{new Date(receipt.paid_at).toLocaleString('en-PH')}</strong></div><div><span>Payment method</span><strong>{titleCase(receipt.payment_method)}</strong></div><div><span>Loan number</span><strong>{receipt.loan_number}</strong></div><div><span>Remaining balance</span><strong>{cash(receipt.remaining_balance)}</strong></div>{receipt.reference && <div><span>Reference</span><strong>{receipt.reference}</strong></div>}</div><p className="document-footnote">This is an official receipt for the amount received. Thank you for your payment.</p></div>;
}

function BorrowerDetail({ data, api, download, canManageAccounts, onEdit, onAccountChange }: { data: Row; api: (path: string, options?: RequestInit) => Promise<any>; download: (path: string, filename: string) => Promise<void>; canManageAccounts: boolean; onEdit: () => void; onAccountChange: (active: boolean) => void }) {
  async function upload(type: 'id' | 'contract', file?: File) {
    if (!file) return;
    try {
      const body = new FormData();
      body.append('document', file);
      await api(`/borrowers/${data.id}/documents/${type}`, { method: 'POST', body });
      window.alert('Document uploaded successfully.');
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Unable to upload this document.');
    }
  }
  return <div className="borrower-detail"><div className="person-large"><div className="profile-large">{String(data.first_name || '?').slice(0, 1)}</div><div><h2>{data.first_name} {data.last_name}</h2><p>{data.email} · {data.phone || 'No phone on file'}</p><Status value={data.account_active === false ? 'INACTIVE' : 'ACTIVE'} /></div></div>
    <div className="detail-grid"><div><small>ADDRESS</small><strong>{data.address || 'No address on file'}</strong></div><div><small>OUTSTANDING BALANCE</small><strong>{cash(data.balance)}</strong></div><div><small>REGISTERED</small><strong>{shortDate(data.created_at)}</strong></div><div><small>ASSOCIATED LOANS</small><strong>{data.loan_count || 0}</strong></div></div>
    <div className="upload-row"><button className="button secondary" onClick={onEdit}>Edit borrower</button>{canManageAccounts && <button className="button secondary" onClick={() => onAccountChange(data.account_active === false)}> {data.account_active === false ? 'Reactivate portal' : 'Deactivate portal'} </button>}<label className="button secondary">Upload ID<input type="file" accept=".pdf,.jpg,.jpeg,.png" hidden onChange={(e) => void upload('id', e.target.files?.[0])} /></label><label className="button secondary">Upload contract<input type="file" accept=".pdf,.jpg,.jpeg,.png" hidden onChange={(e) => void upload('contract', e.target.files?.[0])} /></label><button className="button secondary" onClick={() => void download(`/borrowers/${data.id}/documents/id`, `${data.last_name}-ID`)}>Download ID</button><button className="button secondary" onClick={() => void download(`/borrowers/${data.id}/documents/contract`, `${data.last_name}-loan-agreement`)}>Download contract</button><span>PDF, JPG or PNG · max 5 MB</span></div></div>;
}
