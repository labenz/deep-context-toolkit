#!/usr/bin/env bun

export const EXIT = {
  OK: 0,
  USAGE: 2,
  MISSING: 64,
  INVALID: 65,
  NETWORK: 70,
  TIMEOUT: 124,
} as const

type ErrorOptions = {
  fix?: string
  cause?: unknown
  status?: number
  context?: Record<string, unknown>
  [key: string]: unknown
}

function mergeContext(
  base?: Record<string, unknown>,
  extra?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!extra || Object.keys(extra).length === 0) {
    return base
  }
  if (!base || Object.keys(base).length === 0) {
    return extra
  }
  return { ...base, ...extra }
}

export class CliError extends Error {
  override name: string
  code: number
  fix?: string
  override cause?: unknown
  status?: number
  context?: Record<string, unknown>

  constructor(name: string, message: string, code: number, opts: ErrorOptions = {}) {
    super(message)
    this.name = name
    this.code = code
    this.fix = opts.fix
    this.cause = opts.cause
    this.status = opts.status
    this.context = opts.context
  }
}

export class UsageError extends CliError {
  constructor(message: string, fix?: string, opts: ErrorOptions = {}) {
    super('UsageError', message, EXIT.USAGE, { ...opts, fix: fix ?? opts.fix })
  }
}

export class MissingError extends CliError {
  constructor(message: string, fix?: string, opts: ErrorOptions = {}) {
    super('MissingError', message, EXIT.MISSING, { ...opts, fix: fix ?? opts.fix })
  }
}

export class InvalidError extends CliError {
  constructor(message: string, fix?: string, opts: ErrorOptions = {}) {
    super('InvalidError', message, EXIT.INVALID, { ...opts, fix: fix ?? opts.fix })
  }
}

export class AuthError extends CliError {
  constructor(message: string, fix?: string, opts: ErrorOptions = {}) {
    super('AuthError', message, EXIT.INVALID, { ...opts, fix: fix ?? opts.fix })
  }
}

export class NetworkError extends CliError {
  constructor(message: string, opts: ErrorOptions = {}) {
    super('NetworkError', message, EXIT.NETWORK, opts)
  }
}

export class TimeoutError extends CliError {
  constructor(message: string, timeoutMs?: number, fix?: string, opts: ErrorOptions = {}) {
    const timeoutContext = typeof timeoutMs === 'number' ? { timeoutMs } : undefined
    const context = mergeContext(opts.context, timeoutContext)
    super('TimeoutError', message, EXIT.TIMEOUT, { ...opts, context, fix: fix ?? opts.fix })
  }
}

function writeLine(prefix: string, text: string) {
  process.stderr.write(`${prefix} ${text}\n`)
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`
  }
  return String(cause)
}

function stringifyContext(context?: Record<string, unknown>): string | null {
  if (!context || Object.keys(context).length === 0) {
    return null
  }
  try {
    return JSON.stringify(context)
  } catch {
    return null
  }
}

function logCliError(prefix: string, error: CliError) {
  writeLine(prefix, `${error.name}: ${error.message}`)
  if (typeof error.status === 'number') {
    writeLine(prefix, `Status: ${error.status}`)
  }
  if (error.fix) {
    writeLine(prefix, `Fix: ${error.fix}`)
  }
  const ctx = stringifyContext(error.context)
  if (ctx) {
    writeLine(prefix, `Context: ${ctx}`)
  }
  if (error.cause && error.cause !== error) {
    writeLine(prefix, `Cause: ${describeCause(error.cause)}`)
  }
}

function logUnknownError(prefix: string, error: unknown) {
  if (error instanceof Error) {
    writeLine(prefix, `${error.name ?? 'Error'}: ${error.message}`)
    if (error.stack) {
      process.stderr.write(`${error.stack}\n`)
    }
    return
  }
  writeLine(prefix, String(error))
}

export function handleError(toolName: string, error: unknown): never {
  const prefix = `[${toolName}]`
  if (error instanceof CliError) {
    logCliError(prefix, error)
    process.exit(error.code)
  }
  logUnknownError(prefix, error)
  process.exit(EXIT.NETWORK)
}

export function fatal(message: string, code = EXIT.NETWORK): never {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}
