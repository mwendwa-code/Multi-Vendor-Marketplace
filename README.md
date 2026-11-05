# Multi-Vendor Marketplace

## Project structure

- `backend/` contains the Express server, routes, controllers, services, middleware, and PostgreSQL schema.
- `frontend/` contains the EJS views and static assets served by Express.
- `package.json` and `.env` stay at the project root.

## Run locally

1. Install Node.js 22 or newer and PostgreSQL, then start the PostgreSQL service.
2. Create a local database, for example with `createdb marketplace_db`, or connect with `psql` and run `CREATE DATABASE marketplace_db;`.
3. Install the app dependencies with `npm install`.
4. Copy `.env.example` to `.env` and set `DATABASE_URL` to your PostgreSQL connection string:

   ```text
   DATABASE_URL=postgresql://<db-user>:<db-password>@localhost:5432/marketplace_db
   ```

   Replace the placeholders with your local PostgreSQL credentials. If your password contains URL-reserved characters, URL-encode them. To create an administrator automatically on first startup, also set `ADMIN_EMAIL` and `ADMIN_PASSWORD` (at least 12 characters).
5. Start the app with `npm start` and open `http://localhost:3000`. On startup, the app creates or updates its PostgreSQL tables.

The development server can be started with `npm run dev`.

## Deploy to Render

This app uses PostgreSQL for marketplace data and sessions. Uploaded product images, seller logos, private refund evidence, and database backup exports remain on the persistent disk mounted at `/var/data`. Deploy it as a **Blueprint** from this repository using `render.yaml`; the Blueprint provisions the web service, PostgreSQL database, and persistent disk. The Blueprint currently selects Render's free PostgreSQL plan, which is limited and expires after its free retention period. Upgrade the database plan in Render before relying on it for production data.

Administrator sign-in uses an email and password; multi-factor authentication is disabled. Use a strong, unique administrator password.

When Render prompts for environment values, provide:

- `ADMIN_EMAIL` and `ADMIN_PASSWORD` for the first administrator (password must be at least 12 characters).

Render supplies `DATABASE_URL` from the PostgreSQL service and generates `SESSION_SECRET`. For local development, create a PostgreSQL database and set `DATABASE_URL` in `.env`.

To migrate an existing SQLite marketplace database, take the app offline, create a new empty PostgreSQL database, set `DATABASE_URL` and (if needed) `SQLITE_MIGRATION_PATH`, then run `npm run migrate:sqlite -- --confirm` from the project root. The command refuses non-empty PostgreSQL tables and reports row counts without displaying record contents. Keep the SQLite database and its uploads as a backup until the migration is verified.

The importer skips legacy MFA enrollment and recovery-code tables because administrator MFA is no longer used.

The admin backup feature creates JSON exports of PostgreSQL tables on the persistent disk. Set `APP_BASE_URL` only when using a custom domain; otherwise the app uses Render's external URL.

Email verification and password recovery require working SMTP credentials. Google sign-in and M-Pesa payments are optional; add their credentials when enabling those integrations. For Google OAuth, register `https://<your-service>.onrender.com/auth/google/callback` as an authorized redirect URI. Set `MPESA_CALLBACK_URL` to `https://<your-service>.onrender.com/api/payments/mpesa/callback` and generate a URL-safe `MPESA_CALLBACK_TOKEN` with at least 32 characters.

After deployment, Render checks `/healthz`. Use a single web instance when relying on the local persistent disk for uploaded files and backup exports.
