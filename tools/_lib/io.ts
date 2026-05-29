#!/usr/bin/env bun

export async function read_stdin(): Promise<string> {
  return await Bun.stdin.text()
}

export async function read_json_stdin<T = unknown>(): Promise<T> {
  const text = await read_stdin()
  return JSON.parse(text) as T
}

export async function read_file(path: string): Promise<string> {
  return await Bun.file(path).text()
}

export async function write_file(path: string, content: string | Uint8Array): Promise<void> {
  await Bun.write(path, content)
}

export function print_json(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}


