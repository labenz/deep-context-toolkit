#!/usr/bin/env bun
/**
 * Wiki Index & Cross-Reference Generator
 *
 * Scans all .md articles in the wiki, parses frontmatter and links,
 * and generates:
 *   1. _backlinks.json — inverse link mapping
 *   2. _entity-registry.json — name/alias → article path lookup
 *   3. _index.md — root index with orientation and category listing
 *   4. Per-category _index.md files
 *   5. README.md — agent-facing orientation
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join, relative, basename, dirname } from "path";

// The script sits at the wiki repo root; derive the root from its own location
// so the toolkit is portable (no hardcoded install path).
const WIKI_ROOT = import.meta.dir;
const CATEGORIES = ["people", "organizations", "projects", "positions", "expertise", "timeline"];

// ─── Types ───────────────────────────────────────────────────────────────────

interface Article {
  id: string;           // e.g. "people/jane-doe"
  slug: string;         // e.g. "jane-doe"
  category: string;     // e.g. "people"
  filePath: string;     // absolute path
  title: string;        // from frontmatter
  tags: string[];       // from frontmatter
  overviewFirstSentence: string;  // first sentence of Overview section
  outgoingLinks: string[];        // article IDs this article links to
  rawContent: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseFrontmatter(content: string): Record<string, any> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const yaml = match[1];
  const result: Record<string, any> = {};
  for (const line of yaml.split("\n")) {
    const kvMatch = line.match(/^(\w[\w-]*):\s*(.+)/);
    if (kvMatch) {
      const [, key, rawVal] = kvMatch;
      let val = rawVal.trim();
      // Handle arrays like [tag1, tag2, tag3]
      if (val.startsWith("[") && val.endsWith("]")) {
        val = val.slice(1, -1);
        result[key] = val.split(",").map(s => s.trim().replace(/^["']|["']$/g, ""));
      } else {
        // Strip quotes
        result[key] = val.replace(/^["']|["']$/g, "");
      }
    }
  }
  return result;
}

function extractOverviewFirstSentence(content: string): string {
  // Find the ## Overview section
  const overviewMatch = content.match(/## Overview\s*\n+([\s\S]*?)(?=\n## |\n---|\Z)/);
  if (!overviewMatch) return "";
  const overviewText = overviewMatch[1].trim();
  // Get first sentence (end at period followed by space or end of line, but not abbreviations)
  const firstLine = overviewText.split("\n")[0];
  // Find first sentence-ending period
  const sentenceMatch = firstLine.match(/^(.+?\.)\s/);
  if (sentenceMatch) return sentenceMatch[1];
  // If no space after period, take the whole first line up to first period
  const periodIdx = firstLine.indexOf(".");
  if (periodIdx > 0) return firstLine.substring(0, periodIdx + 1);
  return firstLine;
}

function normalizeArticleId(raw: string): string | null {
  // Normalize a link target to an article ID like "people/jane-doe"
  let id = raw.trim();
  // Remove .md extension
  id = id.replace(/\.md$/, "");
  // Remove leading slash or ../
  id = id.replace(/^\//, "");
  id = id.replace(/^\.\.\//g, "");
  // Should now be "category/slug"
  if (!id.includes("/")) return null;
  const parts = id.split("/");
  if (parts.length !== 2) return null;
  const [cat, slug] = parts;
  if (!CATEGORIES.includes(cat)) return null;
  return `${cat}/${slug}`;
}

function extractOutgoingLinks(content: string, sourceId: string): string[] {
  const links = new Set<string>();

  // Pattern 1: [[category/slug]]
  const wikiLinkRe = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = wikiLinkRe.exec(content)) !== null) {
    const id = normalizeArticleId(m[1]);
    if (id && id !== sourceId) links.add(id);
  }

  // Pattern 2: [text](/category/slug.md) or [text](/category/slug)
  const absLinkRe = /\]\(\/([a-z][\w-]*\/[\w-]+(?:\.md)?)\)/g;
  while ((m = absLinkRe.exec(content)) !== null) {
    const id = normalizeArticleId(m[1]);
    if (id && id !== sourceId) links.add(id);
  }

  // Pattern 3: [text](../category/slug.md) or [text](../category/slug)
  const relLinkRe = /\]\(\.\.\/([a-z][\w-]*\/[\w-]+(?:\.md)?)\)/g;
  while ((m = relLinkRe.exec(content)) !== null) {
    const id = normalizeArticleId(m[1]);
    if (id && id !== sourceId) links.add(id);
  }

  return Array.from(links);
}

function extractAliases(article: Article, fm: Record<string, any>): string[] {
  const aliases: string[] = [];

  // Title is always primary
  if (fm.title) aliases.push(fm.title);

  // Tags can contain aliases
  if (fm.tags && Array.isArray(fm.tags)) {
    // Don't add generic tags as aliases — only add tag-based aliases if they seem name-like
    // We'll skip this to avoid cluttered registry
  }

  // For people, try to extract initials as alias if name is short enough
  if (article.category === "people" && fm.title) {
    const words = fm.title.split(/\s+/);
    if (words.length >= 2 && words.length <= 4) {
      const initials = words.map((w: string) => w[0]?.toUpperCase()).filter(Boolean).join("");
      if (initials.length >= 2) {
        // Only add if initials are distinctive (3+ chars or uppercase)
        // Actually, skip auto-generated initials — too many false positives.
        // Only add explicitly mentioned aliases from the article body.
      }
    }
  }

  // Common acronyms to exclude — these are too generic to be useful aliases
  const EXCLUDED_ACRONYMS = new Set([
    "AI", "ML", "EA", "VP", "CEO", "CTO", "COO", "CPO", "CFO",
    "API", "GPU", "LLM", "NLP", "RL", "CV", "UI", "UX",
    "NYC", "USA", "MIT", "PhD", "MBA",
    "PR", "HR", "QA", "PM", "GM", "SVP", "EVP",
    "TV", "B2B", "B2C", "SaaS", "ARR", "MRR", "GTM",
    "DM", "DMs", "OKR", "OKRs", "KPI", "KPIs",
    "IPO", "M&A", "VC", "LP", "GP",
  ]);

  // Check for "also known as" or "formerly" patterns in content
  const akaPatterns = [
    /(?:also known as|a\.?k\.?a\.?|formerly|née)\s+["']?([A-Z][a-zA-Z\s-]+?)["']?(?:\.|,|\)|\n)/gi,
    /\(([A-Z]{2,6})\)/g,  // Parenthetical acronyms like (APS), (SFF)
  ];

  for (const pattern of akaPatterns) {
    let m: RegExpExecArray | null;
    const content = article.rawContent;
    while ((m = pattern.exec(content)) !== null) {
      const alias = m[1].trim();
      if (alias && alias.length > 1 && alias.length < 50
          && !aliases.includes(alias) && !EXCLUDED_ACRONYMS.has(alias)) {
        aliases.push(alias);
      }
    }
  }

  // For organizations, check for common abbreviation patterns in the overview
  if (article.category === "organizations") {
    const overviewMatch = article.rawContent.match(/## Overview\s*\n+([\s\S]*?)(?=\n## )/);
    if (overviewMatch) {
      const overview = overviewMatch[1];
      // Look for parenthetical abbreviations
      const abbrMatch = overview.match(new RegExp(`${fm.title}\\s*\\(([A-Z]{2,10})\\)`));
      if (abbrMatch && !aliases.includes(abbrMatch[1])) {
        aliases.push(abbrMatch[1]);
      }
    }
  }

  return aliases;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function loadAllArticles(): Article[] {
  const articles: Article[] = [];

  for (const category of CATEGORIES) {
    const catDir = join(WIKI_ROOT, category);
    if (!existsSync(catDir)) continue;

    const files = readdirSync(catDir).filter(f => f.endsWith(".md") && !f.startsWith("_"));
    for (const file of files) {
      const filePath = join(catDir, file);
      const slug = file.replace(/\.md$/, "");
      const id = `${category}/${slug}`;
      const rawContent = readFileSync(filePath, "utf-8");
      const fm = parseFrontmatter(rawContent);

      articles.push({
        id,
        slug,
        category,
        filePath,
        title: fm.title || slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
        tags: fm.tags || [],
        overviewFirstSentence: extractOverviewFirstSentence(rawContent),
        outgoingLinks: extractOutgoingLinks(rawContent, id),
        rawContent,
      });
    }
  }

  return articles;
}

function buildBacklinks(articles: Article[]): Record<string, string[]> {
  const backlinks: Record<string, string[]> = {};

  // Initialize all article IDs
  for (const article of articles) {
    if (!backlinks[article.id]) backlinks[article.id] = [];
  }

  // Build inverse mapping
  for (const article of articles) {
    for (const targetId of article.outgoingLinks) {
      if (!backlinks[targetId]) backlinks[targetId] = [];
      if (!backlinks[targetId].includes(article.id)) {
        backlinks[targetId].push(article.id);
      }
    }
  }

  // Sort values and remove empty entries
  const result: Record<string, string[]> = {};
  for (const [key, refs] of Object.entries(backlinks)) {
    if (refs.length > 0) {
      result[key] = refs.sort();
    }
  }

  return result;
}

function buildEntityRegistry(articles: Article[]): Record<string, string> {
  const registry: Record<string, string> = {};

  // Pass 1: Register all article titles first (authoritative mappings).
  // Process in priority order: orgs/projects first, then people, then rest.
  const priorityOrder = ["organizations", "projects", "positions", "expertise", "timeline", "people"];
  const sortedArticles = [...articles].sort((a, b) => {
    const aIdx = priorityOrder.indexOf(a.category);
    const bIdx = priorityOrder.indexOf(b.category);
    return aIdx - bIdx;
  });

  for (const article of sortedArticles) {
    const fm = parseFrontmatter(article.rawContent);
    const path = `${article.id}.md`;
    if (fm.title) {
      registry[fm.title] = path;
    }
  }

  // Pass 2: Add extracted aliases (don't overwrite existing title mappings)
  for (const article of sortedArticles) {
    const fm = parseFrontmatter(article.rawContent);
    const aliases = extractAliases(article, fm);
    const path = `${article.id}.md`;

    for (const alias of aliases) {
      if (!registry[alias]) {
        registry[alias] = path;
      }
    }
  }

  // Sort by key
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(registry).sort()) {
    sorted[key] = registry[key];
  }

  return sorted;
}

function generateRootIndex(articles: Article[]): string {
  const counts: Record<string, number> = {};
  for (const cat of CATEGORIES) {
    counts[cat] = articles.filter(a => a.category === cat).length;
  }

  const categoryLabels: Record<string, string> = {
    people: "People",
    organizations: "Organizations",
    projects: "Projects",
    positions: "Positions",
    expertise: "Expertise",
    timeline: "Timeline",
  };

  let md = `# Personal Knowledge Wiki\n\n`;
  md += `This wiki contains structured knowledge about the owner's professional relationships, `;
  md += `projects, intellectual positions, and areas of expertise. `;
  md += `It is organized by category and designed for AI agent consumption. `;
  md += `Start here for orientation, then navigate by category or use the entity registry and backlinks for cross-referencing.\n\n`;

  md += `## Categories\n\n`;
  for (const cat of CATEGORIES) {
    md += `- **[${categoryLabels[cat]}](${cat}/_index.md)** -- ${counts[cat]} articles\n`;
  }

  md += `\n## Cross-Reference Tools\n\n`;
  md += `- **[Entity Registry](_entity-registry.json)** -- Look up any person, organization, or concept by name or alias\n`;
  md += `- **[Backlinks](_backlinks.json)** -- Find all articles that reference a given article\n`;
  md += `- **[README](README.md)** -- Agent-facing orientation and navigation guide\n`;

  return md;
}

function generateCategoryIndex(category: string, articles: Article[]): string {
  const catArticles = articles.filter(a => a.category === category).sort((a, b) =>
    a.title.localeCompare(b.title)
  );

  const categoryLabels: Record<string, string> = {
    people: "People",
    organizations: "Organizations",
    projects: "Projects",
    positions: "Positions",
    expertise: "Expertise",
    timeline: "Timeline",
  };

  const categoryDescriptions: Record<string, string> = {
    people: "People the owner interacts with professionally and personally.",
    organizations: "Companies, institutions, and organizations the owner is involved with.",
    projects: "Specific initiatives, ventures, and undertakings.",
    positions: "The owner's intellectual positions and public stances.",
    expertise: "The owner's demonstrated areas of expertise and competence.",
    timeline: "Half-year era summaries of the owner's life and career.",
  };

  let md = `# ${categoryLabels[category]}\n\n`;
  md += `${categoryDescriptions[category]}\n\n`;
  md += `${catArticles.length} articles.\n\n`;

  for (const article of catArticles) {
    const desc = article.overviewFirstSentence;
    if (desc) {
      md += `- [${article.title}](${article.slug}.md) -- ${desc}\n`;
    } else {
      md += `- [${article.title}](${article.slug}.md)\n`;
    }
  }

  md += `\n[Back to wiki index](../_index.md)\n`;

  return md;
}

function generateReadme(articles: Article[]): string {
  const counts: Record<string, number> = {};
  for (const cat of CATEGORIES) {
    counts[cat] = articles.filter(a => a.category === cat).length;
  }

  return `# Personal Knowledge Wiki

This wiki contains structured knowledge about the owner's professional relationships,
projects, intellectual positions, and areas of expertise. It is designed primarily for AI agent
consumption.

## How to Navigate
1. Start with \`_index.md\` for orientation
2. Use \`_entity-registry.json\` to look up people/orgs by name
3. Use \`_backlinks.json\` to find reverse references
4. Browse category indexes: \`people/_index.md\`, \`organizations/_index.md\`, etc.

## Structure
- \`people/\` -- ${counts.people} articles on people the owner interacts with
- \`organizations/\` -- ${counts.organizations} articles on companies and institutions
- \`projects/\` -- ${counts.projects} articles on specific initiatives
- \`positions/\` -- ${counts.positions} articles on the owner's intellectual positions
- \`expertise/\` -- ${counts.expertise} articles on the owner's demonstrated expertise
- \`timeline/\` -- ${counts.timeline} half-year era summaries

## Privacy Model
This is the shared version of the wiki, accessible to trusted AI assistants.
Sensitive information (financial details, medical information, private assessments)
is kept in a separate private wiki. If you need information beyond what's here,
request escalation to a trusted session.
`;
}

// ─── Execute ─────────────────────────────────────────────────────────────────

console.log("Loading articles...");
const articles = loadAllArticles();
console.log(`Loaded ${articles.length} articles across ${CATEGORIES.length} categories.`);

// Count by category
for (const cat of CATEGORIES) {
  const count = articles.filter(a => a.category === cat).length;
  console.log(`  ${cat}: ${count}`);
}

// Count total outgoing links
const totalLinks = articles.reduce((sum, a) => sum + a.outgoingLinks.length, 0);
console.log(`Total outgoing links found: ${totalLinks}`);

// 1. Backlinks
console.log("\nGenerating _backlinks.json...");
const backlinks = buildBacklinks(articles);
const backlinksJson = JSON.stringify(backlinks, null, 2);
writeFileSync(join(WIKI_ROOT, "_backlinks.json"), backlinksJson);
console.log(`  ${Object.keys(backlinks).length} articles have backlinks.`);

// 2. Entity Registry
console.log("Generating _entity-registry.json...");
const registry = buildEntityRegistry(articles);
const registryJson = JSON.stringify(registry, null, 2);
writeFileSync(join(WIKI_ROOT, "_entity-registry.json"), registryJson);
console.log(`  ${Object.keys(registry).length} entries in registry.`);

// 3. Root index
console.log("Generating _index.md...");
const rootIndex = generateRootIndex(articles);
writeFileSync(join(WIKI_ROOT, "_index.md"), rootIndex);

// 4. Per-category indexes
console.log("Generating per-category _index.md files...");
for (const cat of CATEGORIES) {
  const catIndex = generateCategoryIndex(cat, articles);
  writeFileSync(join(WIKI_ROOT, cat, "_index.md"), catIndex);
  console.log(`  ${cat}/_index.md`);
}

// 5. README
console.log("Generating README.md...");
const readme = generateReadme(articles);
writeFileSync(join(WIKI_ROOT, "README.md"), readme);

console.log("\nDone! All index and cross-reference files generated.");
