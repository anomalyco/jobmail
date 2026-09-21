import { spawnSync } from "node:child_process";
import { unstable_readConfig } from "wrangler";

const config = unstable_readConfig({ config: "wrangler.jsonc" }, { hideWarnings: true });

const addresses = config.addresses ?? [];
const domains = [...new Set(addresses.map((address) => address.slice(address.lastIndexOf("@") + 1).toLowerCase()))];

if (domains.length === 0) {
  console.error("Add at least one entry such as \"*@jobs.example.com\" to `addresses` in wrangler.jsonc.");
  process.exit(1);
}

const placeholders = ["jobs.example.com", "your-github-owner"];
const unset = [
  ...domains.filter((domain) => placeholders.includes(domain)).map((domain) => `addresses → ${domain}`),
  ...(placeholders.includes(config.vars.GITHUB_OWNER) ? ["vars.GITHUB_OWNER"] : []),
];
if (unset.length > 0) {
  console.error(`Replace the placeholder values in wrangler.jsonc first:\n  ${unset.join("\n  ")}`);
  process.exit(1);
}

function wrangler(args, { capture = false } = {}) {
  const result = spawnSync("npx", ["wrangler", ...args], {
    stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    if (capture) process.stderr.write(result.stderr ?? "");
    console.error(`\nwrangler ${args.join(" ")} failed.`);
    process.exit(result.status ?? 1);
  }
  return result.stdout ?? "";
}

console.log(`Worker: ${config.name}`);
console.log(`Domains: ${domains.join(", ")}\n`);

for (const domain of domains) {
  console.log(`Enabling Email Routing for ${domain}`);
  wrangler(["email", "routing", "enable", domain]);
}

console.log("\nDeploying the Worker and applying catch-all rules");
wrangler(["deploy"]);

const secrets = JSON.parse(wrangler(["secret", "list"], { capture: true }) || "[]");
if (!secrets.some((secret) => secret.name === "GITHUB_TOKEN")) {
  console.log("\nGITHUB_TOKEN is not set yet. Paste a fine-grained token with Contents: Read and write for");
  console.log(`${config.vars.GITHUB_OWNER}/${config.vars.GITHUB_REPO}:`);
  wrangler(["secret", "put", "GITHUB_TOKEN"]);
}

console.log("\nDone. Send a test email to any address at one of the domains above.");
