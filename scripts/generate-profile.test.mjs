import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  aggregateCalendarMonths,
  aggregateLanguageChanges,
  assertUsername,
  escapeXml,
  fetchMergedPullRequests,
  languageForPath,
  normalizeSnapshotDate,
  renderActivitySvg,
  renderActivityMobileSvg,
  renderCapabilitiesSvg,
  renderCapabilitiesMobileSvg,
  renderLanguagesSvg,
  renderLanguagesMobileSvg,
  summarizeLanguages
} from "./generate-profile.mjs";
import { buildPreviewHtml } from "./render-preview.mjs";

test("escapeXml neutralizes SVG markup", () => {
  assert.equal(
    escapeXml('<script data-x="1">a&b</script>'),
    "&lt;script data-x=&quot;1&quot;&gt;a&amp;b&lt;/script&gt;"
  );
});

test("assertUsername accepts GitHub names and rejects unsafe input", () => {
  assert.equal(assertUsername("Yo-DDV"), "Yo-DDV");
  assert.throws(() => assertUsername("../owner"), /Invalid GitHub username/);
  assert.throws(() => assertUsername("owner--name"), /Invalid GitHub username/);
});

function searchItem(repository, number) {
  return {
    number,
    repository_url: `https://api.github.com/repos/${repository}`
  };
}

test("fetchMergedPullRequests paginates complete GitHub search results", async () => {
  const calls = [];
  const firstPage = [
    searchItem("Yo-DDV/Towk", 1),
    searchItem("ilysenko/codex-desktop-linux", 2),
    ...Array.from({ length: 98 }, (_, index) => searchItem("owner/repo", index + 3))
  ];
  const secondPage = Array.from({ length: 26 }, (_, index) => searchItem("owner/repo", index + 101));
  const request = async (url) => {
    calls.push(url);
    return {
      data: {
        total_count: 126,
        incomplete_results: false,
        items: calls.length === 1 ? firstPage : secondPage
      }
    };
  };

  const pullRequests = await fetchMergedPullRequests(
    "Yo-DDV",
    "test-token",
    "2025-07-19",
    { request }
  );

  assert.equal(pullRequests.length, 126);
  assert.equal(calls.length, 2);
  assert.match(decodeURIComponent(calls[0]), /is:public author:Yo-DDV/);
  assert.match(calls[0], /per_page=100&page=1$/);
  assert.match(calls[1], /per_page=100&page=2$/);
  assert.equal(pullRequests[0].filesUrl, "/repos/Yo-DDV/Towk/pulls/1/files?per_page=100");
  assert.equal(
    pullRequests[1].filesUrl,
    "/repos/ilysenko/codex-desktop-linux/pulls/2/files?per_page=100"
  );
  assert.equal(pullRequests.at(-1).filesUrl, "/repos/owner/repo/pulls/126/files?per_page=100");
});

test("fetchMergedPullRequests rejects incomplete GitHub search results", async () => {
  const request = async () => ({
    data: { total_count: 1, incomplete_results: true, items: [searchItem("owner/repo", 1)] }
  });

  await assert.rejects(
    fetchMergedPullRequests("Yo-DDV", "test-token", "2025-07-19", { request }),
    /returned incomplete results/
  );
});

test("fetchMergedPullRequests enforces its bounded pagination limit", async () => {
  const request = async () => ({
    data: { total_count: 1001, incomplete_results: false, items: [] }
  });

  await assert.rejects(
    fetchMergedPullRequests("Yo-DDV", "test-token", "2025-07-19", { request }),
    /More than 1000 merged pull requests matched/
  );
});

test("fetchMergedPullRequests rejects an early partial page", async () => {
  const request = async () => ({
    data: { total_count: 2, incomplete_results: false, items: [searchItem("owner/repo", 1)] }
  });

  await assert.rejects(
    fetchMergedPullRequests("Yo-DDV", "test-token", "2025-07-19", { request }),
    /ended after 1 of 2 results/
  );
});

test("fetchMergedPullRequests rejects malformed counters and repository URLs", async () => {
  const negativeCount = async () => ({
    data: { total_count: -1, incomplete_results: false, items: [] }
  });
  await assert.rejects(
    fetchMergedPullRequests("Yo-DDV", "test-token", "2025-07-19", { request: negativeCount }),
    /Unexpected response/
  );

  const foreignRepository = async () => ({
    data: {
      total_count: 1,
      incomplete_results: false,
      items: [{ number: 1, repository_url: "https://example.com/repos/owner/repo" }]
    }
  });
  await assert.rejects(
    fetchMergedPullRequests("Yo-DDV", "test-token", "2025-07-19", { request: foreignRepository }),
    /Unexpected repository URL/
  );
});

test("languageForPath classifies automation files and excludes generated content", () => {
  assert.equal(languageForPath("scripts/deploy.sh"), "Shell");
  assert.equal(languageForPath(".github/workflows/ci.yml"), "YAML");
  assert.equal(languageForPath("Dockerfile"), "Dockerfile");
  assert.equal(languageForPath("src/main.rs"), "Rust");
  assert.equal(languageForPath("docs/runbook.md"), null);
  assert.equal(languageForPath("app/dist/bundle.js"), null);
  assert.equal(languageForPath("package-lock.json"), null);
});

test("aggregateLanguageChanges sums additions and deletions without negative values", () => {
  const entries = aggregateLanguageChanges([
    { filename: "src/main.js", additions: 10, deletions: 2 },
    { filename: "test/main.test.js", additions: 4, deletions: 1 },
    { filename: "src/main.rs", additions: 7, deletions: 3 },
    { filename: "README.md", additions: 100, deletions: 0 },
    { filename: "scripts/empty.py", additions: -4, deletions: 2 }
  ]);
  assert.deepEqual(entries, [
    { name: "JavaScript", lines: 17 },
    { name: "Rust", lines: 10 },
    { name: "Python", lines: 2 }
  ]);
});

test("aggregateCalendarMonths returns twelve ordered calendar buckets", () => {
  const months = aggregateCalendarMonths([
    { date: "2026-06-30", contributionCount: 2 },
    { date: "2026-07-01", contributionCount: 3 }
  ], new Date("2026-07-10T12:00:00Z"));
  assert.equal(months.length, 12);
  assert.deepEqual(months.slice(-2), [
    { key: "2026-06", label: "Jun", count: 2 },
    { key: "2026-07", label: "Jul", count: 3 }
  ]);
});

test("normalizeSnapshotDate makes same-day generations deterministic", () => {
  assert.equal(
    normalizeSnapshotDate(new Date("2026-07-10T00:01:02Z")).toISOString(),
    "2026-07-10T23:59:59.000Z"
  );
  assert.equal(
    normalizeSnapshotDate(new Date("2026-07-10T23:58:59Z")).toISOString(),
    "2026-07-10T23:59:59.000Z"
  );
  assert.throws(() => normalizeSnapshotDate(new Date("invalid")), /Invalid snapshot date/);
});

test("summarizeLanguages keeps the largest entries and folds the remainder", () => {
  const summary = summarizeLanguages([
    { name: "JavaScript", lines: 50 },
    { name: "Rust", lines: 25 },
    { name: "Shell", lines: 15 },
    { name: "Python", lines: 10 }
  ], 2);
  assert.deepEqual(summary.map(({ name, lines }) => ({ name, lines })), [
    { name: "JavaScript", lines: 50 },
    { name: "Rust", lines: 25 },
    { name: "Other", lines: 25 }
  ]);
  assert.equal(summary.reduce((sum, entry) => sum + entry.percent, 0), 100);
});

test("summarizeLanguages folds visually insignificant entries into Other", () => {
  const summary = summarizeLanguages([
    { name: "JavaScript", lines: 900 },
    { name: "Rust", lines: 95 },
    { name: "Python", lines: 4 },
    { name: "Makefile", lines: 1 }
  ]);
  assert.deepEqual(summary.map(({ name, lines }) => ({ name, lines })), [
    { name: "JavaScript", lines: 900 },
    { name: "Rust", lines: 95 },
    { name: "Other", lines: 5 }
  ]);
});

test("renderers emit accessible, bounded SVG documents", () => {
  const config = {
    name: "Example & Co",
    capabilities: Array.from({ length: 5 }, (_, index) => ({
      title: `Group ${index + 1}`,
      color: "#2f81f7",
      items: ["One", "Two", "Three", "Four"]
    }))
  };
  const stats = {
    username: "Yo-DDV",
    totalPullRequestContributions: 4,
    totalPullRequestReviewContributions: 2,
    contributionCalendar: {
      totalContributions: 8,
      weeks: [{ contributionDays: [
        { date: "2026-07-09", contributionCount: 3, weekday: 4 },
        { date: "2026-07-10", contributionCount: 5, weekday: 5 }
      ] }]
    }
  };
  const outputs = [
    renderCapabilitiesSvg(config),
    renderCapabilitiesMobileSvg(config),
    renderActivitySvg(stats, new Date("2026-07-10T12:00:00Z")),
    renderActivityMobileSvg(stats, new Date("2026-07-10T12:00:00Z")),
    renderLanguagesSvg([
      { name: "Shell", lines: 12 },
      { name: "Python", lines: 8 }
    ], { pullRequestCount: 3 }),
    renderLanguagesMobileSvg([
      { name: "Shell", lines: 12 },
      { name: "Python", lines: 8 }
    ], { pullRequestCount: 3 })
  ];

  for (const svg of outputs) {
    assert.match(svg, /^<svg /);
    assert.match(svg, /<title id="title">/);
    assert.match(svg, /<desc id="desc">/);
    assert.match(svg, /role="img"/);
    assert.match(svg, /@media \(prefers-color-scheme: dark\)/);
    assert.doesNotMatch(svg, /<script/i);
    assert.match(svg, /<\/svg>\n$/);
  }
  assert.match(outputs[0], /Example &amp; Co/);
});

test("README prose avoids hard-wrapped paragraphs that GitHub renders as visible breaks", () => {
  const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
  const plainRuns = [];
  let currentRun = [];

  for (const [index, line] of readme.split("\n").entries()) {
    const trimmed = line.trim();
    const plainProse = Boolean(trimmed) &&
      !/^(#|[-*] |\d+\. |<|>|!?\[|`{3}|<!--|\*\*)/.test(trimmed);

    if (plainProse) {
      currentRun.push(index + 1);
      continue;
    }

    if (currentRun.length > 1) plainRuns.push([...currentRun]);
    currentRun = [];
  }
  if (currentRun.length > 1) plainRuns.push([...currentRun]);

  assert.deepEqual(plainRuns, []);
});

test("preview HTML wraps GitHub-rendered markdown with document CSS", () => {
  const html = buildPreviewHtml("<h1>Profile</h1>", "body { color: red; }");
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<main class="markdown-body">/);
  assert.match(html, /<style>body \{ color: red; \}<\/style>/);
  assert.match(html, /<meta name="viewport"/);
});

test("capability map labels stay specific and compact", () => {
  const config = JSON.parse(readFileSync(fileURLToPath(new URL("../profile.config.json", import.meta.url)), "utf8"));
  const labels = config.capabilities.flatMap((capability) => capability.items);
  const weakLabels = [
    "Linux-first operations",
    "Windows Server services",
    "Debian, Ubuntu and RHEL-family",
    "Hardening and recovery",
    "VPS and hosting operations",
    "Monitoring, backup and DR",
    "Runbooks and documentation"
  ];

  assert.deepEqual(labels.filter((label) => weakLabels.includes(label)), []);
  assert.equal(labels.length, 20);
  assert.equal(labels.every((label) => label.length <= 32), true);
});

test("public profile stays focused on technical inventory", () => {
  const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
  const headings = [...readme.matchAll(/^## .+$/gm)].map((match) => match[0]);
  assert.deepEqual(headings, ["## Technical stack", "## Public activity", "## Contact"]);
  assert.doesNotMatch(readme, /\bI (work|like|contribute|am)\b/);
});
