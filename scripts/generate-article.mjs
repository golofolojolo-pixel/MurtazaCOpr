// Weekly engineering article generator.
// Run by .github/workflows/weekly-article.yml on a cron schedule.
//
// What it does:
//   1. Reads data/used-article-topics.json (topics already published)
//   2. Asks Gemini for ONE new article (JSON), telling it what's already covered
//      and restricting it to a fixed set of category names
//   3. Builds the compact row HTML + full article block in the site's existing style
//   4. Inserts the row into the matching <div class="article-category" data-category="...">
//      block (creating a new category block if none matches), and the full
//      article at the top of the AUTO-ARTICLES block
//   5. Assigns each article a permanent, never-renumbered display number
//      (equal to its position in used-article-topics.json at publish time)
//   6. Appends the new topic to data/used-article-topics.json
//
// Requires: GEMINI_API_KEY env var (set as a GitHub Actions secret)
//
// IMPORTANT: engineering-articles.html must contain these markers for
// insertion to work — if the page is ever redesigned again, update the
// markers here AND in the HTML together:
//   <!-- CATEGORIES:END -->             (end of the whole articles-compact block, for new categories)
//   <!-- ROWS:START -->  / <!-- ROWS:END -->   (inside each .article-category-rows)
//   <!-- AUTO-ARTICLES:START (script inserts new full article as first child here) -->

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const HTML_PATH = path.join(ROOT, "engineering-articles.html");
const TOPICS_PATH = path.join(ROOT, "data", "used-article-topics.json");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";

if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY env var.");
  process.exit(1);
}

// Fixed, closed list of categories. Gemini MUST pick one of these — this is
// what stops category-name drift (e.g. "Standards & Codes" vs "Standards &amp; Codes"
// vs "Standards and Codes" all being treated as different groups).
const ALLOWED_CATEGORIES = [
  "Materials",
  "Piping Design",
  "Quality & Traceability",
  "Standards & Codes",
  "Fabrication",
  "Corrosion Prevention",
  "Valves & Flow Control",
];

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Treat "&" and "&amp;" (and stray whitespace/case) as the same category.
function normalizeCategory(str) {
  return String(str)
    .replaceAll("&amp;", "&")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

async function loadTopics() {
  try {
    const raw = await readFile(TOPICS_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveTopics(topics) {
  await writeFile(TOPICS_PATH, JSON.stringify(topics, null, 2) + "\n", "utf8");
}

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    slug: {
      type: "STRING",
      description:
        "kebab-case id, e.g. 'welding-stainless-steel'. Must be unique, no spaces, no punctuation besides hyphens.",
    },
    title: { type: "STRING", description: "Article title, plain text, no HTML." },
    category: {
      type: "STRING",
      description:
        `Must be EXACTLY one of these strings, character for character: ${ALLOWED_CATEGORIES.map((c) => `"${c}"`).join(", ")}. Do not invent a new category and do not use HTML entities.`,
    },
    read_time_minutes: { type: "INTEGER" },
    excerpt: {
      type: "STRING",
      description: "1-2 sentence teaser for the preview row, plain text, no HTML, under 160 characters.",
    },
    body_html: {
      type: "STRING",
      description:
        "The full article body as inner HTML only (no outer <div>/<html>). Use <h4 style=\"margin:24px 0 10px;font-size:17px;font-weight:600;\"> for subheadings, <p style=\"color:var(--color-ink);font-size:16px;line-height:1.75;margin:0 0 16px;\"> for paragraphs (last paragraph margin:0), and <ul class=\"stock-list\" style=\"margin:0 0 16px;\"><li>...</li></ul> for bullet lists. 500-800 words, 4-6 sections. Where relevant, link to the site's own pages using plain relative hrefs like pipes.html, fittings.html, valves.html, flanges.html, tubes.html, dairy-tubes.html, mill-test-report.html, services.html, company-profile.html, lor.html, styled as <a href=\"...\" style=\"color:var(--color-ink);text-decoration:underline;\">. Do not invent statistics, standards numbers, or certifications you are not confident about; keep claims general and accurate. Escape any literal '&' as '&amp;'.",
    },
  },
  required: ["slug", "title", "category", "read_time_minutes", "excerpt", "body_html"],
};

async function generateArticle(existingTopics) {
  const coveredList = existingTopics.map((t) => `- ${t.title} (${t.category})`).join("\n");

  const prompt = `You are writing one new engineering article for the "Engineering Articles" page of Murtaza Corporation, a Karachi, Pakistan-based stainless steel & carbon steel pipe, tube, fitting, flange and valve distributor/stockist.

Audience: engineers, procurement staff, and contractors who buy piping materials.
Tone: practical, precise, no marketing fluff, matches an established engineering reference article.

Topics already published (do NOT repeat these or anything essentially the same):
${coveredList || "(none yet)"}

You MUST set "category" to exactly one of: ${ALLOWED_CATEGORIES.join(", ")}.

Pick ONE new, genuinely useful topic relevant to stainless/carbon steel pipes, tubes, fittings, flanges, valves, or dairy/hygienic piping. Return only real, generally accepted engineering information — do not fabricate specific standard numbers or figures you're not confident about; keep such references general if unsure.

Respond only with the JSON object matching the given schema.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0.8,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no content: " + JSON.stringify(data));

  const parsed = JSON.parse(text);

  // Belt-and-suspenders: coerce whatever Gemini returned to the closest
  // allowed category rather than trusting it blindly.
  const normalized = normalizeCategory(parsed.category);
  const match = ALLOWED_CATEGORIES.find((c) => normalizeCategory(c) === normalized);
  parsed.category = match || ALLOWED_CATEGORIES[0];

  return parsed;
}

function buildRowHtml(article, num) {
  return `          <a class="article-row" href="#${article.slug}">
            <span class="article-row-num">${num}</span>
            <span class="article-row-body">
              <span class="article-row-title">${escapeHtml(article.title)}</span>
              <span class="article-row-excerpt">${escapeHtml(article.excerpt)}</span>
            </span>
            <span class="article-row-meta">${article.read_time_minutes} min read</span>
            <span class="article-row-arrow">&rarr;</span>
          </a>
`;
}

function buildArticleHtml(article, num) {
  return `    <div id="${article.slug}" style="margin-top:56px;padding-top:24px;border-top:1px solid #ececec;scroll-margin-top:110px;">
      <p class="eyebrow" style="margin:0 0 8px;">Article ${num} &middot; ${escapeHtml(
    article.category
  )} &middot; ${article.read_time_minutes} min read</p>
      <h3 style="font-size:26px;font-weight:600;margin:0 0 20px;">${escapeHtml(article.title)}</h3>

      ${article.body_html}

      <a href="#articles-grid" class="btn btn-ghost btn-sm" style="margin-top:24px;">&uarr; Back to articles</a>
    </div>
`;
}

function buildNewCategoryBlockHtml(category, rowHtml) {
  return `      <div class="article-category" data-category="${escapeHtml(category)}">
        <p class="article-category-label">${escapeHtml(category)} <span class="count">(1)</span></p>
        <div class="article-category-rows">
          <!-- ROWS:START -->
${rowHtml}          <!-- ROWS:END -->
        </div>
      </div>
`;
}

function insertRow(html, article, num) {
  const rowHtml = buildRowHtml(article, num);

  // Find every existing category block and check for a normalized match.
  const categoryBlockRegex =
    /<div class="article-category" data-category="([^"]*)">([\s\S]*?)<\/div>\s*<\/div>/g;

  let match;
  let target = null;
  while ((match = categoryBlockRegex.exec(html)) !== null) {
    if (normalizeCategory(match[1]) === normalizeCategory(article.category)) {
      target = match;
      break;
    }
  }

  if (target) {
    // Insert as the first row inside this category's ROWS:START marker,
    // and bump the displayed count.
    const [fullBlock] = target;
    const updatedBlock = fullBlock
      .replace("<!-- ROWS:START -->", `<!-- ROWS:START -->\n${rowHtml}`)
      .replace(/(<span class="count">\()(\d+)(\)<\/span>)/, (_, a, n, c) => `${a}${Number(n) + 1}${c}`);
    return html.slice(0, target.index) + updatedBlock + html.slice(target.index + fullBlock.length);
  }

  // No matching category yet — create a new one, appended before CATEGORIES:END.
  const newBlock = buildNewCategoryBlockHtml(article.category, rowHtml);
  const marker = "<!-- CATEGORIES:END -->";
  if (!html.includes(marker)) {
    throw new Error("CATEGORIES:END marker not found — cannot add a new category block.");
  }
  return html.replace(marker, `${newBlock}${marker}`);
}

async function main() {
  const topics = await loadTopics();
  const article = await generateArticle(topics);

  if (topics.some((t) => t.slug === article.slug)) {
    article.slug = `${article.slug}-${Date.now().toString(36)}`;
  }

  const html = await readFile(HTML_PATH, "utf8");

  // Permanent number — assigned once, never recalculated from DOM position.
  const num = String(topics.length + 1).padStart(2, "0");

  let updated = insertRow(html, article, num);

  const articleHtml = buildArticleHtml(article, num);
  const articleMarker =
    "<!-- AUTO-ARTICLES:START (script inserts new full article as first child here) -->";
  if (!updated.includes(articleMarker)) {
    throw new Error("AUTO-ARTICLES:START marker not found — engineering-articles.html may have been restructured.");
  }
  updated = updated.replace(articleMarker, `${articleMarker}\n${articleHtml}`);

  await writeFile(HTML_PATH, updated, "utf8");

  topics.push({
    slug: article.slug,
    title: article.title,
    category: article.category, // always the clean, non-escaped form
    date_added: new Date().toISOString().slice(0, 10),
  });
  await saveTopics(topics);

  if (process.env.GITHUB_ENV) {
    await writeFile(
      process.env.GITHUB_ENV,
      `ARTICLE_TITLE=${article.title.replace(/\n/g, " ")}\n`,
      { flag: "a" }
    );
  }

  console.log(`Added article: ${article.title} (${article.slug}, #${num}, ${article.category})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
