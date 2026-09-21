import PostalMime from "postal-mime";

const GITHUB_API_VERSION = "2022-11-28";

declare global {
  interface Env {
    GITHUB_TOKEN: string;
  }
}

export default {
  async fetch(_request, env): Promise<Response> {
    if (env.REDIRECT_URL) {
      return Response.redirect(env.REDIRECT_URL, 302);
    }
    return new Response("Not found", { status: 404 });
  },

  async email(message, env): Promise<void> {
    // Email Routing only invokes this Worker for domains listed under
    // `addresses` in wrangler.jsonc, so the domain needs no further checks here.
    const { role } = parseRecipient(message.to);

    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(role)) {
      message.setReject("Invalid job address");
      return;
    }

    try {
      const parsed = await PostalMime.parse(message.raw, {
        attachmentEncoding: "arraybuffer",
      });
      const applicantEmail = normalizeEmail(
        parsed.from?.address ?? message.from,
      );
      const applicantName = parsed.from?.name.trim() || applicantEmail.split("@")[0];
      const candidateDirectory = `records/${role}/${sanitizePathSegment(
        `${applicantName} - ${applicantEmail}`,
      )}`;
      const attachments = parsed.attachments.filter(
        (attachment) => attachment.disposition !== "inline",
      );
      const attachmentPaths = attachments.map((attachment, index) =>
        `${candidateDirectory}/attachments/${String(index + 1).padStart(2, "0")}-${sanitizeFilename(attachment.filename)}`
      );
      const plainBody = parsed.text ?? htmlToPlainText(parsed.html ?? "");
      const htmlBody = parsed.html ?? plainTextToHtml(plainBody);
      const content = formatApplication({
        role,
        recipient: message.to,
        sender: applicantEmail,
        subject: parsed.subject ?? "",
        messageId: parsed.messageId ?? message.headers.get("message-id") ?? "",
        date: parsed.date ?? message.headers.get("date") ?? "",
        body: plainBody,
        attachments: attachmentPaths,
      });

      const files: GitHubFile[] = [
        {
          path: `${candidateDirectory}/email.txt`,
          base64Content: toBase64(content),
        },
        {
          path: `${candidateDirectory}/email.html`,
          base64Content: toBase64(htmlBody),
        },
        ...attachments.map((attachment, index) => ({
          path: attachmentPaths[index],
          base64Content: attachmentContentAsBase64(attachment.content),
        })),
      ];

      await commitGitHubFiles(
        env,
        files,
        `Archive ${role} application from ${applicantEmail}`,
      );

      if (env.FORWARD_TO) {
        const headers = new Headers({
          "X-Jobmail-Role": role,
          "X-Jobmail-Archived": "true",
        });
        await message.forward(env.FORWARD_TO, headers);
      }

      console.log(JSON.stringify({ event: "application_cataloged", role }));
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "application_catalog_failed",
          role,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;

function parseRecipient(recipient: string): { role: string } {
  const normalized = recipient.trim().toLowerCase();
  const separator = normalized.lastIndexOf("@");

  if (separator <= 0 || separator === normalized.length - 1) {
    return { role: "" };
  }

  return { role: normalized.slice(0, separator) };
}

function normalizeEmail(value: string): string {
  const match = value.trim().toLowerCase().match(/<?([^<>\s]+@[^<>\s]+)>?$/);
  const email = match?.[1];

  if (!email || !/^[^@/]+@[^@/]+$/.test(email)) {
    throw new Error("Message has no valid applicant email address");
  }

  return email.replace(/[^a-z0-9@._+-]/g, "-");
}

function sanitizeFilename(value: string | null): string {
  const safe = (value || "attachment.bin")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return safe || "attachment.bin";
}

function sanitizePathSegment(value: string): string {
  const safe = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9@._+ -]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .trim()
    .replace(/^[-.]+|[-.]+$/g, "");
  return safe || "unknown-applicant";
}

function htmlToPlainText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li|\/tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function plainTextToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  return `<!doctype html><meta charset="utf-8"><pre>${escaped}</pre>\n`;
}

function formatApplication(input: {
  role: string;
  recipient: string;
  sender: string;
  subject: string;
  messageId: string;
  date: string;
  body: string;
  attachments: string[];
}): string {
  const attachments = input.attachments.length
    ? input.attachments.map((name) => `- ${name}`).join("\n")
    : "- None";

  return [
    `Role: ${input.role}`,
    `From: ${input.sender}`,
    `To: ${input.recipient}`,
    `Subject: ${input.subject}`,
    `Date: ${input.date}`,
    `Message-ID: ${input.messageId}`,
    "",
    "Attachments:",
    attachments,
    "",
    "Message:",
    input.body.trim(),
    "",
  ].join("\n");
}

type GitHubFile = {
  path: string;
  base64Content: string;
};

async function commitGitHubFiles(
  env: Env,
  files: GitHubFile[],
  message: string,
): Promise<void> {
  const repository =
    `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}` +
    `/${encodeURIComponent(env.GITHUB_REPO)}`;
  const headers = githubHeaders(env.GITHUB_TOKEN);
  const branch = encodeURIComponent(env.GITHUB_BRANCH);

  const ref = await githubJson<{ object?: { sha?: string } }>(
    await fetch(`${repository}/git/ref/heads/${branch}`, { headers }),
    "branch lookup",
  );
  const parentCommitSha = ref.object?.sha;
  if (!parentCommitSha) {
    throw new Error("GitHub branch lookup returned no commit SHA");
  }

  const parentCommit = await githubJson<{ tree?: { sha?: string } }>(
    await fetch(`${repository}/git/commits/${parentCommitSha}`, { headers }),
    "parent commit lookup",
  );
  const parentTreeSha = parentCommit.tree?.sha;
  if (!parentTreeSha) {
    throw new Error("GitHub parent commit returned no tree SHA");
  }

  const treeEntries = await Promise.all(
    files.map(async (file) => {
      const blob = await githubJson<{ sha?: string }>(
        await fetch(`${repository}/git/blobs`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            content: file.base64Content,
            encoding: "base64",
          }),
        }),
        `blob creation for ${file.path}`,
      );
      if (!blob.sha) {
        throw new Error(`GitHub returned no blob SHA for ${file.path}`);
      }
      return {
        path: file.path,
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      };
    }),
  );

  const tree = await githubJson<{ sha?: string }>(
    await fetch(`${repository}/git/trees`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        base_tree: parentTreeSha,
        tree: treeEntries,
      }),
    }),
    "tree creation",
  );
  if (!tree.sha) {
    throw new Error("GitHub returned no tree SHA");
  }

  const commit = await githubJson<{ sha?: string }>(
    await fetch(`${repository}/git/commits`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        message,
        tree: tree.sha,
        parents: [parentCommitSha],
      }),
    }),
    "commit creation",
  );
  if (!commit.sha) {
    throw new Error("GitHub returned no commit SHA");
  }

  await githubJson(
    await fetch(`${repository}/git/refs/heads/${branch}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ sha: commit.sha, force: false }),
    }),
    "branch update",
  );
}

async function githubJson<T = unknown>(
  response: Response,
  operation: string,
): Promise<T> {
  if (!response.ok) {
    throw new Error(`GitHub ${operation} failed with status ${response.status}`);
  }
  return response.json<T>();
}

function toBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > 1_000_000) {
    throw new Error("Application text exceeds the 1 MB archive limit");
  }

  return bytesToBase64(bytes);
}

function attachmentContentAsBase64(
  value: ArrayBuffer | Uint8Array | string,
): string {
  if (typeof value === "string") {
    return toBase64(value);
  }
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (bytes.byteLength > 20_000_000) {
    throw new Error("An attachment exceeds the 20 MB archive limit");
  }
  return bytesToBase64(bytes);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 32_768));
  }
  return btoa(binary);
}

function githubHeaders(token: string): Headers {
  return new Headers({
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "jobmail",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  });
}
