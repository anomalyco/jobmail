# jobmail

<img width="1552" height="1552" alt="image" src="https://github.com/user-attachments/assets/1d5f536b-d567-45f7-8de5-4efd7ad09faa" />

Turn any address at your jobs domain into an inbox that files applications into
this Git repository. Mail to `engineering@jobs.example.com` becomes:

```text
records/
└── engineering/
    └── Jane Applicant - applicant@example.com/
        ├── email.txt
        ├── email.html
        └── attachments/
            └── 01-resume.pdf
```

Cloudflare Email Routing receives the mail, a Worker parses it, and the GitHub
API writes every file in one commit. There is no mailbox, no IMAP, and no OAuth.
Review candidates with `git pull` and whatever tools you already use.

## How it works

```text
Applicant
  → role@jobs.example.com
  → Cloudflare Email Routing (catch-all)
  → Worker: parse MIME, derive role from the address
  → GitHub Git Data API: blobs → tree → commit → main
  → records/<role>/<name - email>/
```

The part before `@` is the role, so new roles need no configuration. Role names
may contain lowercase letters, numbers, and hyphens; anything else is rejected.

## Prerequisites

- A domain whose DNS is hosted on Cloudflare. A subdomain such as
  `jobs.example.com` works if it is its own Cloudflare zone.
- Node.js 20+ and npm.
- Permission to create a fine-grained GitHub token for this repository.

## 1. Create your copy

Click **Use this template** (or fork), and make the new repository **private**.
Applications contain personal data.

Clone it and open `deploy/wrangler.jsonc`. Set:

```jsonc
"JOBS_DOMAIN": "jobs.example.com",
"GITHUB_OWNER": "your-github-owner",
"GITHUB_REPO": "your-repository-name",
"GITHUB_BRANCH": "main"
```

`FORWARD_TO` and `REDIRECT_URL` are optional; see below.

## 2. Create the GitHub token

GitHub → **Settings → Developer settings → Personal access tokens →
Fine-grained tokens → Generate new token**:

- **Resource owner:** the owner of your copy
- **Repository access:** only your copy
- **Repository permissions:** Contents — Read and write
- **Expiration:** as long as your organization allows

Keep the value for the next step. Never commit it.

## 3. Deploy the Worker

```sh
cd deploy
npm install
npx wrangler login
npm run types
npm run check
npm run deploy
npx wrangler secret put GITHUB_TOKEN
```

Paste the token when prompted. The Worker is named `jobmail`.

## 4. Enable Email Routing

```sh
npx wrangler email routing enable jobs.example.com
```

This adds the MX and SPF records Cloudflare needs. The zone must be active
(nameservers pointed at Cloudflare) or the command fails with `Active zone
required`. Do not keep another provider's MX records on this domain.

## 5. Route everything to the Worker

In the Cloudflare dashboard: zone → **Email → Email Routing → Routing rules →
Catch-all address** → action **Send to a Worker** → select `jobmail` → save.

(The `wrangler email routing rules update … catch-all` beta command currently
rejects the `worker` action even though the API supports it, so use the
dashboard for this step.)

## 6. Test

Send an email from an external account to `test@jobs.example.com` with a small
attachment. Within a few seconds a commit appears containing:

```text
records/test/<Sender Name - sender@example.com>/email.txt
records/test/<Sender Name - sender@example.com>/email.html
records/test/<Sender Name - sender@example.com>/attachments/01-<file>
```

Watch the Worker while testing:

```sh
cd deploy
npx wrangler tail
```

## Options

**Forward to an inbox.** Verify a destination address under Email Routing, set
`FORWARD_TO` to it in `wrangler.jsonc`, then `npm run deploy`. Each application
is archived first and then forwarded with `X-Jobmail-Role` set.

**Redirect web visits.** Set `REDIRECT_URL` (for example your careers page),
uncomment `routes` in `wrangler.jsonc` with your hostnames, and deploy. Without
`REDIRECT_URL` the Worker answers HTTP requests with 404.

## Behavior

- `email.txt` holds message metadata plus readable text (HTML is converted when
  the sender sent HTML only).
- `email.html` holds the original HTML, or a minimal escaped wrapper for
  plain-text mail.
- Inline images (signatures, tracking pixels) are skipped. Other attachments are
  stored unchanged with sanitized filenames, up to 20 MB each; text is capped at
  1 MB.
- All files for one email land in a single commit
  (`Archive <role> application from <sender>`).
- A repeat email from the same name and address updates the same folder.
- If parsing or the GitHub write fails, the Worker throws so Cloudflare retries
  instead of silently dropping the mail.

## Troubleshooting

- **Mail bounces:** confirm Email Routing shows the zone as enabled and that
  Cloudflare's MX records are the only MX records on the domain.
- **Nothing committed:** run `npx wrangler tail`, then check the token has
  Contents read/write on this exact repository and `GITHUB_OWNER`/`GITHUB_REPO`
  match its current name (GitHub redirects renamed repos in a way that breaks
  API writes).
- **Worker missing from the catch-all list:** deploy once before creating the
  rule.
- **401/403 from GitHub:** the token expired or was revoked; run
  `npx wrangler secret put GITHUB_TOKEN` again.
