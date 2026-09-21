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

Setup is config-driven: list your domains in `deploy/wrangler.jsonc`, run
`npm run setup`, and Email Routing, the catch-all rules, and the Worker are
provisioned for every domain listed. Adding a domain later is the same edit and
the same command.

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
"addresses": ["*@jobs.example.com"],
"vars": {
  "GITHUB_OWNER": "your-github-owner",
  "GITHUB_REPO": "your-repository-name",
  "GITHUB_BRANCH": "main"
}
```

`addresses` takes one `*@domain` entry per domain that should accept
applications. Every domain must already be a zone in the Cloudflare account you
will deploy with, with its nameservers active. `FORWARD_TO` and `REDIRECT_URL`
are optional; see below.

## 2. Create the GitHub token

GitHub → **Settings → Developer settings → Personal access tokens →
Fine-grained tokens → Generate new token**:

- **Resource owner:** the owner of your copy
- **Repository access:** only your copy
- **Repository permissions:** Contents — Read and write
- **Expiration:** as long as your organization allows

Keep the value for the next step. Never commit it.

## 3. Run setup

```sh
cd deploy
npm install
npx wrangler login
npm run setup
```

`setup` reads `addresses` from `wrangler.jsonc` and, for each domain:

1. Enables Email Routing on the zone, which adds and locks Cloudflare's MX and
   SPF records. Fails with `Active zone required` if the nameservers are not
   yet pointed at Cloudflare.
2. Deploys the Worker (`jobmail`). Wrangler reconciles a catch-all rule on each
   zone that sends every address to the Worker.
3. Prompts for `GITHUB_TOKEN` if the secret is not set yet. Paste the token
   from step 2.

The command is safe to re-run; it reports `Email Routing rules are up to date`
when nothing changed. Do not keep another provider's MX records on these
domains.

If a domain already has a catch-all rule that was created in the dashboard,
Wrangler shows it as a conflict and asks before taking it over. Answer yes to
let the config own the rule from then on.

## 4. Test

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

**Add or remove a domain.** Edit `addresses` and run `npm run setup` again.
Removing an entry is a destructive change: Wrangler lists the rule it will
delete and asks for confirmation.

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
- **`Email Routing has destructive changes … Re-run the deployment
  interactively`:** the deploy ran without a terminal (CI, piped output). Run
  `npm run setup` from an interactive shell to confirm the takeover or delete.
- **401/403 from GitHub:** the token expired or was revoked; run
  `npx wrangler secret put GITHUB_TOKEN` again.
