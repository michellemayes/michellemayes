#!/usr/bin/env node
// generate-profile.mjs: self-hosted GitHub profile stats card + pins block.
//
// Zero dependencies (Node 20+ built-in fetch). Queries the GitHub GraphQL API
// for the contribution calendar, repo totals, languages, and pinned repos;
// computes streaks locally; renders assets/stats.svg (dark) and
// assets/stats-light.svg from assets/stats.template.svg; and rewrites the
// README block between the PINS markers.
//
// Auth: STATS_TOKEN (optional classic PAT, no scopes needed) or the Actions
// GITHUB_TOKEN. Every query reads public data. Private contributions count
// only if the profile's "Include private contributions" setting is on.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const LOGIN = process.env.PROFILE_LOGIN || "michellemayes";
const TOKEN = process.env.STATS_TOKEN || process.env.GITHUB_TOKEN;

if (!TOKEN) {
  console.error("No token found. Set STATS_TOKEN or GITHUB_TOKEN (GraphQL requires authentication).");
  process.exit(1);
}

async function gql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": `${LOGIN}-profile-generator`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

// ── Data fetch ──────────────────────────────────────────────────────────────

const PROFILE_QUERY = `
  query($login: String!) {
    user(login: $login) {
      contributionsCollection {
        contributionCalendar {
          totalContributions
          weeks { contributionDays { date contributionCount } }
        }
      }
      pinnedItems(first: 6, types: REPOSITORY) {
        nodes { ... on Repository { name description url stargazerCount } }
      }
    }
  }
`;

const REPOS_QUERY = `
  query($login: String!, $cursor: String) {
    user(login: $login) {
      repositories(ownerAffiliations: OWNER, privacy: PUBLIC, isFork: false, first: 100, after: $cursor) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          name description url stargazerCount pushedAt
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
            edges { size node { name } }
          }
        }
      }
    }
  }
`;

async function fetchRepos() {
  let cursor = null;
  let totalCount = 0;
  const repos = [];
  do {
    const data = await gql(REPOS_QUERY, { login: LOGIN, cursor });
    const page = data.user.repositories;
    totalCount = page.totalCount;
    repos.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return { totalCount, repos };
}

// ── Stats math ──────────────────────────────────────────────────────────────

function flattenDays(calendar) {
  return calendar.weeks
    .flatMap((w) => w.contributionDays)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function computeStreaks(days) {
  let longest = 0;
  let run = 0;
  for (const day of days) {
    run = day.contributionCount > 0 ? run + 1 : 0;
    if (run > longest) longest = run;
  }

  // Walk back from the most recent day. Today at zero doesn't break the
  // streak (the day isn't over), but any earlier zero does.
  let current = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].contributionCount > 0) current += 1;
    else if (i === days.length - 1) continue;
    else break;
  }
  return { current, longest };
}

// Language with the most bytes across public, non-fork repos.
function topLanguage(repos) {
  const bytes = new Map();
  for (const repo of repos) {
    for (const { size, node } of repo.languages.edges) {
      bytes.set(node.name, (bytes.get(node.name) || 0) + size);
    }
  }
  const [name] = [...bytes.entries()].sort((a, b) => b[1] - a[1])[0] || ["—"];
  return name;
}

const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const formatCompact = (n) => (n < 10000 ? n.toLocaleString("en-US") : COMPACT.format(n));

// ── SVG render ──────────────────────────────────────────────────────────────

// One bar per calendar week. Square-root scale keeps quiet weeks visible next
// to a busy peak; there's no axis, so it shows shape, not exact values.
const BARS_WIDTH = 592;
const BARS_HEIGHT = 36;
const BARS_GAP = 2;
const BARS_STAGGER_MS = 12;

function renderWeekBars(calendar) {
  const totals = calendar.weeks.map((w) =>
    w.contributionDays.reduce((sum, d) => sum + d.contributionCount, 0),
  );
  const max = Math.max(1, ...totals);
  const step = BARS_WIDTH / totals.length;
  const width = (step - BARS_GAP).toFixed(2);
  return totals
    .map((count, i) => {
      const h = Math.max(1.5, Math.sqrt(count / max) * BARS_HEIGHT);
      const cls = i === totals.length - 1 ? "bar bar-now" : "bar";
      return `<rect class="${cls}" x="${(i * step).toFixed(2)}" y="${(BARS_HEIGHT - h).toFixed(2)}" width="${width}" height="${h.toFixed(2)}" rx="1" style="animation-delay: ${i * BARS_STAGGER_MS}ms"/>`;
    })
    .join("\n    ");
}

// The template uses the dark palette; the light copy swaps each hex. README's
// <picture> picks one per the viewer's GitHub theme. Every template hex must be
// mapped, so a new color fails the run instead of staying dark on white.
const LIGHT_THEME = new Map([
  ["#1c1726", "#fafaf8"], // card bg
  ["#3b3150", "#ddd6fe"], // border
  ["#cfc8dc", "#4c4361"], // secondary text
  ["#ddd6fe", "#3b2a6b"], // stat numbers
  ["#a78bfa", "#7c3aed"], // violet accent
  ["#c4b5fd", "#8b5cf6"], // hero gradient top
  ["#8b5cf6", "#5b21b6"], // hero gradient base
  ["#f472b6", "#be185d"], // rose (wordmark)
  ["#f59e0b", "#b45309"], // amber (star, current week)
  ["#4ade80", "#15803d"], // leaf (wordmark, status dot)
  ["#7c6aa6", "#a78bfa"], // bars
]);

const HEX = /#[0-9a-fA-F]{3,8}\b/g;

function toLightTheme(svg) {
  const unmapped = [...new Set(svg.match(HEX) ?? [])].filter((h) => !LIGHT_THEME.has(h.toLowerCase()));
  if (unmapped.length) throw new Error(`LIGHT_THEME has no light value for: ${unmapped.join(", ")}`);
  return svg.replace(HEX, (h) => LIGHT_THEME.get(h.toLowerCase()));
}

// Values are XML-escaped except generated markup.
const RAW_PLACEHOLDERS = new Set(["WEEK_BARS"]);
const escapeXml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function renderSvg(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!(key in values)) return match;
    const v = String(values[key]);
    return RAW_PLACEHOLDERS.has(key) ? v : escapeXml(v);
  });
}

// ── README pins block ───────────────────────────────────────────────────────

const PINS_START = "<!-- PINS:START -->";
const PINS_END = "<!-- PINS:END -->";

function renderPins(pins) {
  const lines = pins.map((p) => {
    const desc = p.description ? ` — ${p.description.trim()}` : "";
    const star = p.stargazerCount > 0 ? ` ★ ${p.stargazerCount}` : "";
    return `- [${p.name}](${p.url})${desc}${star}`;
  });
  return [PINS_START, "<!-- generated weekly — do not edit by hand -->", ...lines, PINS_END].join("\n");
}

function rewritePins(readme, pins) {
  const startIdx = readme.indexOf(PINS_START);
  const endIdx = readme.indexOf(PINS_END);
  if (startIdx === -1 || endIdx === -1) throw new Error(`PINS markers not found in README`);
  return readme.slice(0, startIdx) + renderPins(pins) + readme.slice(endIdx + PINS_END.length);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const [profile, { totalCount, repos }] = await Promise.all([
    gql(PROFILE_QUERY, { login: LOGIN }),
    fetchRepos(),
  ]);

  const calendar = profile.user.contributionsCollection.contributionCalendar;
  const { current, longest } = computeStreaks(flattenDays(calendar));

  // Profile pins drive the list; with none set, fall back to the six most
  // recently pushed public repos (skipping this profile repo itself).
  let pins = profile.user.pinnedItems.nodes.filter(Boolean);
  if (pins.length === 0) {
    pins = repos
      .filter((r) => r.name.toLowerCase() !== LOGIN.toLowerCase())
      .sort((a, b) => b.pushedAt.localeCompare(a.pushedAt))
      .slice(0, 6);
  }

  const values = {
    CURRENT_STREAK: current,
    LONGEST_STREAK: longest,
    TOTAL_CONTRIB: calendar.totalContributions,
    TOTAL_CONTRIB_SHORT: formatCompact(calendar.totalContributions),
    PUBLIC_REPOS: totalCount,
    TOTAL_STARS: repos.reduce((sum, r) => sum + r.stargazerCount, 0),
    TOP_LANGUAGE: topLanguage(repos),
    UPDATED: new Date().toISOString().slice(0, 10),
    WEEK_BARS: renderWeekBars(calendar),
  };

  const { WEEK_BARS, ...stats } = values;
  console.log("Stats:", JSON.stringify(stats));
  console.log("Pins:", pins.map((p) => p.name).join(", "));

  const template = await readFile(join(ROOT, "assets/stats.template.svg"), "utf8");
  const svg = renderSvg(template, values);
  const lightSvg = toLightTheme(svg); // throws before any write on an unmapped color
  await writeFile(join(ROOT, "assets/stats.svg"), svg);
  await writeFile(join(ROOT, "assets/stats-light.svg"), lightSvg);

  const readmePath = join(ROOT, "README.md");
  await writeFile(readmePath, rewritePins(await readFile(readmePath, "utf8"), pins));

  console.log("Wrote assets/stats.svg, assets/stats-light.svg, and the README pins block.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
