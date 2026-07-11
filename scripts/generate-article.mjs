// Weekly engineering article generator.
// Run by .github/workflows/weekly-article.yml on a cron schedule.
//
// What it does:
//   1. Reads data/used-article-topics.json (topics already published)
//   2. Asks Gemini for ONE new article's CONTENT as plain text/JSON only —
//      title, intro, sections (heading + paragraphs + optional bullets),
//      closing. Gemini never writes HTML; the script renders it through a
//      fixed template (buildArticleBodyHtml) so every article gets
//      identical paragraph/heading/list styling, and rejects the response
//      if it looks like leftover assistant chatter ("let me know if...",
//      "best regards", etc.) rather than publish it.
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
// Row insertion is structural, not marker-based: it locates the
// #articles-grid container and each .article-category block by counting
// balanced <div> tags, so it works against the page as it actually exists —
// no hand-placed comment markers required. It still relies on the literal
// "<!-- AUTO-ARTICLES:START (script inserts new full article as first child here) -->"
// comment for the full write-up section; if that section of the page is ever
// redesigned, update ARTICLE_MARKER below to match.

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
    intro: {
      type: "STRING",
      description:
        "Opening paragraph, plain text, no HTML, no markdown. 2-4 sentences introducing the topic and why it matters.",
    },
    sections: {
      type: "ARRAY",
      description: "3-5 body sections, each with a subheading and 1-2 supporting paragraphs, optionally a bullet list.",
      items: {
        type: "OBJECT",
        properties: {
          heading: { type: "STRING", description: "Short subheading, plain text, no HTML." },
          paragraphs: {
            type: "ARRAY",
            items: { type: "STRING" },
            description: "1-2 plain-text paragraphs for this section, no HTML, no markdown.",
          },
          bullets: {
            type: "ARRAY",
            items: { type: "STRING" },
            description: "Optional: 0 or 3-5 plain-text bullet points for this section, no HTML, no markdown, no leading dashes/bullets.",
          },
        },
        required: ["heading", "paragraphs"],
      },
    },
    closing: {
      type: "STRING",
      description:
        "Closing paragraph, plain text, no HTML, no markdown. 1-2 sentences that naturally point back to Murtaza Corporation's relevant product range.",
    },
    closing_link_page: {
      type: "STRING",
      description:
        "One relative page filename to link from inside the closing paragraph, e.g. 'pipes.html'. Must be one of: pipes.html, fittings.html, valves.html, flanges.html, tubes.html, dairy-tubes.html, mill-test-report.html, services.html, company-profile.html, lor.html. Leave empty string if none fits naturally.",
    },
  },
  required: ["slug", "title", "category", "read_time_minutes", "excerpt", "intro", "sections", "closing", "closing_link_page"],
};

const VALID_LINK_PAGES = [
  "pipes.html",
  "fittings.html",
  "valves.html",
  "flanges.html",
  "tubes.html",
  "dairy-tubes.html",
  "mill-test-report.html",
  "services.html",
  "company-profile.html",
  "lor.html",
];

async function generateArticle(existingTopics) {
  const coveredList = existingTopics.map((t) => `- ${t.title} (${t.category})`).join("\n");

  const prompt = `You are writing one new engineering article for the "Engineering Articles" page of Murtaza Corporation, a Karachi, Pakistan-based stainless steel & carbon steel pipe, tube, fitting, flange and valve distributor/stockist.

Audience: engineers, procurement staff, and contractors who buy piping materials.
Tone: practical, precise, no marketing fluff, matches an established engineering reference article.

Topics already published (do NOT repeat these or anything essentially the same):
${coveredList || "(none yet)"}

You MUST set "category" to exactly one of: ${ALLOWED_CATEGORIES.join(", ")}.

Pick ONE new, genuinely useful topic relevant to stainless/carbon steel pipes, tubes, fittings, flanges, valves, or dairy/hygienic piping. Return only real, generally accepted engineering information — do not fabricate specific standard numbers or figures you're not confident about; keep such references general if unsure.

Write all text fields as PLAIN TEXT ONLY — no HTML tags, no markdown (no **, no #, no leading "-" or "*" on bullets), no leftover assistant-style phrasing ("Sure, here's...", "Let me know if...", "I hope this helps", "Best regards", sign-offs, or any mention of being an AI). Every text field is inserted directly into a fixed, pre-styled HTML template by code — do not include any markup or formatting characters yourself.

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

  // Only allow a link page from the known-good list; drop anything else.
  if (!VALID_LINK_PAGES.includes(parsed.closing_link_page)) {
    parsed.closing_link_page = "";
  }

  assertNoLeakedMetaCommentary(parsed);

  return parsed;
}

// Reject the whole article if any text field looks like leftover
// assistant-style chatter rather than article content. Fail loud (the
// workflow run errors out) rather than silently publishing junk — a missed
// week is far cheaper than an AI sign-off showing up on the live site.
const META_COMMENTARY_PATTERNS = [
  /\bas an ai\b/i,
  /\bi (cannot|can't|am unable to)\b/i,
  /\blet me know if\b/i,
  /\bfeel free to\b/i,
  /\bi hope this helps\b/i,
  /\bbest regards\b/i,
  /\bsincerely\b/i,
  /^(sure|certainly|okay|here'?s|here is)[,.:]?\s/i,
];

function assertNoLeakedMetaCommentary(article) {
  const allText = [
    article.title,
    article.excerpt,
    article.intro,
    article.closing,
    ...(article.sections || []).flatMap((s) => [s.heading, ...(s.paragraphs || []), ...(s.bullets || [])]),
  ].join("\n");

  for (const pattern of META_COMMENTARY_PATTERNS) {
    if (pattern.test(allText)) {
      throw new Error(
        `Generated content looks like it contains leaked assistant chatter (matched ${pattern}) — rejecting rather than publishing. Try re-running the workflow.`
      );
    }
  }
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

// ---------------------------------------------------------------------
// FIXED ARTICLE TEMPLATE
// This is the single source of truth for article-body styling. Gemini
// never supplies HTML — only plain text — so every article renders with
// identical paragraph spacing, heading style, and list formatting no
// matter what the model returns.
// ---------------------------------------------------------------------
const STYLE_PARAGRAPH = 'color:var(--color-ink);font-size:16px;line-height:1.75;margin:0 0 16px;';
const STYLE_PARAGRAPH_LAST = 'color:var(--color-ink);font-size:16px;line-height:1.75;margin:0;';
const STYLE_HEADING = 'margin:24px 0 10px;font-size:17px;font-weight:600;';
const STYLE_LIST = 'margin:0 0 16px;';
const STYLE_LINK = 'color:var(--color-ink);text-decoration:underline;';

function paragraphHtml(text, isLast) {
  return `<p style="${isLast ? STYLE_PARAGRAPH_LAST : STYLE_PARAGRAPH}">${escapeHtml(text)}</p>`;
}

function bulletsHtml(items) {
  if (!items || items.length === 0) return "";
  const lis = items.map((item) => `<li>${escapeHtml(item)}</li>`).join("\n        ");
  return `<ul class="stock-list" style="${STYLE_LIST}">\n        ${lis}\n      </ul>`;
}

// Renders the closing paragraph with an optional inline link to one of the
// site's own pages, appended as a trailing sentence-style link — kept
// separate from free-text link insertion so we never trust the model to
// hand-place an <a> tag itself.
function closingParagraphHtml(text, linkPage) {
  const escaped = escapeHtml(text);
  if (!linkPage) return `<p style="${STYLE_PARAGRAPH_LAST}">${escaped}</p>`;
  const label = linkPage.replace(/-/g, " ").replace(".html", "");
  return `<p style="${STYLE_PARAGRAPH_LAST}">${escaped} See our <a href="${linkPage}" style="${STYLE_LINK}">${escapeHtml(label)}</a> page for more.</p>`;
}

function buildArticleBodyHtml(article) {
  const parts = [];

  parts.push(paragraphHtml(article.intro, false));

  for (const section of article.sections || []) {
    parts.push(`<h4 style="${STYLE_HEADING}">${escapeHtml(section.heading)}</h4>`);
    const paragraphs = section.paragraphs || [];
    paragraphs.forEach((p) => parts.push(paragraphHtml(p, false)));
    const bullets = bulletsHtml(section.bullets);
    if (bullets) parts.push(bullets);
  }

  parts.push(closingParagraphHtml(article.closing, article.closing_link_page));

  return parts.join("\n\n      ");
}

function buildArticleHtml(article, num) {
  return `    <div id="${article.slug}" style="margin-top:56px;padding-top:24px;border-top:1px solid #ececec;scroll-margin-top:110px;">
      <p class="eyebrow" style="margin:0 0 8px;">Article ${num} &middot; ${escapeHtml(
    article.category
  )} &middot; ${article.read_time_minutes} min read</p>
      <h3 style="font-size:26px;font-weight:600;margin:0 0 20px;">${escapeHtml(article.title)}</h3>

      ${buildArticleBodyHtml(article)}

      <a href="#articles-grid" class="btn btn-ghost btn-sm" style="margin-top:24px;">&uarr; Back to articles</a>
    </div>
`;
}

function buildNewCategoryBlockHtml(category, rowHtml) {
  return `      <div class="article-category" data-category="${escapeHtml(category)}">
        <p class="article-category-label">${escapeHtml(category)} <span class="count">(1)</span></p>
        <div class="article-category-rows">
${rowHtml}        </div>
      </div>
`;
}

// Structural HTML helpers — no reliance on hand-placed marker comments.
// Given the index of the "<" of an opening <div ...> tag, returns the index
// of the "<" of its matching closing </div>, by counting nested divs.
function findMatchingDivClose(html, openTagStart) {
  const tagEnd = html.indexOf(">", openTagStart);
  if (tagEnd === -1) throw new Error("Malformed HTML: unterminated opening <div> tag.");
  let depth = 1;
  let pos = tagEnd + 1;
  while (depth > 0) {
    const nextOpen = html.indexOf("<div", pos);
    const nextClose = html.indexOf("</div>", pos);
    if (nextClose === -1) throw new Error("Malformed HTML: unbalanced <div> tags, no matching close found.");
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      pos = nextOpen + 4;
    } else {
      depth--;
      pos = nextClose + 6;
      if (depth === 0) return nextClose;
    }
  }
}

function getArticlesGridContainer(html) {
  const openMatch = html.match(/<div class="articles-compact[^"]*"[^>]*id="articles-grid"[^>]*>/);
  if (!openMatch) {
    throw new Error('Could not find the #articles-grid container ("articles-compact" div) — the page structure may have changed.');
  }
  const openStart = html.indexOf(openMatch[0]);
  const openTagEnd = openStart + openMatch[0].length;
  const closeStart = findMatchingDivClose(html, openStart);
  return { openStart, openTagEnd, closeStart };
}

function findCategoryBlocks(html, gridStart, gridEnd) {
  const blocks = [];
  const openRe = /<div class="article-category" data-category="([^"]*)">/g;
  openRe.lastIndex = gridStart;
  let m;
  while ((m = openRe.exec(html)) !== null) {
    if (m.index >= gridEnd) break;
    const closeStart = findMatchingDivClose(html, m.index);
    blocks.push({ category: m[1], openStart: m.index, openTagEnd: m.index + m[0].length, closeStart });
  }
  return blocks;
}

function insertRow(html, article, num) {
  const rowHtml = buildRowHtml(article, num);

  const grid = getArticlesGridContainer(html);
  const categoryBlocks = findCategoryBlocks(html, grid.openTagEnd, grid.closeStart);

  const target = categoryBlocks.find(
    (b) => normalizeCategory(b.category) === normalizeCategory(article.category)
  );

  if (target) {
    // Find the .article-category-rows div inside this category block and
    // insert the new row as its first child; bump the displayed count.
    const rowsOpenMatch = html
      .slice(target.openTagEnd, target.closeStart)
      .match(/<div class="article-category-rows">/);
    if (!rowsOpenMatch) {
      throw new Error(`Category "${article.category}" block found, but its .article-category-rows div is missing.`);
    }
    const rowsOpenStart = target.openTagEnd + rowsOpenMatch.index;
    const insertAt = rowsOpenStart + rowsOpenMatch[0].length;

    let updated = html.slice(0, insertAt) + `\n${rowHtml}` + html.slice(insertAt);

    // Bump the count badge — search only within this category's label (before insertAt).
    updated = updated.replace(
      new RegExp(
        `(data-category="${target.category.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}">[\\s\\S]*?<span class="count">\\()(\\d+)(\\)<\\/span>)`
      ),
      (_, a, n, c) => `${a}${Number(n) + 1}${c}`
    );
    return updated;
  }

  // No matching category yet — create a new one, appended as the last
  // category block inside the grid container.
  const newBlock = buildNewCategoryBlockHtml(article.category, rowHtml);
  return html.slice(0, grid.closeStart) + newBlock + html.slice(grid.closeStart);
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

