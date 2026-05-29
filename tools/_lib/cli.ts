#!/usr/bin/env bun

export type FlagSchema = Record<string, { type: 'string' | 'boolean'; alias?: string; multi?: boolean }>

export type ParsedArgs = {
  _: string[];
  [key: string]: string | boolean | string[];
};

export function print_help(name: string, usage: string) {
  const u = String(usage || "");
  const lines = u.split(/\r?\n/);
  const idx = lines.findIndex((ln) => ln.trim().length > 0);
  const firstNonEmpty = idx >= 0 ? (lines[idx] ?? "").trim() : "";
  // Normalize header: strip (Bun) / (Bun client) suffixes from the first non-empty line only
  if (idx >= 0 && firstNonEmpty) {
    const cleaned = firstNonEmpty
      .replace(/\s*\((?:Bun(?: client)?)\)\s*/gi, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    lines[idx] = cleaned;
  }
  const rebuilt = lines.join("\n");
  const startsWithName = firstNonEmpty
    .toLowerCase()
    .startsWith(String(name || "").toLowerCase());
  if (startsWithName) {
    console.error(rebuilt);
  } else {
    console.error(`${name}\n\n${rebuilt}`);
  }
}

type MutableParsedArgs = { _: string[] } & Record<string, string | boolean | string[]>

export function parse_flags(argv: string[], schema: FlagSchema): ParsedArgs {
  const out: MutableParsedArgs = { _: [] }
  const aliasToKey: Record<string, string> = {}
  for (const [key, spec] of Object.entries(schema)) {
    if (spec.alias) aliasToKey[spec.alias] = key;
  }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("-")) {
      out._.push(token);
      continue;
    }
    if (token === "--") {
      // rest are positional
      out._.push(...argv.slice(i + 1));
      break;
    }
    let key = "";
    if (token.startsWith("--")) {
      key = token.slice(2);
    } else if (token.startsWith("-")) {
      const alias = token.slice(1);
      key = aliasToKey[alias] ?? "";
    }
    if (!(key && (key in schema))) {
      const err: Error & { code?: number } = new Error(
        `Unknown flag: ${token}`,
      );
      err.code = 2;
      throw err;
    }
    const spec = schema[key]
    if (spec.type === 'boolean') {
      out[key] = true
    } else {
      const next = argv[i + 1];
      if (typeof next !== "string") {
        const err: Error & { code?: number } = new Error(
          `Flag requires value: --${key}`,
        );
        err.code = 2;
        throw err;
      }

      const current = out[key]
      if (spec.multi) {
        if (Array.isArray(current)) {
          current.push(next)
        } else if (typeof current === 'string') {
          out[key] = [current, next]
        } else {
          out[key] = [next]
        }
      } else {
        out[key] = next
      }

      i += 1
    }
  }
  return out;
}
