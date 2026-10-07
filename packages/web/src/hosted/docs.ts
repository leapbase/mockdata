import type { Block, DocPage, DocsExtension } from "@mockdata/web";
import { MCP_URL } from "./landing";

/**
 * mockdata.com's documentation, added to the open docs through the `docs` slot: two pages (MCP on the web, Accounts mode),
 * a card and an environment section, and the places where the open text describes the local workspace and this site
 * says something else. Strings are English; hosted/i18n/ has their translations.
 */

const MCP_PAGE: DocPage = {
    slug: "mcp", title: "MCP on the web", group: "AI agents", icon: "agent",
    summary: "Connect an AI agent such as Claude to mockdata.com over the Model Context Protocol, with nothing to install.",
    sections: [
      { id: "connect", title: "Connect", blocks: [
        { list: [
          "Sign in to the [workspace](/app).",
          "Open the account menu, choose **API keys**, and create a key. Copy it now: it is shown only once.",
          "Add the server to your client:",
        ], ordered: true },
        { code: `claude mcp add --transport http mockdata ${MCP_URL} --header "Authorization: Bearer <your API key>"` },
        { p: "Other clients take the same two things: the URL `" + MCP_URL + "` (Streamable HTTP) and the header `Authorization: Bearer <your API key>`." },
      ] },
      { id: "api-keys", title: "API keys", blocks: [
        { list: [
          "Each key is shown once; only a hash of it is stored. The list shows each key's name, its first characters and when it was last used.",
          "You may hold 10 keys and revoke any of them at any time from the same dialog.",
          "The key goes in the `Authorization` header only. Your browser's sign-in is never accepted at `/mcp`, so a web page cannot use it to call the tools.",
          "Resetting your password with \"Forgot password?\" revokes all your keys. Changing the password while signed in, or \"Sign out everywhere\", does not: revoke keys in the list if you need to.",
        ] },
      ] },
      { id: "your-folder", title: "Your folder and limits", blocks: [
        { p: "The tools work in your private folder, the same one the web workspace uses: an agent can read the schemas you saved there by name, or pass a schema inline, and generated files it writes land in that folder. The site's own model settings and limits apply: rows and cells per run, storage, files, and model-written rows per day." },
        { p: "Not available on the web: inferring from a database (`infer_schema` with `connectionEnv`), and choosing a model, provider, address or key in a schema's `llm:` block." },
        { table: { head: ["Limit", "Value"], rows: [
          ["Open sessions", "5 per user; idle sessions close after 30 minutes"],
          ["Requests", "240 a minute per user"],
          ["Wrong keys", "An address that sends 30 wrong keys in 15 minutes is refused for a while"],
        ] } },
      ] },
      { id: "tools", title: "Tools", blocks: [
        { table: { head: ["Tool", "Does"], rows: [
          ["`describe_schema_format`", "Returns the schema reference so an agent can write valid schemas"],
          ["`validate_schema`", "Checks a schema"],
          ["`infer_schema`", "Builds a schema from a file or folder in your folder, or from inline content such as sample rows or an OpenAPI document"],
          ["`generate_data`", "Returns row counts and a small preview; can write every row to files in your folder"],
          ["`get_run_report`", "Seed, row counts, files written, model calls and tokens for the last run"],
        ] } },
        { note: "Running your own [accounts-mode site](/docs/accounts)? It serves the same endpoint at `<MOCKDATA_PUBLIC_URL>/mcp`, with the same keys and limits.", title: "Self-hosted sites" },
      ] },
    ],
  };

const ACCOUNTS_PAGE: DocPage = {
    slug: "accounts", title: "Accounts mode", group: "Self-hosting", icon: "users",
    summary: "Run a public site that people sign in to, like mockdata.com.",
    sections: [
      { id: "modes", title: "Modes", blocks: [
        { table: { head: ["Mode", "Turned on by", "Who gets in"], rows: [
          ["Local (default)", "nothing", "anyone on this machine"],
          ["Private network", "`--allow ranges`", "the listed private ranges, with a shared token"],
          ["**Accounts**", "`MOCKDATA_PUBLIC_URL`", "everyone signs in, including localhost"],
        ] } },
        { p: "Localhost is not trusted in accounts mode because a reverse proxy that terminates https connects from localhost on behalf of everyone." },
      ] },
      { id: "setup", title: "Set it up", blocks: [
        { p: "Set the variables below (environment or `.env`), put a reverse proxy that provides https in front, and start the UI as usual. It refuses to start unless people can sign up by email and/or Google." },
        { code: `mockdata.example.com {
  reverse_proxy 127.0.0.1:4747
}`, title: "Caddyfile" },
        { code: `MOCKDATA_PUBLIC_URL=https://mockdata.example.com MOCKDATA_TRUST_PROXY=1 npm run ui -- /path/holding/.env` },
        { table: { head: ["Variable", "Meaning"], rows: [
          ["`MOCKDATA_PUBLIC_URL`", "`https://your-domain` (plain http only for localhost)"],
          ["`MOCKDATA_DATA_DIR`", "Accounts database and every user's private folder (default `./mockdata-data`); back it up"],
          ["`MOCKDATA_ACCOUNTS_DB`", "Optional `postgres://` URL: the account database in Postgres instead of SQLite, needed to [run several servers](/docs/accounts#several-servers)"],
          ["`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`", "Email for verification and password reset"],
          ["`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`", "Optional Google sign-in; redirect URI `<MOCKDATA_PUBLIC_URL>/api/auth/google/callback`"],
          ["`MOCKDATA_TRUST_PROXY`", "Read the visitor's address from `X-Forwarded-For` (default on for https)"],
        ] } },
        { p: "Back up with `mockdata-ui --backup <file>`, which copies the account database safely while the server runs; copying `accounts.db` alone can miss recent writes. Back up `<data-dir>/users/` with any file tool, and test a restore." },
      ] },
      { id: "limits", title: "Per-user limits", blocks: [
        { table: { head: ["Variable", "Default"], rows: [
          ["`MOCKDATA_LLM_DAILY_ROWS`", "2,000 model-written rows per user per day"],
          ["`MOCKDATA_LLM_GLOBAL_DAILY_ROWS`", "20,000 per day across all users: your spending ceiling"],
          ["`MOCKDATA_MAX_ROWS`, `MOCKDATA_MAX_CELLS`", "200,000 rows and 500,000 cells per run"],
          ["`MOCKDATA_USER_QUOTA_MB`, `MOCKDATA_USER_MAX_FILES`", "50 MB and 500 files per user"],
          ["`MOCKDATA_MAX_RUNS`", "4 runs at once across all users"],
        ] } },
        { p: "Users cannot infer from a database variable or choose a model, provider, address or key in a schema: the operator's settings are used. The same site serves [MCP](/docs/mcp) at `/mcp` with per-user API keys." },
      ] },
      { id: "several-servers", title: "Several servers", blocks: [
        { p: "To run several servers behind a load balancer, every server needs:" },
        { list: ["**One Postgres account database:** the same `MOCKDATA_ACCOUNTS_DB` URL everywhere. Accounts, sessions, API keys, model budgets, rate limits and run slots are then shared, so a sign-in on one server works on all and each limit is counted once.", "**The same user files:** `<data-dir>/users` on shared storage (NFS, EFS or similar) at the same path on each server.", "**The same environment:** public address, email, Google and model settings identical everywhere.", "**MCP sessions routed consistently:** a session lives on the server that opened it, so route by the `Mcp-Session-Id` header; another server answers it with 404 and the client reconnects."] },
        { code: "mockdata.example.com {\n  reverse_proxy 10.0.0.11:4747 10.0.0.12:4747 {\n    lb_policy header Mcp-Session-Id\n    health_uri /healthz\n  }\n}", title: "Caddyfile" },
        { p: "Per server and not shared, by design: the password-hashing queue, the mail queue and the generation worker threads. One server on SQLite remains the simplest setup." },
      ] },
    ],
  };

const MCP_CARD = {"title":"MCP on the web","href":"/docs/mcp","body":"Connect an agent to mockdata.com"};

const ACCOUNTS_SECTION = { id: "accounts", title: "Accounts", blocks: [
  { p: "`MOCKDATA_PUBLIC_URL`, `MOCKDATA_DATA_DIR`, `MOCKDATA_TRUST_PROXY`, the `SMTP_*` and `GOOGLE_*` settings, and the per-user limits are described in [Accounts mode](/docs/accounts)." },
] };

/** Open wording -> mockdata.com wording, matched against a whole string (a test checks that every pair still matches). */
export const SWAPS: [open: string, hosted: string][] = [
  ["Open the [workspace](/app) and follow the [Quick start](/docs/quick-start) to generate your first dataset in a couple of minutes.", "Sign in at [mockdata.com](/app) and follow the [Quick start](/docs/quick-start) to generate your first dataset in a couple of minutes, with nothing to install."],
  ["mockdata is open source under the GNU Affero General Public License, version 3 or later, at [github.com/leapbase/mockdata](https://github.com/leapbase/mockdata). Data you generate is yours and is not covered by the license.", "mockdata is open source under the GNU Affero General Public License, version 3 or later, at [github.com/leapbase/mockdata](https://github.com/leapbase/mockdata). The hosted copy at mockdata.com is free to use. Data you generate is yours and is not covered by the license."],
  ["Open the [workspace](/app).", "Open the [workspace](/app) and sign in, or create an account."],
  ["The left sidebar lists your schemas. Select one to open it, choose **New** to start a draft, and name or rename it in the header field next to **Save**. The top bar holds the theme switch (System, Light, Dark).", "The left sidebar lists your schemas. Select one to open it, choose **New** to start a draft, and name or rename it in the header field next to **Save**. The top bar holds the theme switch (System, Light, Dark) and your account menu."],
  ["The **Import** tab builds a schema from a file in your folder, from pasted sample rows, or from a pasted JSON Schema or OpenAPI document; the workspace can also read a database whose URL is kept in `.env`. The result opens as an unsaved draft with any warnings listed. See [Infer a schema](/docs/infer) for what is inferred.", "The **Import** tab builds a schema from a file in your folder, from pasted sample rows, or from a pasted JSON Schema or OpenAPI document; a self-hosted workspace can also read a database whose URL is kept in `.env`. The result opens as an unsaved draft with any warnings listed. See [Infer a schema](/docs/infer) for what is inferred."],
  ["Settings come from `.env` in the folder you run from; real environment variables override it, and a schema's top-level `llm:` block overrides both.", "On mockdata.com the model is set by the site. When you run mockdata yourself, settings come from `.env` in the folder you run from; real environment variables override it, and a schema's top-level `llm:` block overrides both."],
  ["Run `npm run build` first (and again after code changes). Both servers listen on 127.0.0.1 only unless you allow a [private network](/docs/network).", "Run `npm run build` first (and again after code changes). Both servers listen on 127.0.0.1 only unless you allow a [private network](/docs/network) or turn on [accounts](/docs/accounts)."],
];

const swapped = new Map(SWAPS);
const swap = (s: string) => swapped.get(s) ?? s;

const swapBlock = (b: Block): Block => {
  if ("p" in b) return { ...b, p: swap(b.p) };
  if ("note" in b) return { ...b, note: swap(b.note) };
  if ("list" in b) return { ...b, list: b.list.map(swap) };
  if ("table" in b) return { ...b, table: { ...b.table, rows: b.table.rows.map((r) => r.map(swap)) } };
  return b;
};

/** The overview's card list gets the hosted MCP card just before the local one. */
const addCard = (b: Block): Block =>
  "cards" in b && b.cards.some((c) => c.href === "/docs/mcp-local")
    ? { ...b, cards: b.cards.flatMap((c) => (c.href === "/docs/mcp-local" ? [MCP_CARD, c] : [c])) }
    : b;

/** Add mockdata.com's pages and wording to the open pages. */
function hostedPages(base: DocPage[]): DocPage[] {
  const out: DocPage[] = [];
  for (const page of base) {
    if (page.slug === "mcp-local") out.push(MCP_PAGE);
    const sections = page.sections.map((s) => ({ ...s, blocks: s.blocks.map((b) => swapBlock(addCard(b))) }));
    out.push({ ...page, sections: page.slug === "environment" ? [...sections, ACCOUNTS_SECTION] : sections });
    if (page.slug === "network") out.push(ACCOUNTS_PAGE);
  }
  return out;
}

export const HOSTED_DOCS: DocsExtension = {
  pages: hostedPages,
  dictionaries: {
    es: () => import("./i18n/es").then((m) => m.default),
    zh: () => import("./i18n/zh").then((m) => m.default),
  },
};
