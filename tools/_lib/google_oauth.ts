#!/usr/bin/env bun

import { join } from 'node:path'
import { load_env, PROJECT_ROOT, WRITABLE_ENV_PATH } from './env'
import { request } from './http'

// prefer Bun.file()/Bun.write over Node fs for file IO

// Bun is a global in Bun runtime
declare const Bun: typeof import('bun')

export type OAuthTokens = { access_token: string; refresh_token?: string }

/**
 * All scopes needed across Gmail, Drive, and Calendar tools.
 * We use a SINGLE Google Cloud app and a single refresh token,
 * so every auth flow must request ALL scopes to avoid overwriting
 * a broad-scoped refresh token with a narrow one.
 */
export const ALL_GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/calendar',
]

type TokenResponse = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
  error?: string
  error_description?: string
}

function open_in_browser(url: string) {
  try {
    if (process.platform === 'darwin') {
      Bun.spawn(['open', url], { stdout: 'ignore', stderr: 'ignore' })
    } else if (process.platform === 'win32') {
      Bun.spawn(['cmd', '/c', 'start', '', url], { stdout: 'ignore', stderr: 'ignore' })
    } else {
      Bun.spawn(['xdg-open', url], { stdout: 'ignore', stderr: 'ignore' })
    }
  } catch {
    // Ignore browser open failures
  }
}

export async function update_project_env_vars(vars: Record<string, string>) {
  try {
    const envPath = WRITABLE_ENV_PATH
    let raw = ''
    try {
      raw = await Bun.file(envPath).text()
    } catch {
      raw = ''
    }
    let text = raw
    for (const [k, v] of Object.entries(vars)) {
      const escaped = String(v ?? '').replace(/"/g, '\\"')
      const re = new RegExp(`^${k}=.*$`, 'm')
      if (re.test(text)) {
        text = text.replace(re, `${k}="${escaped}"`)
      } else {
        const trimmed = text.trim()
        text = `${trimmed ? `${trimmed}\n` : ''}${k}="${escaped}"\n`
      }
    }
    await Bun.write(envPath, text)
  } catch {
    // Ignore env file write failures
  }
}

type GoogleCredentials = {
  installed?: {
    client_id?: string
    client_secret?: string
    project_id?: string
    auth_uri?: string
    token_uri?: string
    redirect_uris?: string[]
  }
  web?: {
    client_id?: string
    client_secret?: string
    project_id?: string
    auth_uri?: string
    token_uri?: string
    redirect_uris?: string[]
  }
}

async function load_google_credentials(): Promise<{ client_id: string; client_secret: string } | null> {
  const paths = [
    join(PROJECT_ROOT, 'google_credentials.json'),
    '/etc/secrets/google_credentials.json',
  ]
  
  for (const credPath of paths) {
    try {
      const file = Bun.file(credPath)
      if (await file.exists()) {
        const creds = await file.json() as GoogleCredentials
        const config = creds.installed || creds.web
        if (config?.client_id && config?.client_secret) {
          return {
            client_id: config.client_id,
            client_secret: config.client_secret,
          }
        }
      }
    } catch {
      // Continue to next path if file read fails
    }
  }
  return null
}

export async function get_client_credentials(env: Record<string, string>): Promise<{ client_id: string; client_secret: string } | null> {
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    return {
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
    }
  }
  return await load_google_credentials()
}

export function pick_existing_access_token(env: Record<string, string>, preferredToken?: string): string | null {
  if (preferredToken && env[preferredToken]) {
    return env[preferredToken]
  }
  return env.GOOGLE_TOKEN || env.GMAIL_TOKEN || env.GCAL_TOKEN || env.GDRIVE_TOKEN || null
}

export function pick_existing_refresh_token(env: Record<string, string>, preferredToken?: string): string | null {
  if (preferredToken && env[preferredToken]) {
    return env[preferredToken]
  }
  return env.GOOGLE_REFRESH_TOKEN || env.GMAIL_REFRESH_TOKEN || env.GCAL_REFRESH_TOKEN || env.GDRIVE_REFRESH_TOKEN || null
}

export async function try_refresh_token(envIn?: Record<string, string>, preferredToken?: string): Promise<string | null> {
  const env = envIn ?? (await load_env())
  const refresh = pick_existing_refresh_token(env, preferredToken ? `${preferredToken}_REFRESH_TOKEN` : undefined)
  const creds = await get_client_credentials(env)
  if (!(creds && refresh)) {
    return null
  }
  
  const body = `client_id=${encodeURIComponent(creds.client_id)}&client_secret=${encodeURIComponent(creds.client_secret)}&refresh_token=${encodeURIComponent(refresh)}&grant_type=refresh_token`
  try {
    const res = await request<TokenResponse>({ method: 'POST', url: 'https://oauth2.googleapis.com/token', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, logOnError: false })
    const newToken = res.data?.access_token
    if (typeof newToken === 'string' && newToken.length > 0) {
      await update_project_env_vars({
        GOOGLE_TOKEN: newToken,
        GMAIL_TOKEN: newToken,
        GDRIVE_TOKEN: newToken,
        GCAL_TOKEN: newToken
      })
      return newToken
    }
  } catch (_err) {
    // Refresh token may be revoked/expired — fall through to return null
    // so callers can try the existing access token or re-auth
  }
  return null
}

const DEFAULT_START_PORT = 8080
const MAX_PORT_ATTEMPTS = 10
const SERVER_SHUTDOWN_DELAY_MS = 2000
const AUTH_TIMEOUT_MS = 300_000

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: OAuth flow requires complex logic
export async function start_device_auth(scopes: string[] | undefined, envIn?: Record<string, string>): Promise<OAuthTokens | null> {
  const env = envIn ?? (await load_env())
  const creds = await get_client_credentials(env)
  if (!creds) {
    // biome-ignore lint/suspicious/noConsole: CLI tool requires console output
    console.error('Error: Google client credentials not found.')
    // biome-ignore lint/suspicious/noConsole: CLI tool requires console output
    console.error('Please ensure one of the following:')
    // biome-ignore lint/suspicious/noConsole: CLI tool requires console output
    console.error('  1. GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set in .env')
    // biome-ignore lint/suspicious/noConsole: CLI tool requires console output
    console.error('  2. google_credentials.json exists in project root')
    // biome-ignore lint/suspicious/noConsole: CLI tool requires console output
    console.error('  3. google_credentials.json exists in /etc/secrets/ (Render deployment)')
    return null
  }
  const clientId = creds.client_id
  const clientSecret = creds.client_secret
  // Default to ALL scopes — single Google Cloud app, single refresh token
  const scope = (scopes?.length ? scopes : ALL_GOOGLE_SCOPES).join(' ')

  // Use loopback IP address flow for desktop clients (required - OOB is deprecated)
  // Try to find an available port starting from 8080
  let port = DEFAULT_START_PORT
  let server: ReturnType<typeof Bun.serve> | null = null
  let authCode: string | null = null
  let authError: string | null = null
  let resolveAuth: ((code: string) => void) | null = null
  let rejectAuth: ((error: string) => void) | null = null
  
  const authPromise = new Promise<string>((resolve, reject) => {
    resolveAuth = resolve
    rejectAuth = reject
  })
  
  // Try ports 8080-8089
  for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
    try {
      const testPort = port + i
      server = Bun.serve({
        port: testPort,
        hostname: '127.0.0.1',
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: OAuth callback handler requires complex logic
        fetch(req) {
          const url = new URL(req.url)
          
          // Only handle /oauth path (our redirect_uri)
          if (url.pathname !== '/oauth') {
            return new Response('Not found', { status: 404 })
          }
          
          const code = url.searchParams.get('code')
          const error = url.searchParams.get('error')
          
          if (error) {
            authError = error
            if (rejectAuth) {
              rejectAuth(error)
            }
            const html = `<!DOCTYPE html>
<html><head><title>Authorization Failed</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 60px 40px; text-align: center; background: #f5f5f5;">
<div style="background: white; border-radius: 8px; padding: 40px; max-width: 500px; margin: 0 auto; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
<h1 style="color: #d32f2f; margin: 0 0 20px 0; font-size: 24px;">❌ Authorization Failed</h1>
<p style="color: #666; margin: 0 0 20px 0;">Error: ${error}</p>
<p style="color: #999; font-size: 14px; margin: 0;">You can close this window and check the terminal.</p>
</div>
</body></html>`
            setTimeout(() => {
              try {
                server?.stop()
              } catch {
                // Ignore server stop failures
              }
            }, SERVER_SHUTDOWN_DELAY_MS)
            return new Response(html, { headers: { 'Content-Type': 'text/html' } })
          }
          
          if (code) {
            authCode = code
            if (resolveAuth) {
              resolveAuth(code)
            }
            const html = `<!DOCTYPE html>
<html><head><title>Authorization Successful</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 60px 40px; text-align: center; background: #f5f5f5;">
<div style="background: white; border-radius: 8px; padding: 40px; max-width: 500px; margin: 0 auto; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
<h1 style="color: #4caf50; margin: 0 0 20px 0; font-size: 24px;">✓ Authorization Successful</h1>
<p style="color: #666; margin: 0 0 20px 0;">You have successfully authorized the application.</p>
<p style="color: #999; font-size: 14px; margin: 0;">You can close this window and return to the terminal.</p>
</div>
</body></html>`
            setTimeout(() => {
              try {
                server?.stop()
              } catch {
                // Ignore server stop failures
              }
            }, SERVER_SHUTDOWN_DELAY_MS)
            return new Response(html, { headers: { 'Content-Type': 'text/html' } })
          }
          
          // No code and no error - shouldn't happen
          return new Response('Invalid callback - no code or error', { status: 400 })
        }
      })
      port = testPort
      break
    } catch {
      if (i === MAX_PORT_ATTEMPTS - 1) {
        throw new Error('Failed to start local server on ports 8080-8089. Please ensure these ports are available.')
      }
    }
  }

  // Use 127.0.0.1 with /oauth path - this is what works in real implementations
  const redirectUri = `http://127.0.0.1:${port}/oauth`
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}&response_type=code&access_type=offline&prompt=consent`
  
  // biome-ignore lint/suspicious/noConsole: CLI tool requires console output
  console.error("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
  // biome-ignore lint/suspicious/noConsole: CLI tool requires console output
  console.error('  Google OAuth Authorization')
  // biome-ignore lint/suspicious/noConsole: CLI tool requires console output
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
  // biome-ignore lint/suspicious/noConsole: CLI tool requires console output
  console.error('Opening browser for authorization...')
  // biome-ignore lint/suspicious/noConsole: CLI tool requires console output
  console.error(`Local server listening on http://127.0.0.1:${port}\n`)
  
  open_in_browser(authUrl)
  
  // Wait for authorization with timeout
  const timeout = new Promise<string>((_, reject) => {
    setTimeout(() => reject(new Error('Authorization timed out after 5 minutes')), AUTH_TIMEOUT_MS)
  })
  
  try {
    authCode = await Promise.race([authPromise, timeout])
  } catch (err) {
    if (authError) {
      throw new Error(`Authorization failed: ${authError}`)
    }
    throw err
  } finally {
    try {
      server?.stop()
    } catch {
      // Ignore server stop failures
    }
  }
  
  if (!authCode) {
    throw new Error('No authorization code received')
  }
  
  // Exchange code for token - use query params in URL exactly like working example
  // biome-ignore lint/suspicious/noConsole: CLI tool requires console output
  console.error('Exchanging authorization code for access token...')
  
  const tokenParams = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret || '',
    code: authCode,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri
  }).toString()
  
  let tokenRes: Awaited<ReturnType<typeof request<TokenResponse>>>
  try {
    const response = await fetch(`https://oauth2.googleapis.com/token?${tokenParams}`, {
      method: 'POST',
    })
    const data = await response.json()
    if (!response.ok) {
      throw new Error(`Token exchange failed: ${JSON.stringify(data)}`)
    }
    tokenRes = { status: response.status, headers: response.headers, data: data as TokenResponse }
  } catch (err) {
    const e = err as Error & { status?: number; data?: TokenResponse }
    if (e.data?.error) {
      const desc = e.data.error_description ? ` - ${e.data.error_description}` : ''
      throw new Error(`Token exchange failed: ${e.data.error}${desc}`)
    }
    throw err
  }
  
  const tr = tokenRes.data
  if (tr.access_token) {
    // biome-ignore lint/suspicious/noConsole: CLI tool requires console output
    console.error('✓ Authorization successful\n')
    return { access_token: tr.access_token, refresh_token: tr.refresh_token }
  }
  
  if (tr.error) {
    const desc = tr.error_description ? ` - ${tr.error_description}` : ''
    throw new Error(`Token exchange failed: ${tr.error}${desc}`)
  }
  
  throw new Error('Token exchange failed: no access token received')
}

/** Save access + refresh tokens to ALL Google token keys at once. */
export function build_all_token_vars(access: string, refresh?: string): Record<string, string> {
  const vars: Record<string, string> = {
    GOOGLE_TOKEN: access,
    GMAIL_TOKEN: access,
    GDRIVE_TOKEN: access,
    GCAL_TOKEN: access,
  }
  if (refresh) {
    vars.GOOGLE_REFRESH_TOKEN = refresh
    vars.GMAIL_REFRESH_TOKEN = refresh
    vars.GDRIVE_REFRESH_TOKEN = refresh
    vars.GCAL_REFRESH_TOKEN = refresh
  }
  return vars
}

/**
 * Unified token resolver for all Google tools (Gmail, Drive, Calendar).
 * Always requests ALL scopes when doing a fresh auth to prevent
 * narrow-scoped refresh tokens from overwriting broad ones.
 *
 * @param preferredKey - Token prefix to check first (e.g. 'GMAIL', 'GDRIVE', 'GCAL')
 */
export async function ensure_google_token(preferredKey = 'GOOGLE'): Promise<string> {
  const env = await load_env()
  const existing = pick_existing_access_token(env, `${preferredKey}_TOKEN`)
  if (existing) return existing

  const refreshed = await try_refresh_token(env, preferredKey)
  if (refreshed) return refreshed

  const auth = await start_device_auth(ALL_GOOGLE_SCOPES, env)
  if (!auth?.access_token) {
    throw Object.assign(new Error('Google OAuth failed'), { code: 64 })
  }
  await update_project_env_vars(build_all_token_vars(auth.access_token, auth.refresh_token))
  return auth.access_token
}

/** @deprecated Use ensure_google_token('GCAL') instead */
export async function ensure_token_with_calendar_scope(): Promise<string> {
  return ensure_google_token('GCAL')
}
