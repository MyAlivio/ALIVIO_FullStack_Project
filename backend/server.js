const express = require('express');
const { rateLimit } = require('express-rate-limit');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined });
const port = Number(process.env.PORT || 5000);
const jwtSecret = process.env.JWT_SECRET;
const uploadRoot = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads'));
const allowedOrigins = (process.env.FRONTEND_ORIGIN || 'http://localhost:3000').split(',').map((origin) => origin.trim());

if (!jwtSecret || jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be set to a random value of at least 32 characters.');
}

fs.mkdirSync(uploadRoot, { recursive: true });
app.disable('x-powered-by');
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use('/api/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please try again in 15 minutes.' }
}));

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status });
const asNumber = (value) => Number(value || 0);

function auth(requiredRoles = []) {
  return async (req, res, next) => {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Sign in to continue.' });
    let claims;
    try {
      claims = jwt.verify(token, jwtSecret);
    } catch {
      return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    }
    try {
      const result = await pool.query('SELECT role,borrower_id,active,privacy_consent_at FROM users WHERE id=$1', [claims.id]);
      const current = result.rows[0];
      if (!current || !current.active) return res.status(401).json({ error: 'This account is no longer active.' });
      req.user = { ...claims, role: current.role, borrowerId: current.borrower_id };
      if (current.role === 'BORROWER' && !current.privacy_consent_at &&
          req.path !== '/api/auth/privacy-consent' && req.path !== '/api/auth/me') {
        return res.status(403).json({ error: 'Please review and accept the data privacy consent before using the borrower portal.' });
      }
      if (requiredRoles.length && !requiredRoles.includes(current.role)) {
        return res.status(403).json({ error: 'You do not have permission to perform this action.' });
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

async function audit(req, action, entityType, entityId = null, details = {}) {
  await pool.query(
    'INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip_address) VALUES ($1, $2, $3, $4, $5, $6)',
    [req.user ? req.user.id : null, action, entityType, entityId, JSON.stringify(details), req.ip]
  );
}

async function borrowerScope(req, borrowerId) {
  if (req.user.role === 'BORROWER' && req.user.borrowerId !== borrowerId) throw fail(403, 'You can only access your own borrower records.');
}

async function getLoan(loanId, req, client = pool) {
  const { rows } = await client.query(
    `SELECT l.*, b.first_name, b.last_name, b.email AS borrower_email, b.phone AS borrower_phone,
            COALESCE(SUM(i.amount - i.paid_amount), 0) AS balance
       FROM loans l JOIN borrowers b ON b.id = l.borrower_id
       LEFT JOIN installments i ON i.loan_id = l.id
      WHERE l.id = $1 GROUP BY l.id, b.id`,
    [loanId]
  );
  if (!rows[0]) throw fail(404, 'Loan not found.');
  await borrowerScope(req, rows[0].borrower_id);
  return rows[0];
}

function buildInstallments(total, termMonths, startDate) {
  const cents = Math.round(asNumber(total) * 100);
  const regular = Math.floor(cents / termMonths);
  return Array.from({ length: termMonths }, (_, index) => ({
    number: index + 1,
    amount: (index === termMonths - 1 ? cents - regular * (termMonths - 1) : regular) / 100,
    date: new Date(Date.UTC(
      new Date(`${startDate}T00:00:00Z`).getUTCFullYear(),
      new Date(`${startDate}T00:00:00Z`).getUTCMonth() + index + 1,
      Math.min(new Date(`${startDate}T00:00:00Z`).getUTCDate(), 28)
    )).toISOString().slice(0, 10)
  }));
}

async function createLoan(client, req, data, status = 'ACTIVE') {
  const principal = Number(data.principal);
  const storedRate = await client.query("SELECT value FROM settings WHERE key='monthly_rate'");
  const monthlyRate = Number(data.monthlyRate ?? storedRate.rows[0]?.value ?? 10);
  const termMonths = Number(data.termMonths);
  const startDate = String(data.startDate || '');
  const parsedDate = new Date(`${startDate}T00:00:00Z`);
  const validStartDate = /^\d{4}-\d{2}-\d{2}$/.test(startDate) &&
    !Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === startDate;
  if (!Number.isFinite(principal) || principal <= 0 || principal > 999999999999.99 ||
      !Number.isFinite(monthlyRate) || monthlyRate < 0 || monthlyRate > 100 ||
      !Number.isInteger(termMonths) || termMonths < 1 || termMonths > 120 || !validStartDate) {
    throw fail(400, 'Enter a positive principal, a non-negative monthly rate, a term of 1–120 months, and a start date.');
  }
  const borrower = await client.query('SELECT id FROM borrowers WHERE id = $1', [data.borrowerId]);
  if (!borrower.rows[0]) throw fail(404, 'Borrower not found.');
  const interest = Math.round(principal * (monthlyRate / 100) * termMonths * 100) / 100;
  const totalDue = Math.round((principal + interest) * 100) / 100;
  if (!Number.isFinite(totalDue) || totalDue > 999999999999.99) throw fail(400, 'The calculated total exceeds the supported loan amount.');
  const loanNumber = `AL-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const loan = await client.query(
    `INSERT INTO loans (loan_number, borrower_id, principal, monthly_rate, term_months, interest, total_due, start_date, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [loanNumber, data.borrowerId, principal, monthlyRate, termMonths, interest, totalDue, startDate, status, req.user.id]
  );
  for (const installment of buildInstallments(totalDue, termMonths, data.startDate)) {
    await client.query(
      'INSERT INTO installments (loan_id, installment_number, due_date, amount) VALUES ($1,$2,$3,$4)',
      [loan.rows[0].id, installment.number, installment.date, installment.amount]
    );
  }
  return loan.rows[0];
}

app.get('/api/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok' });
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const result = await pool.query(
    'SELECT id, name, email, password_hash, role, borrower_id, active FROM users WHERE LOWER(email) = $1',
    [email]
  );
  const user = result.rows[0];
  if (!user || !user.active || !(await bcrypt.compare(password, user.password_hash))) {
    await pool.query(
      'INSERT INTO audit_logs (user_id, action, entity_type, details, ip_address) VALUES ($1, $2, $3, $4, $5)',
      [user ? user.id : null, 'LOGIN_FAILED', 'USER', JSON.stringify({ email }), req.ip]
    );
    throw fail(401, 'Email or password is incorrect.');
  }
  const token = jwt.sign(
    { id: user.id, name: user.name, email: user.email, role: user.role, borrowerId: user.borrower_id },
    jwtSecret,
    { expiresIn: process.env.SESSION_TTL || '8h' }
  );
  req.user = { id: user.id };
  await audit(req, 'LOGIN', 'USER', user.id);
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, borrowerId: user.borrower_id } });
}));

app.get('/api/auth/me', auth(), asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT id, name, email, role, borrower_id, privacy_consent_at FROM users WHERE id = $1 AND active = TRUE', [req.user.id]);
  if (!result.rows[0]) throw fail(401, 'This account is no longer active.');
  res.json({ user: result.rows[0] });
}));

app.put('/api/auth/profile', auth(), asyncRoute(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const phone = String(req.body.phone || '').trim();
  if (name.length < 2 || name.length > 160) throw fail(400, 'Name must be between 2 and 160 characters.');
  const result = await pool.query('UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name, email, role, borrower_id', [name, req.user.id]);
  if (req.user.role === 'BORROWER' && req.user.borrowerId) {
    const parts = name.split(/\s+/);
    await pool.query('UPDATE borrowers SET first_name = $1, last_name = $2, phone = $3, updated_at = NOW() WHERE id = $4', [parts[0], parts.slice(1).join(' '), phone, req.user.borrowerId]);
  }
  await audit(req, 'PROFILE_UPDATED', 'USER', req.user.id);
  res.json({ user: result.rows[0] });
}));

app.put('/api/auth/password', auth(), asyncRoute(async (req, res) => {
  const oldPassword = String(req.body.currentPassword || '');
  const newPassword = String(req.body.newPassword || '');
  if (newPassword.length < 10) throw fail(400, 'New password must be at least 10 characters.');
  const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!result.rows[0] || !(await bcrypt.compare(oldPassword, result.rows[0].password_hash))) throw fail(400, 'Current password is incorrect.');
  await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [await bcrypt.hash(newPassword, 12), req.user.id]);
  await audit(req, 'PASSWORD_CHANGED', 'USER', req.user.id);
  res.json({ message: 'Password updated.' });
}));

app.post('/api/auth/privacy-consent', auth(), asyncRoute(async (req, res) => {
  if (req.body.accepted !== true) throw fail(400, 'Consent is required to continue.');
  await pool.query('UPDATE users SET privacy_consent_at = NOW() WHERE id = $1', [req.user.id]);
  await audit(req, 'PRIVACY_CONSENT_ACCEPTED', 'USER', req.user.id);
  res.json({ message: 'Consent recorded.' });
}));

app.get('/api/dashboard', auth(), asyncRoute(async (req, res) => {
  const scoped = req.user.role === 'BORROWER';
  const args = scoped ? [req.user.borrowerId] : [];
  const borrowerFilter = scoped ? 'WHERE l.borrower_id = $1' : '';
  const activeLoanFilter = `${borrowerFilter ? `${borrowerFilter} AND` : 'WHERE'} l.status = 'ACTIVE' AND`;
  if (scoped && !req.user.borrowerId) throw fail(403, 'This account is not linked to a borrower profile.');
  const [borrowerCount, loanCount, amountSummary, dueRows, collections, upcoming, overdue] = await Promise.all([
    scoped ? Promise.resolve({ rows: [{ count: '1' }] }) : pool.query('SELECT COUNT(*)::int AS count FROM borrowers'),
    pool.query(`SELECT COUNT(*)::int AS count FROM loans l ${borrowerFilter} ${scoped ? "AND l.status = 'ACTIVE'" : "WHERE l.status = 'ACTIVE'"}`, args),
    pool.query(`SELECT COALESCE(SUM(i.amount - i.paid_amount),0)::numeric(14,2) AS balance
      FROM installments i JOIN loans l ON l.id=i.loan_id
      ${scoped ? `${borrowerFilter} AND l.status='ACTIVE'` : "WHERE l.status='ACTIVE'"}`, args),
    pool.query(`SELECT COUNT(DISTINCT l.id)::int AS count FROM installments i JOIN loans l ON l.id=i.loan_id
      ${activeLoanFilter} i.due_date=CURRENT_DATE AND i.paid_amount < i.amount`, args),
    pool.query(`SELECT COALESCE(SUM(p.amount),0)::numeric(14,2) AS amount FROM payments p
      ${scoped ? 'WHERE p.borrower_id=$1 AND' : 'WHERE'} date_trunc('month', p.paid_at)=date_trunc('month', CURRENT_DATE)`, args),
    pool.query(`SELECT COUNT(DISTINCT l.id)::int AS count FROM installments i JOIN loans l ON l.id=i.loan_id
      ${activeLoanFilter} i.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
      AND i.paid_amount < i.amount`, args),
    pool.query(`SELECT COUNT(DISTINCT l.id)::int AS count FROM installments i JOIN loans l ON l.id=i.loan_id
      ${activeLoanFilter} i.due_date < CURRENT_DATE AND i.paid_amount < i.amount`, args)
  ]);
  const interest = await pool.query(`SELECT COALESCE(SUM(l.interest),0)::numeric(14,2) AS amount FROM loans l ${borrowerFilter}`, args);
  res.json({
    totalBorrowers: asNumber(borrowerCount.rows[0].count),
    activeLoans: asNumber(loanCount.rows[0].count),
    dueToday: asNumber(dueRows.rows[0].count),
    overdueAccounts: asNumber(overdue.rows[0].count),
    dueThisWeek: asNumber(upcoming.rows[0].count),
    collectionsThisMonth: asNumber(collections.rows[0].amount),
    outstandingBalance: asNumber(amountSummary.rows[0].balance),
    interestIncome: asNumber(interest.rows[0].amount)
  });
}));

app.get('/api/borrowers', auth(['ADMIN', 'COLLECTOR']), asyncRoute(async (req, res) => {
  const search = `%${String(req.query.search || '').trim()}%`;
  const { rows } = await pool.query(
    `SELECT b.*, u.active AS account_active,
       (SELECT COUNT(*)::int FROM loans l WHERE l.borrower_id=b.id) AS loan_count,
       (SELECT COALESCE(SUM(i.amount-i.paid_amount),0)::numeric(14,2) FROM installments i JOIN loans l ON l.id=i.loan_id WHERE l.borrower_id=b.id AND l.status='ACTIVE') AS balance
     FROM borrowers b LEFT JOIN users u ON u.id=b.user_id
     WHERE b.first_name ILIKE $1 OR b.last_name ILIKE $1 OR b.email ILIKE $1
     ORDER BY b.created_at DESC LIMIT 500`,
    [search]
  );
  res.json({ borrowers: rows });
}));

app.post('/api/borrowers', auth(['ADMIN', 'COLLECTOR']), asyncRoute(async (req, res) => {
  const firstName = String(req.body.firstName || '').trim();
  const lastName = String(req.body.lastName || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!firstName || !lastName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, 'Enter the borrower’s first name, last name, and a valid email address.');
  if (password.length < 10) throw fail(400, 'Set a borrower portal password of at least 10 characters.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const createdUser = await client.query(
      `INSERT INTO users (name,email,password_hash,role) VALUES ($1,$2,$3,'BORROWER') RETURNING id`,
      [`${firstName} ${lastName}`, email, await bcrypt.hash(password, 12)]
    );
    const borrower = await client.query(
      `INSERT INTO borrowers (user_id,first_name,last_name,email,phone,address) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [createdUser.rows[0].id, firstName, lastName, email, String(req.body.phone || ''), String(req.body.address || '')]
    );
    await client.query('UPDATE users SET borrower_id=$1 WHERE id=$2', [borrower.rows[0].id, createdUser.rows[0].id]);
    await client.query('COMMIT');
    await audit(req, 'BORROWER_CREATED', 'BORROWER', borrower.rows[0].id);
    res.status(201).json({ borrower: borrower.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') throw fail(409, 'An account with this email address already exists.');
    throw error;
  } finally {
    client.release();
  }
}));

app.put('/api/borrowers/:id', auth(['ADMIN', 'COLLECTOR']), asyncRoute(async (req, res) => {
  const firstName = String(req.body.firstName || '').trim();
  const lastName = String(req.body.lastName || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!firstName || !lastName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw fail(400, 'Enter the borrower’s first name, last name, and a valid email address.');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE borrowers SET first_name=$1,last_name=$2,email=$3,phone=$4,address=$5,updated_at=NOW()
       WHERE id=$6 RETURNING *`,
      [firstName, lastName, email, String(req.body.phone || ''), String(req.body.address || ''), req.params.id]
    );
    if (!rows[0]) throw fail(404, 'Borrower not found.');
    if (rows[0].user_id) await client.query('UPDATE users SET name=$1,email=$2,updated_at=NOW() WHERE id=$3', [`${rows[0].first_name} ${rows[0].last_name}`, rows[0].email, rows[0].user_id]);
    await client.query('COMMIT');
    await audit(req, 'BORROWER_UPDATED', 'BORROWER', req.params.id);
    res.json({ borrower: rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') throw fail(409, 'An account with this email address already exists.');
    throw error;
  } finally {
    client.release();
  }
}));

app.delete('/api/borrowers/:id', auth(['ADMIN']), asyncRoute(async (req, res) => {
  const existing = await pool.query('SELECT user_id FROM borrowers WHERE id=$1', [req.params.id]);
  if (!existing.rows[0]) throw fail(404, 'Borrower not found.');
  const loanCount = await pool.query('SELECT COUNT(*)::int AS count FROM loans WHERE borrower_id=$1', [req.params.id]);
  if (loanCount.rows[0].count) throw fail(409, 'Borrowers with loan records cannot be deleted. Deactivate their portal account instead.');
  await pool.query('DELETE FROM borrowers WHERE id=$1', [req.params.id]);
  if (existing.rows[0].user_id) await pool.query('DELETE FROM users WHERE id=$1', [existing.rows[0].user_id]);
  await audit(req, 'BORROWER_DELETED', 'BORROWER', req.params.id);
  res.json({ message: 'Borrower deleted.' });
}));

app.patch('/api/borrowers/:id/account', auth(['ADMIN']), asyncRoute(async (req, res) => {
  const active = req.body.active === true;
  const result = await pool.query(
    `UPDATE users SET active=$1,updated_at=NOW()
     WHERE borrower_id=$2 AND role='BORROWER' RETURNING id,active`,
    [active, req.params.id]
  );
  if (!result.rows[0]) throw fail(404, 'Borrower portal account not found.');
  await audit(req, active ? 'BORROWER_ACCOUNT_ACTIVATED' : 'BORROWER_ACCOUNT_DEACTIVATED', 'BORROWER', req.params.id);
  res.json({ active: result.rows[0].active });
}));

app.get('/api/loans', auth(), asyncRoute(async (req, res) => {
  const scoped = req.user.role === 'BORROWER';
  const search = `%${String(req.query.search || '').trim()}%`;
  const filters = [];
  const values = [];
  if (scoped) { values.push(req.user.borrowerId); filters.push(`l.borrower_id=$${values.length}`); }
  if (req.query.status && ['ACTIVE', 'CLOSED', 'RENEWED'].includes(req.query.status)) { values.push(req.query.status); filters.push(`l.status=$${values.length}`); }
  values.push(search);
  filters.push(`(l.loan_number ILIKE $${values.length} OR b.first_name ILIKE $${values.length} OR b.last_name ILIKE $${values.length})`);
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT l.*, b.first_name,b.last_name,COALESCE(SUM(i.amount-i.paid_amount),0)::numeric(14,2) AS balance,
      MIN(i.due_date) FILTER (WHERE i.paid_amount<i.amount) AS next_due_date
     FROM loans l JOIN borrowers b ON b.id=l.borrower_id LEFT JOIN installments i ON i.loan_id=l.id
     ${where} GROUP BY l.id,b.id ORDER BY l.created_at DESC LIMIT 500`,
    values
  );
  res.json({ loans: rows });
}));

app.post('/api/loans', auth(['ADMIN', 'COLLECTOR']), asyncRoute(async (req, res) => {
  const loan = await createLoan(pool, req, req.body);
  await audit(req, 'LOAN_CREATED', 'LOAN', loan.id, { loanNumber: loan.loan_number });
  res.status(201).json({ loan });
}));

app.get('/api/loans/:id', auth(), asyncRoute(async (req, res) => {
  const loan = await getLoan(req.params.id, req);
  const [installments, payments] = await Promise.all([
    pool.query('SELECT * FROM installments WHERE loan_id=$1 ORDER BY installment_number', [loan.id]),
    pool.query('SELECT * FROM payments WHERE loan_id=$1 ORDER BY paid_at DESC', [loan.id])
  ]);
  res.json({ loan, installments: installments.rows, payments: payments.rows });
}));

app.post('/api/loans/:id/close', auth(['ADMIN', 'COLLECTOR']), asyncRoute(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM loans WHERE id=$1 FOR UPDATE', [req.params.id]);
    const loan = await getLoan(req.params.id, req, client);
    if (loan.status !== 'ACTIVE') throw fail(409, 'Only active loans can be closed.');
    if (asNumber(loan.balance) > 0.009) throw fail(409, 'A loan must be fully paid before it can be closed.');
    await client.query("UPDATE loans SET status='CLOSED',closed_at=NOW() WHERE id=$1", [loan.id]);
    await client.query('COMMIT');
    await audit(req, 'LOAN_CLOSED', 'LOAN', loan.id);
    res.json({ message: 'Loan closed.' });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}));

app.post('/api/loans/:id/renew', auth(['ADMIN', 'COLLECTOR']), asyncRoute(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM loans WHERE id=$1 FOR UPDATE', [req.params.id]);
    const previous = await getLoan(req.params.id, req, client);
    if (previous.status !== 'ACTIVE') throw fail(409, 'Only active loans can be renewed.');
    const loan = await createLoan(client, req, {
      borrowerId: previous.borrower_id,
      principal: req.body.principal || previous.balance,
      monthlyRate: req.body.monthlyRate ?? previous.monthly_rate,
      termMonths: req.body.termMonths || previous.term_months,
      startDate: req.body.startDate || new Date().toISOString().slice(0, 10)
    });
    await client.query("UPDATE loans SET status='RENEWED',closed_at=NOW() WHERE id=$1", [previous.id]);
    await client.query('COMMIT');
    await audit(req, 'LOAN_RENEWED', 'LOAN', loan.id, { previousLoanId: previous.id });
    res.status(201).json({ loan });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}));

app.get('/api/payments', auth(), asyncRoute(async (req, res) => {
  const scoped = req.user.role === 'BORROWER';
  const values = scoped ? [req.user.borrowerId] : [];
  const { rows } = await pool.query(
    `SELECT p.*, l.loan_number,b.first_name,b.last_name FROM payments p
     JOIN loans l ON l.id=p.loan_id JOIN borrowers b ON b.id=p.borrower_id
     ${scoped ? 'WHERE p.borrower_id=$1' : ''} ORDER BY p.paid_at DESC LIMIT 1000`,
    values
  );
  res.json({ payments: rows });
}));

app.post('/api/payments', auth(['ADMIN', 'COLLECTOR']), asyncRoute(async (req, res) => {
  const amount = Number(req.body.amount);
  const method = String(req.body.paymentMethod || '').trim();
  if (!Number.isFinite(amount) || amount <= 0 || !['CASH', 'BANK_TRANSFER', 'GCASH', 'CHECK', 'OTHER'].includes(method)) {
    throw fail(400, 'Enter a positive payment amount and select a valid payment method.');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM loans WHERE id=$1 FOR UPDATE', [req.body.loanId]);
    const loan = await getLoan(req.body.loanId, req, client);
    if (loan.status !== 'ACTIVE') throw fail(409, 'Payments can only be recorded for active loans.');
    const balance = asNumber(loan.balance);
    if (amount > balance + 0.009) throw fail(400, `Payment exceeds the outstanding balance of ₱${balance.toFixed(2)}.`);
    const receiptNumber = `OR-${new Date().getFullYear()}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const payment = await client.query(
      `INSERT INTO payments (loan_id,borrower_id,receipt_number,amount,remaining_balance,payment_method,reference,received_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [loan.id, loan.borrower_id, receiptNumber, amount, Math.max(0, balance - amount), method, String(req.body.reference || ''), req.user.id]
    );
    let remaining = Math.round(amount * 100);
    const installments = await client.query('SELECT * FROM installments WHERE loan_id=$1 AND paid_amount<amount ORDER BY due_date,installment_number FOR UPDATE', [loan.id]);
    for (const installment of installments.rows) {
      if (remaining <= 0) break;
      const due = Math.round((asNumber(installment.amount) - asNumber(installment.paid_amount)) * 100);
      const allocated = Math.min(remaining, due);
      await client.query('UPDATE installments SET paid_amount=paid_amount+$1 WHERE id=$2', [allocated / 100, installment.id]);
      remaining -= allocated;
    }
    await client.query('COMMIT');
    await audit(req, 'PAYMENT_RECORDED', 'PAYMENT', payment.rows[0].id, { receiptNumber, amount });
    await audit(req, 'RECEIPT_GENERATED', 'PAYMENT', payment.rows[0].id, { receiptNumber });
    res.status(201).json({ payment: payment.rows[0], remainingBalance: Math.max(0, balance - amount) });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}));

app.get('/api/loans/:id/statement', auth(), asyncRoute(async (req, res) => {
  const loan = await getLoan(req.params.id, req);
  const [installments, payments] = await Promise.all([
    pool.query('SELECT installment_number,due_date,amount,paid_amount FROM installments WHERE loan_id=$1 ORDER BY installment_number', [loan.id]),
    pool.query('SELECT receipt_number,amount,payment_method,paid_at FROM payments WHERE loan_id=$1 ORDER BY paid_at', [loan.id])
  ]);
  await audit(req, 'STATEMENT_VIEWED', 'LOAN', loan.id);
  res.json({ loan, installments: installments.rows, payments: payments.rows });
}));

app.get('/api/receipts/:id', auth(), asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT p.*,l.loan_number,b.first_name,b.last_name,b.email FROM payments p
     JOIN loans l ON l.id=p.loan_id JOIN borrowers b ON b.id=p.borrower_id WHERE p.id=$1`,
    [req.params.id]
  );
  const receipt = result.rows[0];
  if (!receipt) throw fail(404, 'Receipt not found.');
  await borrowerScope(req, receipt.borrower_id);
  await audit(req, 'RECEIPT_VIEWED', 'PAYMENT', receipt.id);
  res.json({ receipt });
}));

app.get('/api/reports', auth(['ADMIN', 'COLLECTOR']), asyncRoute(async (req, res) => {
  const from = req.query.from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
  const to = req.query.to || new Date().toISOString().slice(0, 10);
  const [collections, outstanding, overdue, interest] = await Promise.all([
    pool.query(`SELECT p.paid_at::date AS date,COUNT(*)::int AS payment_count,SUM(p.amount)::numeric(14,2) AS collected
      FROM payments p WHERE p.paid_at::date BETWEEN $1 AND $2 GROUP BY p.paid_at::date ORDER BY date DESC`, [from, to]),
    pool.query(`SELECT b.id,b.first_name,b.last_name,l.loan_number,SUM(i.amount-i.paid_amount)::numeric(14,2) AS balance
      FROM installments i JOIN loans l ON l.id=i.loan_id JOIN borrowers b ON b.id=l.borrower_id
      WHERE l.status='ACTIVE' AND i.paid_amount<i.amount GROUP BY b.id,l.id ORDER BY balance DESC`),
    pool.query(`SELECT b.first_name,b.last_name,l.loan_number,MIN(i.due_date) AS oldest_due,
      SUM(i.amount-i.paid_amount)::numeric(14,2) AS overdue_balance
      FROM installments i JOIN loans l ON l.id=i.loan_id JOIN borrowers b ON b.id=l.borrower_id
      WHERE l.status='ACTIVE' AND i.due_date<CURRENT_DATE AND i.paid_amount<i.amount
      GROUP BY b.id,l.id ORDER BY oldest_due`),
    pool.query(`SELECT COALESCE(SUM(interest),0)::numeric(14,2) AS expected_interest,
      COALESCE(SUM(interest) FILTER (WHERE date_trunc('month',created_at)=date_trunc('month',CURRENT_DATE)),0)::numeric(14,2) AS this_month
      FROM loans`)
  ]);
  await audit(req, 'REPORTS_VIEWED', 'REPORT', null, { from, to });
  res.json({ from, to, collections: collections.rows, outstanding: outstanding.rows, overdue: overdue.rows, interest: interest.rows[0] });
}));

app.get('/api/settings', auth(['ADMIN', 'COLLECTOR']), asyncRoute(async (_req, res) => {
  const { rows } = await pool.query('SELECT key,value FROM settings ORDER BY key');
  res.json({ settings: Object.fromEntries(rows.map((row) => [row.key, row.value])) });
}));

app.put('/api/settings', auth(['ADMIN']), asyncRoute(async (req, res) => {
  const monthlyRate = Number(req.body.monthly_rate);
  const penaltyRate = Number(req.body.penalty_rate);
  if (!Number.isFinite(monthlyRate) || monthlyRate < 0 || monthlyRate > 100 ||
      !Number.isFinite(penaltyRate) || penaltyRate < 0 || penaltyRate > 100) {
    throw fail(400, 'Monthly interest and penalty rates must be between 0 and 100 percent.');
  }
  for (const [key, value] of Object.entries({ monthly_rate: monthlyRate, penalty_rate: penaltyRate })) {
    await pool.query(
      'INSERT INTO settings (key,value,updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()',
      [key, JSON.stringify(value)]
    );
  }
  await audit(req, 'SETTINGS_UPDATED', 'SETTINGS', null, { monthlyRate, penaltyRate });
  res.json({ settings: { monthly_rate: monthlyRate, penalty_rate: penaltyRate } });
}));

app.get('/api/users', auth(['ADMIN']), asyncRoute(async (_req, res) => {
  const { rows } = await pool.query("SELECT id,name,email,role,active,created_at FROM users WHERE role IN ('ADMIN','COLLECTOR') ORDER BY created_at DESC");
  res.json({ users: rows });
}));

app.post('/api/users', auth(['ADMIN']), asyncRoute(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = String(req.body.role || '');
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10 || !['ADMIN', 'COLLECTOR'].includes(role)) {
    throw fail(400, 'Provide a name, valid email, password of at least 10 characters, and ADMIN or COLLECTOR role.');
  }
  try {
    const { rows } = await pool.query(
      'INSERT INTO users (name,email,password_hash,role) VALUES ($1,$2,$3,$4) RETURNING id,name,email,role,active,created_at',
      [name, email, await bcrypt.hash(password, 12), role]
    );
    await audit(req, 'USER_CREATED', 'USER', rows[0].id, { role });
    res.status(201).json({ user: rows[0] });
  } catch (error) {
    if (error.code === '23505') throw fail(409, 'An account with this email address already exists.');
    throw error;
  }
}));

app.patch('/api/users/:id', auth(['ADMIN']), asyncRoute(async (req, res) => {
  if (req.params.id === req.user.id) throw fail(400, 'You cannot deactivate your own account.');
  const { rows } = await pool.query('UPDATE users SET active=$1,updated_at=NOW() WHERE id=$2 RETURNING id,name,email,role,active', [Boolean(req.body.active), req.params.id]);
  if (!rows[0]) throw fail(404, 'User not found.');
  await audit(req, rows[0].active ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', 'USER', req.params.id);
  res.json({ user: rows[0] });
}));

app.get('/api/audit-logs', auth(['ADMIN']), asyncRoute(async (req, res) => {
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 500));
  const { rows } = await pool.query(
    `SELECT a.*,u.name AS user_name,u.email AS user_email FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
     ORDER BY a.created_at DESC LIMIT $1`,
    [limit]
  );
  res.json({ logs: rows });
}));

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, uploadRoot),
  filename: (_req, file, callback) => callback(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
});
const uploader = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png'];
    callback(allowed.includes(file.mimetype) ? null : fail(400, 'Only PDF, JPG, and PNG documents are accepted.'), allowed.includes(file.mimetype));
  }
});

app.post('/api/borrowers/:id/documents/:type', auth(['ADMIN', 'COLLECTOR']), uploader.single('document'), asyncRoute(async (req, res) => {
  if (!['id', 'contract'].includes(req.params.type)) throw fail(400, 'Document type must be id or contract.');
  if (!req.file) throw fail(400, 'Choose a document to upload.');
  const column = req.params.type === 'id' ? 'id_document_path' : 'contract_path';
  const result = await pool.query(`UPDATE borrowers SET ${column}=$1,updated_at=NOW() WHERE id=$2 RETURNING id`, [req.file.filename, req.params.id]);
  if (!result.rows[0]) throw fail(404, 'Borrower not found.');
  await audit(req, 'DOCUMENT_UPLOADED', 'BORROWER', req.params.id, { type: req.params.type });
  res.status(201).json({ message: 'Document uploaded.' });
}));

app.get('/api/borrowers/:id/documents/:type', auth(), asyncRoute(async (req, res) => {
  const borrower = await pool.query('SELECT id,id_document_path,contract_path FROM borrowers WHERE id=$1', [req.params.id]);
  if (!borrower.rows[0]) throw fail(404, 'Borrower not found.');
  await borrowerScope(req, borrower.rows[0].id);
  if (!['id', 'contract'].includes(req.params.type)) throw fail(400, 'Document type must be id or contract.');
  const filename = req.params.type === 'id' ? borrower.rows[0].id_document_path : borrower.rows[0].contract_path;
  if (!filename) throw fail(404, 'No document has been uploaded for this borrower.');
  const target = path.resolve(uploadRoot, filename);
  if (!target.startsWith(`${uploadRoot}${path.sep}`)) throw fail(400, 'Invalid document path.');
  res.download(target);
}));

app.use((error, _req, res, _next) => {
  if (res.headersSent) return;
  const status = error.status || (error.code === '23505' ? 409 : 500);
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status >= 500 ? 'An unexpected server error occurred.' : error.message });
});

app.listen(port, () => console.log(`ALIVIO API listening on port ${port}`));
