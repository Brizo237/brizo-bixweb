# BixTech: social login (Google, Apple, GitHub, Facebook, Microsoft)

## Why you saw "Social sign-in needs the BixTech server"

The buttons talk to a small login server (`server.js`). The message appears when the page can't reach it, which happens when you:

- double-click `index.html` (address starts with `file://`), or
- open it with a static tool (VS Code *Live Server*, GitHub Pages, Netlify drop, etc.), or
- have not started `node server.js`.

The website and the login server are **one program**, so there is no separate "frontend server". The page now tells you which of these happened, and also warns if you are on the wrong address (for example `127.0.0.1` instead of `localhost`), because the provider can only send you back to the address you registered.

## Start it locally (the only commands you need)

Install Node.js 18+ from https://nodejs.org once, then, inside this folder:

```
node setup.js        # first time only: creates .env with a secret key
node server.js       # starts website + login server
```

Open **http://localhost:3000** (not a file, not Live Server). Stop with Ctrl+C.

On start, the terminal tells you for every provider whether it is `READY` or which variables are missing, plus the exact callback URL to register. Clicking a provider that isn't set up shows "That sign-in method isn't set up yet", never a fake success.

Check it's alive: http://localhost:3000/healthz should show `{"ok":true}`.

## Credentials you must create (I can't do this for you)

Put each value in `.env`. Register the callback URL **exactly** (shown for local testing; swap in your https address when you deploy).

| Provider | Variables to fill in `.env` | Where to create them | Callback URL |
|---|---|---|---|
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | console.cloud.google.com → APIs & Services → OAuth consent screen, then Credentials → OAuth client ID → *Web application* | `http://localhost:3000/auth/google/callback` |
| GitHub | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | github.com/settings/developers → New OAuth App | `http://localhost:3000/auth/github/callback` |
| Facebook | `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` | developers.facebook.com → Create App → add *Facebook Login* → Valid OAuth Redirect URIs | `http://localhost:3000/auth/facebook/callback` |
| Microsoft | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` (+ `MICROSOFT_TENANT=common`) | entra.microsoft.com → App registrations → New (Web redirect URI) → Certificates & secrets → copy the secret **Value** | `http://localhost:3000/auth/microsoft/callback` |
| Apple | `APPLE_CLIENT_ID` (Services ID), `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` | developer.apple.com (paid account): App ID, Services ID with Sign in with Apple, a Key (.p8) | `https://YOUR-HTTPS-ADDRESS/auth/apple/callback` |

Notes: Apple refuses `localhost`, so test it only after deploying with https. Facebook apps in Development mode accept only you and added testers. Start with Google or GitHub, which are the quickest.

## One-tap sign-in for students (email code + Face ID)

Students no longer fill in a long form. The screen offers the five provider buttons, a **Face ID** button (shown on devices that support it), and **a 6-digit code sent to their email**. The first sign-in creates the account automatically.

**Email codes need a free Brevo account (about 10 minutes):**
1. Sign up at brevo.com (free plan: 300 emails a day).
2. Open **Senders, Domains & Dedicated IPs → Senders → Add a sender**. Use an email address you own and click the verification link Brevo emails you.
3. Open **SMTP & API → API Keys → Generate a new API key** and copy it.
4. In Render, **Environment**, add `BREVO_API_KEY` (the key) and `MAIL_FROM` (the sender address you verified). Save.
A Gmail sender can land in the recipients' spam folder. Your own domain with Brevo's DNS records delivers better. WhatsApp codes are not included: they need Meta's WhatsApp Business API, which is not free or quick to set up.

**Face ID / fingerprint (passkeys)** needs no credentials. After a student signs in once (provider or email code), they tap **Enable Face ID** at the top of the app. Next time, **Sign in with Face ID** works with one look. It works on iPhone (Safari or Chrome), Android and modern laptops, over https only, and not inside in-app browsers such as the Facebook or Instagram browser. Passkeys belong to the website address: if you move to a new address (for example bixtech.cm), students enable Face ID again.

**Keep accounts and Face ID permanently (free, Upstash):** a free host wipes its disk when it restarts, which would erase saved Face IDs. Make a free account at upstash.com, create a **Redis** database, copy its **REST URL** and **REST Token**, and add them in Render as `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. I tested this storage against a stand-in, not against Upstash itself, so check that a Face ID survives a restart after you set it up.

The old email-and-password form still exists under "Sign in with a password instead", so existing password accounts keep working. The Register tab is gone.

## Free hosting that works today: Render (no Google account needed)

Render's free plan runs this server. Most sources say no card is needed, though one reports a small card check, so just try it. Limits you should accept: the site **sleeps after 15 minutes without visitors** and takes about a minute to wake up, and its disk is wiped on every sleep (logins use signed cookies, so they survive; the small server-side account list does not, and people simply sign in again). That sleep also makes it a poor fit for Google search visibility later. A paid instance (about $7/month) removes it.

1. Make a free account at github.com. Create a **New repository** (name it `bixtech`, Public or Private).
2. On the repository page click **uploading an existing file** and drag in everything inside the `bixtech-auth` folder: `public`, `server.js`, `package.json`, `render.yaml`, `setup.js`, `.env.example`, `.gitignore`. **Do not upload `.env` or `data`.** Click **Commit changes**.
3. Make a free account at render.com (sign in with GitHub). Click **New → Blueprint**, pick your `bixtech` repository, and click **Apply**. Render creates the service and generates `SESSION_SECRET` for you.
4. When the deploy shows **Live**, open the `https://bixtech-xxxx.onrender.com` address at the top of the service page. Add `/healthz` to the address: it should show `{"ok":true}`.
5. The site and email login now work. For social login, create the provider keys (table above) using `https://YOUR-ADDRESS.onrender.com/auth/<provider>/callback`, then in Render open the service, **Environment**, add the variables (for Google: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`) and save. Render restarts it.

## Get BixTech found on Google (free, step by step)

Honest expectations first: nobody can make Google show a site on demand. After you submit it, Google usually needs from a few days to a few weeks to index a new site, and where it ranks depends on competition (other companies are also called BixTech). A free `onrender.com` address ranks weaker than your own domain. Until it shows up, **give students the direct link** (WhatsApp, flyers, posters). Do not tell anyone it is on Google until you have checked (step 9).

Your page already contains the search tags (title, description, canonical address, share image, favicon from your logo, Organization and WebSite data), and the server publishes `/robots.txt` and `/sitemap.xml` for whatever address it runs on.

**Before you submit: keep the site awake.** On Render's free plan a sleeping site answers Google's robots.txt request with "do not crawl", which blocks indexing. So:
1. Make a free account at uptimerobot.com, click **Add New Monitor**, type **HTTP(s)**, URL `https://YOUR-ADDRESS.onrender.com/healthz`, interval **5 minutes**. This keeps the site awake. It uses nearly all of Render's 750 free hours a month, so run only this one service there.

**Submit to Google Search Console**
2. Go to https://search.google.com/search-console and sign in with a Google account.
3. Click **Add property**, choose **URL prefix**, paste `https://YOUR-ADDRESS.onrender.com/` and continue.
4. Pick the verification method **HTML tag**. Google shows a line like `<meta name="google-site-verification" content="LONG-CODE">`. Copy only the LONG-CODE.
5. In Render open your service, **Environment**, add `GOOGLE_SITE_VERIFICATION` = LONG-CODE, **Save**. Wait until it says Live again.
6. Back in Search Console click **Verify**.
7. Left menu **Sitemaps**, type `sitemap.xml`, click **Submit**. It should say "Success".
8. Left menu **URL inspection**, paste `https://YOUR-ADDRESS.onrender.com/`, press Enter, then click **Request indexing**.
9. Check after a few days: search Google for `site:YOUR-ADDRESS.onrender.com`. If your page appears, it is indexed. In Search Console the **Pages** report lists any problems.

**When you buy your own domain later** (for example bixtech.cm): connect it in Render (service, Settings, Custom Domains), add the new address as a new Search Console property, and update the callback URLs at every login provider.

## Free hosting on Google (Cloud Run)

Honest summary of cost: Cloud Run has a free monthly allowance (roughly 2 million requests plus some compute time; check the current numbers on Google's pricing page) that a small site normally stays inside, **but Google requires a billing account with a card on file even for the free tier**. Firebase Hosting alone is not enough, because it can't run the login server. Set a budget alert (Billing → Budgets & alerts) so you are warned about any charge.

I could not deploy to your Google account from here, so these commands are untested against your project. Run them in the Google Cloud Shell (cloud.google.com/shell) or after installing the `gcloud` CLI.

**1. One-time setup** (replace `YOUR_PROJECT_ID`)

```
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```

**2. A storage bucket so accounts survive restarts** (Cloud Run's own disk is wiped; a small bucket in a US region fits the free storage allowance)

```
gcloud storage buckets create gs://YOUR_PROJECT_ID-bixtech-data --location=us-central1
PROJECT_NUMBER=$(gcloud projects describe YOUR_PROJECT_ID --format='value(projectNumber)')
gcloud storage buckets add-iam-policy-binding gs://YOUR_PROJECT_ID-bixtech-data \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" --role=roles/storage.objectUser
```

**3. Create `env.yaml`** (never commit it; it is in `.gcloudignore`). Your site's address on Cloud Run is `https://bixtech-PROJECT_NUMBER.us-central1.run.app` (confirm after step 4):

```yaml
BASE_URL: "https://bixtech-PROJECT_NUMBER.us-central1.run.app"
SESSION_SECRET: "paste-a-long-random-value-from-node-setup.js"
DATA_DIR: "/data"
GOOGLE_CLIENT_ID: "..."
GOOGLE_CLIENT_SECRET: "..."
GITHUB_CLIENT_ID: "..."
GITHUB_CLIENT_SECRET: "..."
```
Add the other providers' variables the same way. (This keeps secrets in the service settings, visible to project editors. Google Secret Manager is the stricter option, though its free allowance is only 6 secret versions.)

**4. Deploy**

```
gcloud run deploy bixtech --source . --region us-central1 --allow-unauthenticated \
  --max-instances 1 --memory 256Mi --env-vars-file env.yaml \
  --add-volume name=data,type=cloud-storage,bucket=YOUR_PROJECT_ID-bixtech-data \
  --add-volume-mount volume=data,mount-path=/data
```
`--max-instances 1` is deliberate: accounts are stored in one file, so only one copy of the server may write to it.

**5. Confirm the address and finish**

```
gcloud run services describe bixtech --region us-central1 --format='value(status.url)'
```
If that differs from `BASE_URL` in `env.yaml`, fix it and run `gcloud run services update bixtech --region us-central1 --update-env-vars BASE_URL=THE_URL`. Then in every provider's console register `THE_URL/auth/<provider>/callback`, open `THE_URL/healthz`, and test each button. The server refuses to start on https without a strong `SESSION_SECRET`, so a startup error in the Cloud Run logs usually means a missing value.

**Custom domain later (bixtech.cm):** once you have registered it, map it to this service (Cloud Run → Manage custom domains), then change `BASE_URL` and re-register all callback URLs with the new domain.

## How login is protected

Authorization-code flow with one-time `state` kept in a signed HttpOnly cookie, PKCE (Google, GitHub, Microsoft), Apple ID-token signature + nonce checks, HttpOnly session cookie (hash stored server-side, 7 days), logout that destroys the server session, rate limiting on `/auth/*`, and no auto-linking of accounts by unverified emails. `GET /api/me` answers 401 without a session, and the student area locks if the session ends. Secrets exist only in `.env` / the host's settings, never in `public/`.

## Tests

`node --test` runs 11 server checks with mocked providers. I also ran the whole flow in a real browser against the real server with only Google's own servers replaced: first sign-in creates the account, a new tab is signed in by the cookie, logout ends the session, signing in again reuses the account, and the three failure messages above appear. A login with your real provider accounts is the one thing only you can test once credentials exist.

## Known limits

Student data and email/password accounts still live in each browser's storage (original design). Accounts from social login are stored in `data/store.json` on the server. Forgot password opens an email to bixtech3@gmail.com. The Terms of Service text is a placeholder.

## Internship application forms (student upload + admin review)

Students upload the **school's own application form** (photo or PDF) from the **Application** tab. Admins review it in **Applications**.

**Set up (3 steps)**
1. Add `ADMIN_PASSWORD` (8+ characters) to `.env` or Render's Environment. Without it the admin side stays locked on purpose.
2. Restart `node server.js`. The terminal prints `Admin review: READY` and where files are kept.
3. Sign in as admin, tap **Applications**, enter the admin email and this password.

**Where files go:** `DATA_DIR/uploads/`, or Upstash when `UPSTASH_REDIS_REST_URL/TOKEN` are set. A free Render disk is wiped on restart, so use Upstash (free plan 256 MB) or a Cloud Run bucket (`DATA_DIR=/data`). If a file is lost the admin sees a clear message and can reject it so the student re-uploads.

**APIs** (JSON; uploads and POSTs need the `X-Requested-With: fetch` header)

| Method and path | Who | What |
|---|---|---|
| `POST /api/applications` | student | raw file body (JPG/PNG/PDF); headers `Content-Type`, `X-File-Name` |
| `GET /api/applications/mine` | student | my application and status, or `null` |
| `GET /api/applications/mine/file` | student | my uploaded file |
| `GET /api/admin/session` | anyone | `{admin, configured}` |
| `POST /api/admin/login`, `/api/admin/logout` | admin | server sign-in (8 hours; 8 tries per 10 min) |
| `GET /api/admin/applications?status=&q=` | admin | list and counts |
| `GET /api/admin/applications/:id` | admin | one application |
| `GET /api/admin/applications/:id/file[?download=1]` | admin | view or download the original |
| `POST /api/admin/applications/:id/review` | admin | `{decision: "approved" or "rejected", comment}`; comment required to reject |

Tests: `node --test`.

## Setting up Brevo (the emails with the 6-digit code)

1. Create a free account at brevo.com.
2. **Add a sender:** Senders, Domains & Dedicated IPs > Senders > Add a sender. Use an address you own (for example your Gmail). Brevo emails you a link: click it to verify.
3. **Make an API key:** top-right menu > SMTP & API > API Keys > Generate a new API key. Copy it once.
4. Run `node setup.js` (creates `.env`), then open `.env` and fill in:
   `BREVO_API_KEY=` the key you copied, and `MAIL_FROM=` the exact sender address from step 2.
5. If your key is blocked: Security > Authorised IPs > turn off the blocking (or add your server's IP).
6. **Test it:** `node check-mail.js your-own-email@gmail.com`. It prints `OK`, or says exactly what to fix.
7. On Render, add the same two values (plus `ADMIN_PASSWORD`) in Environment, then redeploy.

## Student sign up and sign in (passwords, no email code)

- **Sign up:** name, email, password (8+), course, field, duration, then the school form (photo or PDF). The account is created, the student is signed in, and the form is sent as **Pending**.
- **Sign in:** email + password. Google / Apple / GitHub / Facebook buttons still work if you configured them.
- Passwords are stored only as salted scrypt hashes on the server. 8 wrong tries per 10 minutes are blocked.
- Old accounts that only existed in one browser are moved to the server the first time that student signs in (password 8+ characters).
- **Forgot password** still opens an email to your contact address; reset it by asking the student to sign up again with another email, or ask me to add an admin reset button.
- API: `POST /auth/register`, `POST /auth/login` (JSON). Brevo is now only needed for the optional email-code fallback.
