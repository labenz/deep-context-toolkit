export function slugify(input: string, maxLen = 80): string {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, Math.max(1, maxLen))
}


