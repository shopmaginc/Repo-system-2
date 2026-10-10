# Deploying repo-system — the free stack ($0/month)

This guide takes the system from this repo to a live, working deployment
using only free tiers: **Neon** (database), **Render** (API), **Cloudflare
Pages** (field app), **Cloudflare R2** (photo/file storage). No credit card
is required for any of them.

Every step is marked **👤 CRAIG** (needs you — an account signup or pasting
a secret) or **🤖 JARVIS** (I can do it or it's automatic). Nothing here
sends anything to clients or costs money.

## What gets created

| Piece | Provider | Free tier | What it does |
|---|---|---|---|
| Database | Neon | 0.5 GB Postgres, no card | All case data |
| API | Render | Web service, sleeps when idle (~30–60 s cold start on first hit of the day) | The backend |
| Field app | Cloudflare Pages | Unlimited bandwidth | The mobile app your team opens |
| File storage | Cloudflare R2 | 10 GB, no card | Case photos, scans, message attachments (private bucket — files are only ever served through the API's login-protected endpoints) |

## Step 0 — Code on GitHub

**👤 CRAIG:** Create a free GitHub account (if you don't have one), then
create a new **private** repository called `repo-system`. **🤖 JARVIS:**
pushes this code to it once the repo exists — just say the word and hand
over the repo URL.

## Step 1 — Neon: the database (5 minutes)

**👤 CRAIG:**
1. Sign up at [neon.tech](https://neon.tech) (free, no card).
2. Create a project (name it `repo-system`, region: US East).
3. Open the project dashboard → **Connection Details**. Copy the
   **connection string** (it looks like
   `postgresql://user:password@ep-xxx.us-east-2.aws.neon.tech/dbname?sslmode=require`).
4. Keep that string handy — you paste it into Render in Step 3.

> Migrations `0001`–`0005` ship in `apps/api/prisma/migrations/`.
> `0003`–`0005` were hand-written (no live Postgres where they were built),
> so the first Render deploy is also the migration test: if
> `prisma migrate deploy` fails, the deploy stops and the log shows the
> exact SQL line to fix. Nothing half-applied ever goes live.

## Step 2 — Cloudflare: R2 bucket for files (10 minutes)

**👤 CRAIG:**
1. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com) (free, no card).
2. Left sidebar → **R2** → **Create bucket**. Name it `repo-system-uploads`.
   (Leave all defaults; the bucket stays private.)
3. Still in R2 → **Manage R2 API Tokens** → **Create API Token**:
   - Permissions: **Object Read & Write**
   - Scope: **Apply to specific buckets** → `repo-system-uploads`
   - Create it and copy the three values it shows **once**:
     - Account ID
     - Access Key ID
     - Secret Access Key
4. Your S3 endpoint is: `https://<ACCOUNT-ID>.r2.cloudflarestorage.com`
   (replace `<ACCOUNT-ID>` with the Account ID from step 3).

**🤖 JARVIS:** The API already speaks S3/R2 — no code changes needed.

## Step 3 — Render: the API via blueprint (10 minutes)

**👤 CRAIG:**
1. Sign up at [render.com](https://render.com) (free, no card).
2. **New → Blueprint**, connect your GitHub, pick the `repo-system` repo.
   Render reads `render.yaml` at the repo root and creates the web service.
3. When Render asks for the `sync: false` values, paste:
   - `DATABASE_URL` ← the Neon connection string from Step 1
   - `S3_ENDPOINT` ← `https://<ACCOUNT-ID>.r2.cloudflarestorage.com`
   - `S3_BUCKET` ← `repo-system-uploads`
   - `S3_ACCESS_KEY_ID` ← from Step 2
   - `S3_SECRET_ACCESS_KEY` ← from Step 2
   - `SEED_ADMIN_EMAIL` ← **your** email (this becomes your manager login)
   - `SEED_ADMIN_PASSWORD` ← a strong password, 12+ characters
   - `SEED_ADMIN_NAME` ← your name (optional)
   - Leave `CORS_ORIGIN` empty for now — you set it in Step 4.
   - `JWT_SECRET` is generated for you automatically.
4. Hit **Deploy**. The pre-deploy step runs the database migrations and the
   production seed (operational data only — no demo accounts, no demo cases).
   Watch the deploy log for: `Created initial manager account: <your email>`.

**🤖 JARVIS:** `render.yaml` is already in the repo root and wired for the
free plan — build, start, migrations, and seed all run automatically.

## Step 4 — Delete the bootstrap secrets, then the field app

**👤 CRAIG** (do this right after the first successful deploy):
1. In Render → your service → **Environment**: **delete**
   `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, and `SEED_ADMIN_NAME`.
   (They've done their job — your login now lives in the database.)
2. Hit **Manual Deploy → Deploy latest commit** so the running service no
   longer carries them.
3. Copy your API's public URL from the top of the Render dashboard
   (e.g. `https://repo-system-api.onrender.com`). Verify it:
   open `<that-url>/health` in a browser — you should see `{"status":"ok"}`.

**👤 CRAIG** — Cloudflare Pages (the field app):
1. In the Cloudflare dashboard → **Workers & Pages** → **Create** →
   **Pages** → **Connect to Git** → pick the `repo-system` repo.
2. Project settings:
   - **Root directory:** `apps/field`
   - **Build command:** `npm install --include=dev && npm run build`
     (`--include=dev` because the build tool itself is a devDependency)
   - **Build output directory:** `dist`
3. **Environment variables** (Production): add
   `VITE_API_URL` = your Render API URL from above
   (e.g. `https://repo-system-api.onrender.com` — no trailing slash).
4. Deploy. You get a `*.pages.dev` URL — that's the app your team opens
   on their phones (add it to the home screen; it installs as a PWA).
5. Back in **Render → Environment**: set `CORS_ORIGIN` to that
   `*.pages.dev` URL and redeploy. (This locks the API to your app's
   origin instead of accepting any.)

> The app uses hash-based routing (`#/map`, `#/comms`), so Pages needs no
> redirect rules — every route serves `index.html` naturally.

## Step 5 — Smoke test (15 minutes, **👤 CRAIG** with **🤖 JARVIS** on call)

1. Open the Pages URL → log in with your `SEED_ADMIN_EMAIL` + password.
   - If the Render free service is asleep, the first login takes ~30–60 s.
     That's the free-tier cold start, not a bug.
2. **Admin → users**: create one test agent user. Log in as them on your
   phone — confirm they see only the field workspace, no manager screens.
3. As the agent: open the demo flow — check in, add a note, upload a photo.
   Then check the **R2 bucket** in Cloudflare — the file should be there
   under a random name (never the original filename).
4. As manager: open the review queue, approve the photo's document, and
   confirm the invoice gate still blocks until evidence is complete.
5. Suspend the test agent (**Admin → users → suspend**), then try to use
   the app as them — every request should fail immediately. Reinstate after.
6. Delete the test data, or leave it — your call.

## Ongoing

- **Deploys:** every push to GitHub's main branch redeploys Render and Pages
  automatically. Migrations run before the API restarts.
- **Backups:** Neon free tier includes point-in-time recovery on a short
  window — for real safety, set a weekly `pg_dump` reminder once live
  cases are in it. (Say the word and I'll write the one-liner.)
- **Logs:** Render dashboard → Logs shows API errors; nothing sensitive is
  ever logged (no passwords, no message bodies, no PII in upload paths).
- **Client emails:** the in-app email flow records sends but does not
  deliver yet — real SMTP config is still an open deploy item. Don't
  promise clients email delivery until that's wired.

## Later: the $5/month step (when the free API's naps get annoying)

When the team is on it daily and the ~30–60 s cold start after 15 idle
minutes gets old:

1. Sign up at [railway.app](https://railway.app) → **Hobby plan ($5/mo)**.
2. New project → deploy the API from the same GitHub repo; add the
   **Postgres** plugin (data migrates with one `pg_dump`/`pg_restore`).
3. Copy the same env vars over (DATABASE_URL now points at Railway
   Postgres; S3 vars stay exactly as-is — R2 doesn't move).
4. Update `VITE_API_URL` in Cloudflare Pages and `CORS_ORIGIN` in Railway
   to the new API URL. Pages + R2 stay free.
5. Delete the Render service.

Total then: **$5/mo** (Railway) + $0 (Pages, R2, and Neon is retired).
Same code, same repo — only the env values change, because every
provider-specific detail lives behind environment variables.

## What I could not verify without real accounts

- The actual Neon signup/connection-string format (documented from Neon's
  public docs; the `?sslmode=require` form is standard).
- The Render Blueprint first-deploy flow (blueprint schema follows Render's
  documented spec; `preDeployCommand` runs migrations + seed before traffic).
- The Cloudflare Pages build from a monorepo subdirectory (standard Pages
  feature: root directory + build command + output dir).
- R2 API token permission names (from Cloudflare's documented R2 token flow).
- Hand-written migrations `0003`–`0005` against a real Postgres — the first
  Render deploy is the validation gate; if one fails, the deploy log names
  the statement and I fix it before anything serves traffic.
