import * as yaml from 'js-yaml'

export function strip_frontmatter_if_md(
  text: string,
  filePath: string,
): string {
  const isMd = /\.md$/i.test(filePath);
  if (!isMd) return text;
  const m = text.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  if (m && m[1] !== undefined) return m[1];
  return text;
}

export function extract_frontmatter(
  text: string,
  filePath: string,
): { data: Record<string, unknown>; body: string } {
  const isMd = /\.(md|markdown)$/i.test(filePath);
  if (!isMd) return { data: {}, body: text };
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { data: {}, body: text };
  let data: Record<string, unknown> = {};
  try {
    data = (yaml.load(m[1] ?? "") as Record<string, unknown>) || {};
  } catch {}
  return { data, body: m[2] || "" };
}

export function md_escape(s: string): string {
  try {
    return String(s).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
  } catch {
    return String(s ?? "");
  }
}

export function truncate(s: string, n = 120): string {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export function print_markdown_kv(title: string, kv: Record<string, string>) {
  const lines = [
    "---",
    ...Object.entries(kv).map(
      ([k, v]) => `${k}: "${String(v ?? "").replace(/"/g, '\\"')}"`,
    ),
    "---",
    "",
    `# ${title}`,
    "",
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

export function print_markdown_table(headers: string[], rows: string[][]) {
  const head = `| ${headers.join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map((r) => `| ${r.map((c) => String(c ?? '')).join(' | ')} |`).join('\n')
  process.stdout.write([head, sep, body].join('\n') + '\n')
}

// Sanitize markdown to be clean-by-default without altering code blocks
export function sanitize_markdown(input: string): string {
  const raw = String(input ?? "");
  if (!raw) return "";

  // Split into segments, preserving fenced code blocks exactly
  type Seg = { code: boolean; text: string };
  const lines = raw.split(/\r?\n/);
  const segs: Seg[] = [];
  let buf: string[] = [];
  let in_code = false;
  const fence_re = /^(```|~~~)/;

  const flush = (code: boolean) => {
    if (buf.length) segs.push({ code, text: buf.join("\n") });
    buf = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (fence_re.test(line)) {
      if (in_code) {
        buf.push(line);
        flush(true);
        in_code = false;
      } else {
        flush(false);
        in_code = true;
        buf.push(line);
      }
      continue;
    }
    buf.push(line);
  }
  flush(in_code);

  const clean_text = (s: string): string => {
    let t = s;
    // Remove zero-width chars
    t = t.replace(/[\u200B-\u200D\uFEFF]/g, "");
    // Wikipedia: drop donation/banner content before main article
    t = t.replace(
      /^[\s\S]*?From Wikipedia, the free encyclopedia/,
      "From Wikipedia, the free encyclopedia",
    );
    // Remove doc-site header/nav block (logo through nav links)
    // Pattern: [*Docs home page*] through first real content heading
    t = t.replace(
      /^\[.*?(?:Docs home page|logo).*?\]\([^)]+\)[\s\S]*?(?=Firecrawl converts|^#{1,2}\s+[A-Z]|\n#{1,2}\s+[A-Z])/im,
      "",
    );
    // Remove sidebar nav sections (##### headings followed by bullet lists)
    t = t.replace(
      /^#{5}\s+(?:Get Started|New Features|Standard Features|Webhooks|Developer Guides|Use Cases|Contributing)\s*\n(?:[\s\S]*?)(?=^#{1,5}\s+|^Firecrawl converts|$)/gm,
      "",
    );
    // Remove TOC listings that are just anchor links to same page
    t = t.replace(/^- \[[^\]]+\]\(https?:\/\/[^)]*#[^)]+\)\s*$/gm, "");
    // Remove orphaned UI elements
    t = t.replace(/^v2\s*$/gm, "");
    t = t.replace(/^!\[US\].*$/gm, "");
    t = t.replace(/^English\s*$/gm, "");
    t = t.replace(/^Search\.\.\.\s*$/gm, "");
    t = t.replace(/^Ctrl K.*$/gm, "");
    t = t.replace(/^Scrape\s*$/gm, ""); // Orphaned page title
    // Drop common doc-site boilerplate and UI tokens
    t = t
      .replace(
        /^\s*-\s*\[(?:Skip to [^\]]+|Previous|Next)\]\([^)]+\)\s*$/gim,
        "",
      )
      .replace(/^\s*Link for this heading.*$/gim, "")
      .replace(
        /^\s*(?:[a-z]{1,5}Copy|Copy code|Show more|Download|Reload|Clear|Fork)\s*$/gim,
        "",
      )
      .replace(/^.*sp-pre-placeholder.*$/gim, "")
      .replace(/^\s*(?:Download|Reload|Clear|Fork|Copy|Edit|Run)+\s*$/gim, "")
      // Remove trailing "[Link for …]" helpers appended to headings
      .replace(/^(\s*#{1,6}\s+.+?)\s*\[Link for .*$/gim, "$1")
      // Remove long runs of standalone numeric lines (line-number artifacts)
      .replace(/^(?:\s*\d+\s*\n){3,}/gim, "");
    // Unescape over-escaped anchors like \#section
    t = t.replace(/\\#/g, "#");
    // Remove stray trailing backslashes (outside code blocks)
    t = t.replace(/[ \t]*\\[ \t]*$/gm, "");
    // Clean empty anchor patterns in headings: ## [](url) Title -> ## Title
    t = t.replace(/^(#{1,6})\s*\[]\([^)]*\)\s*/gm, "$1 ");
    // Remove standalone UI tab labels (Python, Node, cURL, Copy, Ask AI, etc.)
    t = t.replace(
      /^(?:Python|Node|cURL|Copy|Ask AI|JSON|Completed|Output)\s*$/gm,
      "",
    );
    // Remove "Skip to" links at start
    t = t.replace(/^\[Skip to [^\]]+\]\([^)]+\)\s*/gm, "");
    // Remove Mintlify/doc-site navigation cruft
    t = t.replace(/^(?:Navigation|On this page)\s*$/gim, "");
    // Remove "Suggest edits" / "Raise issue" footer links
    t = t.replace(
      /^\[Suggest edits\]\([^)]+\)\s*\[Raise issue\]\([^)]+\)\s*$/gm,
      "",
    );
    // Remove assistant/AI footer cruft
    t = t.replace(/^Ctrl\+I\s*$/gm, "");
    t = t.replace(/^Assistant\s*$/gm, "");
    t = t.replace(/^Responses are generated using AI.*$/gm, "");
    // Remove Previous/Next navigation links at end of doc pages (can span multiple lines with \\)
    t = t.replace(
      /\[[\s\S]*?Previous\]\([^)]+\)\s*\[[\s\S]*?Next\]\([^)]+\)\s*$/gm,
      "",
    );
    // Collapse 3+ blank lines to 2
    t = t.replace(/\n{3,}/g, "\n\n");
    // Trim leading whitespace
    t = t.replace(/^\s+/, "");
    return t;
  };

  // Clean code blocks: remove trailing backslashes from all lines including fences
  const clean_code = (s: string): string => {
    const codeLines = s.split("\n");
    const cleaned = codeLines.map((line) => {
      // Remove trailing backslash that's not escaping anything meaningful
      return line.replace(/\\$/, "");
    });
    return cleaned.join("\n");
  };

  const out = segs
    .map((seg) => {
      if (!seg.code) return clean_text(seg.text);
      const first = seg.text.split("\n")[0] || "";
      if (/^```[^\n]*sp-pre-placeholder/i.test(first)) return "";
      return clean_code(seg.text);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

  return out;
}
