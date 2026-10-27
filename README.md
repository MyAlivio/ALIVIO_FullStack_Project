# ALIVIO Lending Management System

ALIVIO V1 is a responsive Next.js borrower/admin portal backed by an Express API and PostgreSQL. It includes role-scoped borrower access, loan and installment tracking, payment receipts, printable statements, reports, user administration, document uploads, and audit events.

## Included in this V1

- Roles: `ADMIN`, `COLLECTOR`, and `BORROWER`; borrowers can only access their own loans, payments, receipts, and uploaded documents.
- JWT authentication with bcrypt password hashes and configurable token lifetime.
- Borrower records, portal accounts, loan creation/renewal/closure, simple-interest computation, and monthly installment schedules.
- Payment allocation against the oldest unpaid installments, unique official receipt numbers, printable receipts, and printable/downloadable-as-PDF SOAs (use the browser's Print → Save as PDF).
- Dashboard figures, daily collections, outstanding and overdue reports, CSV export, audit history, user activation/deactivation, and settings.
- Borrower ID/contract upload (PDF, JPG, PNG; 5 MB max), profile/password updates, and recorded data-privacy consent.

## Requirements

- Node.js 20 or later
- PostgreSQL 14 or later

## Local development

1. Create a PostgreSQL database named `alivio`.
2. Copy `backend/.env.example` to `backend/.env`, then set `DATABASE_URL` and a cryptographically random `JWT_SECRET` of at least 32 characters. Keep `.env` private.
3. Apply the schema and create the first administrator:

   ```powershell
   cd backend
   npm install
   npm run db:migrate
   $env:ADMIN_EMAIL = "admin@example.com"
   $env:ADMIN_PASSWORD = "use-a-unique-password-of-at-least-12-characters"
   npm run db:seed
   npm run dev
   ```

   `db:seed` does not overwrite an existing account. To set the initial administrator's name, set `ADMIN_NAME` before seeding.

4. In another terminal, copy `frontend/.env.example` to `frontend/.env.local`, then run:

   ```powershell
   cd frontend
   npm install
   npm run dev
   ```

5. Open `http://localhost:3000`. The API health check is at `http://localhost:5000/api/health`.

The `UPLOAD_DIR` defaults to `backend/uploads`; use persistent private storage in production. Do not commit environment files or borrower documents.

## Deployment outline

- **Database:** Create a private PostgreSQL service on Railway and apply `database_schema.sql` using `npm run db:migrate`.
- **API:** Deploy the repository as a Railway Node service, with the repository root as its working directory. Set the build command to `npm --prefix backend install --omit=dev` and the start command to `npm --prefix backend start`. Configure `DATABASE_URL`, `PGSSL=true` as appropriate for the provider, `JWT_SECRET`, `FRONTEND_ORIGIN` (the deployed Vercel origin), and a persistent volume mounted at `UPLOAD_DIR` (for example `/app/backend/uploads`). The repository root must be present because the migration script applies `database_schema.sql` from there.
- **Admin account:** Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` as Railway variables and run `npm --prefix backend run db:migrate`, then `npm --prefix backend run db:seed` once from the service or a one-off job. Remove the seed password variables after provisioning.
- **Web:** Import `frontend/` into Vercel and configure `NEXT_PUBLIC_API_URL` to the Railway API URL ending in `/api`. Redeploy when this build-time variable changes.
- **CORS:** Set `FRONTEND_ORIGIN` to the exact production web origin. For preview deployments, explicitly include approved origins as a comma-separated list.
- **Operations:** Back up PostgreSQL and private document storage, rotate secrets, enable TLS, and configure monitoring before inviting borrowers.

## Loan computation

Interest is simple monthly interest, not compounding:

`interest = principal × (monthly_rate / 100) × term_months`

The total payable is principal plus interest, divided into equal monthly installments (with any rounding remainder assigned to the final installment). For example, PHP 50,000 at 10% monthly for 3 months yields PHP 15,000 interest and PHP 65,000 total due.

## API roles

- `ADMIN`: all management features, settings, users, reports, and audit log.
- `COLLECTOR`: borrower, loan, payment, and report operations.
- `BORROWER`: own dashboard, loans/SOA, payment history/receipts, profile, and own documents.

## V1 boundaries

- Printable statements and receipts can be saved as PDF from the browser; server-side PDF generation and email delivery are not configured.
- The penalty percentage is stored as an administrative setting; automatic penalty accrual and penalty collection are not enabled in this V1.
- Uploads are stored on the API host's configured persistent disk. Use private object storage and malware scanning for a larger production rollout.
- This starter provides basic operational lending workflows, not legal, accounting, credit-bureau, or regulatory certification. Have disclosures, consent text, retention, and lending practices reviewed for the institution's jurisdiction before production use.
