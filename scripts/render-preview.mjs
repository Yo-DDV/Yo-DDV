import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const CACHE_DIR = path.join(ROOT_DIR, ".profile-cache");
const PREVIEW_PATH = path.join(CACHE_DIR, "preview.html");

const PREVIEW_FRAME_CSS = `
body {
  margin: 0;
  background: #f6f8fa;
  color: #1f2328;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.markdown-body {
  box-sizing: border-box;
  max-width: 980px;
  margin: 32px auto;
  padding: 40px;
  background: #ffffff;
  border: 1px solid #d0d7de;
  border-radius: 8px;
  font-size: 16px;
  line-height: 1.5;
}

.markdown-body h1,
.markdown-body h2,
.markdown-body h3 {
  line-height: 1.25;
}

.markdown-body h1 {
  font-size: 2em;
  margin: 0.67em 0;
}

.markdown-body h2 {
  margin-top: 24px;
  padding-bottom: 0.3em;
  border-bottom: 1px solid #d8dee4;
  font-size: 1.5em;
}

.markdown-body h3 {
  margin-top: 24px;
  font-size: 1.25em;
}

.markdown-body p,
.markdown-body ul,
.markdown-body details {
  margin-top: 0;
  margin-bottom: 16px;
}

.markdown-body img {
  max-width: 100%;
  box-sizing: content-box;
}

@media (max-width: 640px) {
  body {
    background: #ffffff;
  }

  .markdown-body {
    margin: 0;
    padding: 20px 16px;
    border: 0;
    border-radius: 0;
  }
}
`;

const FALLBACK_MARKDOWN_CSS = PREVIEW_FRAME_CSS;

export function buildPreviewHtml(markdownHtml, css = FALLBACK_MARKDOWN_CSS) {
  const body = markdownHtml.trim().startsWith("<main")
    ? markdownHtml.trim()
    : `<main class="markdown-body">\n${markdownHtml.trim()}\n</main>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Yo-DDV GitHub profile preview</title>
  <style>${css}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function renderGitHubMarkdown() {
  return run("gh", [
    "api",
    "markdown",
    "-f",
    "mode=gfm",
    "-f",
    "context=Yo-DDV/Yo-DDV",
    "-F",
    "text=@README.md"
  ]);
}

async function loadPreviewCss() {
  try {
    const githubCss = await readFile(path.join(CACHE_DIR, "github-markdown.css"), "utf8");
    return `${githubCss}\n${PREVIEW_FRAME_CSS}`;
  } catch {
    return FALLBACK_MARKDOWN_CSS;
  }
}

function chromeExecutable() {
  for (const candidate of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]) {
    const result = spawnSync("which", [candidate], { encoding: "utf8" });
    if (result.status === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  }
  throw new Error("No Chrome or Chromium executable found for screenshot capture");
}

function screenshot(previewPath, outputPath, width, height) {
  run(chromeExecutable(), [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--virtual-time-budget=5000",
    `--window-size=${width},${height}`,
    `--screenshot=${outputPath}`,
    pathToFileURL(previewPath).href
  ]);
}

export async function renderPreview() {
  await mkdir(CACHE_DIR, { recursive: true });

  const markdownHtml = renderGitHubMarkdown();
  const css = await loadPreviewCss();
  const previewHtml = buildPreviewHtml(markdownHtml, css);

  await writeFile(PREVIEW_PATH, previewHtml);
  screenshot(PREVIEW_PATH, path.join(CACHE_DIR, "profile-desktop-full.png"), 1440, 5600);
  screenshot(PREVIEW_PATH, path.join(CACHE_DIR, "profile-mobile.png"), 430, 7800);

  return {
    preview: PREVIEW_PATH,
    desktop: path.join(CACHE_DIR, "profile-desktop-full.png"),
    mobile: path.join(CACHE_DIR, "profile-mobile.png")
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  renderPreview()
    .then((result) => {
      console.log(`preview: ${result.preview}`);
      console.log(`desktop: ${result.desktop}`);
      console.log(`mobile: ${result.mobile}`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
