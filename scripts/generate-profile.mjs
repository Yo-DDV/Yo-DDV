import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const ASSET_DIR = path.join(ROOT_DIR, "assets");
const CONFIG_PATH = path.join(ROOT_DIR, "profile.config.json");
const README_PATH = path.join(ROOT_DIR, "README.md");
const API_ROOT = "https://api.github.com";
const MAX_PAGES = 10;
const SEARCH_PAGE_SIZE = 100;
const REQUEST_CONCURRENCY = 4;
const PROFILE_CARD_PATTERN = /assets\/(capabilities|activity|languages)(-mobile)?\.svg(?:\?v=[a-f0-9]{12})?/g;

const LANGUAGE_COLORS = {
  JavaScript: "#f1e05a",
  TypeScript: "#3178c6",
  Rust: "#dea584",
  Shell: "#89e051",
  Python: "#3572a5",
  YAML: "#cb171e",
  Nix: "#7e7eff",
  PowerShell: "#012456",
  Dockerfile: "#384d54",
  Makefile: "#427819",
  CSS: "#563d7c",
  HTML: "#e34c26",
  "C#": "#178600",
  C: "#555555",
  "C++": "#f34b7d",
  HCL: "#844fba",
  SQL: "#e38c00",
  Other: "#8c959f"
};

const EXTENSION_LANGUAGES = new Map([
  [".js", "JavaScript"],
  [".cjs", "JavaScript"],
  [".mjs", "JavaScript"],
  [".jsx", "JavaScript"],
  [".ts", "TypeScript"],
  [".tsx", "TypeScript"],
  [".rs", "Rust"],
  [".sh", "Shell"],
  [".bash", "Shell"],
  [".zsh", "Shell"],
  [".py", "Python"],
  [".yml", "YAML"],
  [".yaml", "YAML"],
  [".nix", "Nix"],
  [".ps1", "PowerShell"],
  [".psm1", "PowerShell"],
  [".css", "CSS"],
  [".scss", "CSS"],
  [".html", "HTML"],
  [".cs", "C#"],
  [".c", "C"],
  [".h", "C"],
  [".cc", "C++"],
  [".cpp", "C++"],
  [".hpp", "C++"],
  [".tf", "HCL"],
  [".hcl", "HCL"],
  [".sql", "SQL"]
]);

const EXCLUDED_PATH_PARTS = [
  "/node_modules/",
  "/vendor/",
  "/dist/",
  "/build/",
  "/target/",
  "/coverage/",
  "/.vite/",
  "/generated/"
];

const EXCLUDED_FILE_PATTERNS = [
  /(?:^|\/)package-lock\.json$/,
  /(?:^|\/)npm-shrinkwrap\.json$/,
  /(?:^|\/)yarn\.lock$/,
  /(?:^|\/)pnpm-lock\.yaml$/,
  /(?:^|\/)Cargo\.lock$/,
  /(?:^|\/)flake\.lock$/,
  /\.min\.(?:js|css)$/,
  /\.(?:md|mdx|rst|txt|json|svg|png|jpe?g|gif|webp|ico|pdf)$/i
];

export function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function assertUsername(username) {
  if (!/^(?!-)(?!.*--)[A-Za-z0-9-]{1,39}(?<!-)$/.test(username)) {
    throw new Error("Invalid GitHub username in profile configuration");
  }
  return username;
}

export function languageForPath(filename) {
  const normalized = `/${String(filename).replaceAll("\\", "/")}`;
  const lower = normalized.toLowerCase();

  if (EXCLUDED_PATH_PARTS.some((part) => lower.includes(part))) {
    return null;
  }
  if (EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return null;
  }

  const basename = path.posix.basename(normalized);
  if (/^dockerfile(?:\..+)?$/i.test(basename)) return "Dockerfile";
  if (/^(?:gnu)?makefile$/i.test(basename)) return "Makefile";
  return EXTENSION_LANGUAGES.get(path.posix.extname(basename).toLowerCase()) ?? null;
}

export function aggregateLanguageChanges(files) {
  const totals = new Map();
  for (const file of files) {
    const language = languageForPath(file.filename);
    if (!language) continue;
    const additions = Number.isFinite(file.additions) ? file.additions : 0;
    const deletions = Number.isFinite(file.deletions) ? file.deletions : 0;
    const changedLines = Math.max(0, additions) + Math.max(0, deletions);
    if (changedLines === 0) continue;
    totals.set(language, (totals.get(language) ?? 0) + changedLines);
  }
  return [...totals.entries()]
    .map(([name, lines]) => ({ name, lines }))
    .sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name));
}

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function aggregateCalendarMonths(days, now = new Date()) {
  const months = [];
  for (let offset = 11; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    months.push({
      key: monthKey(date),
      label: new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" }).format(date),
      count: 0
    });
  }
  const byKey = new Map(months.map((month) => [month.key, month]));
  for (const day of days) {
    const target = byKey.get(String(day.date).slice(0, 7));
    if (target) target.count += Math.max(0, Number(day.contributionCount) || 0);
  }
  return months;
}

export function summarizeLanguages(entries, limit = 6, minimumPercent = 1) {
  const total = entries.reduce((sum, entry) => sum + entry.lines, 0);
  if (total === 0) return [];

  const visible = [];
  const hidden = [];
  for (const entry of entries) {
    const percent = (entry.lines / total) * 100;
    if (visible.length < limit && percent >= minimumPercent) {
      visible.push({ ...entry });
    } else {
      hidden.push(entry);
    }
  }
  const otherLines = hidden.reduce((sum, entry) => sum + entry.lines, 0);
  if (otherLines > 0) visible.push({ name: "Other", lines: otherLines });

  return visible.map((entry) => ({
    ...entry,
    percent: (entry.lines / total) * 100,
    color: LANGUAGE_COLORS[entry.name] ?? LANGUAGE_COLORS.Other
  }));
}

export function normalizeSnapshotDate(now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("Invalid snapshot date");
  }
  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    23,
    59,
    59
  ));
}

function svgShell({ width, height, title, description, body }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(title)}</title>
  <desc id="desc">${escapeXml(description)}</desc>
  <style>
    .bg { fill: #ffffff; stroke: #d0d7de; }
    .panel { fill: #f6f8fa; stroke: #d8dee4; }
    .title { fill: #1f2328; font: 700 22px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .subtitle { fill: #636c76; font: 400 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .metric { fill: #1f2328; font: 700 25px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .label { fill: #636c76; font: 500 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .body { fill: #1f2328; font: 500 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .muted { fill: #636c76; font: 400 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    @media (prefers-color-scheme: dark) {
      .bg { fill: #0d1117; stroke: #30363d; }
      .panel { fill: #161b22; stroke: #30363d; }
      .title, .metric, .body { fill: #f0f6fc; }
      .subtitle, .label, .muted { fill: #8b949e; }
    }
  </style>
  <rect class="bg" x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="8" />
${body}
</svg>
`;
}

export function renderCapabilitiesSvg(config) {
  const width = 900;
  const height = 410;
  const layouts = [
    { x: 28, y: 82, width: 268, height: 132 },
    { x: 316, y: 82, width: 268, height: 132 },
    { x: 604, y: 82, width: 268, height: 132 },
    { x: 28, y: 234, width: 412, height: 146 },
    { x: 460, y: 234, width: 412, height: 146 }
  ];

  const cards = config.capabilities.map((capability, index) => {
    const layout = layouts[index];
    if (!layout) throw new Error("The capability map supports up to five groups");
    const title = escapeXml(capability.title);
    const color = /^#[0-9a-f]{6}$/i.test(capability.color) ? capability.color : "#2f81f7";
    const items = capability.items.map((item, itemIndex) =>
      `    <circle cx="${layout.x + 20}" cy="${layout.y + 54 + itemIndex * 21}" r="3" fill="${color}" />\n` +
      `    <text class="body" x="${layout.x + 32}" y="${layout.y + 58 + itemIndex * 21}">${escapeXml(item)}</text>`
    ).join("\n");
    return `  <g>
    <rect class="panel" x="${layout.x}" y="${layout.y}" width="${layout.width}" height="${layout.height}" rx="8" />
    <rect x="${layout.x}" y="${layout.y}" width="${layout.width}" height="4" rx="2" fill="${color}" />
    <text class="title" x="${layout.x + 18}" y="${layout.y + 32}" style="font-size:16px">${title}</text>
${items}
  </g>`;
  }).join("\n");

  return svgShell({
    width,
    height,
    title: `${config.name} infrastructure capability map`,
    description: "Verified working areas across systems, networks, service edge, platforms and automation. No proficiency scores are used.",
    body: `  <text class="title" x="28" y="38">Infrastructure capability map</text>
  <text class="subtitle" x="28" y="60">Systems, networks, platforms and automation</text>
${cards}`
  });
}

export function renderCapabilitiesMobileSvg(config) {
  const width = 420;
  const height = 816;
  const layouts = config.capabilities.map((_, index) => ({
    x: 24,
    y: 82 + index * 146,
    width: 372,
    height: 128
  }));

  const cards = config.capabilities.map((capability, index) => {
    const layout = layouts[index];
    const title = escapeXml(capability.title);
    const color = /^#[0-9a-f]{6}$/i.test(capability.color) ? capability.color : "#2f81f7";
    const items = capability.items.map((item, itemIndex) =>
      "    <circle cx=\"" + (layout.x + 20) + "\" cy=\"" + (layout.y + 51 + itemIndex * 19) + "\" r=\"3\" fill=\"" + color + "\" />\n" +
      "    <text class=\"body\" x=\"" + (layout.x + 32) + "\" y=\"" + (layout.y + 55 + itemIndex * 19) + "\">" + escapeXml(item) + "</text>"
    ).join("\n");
    return [
      "  <g>",
      "    <rect class=\"panel\" x=\"" + layout.x + "\" y=\"" + layout.y + "\" width=\"" + layout.width + "\" height=\"" + layout.height + "\" rx=\"8\" />",
      "    <rect x=\"" + layout.x + "\" y=\"" + layout.y + "\" width=\"" + layout.width + "\" height=\"4\" rx=\"2\" fill=\"" + color + "\" />",
      "    <text class=\"title\" x=\"" + (layout.x + 18) + "\" y=\"" + (layout.y + 31) + "\" style=\"font-size:16px\">" + title + "</text>",
      items,
      "  </g>"
    ].join("\n");
  }).join("\n");

  return svgShell({
    width,
    height,
    title: config.name + " infrastructure capability map for mobile screens",
    description: "A vertically stacked view of verified working areas across systems, networks, service edge, platforms and automation.",
    body: [
      "  <text class=\"title\" x=\"24\" y=\"38\" style=\"font-size:20px\">Infrastructure capability map</text>",
      "  <text class=\"subtitle\" x=\"24\" y=\"60\">Systems, networks, platforms and automation</text>",
      cards
    ].join("\n")
  });
}

export function renderActivitySvg(stats, now = new Date()) {
  const width = 900;
  const height = 300;
  const days = stats.contributionCalendar.weeks.flatMap((week) => week.contributionDays);
  const months = aggregateCalendarMonths(days, now);
  const maxCount = Math.max(...months.map((month) => month.count), 1);
  const activeDays = days.filter((day) => day.contributionCount > 0).length;
  const metrics = [
    [stats.contributionCalendar.totalContributions, "public contributions"],
    [stats.totalPullRequestContributions, "pull requests"],
    [stats.totalPullRequestReviewContributions, "reviews"],
    [activeDays, "active days"]
  ];

  const metricWidth = 196;
  const metricMarkup = metrics.map(([value, label], index) => {
    const x = 28 + index * (metricWidth + 16);
    return `  <g>
    <rect class="panel" x="${x}" y="78" width="${metricWidth}" height="70" rx="8" />
    <text class="metric" x="${x + 16}" y="108">${escapeXml(formatNumber(value))}</text>
    <text class="label" x="${x + 16}" y="132">${escapeXml(label)}</text>
  </g>`;
  }).join("\n");

  const chartX = 35;
  const chartY = 174;
  const chartHeight = 76;
  const barWidth = 44;
  const gap = 27;
  const bars = months.map((month, index) => {
    const x = chartX + index * (barWidth + gap);
    const rawHeight = (month.count / maxCount) * chartHeight;
    const barHeight = month.count === 0 ? 2 : Math.max(4, rawHeight);
    const y = chartY + chartHeight - barHeight;
    return `  <g>
    <rect x="${x}" y="${y.toFixed(1)}" width="${barWidth}" height="${barHeight.toFixed(1)}" rx="4" fill="#2f81f7" />
    <text class="muted" x="${x + barWidth / 2}" y="${chartY + chartHeight + 18}" text-anchor="middle">${escapeXml(month.label)}</text>
  </g>`;
  }).join("\n");

  const start = days.at(0)?.date ?? "unknown";
  const end = days.at(-1)?.date ?? "unknown";
  return svgShell({
    width,
    height,
    title: "Trailing twelve-month public GitHub activity",
    description: `Public contribution activity for ${stats.username} from ${start} through ${end}.`,
    body: `  <text class="title" x="28" y="38">Open-source activity</text>
  <text class="subtitle" x="28" y="60">Trailing twelve months of public GitHub data</text>
${metricMarkup}
${bars}
  <text class="muted" x="872" y="286" text-anchor="end">Updated ${escapeXml(end)}</text>`
  });
}

export function renderActivityMobileSvg(stats, now = new Date()) {
  const width = 420;
  const height = 430;
  const days = stats.contributionCalendar.weeks.flatMap((week) => week.contributionDays);
  const months = aggregateCalendarMonths(days, now);
  const maxCount = Math.max(...months.map((month) => month.count), 1);
  const activeDays = days.filter((day) => day.contributionCount > 0).length;
  const metrics = [
    [stats.contributionCalendar.totalContributions, "public contributions"],
    [stats.totalPullRequestContributions, "pull requests"],
    [stats.totalPullRequestReviewContributions, "reviews"],
    [activeDays, "active days"]
  ];

  const metricMarkup = metrics.map(([value, label], index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = 24 + column * 189;
    const y = 80 + row * 78;
    return [
      "  <g>",
      "    <rect class=\"panel\" x=\"" + x + "\" y=\"" + y + "\" width=\"183\" height=\"64\" rx=\"8\" />",
      "    <text class=\"metric\" x=\"" + (x + 14) + "\" y=\"" + (y + 28) + "\" style=\"font-size:22px\">" + escapeXml(formatNumber(value)) + "</text>",
      "    <text class=\"label\" x=\"" + (x + 14) + "\" y=\"" + (y + 49) + "\">" + escapeXml(label) + "</text>",
      "  </g>"
    ].join("\n");
  }).join("\n");

  const chartX = 32;
  const chartY = 252;
  const chartHeight = 92;
  const barWidth = 19;
  const gap = 10;
  const bars = months.map((month, index) => {
    const x = chartX + index * (barWidth + gap);
    const rawHeight = (month.count / maxCount) * chartHeight;
    const barHeight = month.count === 0 ? 2 : Math.max(4, rawHeight);
    const y = chartY + chartHeight - barHeight;
    return [
      "  <g>",
      "    <rect x=\"" + x + "\" y=\"" + y.toFixed(1) + "\" width=\"" + barWidth + "\" height=\"" + barHeight.toFixed(1) + "\" rx=\"4\" fill=\"#2f81f7\" />",
      "    <text class=\"muted\" x=\"" + (x + barWidth / 2) + "\" y=\"" + (chartY + chartHeight + 17) + "\" text-anchor=\"middle\" style=\"font-size:9px\">" + escapeXml(month.label) + "</text>",
      "  </g>"
    ].join("\n");
  }).join("\n");

  const end = days.at(-1)?.date ?? "unknown";
  return svgShell({
    width,
    height,
    title: "Trailing twelve-month public GitHub activity for mobile screens",
    description: "A mobile-friendly view of public contribution activity for " + stats.username + ".",
    body: [
      "  <text class=\"title\" x=\"24\" y=\"38\" style=\"font-size:20px\">Open-source activity</text>",
      "  <text class=\"subtitle\" x=\"24\" y=\"60\">Trailing twelve months of public GitHub data</text>",
      metricMarkup,
      bars,
      "  <text class=\"muted\" x=\"396\" y=\"410\" text-anchor=\"end\">Updated " + escapeXml(end) + "</text>"
    ].join("\n")
  });
}

export function renderLanguagesSvg(entries, metadata) {
  const width = 900;
  const height = 270;
  const languages = summarizeLanguages(entries);
  const total = languages.reduce((sum, entry) => sum + entry.lines, 0);

  if (languages.length === 0 || total === 0) {
    throw new Error("No supported code changes were found in merged public pull requests");
  }

  let cursor = 28;
  const barWidth = 844;
  const segments = languages.map((entry, index) => {
    const widthForEntry = index === languages.length - 1
      ? 28 + barWidth - cursor
      : (entry.lines / total) * barWidth;
    const markup = `  <rect x="${cursor.toFixed(2)}" y="86" width="${Math.max(1, widthForEntry).toFixed(2)}" height="22" fill="${entry.color}" />`;
    cursor += widthForEntry;
    return markup;
  }).join("\n");

  const legends = languages.map((entry, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = 28 + column * 422;
    const y = 142 + row * 30;
    return `  <g>
    <circle cx="${x + 6}" cy="${y - 4}" r="6" fill="${entry.color}" />
    <text class="body" x="${x + 20}" y="${y}">${escapeXml(entry.name)}</text>
    <text class="label" x="${x + 398}" y="${y}" text-anchor="end">${entry.percent.toFixed(1)}% / ${escapeXml(formatNumber(entry.lines))} lines</text>
  </g>`;
  }).join("\n");

  return svgShell({
    width,
    height,
    title: "Public automation and code mix",
    description: `Language mix derived from ${metadata.pullRequestCount} merged public pull requests over the trailing twelve months.`,
    body: `  <text class="title" x="28" y="38">Public automation and code mix</text>
  <text class="subtitle" x="28" y="60">Changed lines in merged public pull requests / trailing twelve months</text>
${segments}
${legends}
  <text class="muted" x="28" y="250">Docs, lockfiles, vendored content and generated output are excluded. This is activity, not a proficiency score.</text>`
  });
}

export function renderLanguagesMobileSvg(entries, metadata) {
  const width = 420;
  const languages = summarizeLanguages(entries);
  const total = languages.reduce((sum, entry) => sum + entry.lines, 0);

  if (languages.length === 0 || total === 0) {
    throw new Error("No supported code changes were found in merged public pull requests");
  }
  const footerY = 144 + languages.length * 30 + 40;
  const height = Math.max(280, footerY + 16);

  let cursor = 24;
  const barWidth = 372;
  const segments = languages.map((entry, index) => {
    const widthForEntry = index === languages.length - 1
      ? 24 + barWidth - cursor
      : (entry.lines / total) * barWidth;
    const markup = "  <rect x=\"" + cursor.toFixed(2) + "\" y=\"86\" width=\"" + Math.max(1, widthForEntry).toFixed(2) + "\" height=\"22\" fill=\"" + entry.color + "\" />";
    cursor += widthForEntry;
    return markup;
  }).join("\n");

  const legends = languages.map((entry, index) => {
    const y = 144 + index * 30;
    return [
      "  <g>",
      "    <circle cx=\"30\" cy=\"" + (y - 4) + "\" r=\"6\" fill=\"" + entry.color + "\" />",
      "    <text class=\"body\" x=\"44\" y=\"" + y + "\">" + escapeXml(entry.name) + "</text>",
      "    <text class=\"label\" x=\"396\" y=\"" + y + "\" text-anchor=\"end\">" + entry.percent.toFixed(1) + "% / " + escapeXml(formatNumber(entry.lines)) + " lines</text>",
      "  </g>"
    ].join("\n");
  }).join("\n");

  return svgShell({
    width,
    height,
    title: "Public automation and code mix for mobile screens",
    description: "A mobile-friendly language mix derived from " + metadata.pullRequestCount + " merged public pull requests over the trailing twelve months.",
    body: [
      "  <text class=\"title\" x=\"24\" y=\"38\" style=\"font-size:20px\">Public automation and code mix</text>",
      "  <text class=\"subtitle\" x=\"24\" y=\"60\">Changed lines in merged public pull requests</text>",
      segments,
      legends,
      "  <text class=\"muted\" x=\"24\" y=\"" + footerY + "\">Activity, not a proficiency score. Exclusions match the desktop chart.</text>"
    ].join("\n")
  });
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Number(value) || 0);
}

async function githubRequest(url, { authHeader, method = "GET", body } = {}) {
  const target = new URL(url, API_ROOT);
  if (target.origin !== API_ROOT) throw new Error("Refusing a non-GitHub API request");

  const response = await fetch(target, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${authHeader}`,
      "Content-Type": "application/json",
      "User-Agent": "yo-ddv-profile-metrics",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await response.text();
  if (!response.ok) {
    let message = text.slice(0, 400);
    try {
      message = JSON.parse(text).message ?? message;
    } catch {
      // Keep the bounded response text.
    }
    throw new Error(`GitHub API ${response.status}: ${message}`);
  }

  return {
    data: text ? JSON.parse(text) : null,
    link: response.headers.get("link")
  };
}

async function fetchContributions(username, authHeader, from, to) {
  const query = `query($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        totalCommitContributions
        totalIssueContributions
        totalPullRequestContributions
        totalPullRequestReviewContributions
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays { date contributionCount weekday }
          }
        }
      }
    }
  }`;
  const response = await githubRequest("/graphql", {
    authHeader,
    method: "POST",
    body: { query, variables: { login: username, from, to } }
  });
  const errors = response.data?.errors;
  if (errors?.length) throw new Error(`GitHub GraphQL: ${errors[0].message}`);
  const stats = response.data?.data?.user?.contributionsCollection;
  if (!stats) throw new Error(`GitHub user ${username} was not found`);
  return { username, ...stats };
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

async function fetchPages(url, authHeader, maxPages = MAX_PAGES) {
  const items = [];
  let next = url;
  for (let page = 0; next && page < maxPages; page += 1) {
    const response = await githubRequest(next, { authHeader });
    if (!Array.isArray(response.data)) throw new Error("Expected a paginated array from GitHub");
    items.push(...response.data);
    next = parseNextLink(response.link);
  }
  if (next) throw new Error(`GitHub pagination exceeded the ${maxPages}-page safety limit`);
  return items;
}

export async function fetchMergedPullRequests(
  username,
  authHeader,
  fromDate,
  { request = githubRequest, maxPages = MAX_PAGES } = {}
) {
  const query = `is:pr is:merged is:public author:${username} merged:>=${fromDate}`;
  const pullRequests = [];
  const seen = new Set();
  let expectedCount = null;

  for (let page = 1; page <= maxPages; page += 1) {
    const response = await request(
      `/search/issues?q=${encodeURIComponent(query)}&per_page=${SEARCH_PAGE_SIZE}&page=${page}`,
      { authHeader }
    );
    const payload = response.data;
    if (
      !payload ||
      !Number.isInteger(payload.total_count) ||
      payload.total_count < 0 ||
      !Array.isArray(payload.items)
    ) {
      throw new Error("Unexpected response returned by GitHub pull request search");
    }
    if (payload.incomplete_results) {
      throw new Error("GitHub pull request search returned incomplete results");
    }
    if (payload.total_count > maxPages * SEARCH_PAGE_SIZE) {
      throw new Error(
        `More than ${maxPages * SEARCH_PAGE_SIZE} merged pull requests matched; narrow or partition the search window`
      );
    }
    expectedCount ??= payload.total_count;

    for (const item of payload.items) {
      const repositoryUrl = new URL(item.repository_url);
      if (
        repositoryUrl.origin !== API_ROOT ||
        !/^\/repos\/[^/]+\/[^/]+$/.test(repositoryUrl.pathname) ||
        repositoryUrl.search ||
        repositoryUrl.hash
      ) {
        throw new Error("Unexpected repository URL returned by GitHub search");
      }
      if (!Number.isInteger(item.number) || item.number <= 0) {
        throw new Error("Unexpected pull request number returned by GitHub search");
      }
      const key = `${repositoryUrl.pathname}#${item.number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pullRequests.push({
        number: item.number,
        filesUrl: `${repositoryUrl.pathname}/pulls/${item.number}/files?per_page=100`
      });
    }

    if (pullRequests.length >= expectedCount) return pullRequests;
    if (payload.items.length < SEARCH_PAGE_SIZE) {
      throw new Error(
        `GitHub pull request search ended after ${pullRequests.length} of ${expectedCount} results`
      );
    }
  }

  throw new Error(`GitHub pull request search exceeded the ${maxPages}-page safety limit`);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  const workerCount = Math.min(Math.max(1, concurrency), items.length || 1);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function loadConfig() {
  const parsed = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  assertUsername(parsed.username);
  if (!Array.isArray(parsed.capabilities) || parsed.capabilities.length !== 5) {
    throw new Error("profile.config.json must define exactly five capability groups");
  }
  for (const capability of parsed.capabilities) {
    if (!capability.title || !Array.isArray(capability.items) || capability.items.length !== 4) {
      throw new Error("Each capability group must have a title and exactly four items");
    }
  }
  return parsed;
}

export function withProfileCardCacheToken(readme, cacheToken) {
  if (!/^[a-f0-9]{12}$/.test(cacheToken)) {
    throw new Error("Profile card cache token must be 12 lowercase hexadecimal characters");
  }

  let replacementCount = 0;
  const updatedReadme = readme.replace(PROFILE_CARD_PATTERN, (assetPath) => {
    replacementCount += 1;
    return `${assetPath.split("?")[0]}?v=${cacheToken}`;
  });

  if (replacementCount !== 6) {
    throw new Error(`Expected six profile card references in README.md, found ${replacementCount}`);
  }
  return updatedReadme;
}

export async function generateProfileAssets({ authHeader, now = new Date() }) {
  if (!authHeader) throw new Error("Set GITHUB_TOKEN or GH_TOKEN to generate live profile metrics");
  const config = await loadConfig();
  const username = assertUsername(process.env.GITHUB_USERNAME || config.username);
  const snapshotNow = normalizeSnapshotDate(now);
  const to = snapshotNow.toISOString();
  const fromDate = new Date(snapshotNow.getTime() - 365 * 24 * 60 * 60 * 1000);
  const from = fromDate.toISOString();
  const mergedSince = from.slice(0, 10);

  const contributions = await fetchContributions(username, authHeader, from, to);
  const pullRequests = await fetchMergedPullRequests(username, authHeader, mergedSince);
  const filesByPullRequest = await mapWithConcurrency(
    pullRequests,
    REQUEST_CONCURRENCY,
    (pullRequest) => fetchPages(pullRequest.filesUrl, authHeader)
  );
  const languageEntries = aggregateLanguageChanges(filesByPullRequest.flat());

  await mkdir(ASSET_DIR, { recursive: true });
  const assets = {
    "capabilities.svg": renderCapabilitiesSvg(config),
    "capabilities-mobile.svg": renderCapabilitiesMobileSvg(config),
    "activity.svg": renderActivitySvg(contributions, snapshotNow),
    "activity-mobile.svg": renderActivityMobileSvg(contributions, snapshotNow),
    "languages.svg": renderLanguagesSvg(languageEntries, { pullRequestCount: pullRequests.length }),
    "languages-mobile.svg": renderLanguagesMobileSvg(languageEntries, { pullRequestCount: pullRequests.length })
  };
  await Promise.all(Object.entries(assets).map(([name, content]) =>
    writeFile(path.join(ASSET_DIR, name), content, { encoding: "utf8", mode: 0o644 })
  ));

  const cacheHash = createHash("sha256");
  for (const name of Object.keys(assets).sort()) {
    cacheHash.update(name).update("\0").update(assets[name]);
  }
  const cacheToken = cacheHash.digest("hex").slice(0, 12);
  const readme = await readFile(README_PATH, "utf8");
  const updatedReadme = withProfileCardCacheToken(readme, cacheToken);
  if (updatedReadme !== readme) {
    await writeFile(README_PATH, updatedReadme, { encoding: "utf8", mode: 0o644 });
  }

  return {
    username,
    from,
    to,
    pullRequestCount: pullRequests.length,
    cacheToken,
    languageEntries,
    assetNames: Object.keys(assets)
  };
}

async function main() {
  const result = await generateProfileAssets({
    authHeader: process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  });
  process.stdout.write(
    `Generated ${result.assetNames.join(", ")} for ${result.username} from ${result.from} to ${result.to}\n`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
