# Multi-Vendor Marketplace

## Project structure

- `backend/` contains the Express server, routes, controllers, services, middleware, and SQLite database.
- `frontend/` contains the EJS views and static assets served by Express.
- `package.json` and `.env` stay at the project root.

## Run locally

1. Install dependencies with `npm install`.
2. Configure the required values in `.env` (copy `.env.example` as a starting point).
3. Start the server with `npm start`.

The development server can be started with `npm run dev`.

## Deploy to Render

This app uses SQLite and stores uploaded product images, seller logos, and private refund evidence on disk. Deploy it as a **Blueprint** from this repository using `render.yaml`. The Blueprint provisions a Starter web service and a persistent disk mounted at `/var/data`; the free web-service plan does not provide persistent disks.

When Render prompts for environment values, provide:

- `ADMIN_EMAIL` and `ADMIN_PASSWORD` for the first administrator (password must be at least 12 characters).
- `MFA_ENCRYPTION_KEY`, generated with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

Render generates `SESSION_SECRET`. The database, session store, backups, and uploaded files are configured to use the persistent disk. Set `APP_BASE_URL` only when using a custom domain; otherwise the app uses Render's external URL.

Email verification and password recovery require working SMTP credentials. Google sign-in and M-Pesa payments are optional; add their credentials when enabling those integrations. For Google OAuth, register `https://<your-service>.onrender.com/auth/google/callback` as an authorized redirect URI. Set `MPESA_CALLBACK_URL` to `https://<your-service>.onrender.com/api/payments/mpesa/callback` and generate a URL-safe `MPESA_CALLBACK_TOKEN` with at least 32 characters.

After deployment, Render checks `/healthz`. The service must stay at one instance because SQLite and a Render disk are not suitable for multiple app instances.
