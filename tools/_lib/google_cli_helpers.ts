#!/usr/bin/env bun

import { join } from 'path'
import { SearchPipeline } from './search_pipeline.ts'
import { render_hybrid_markdown, render_full_markdown, render_light_markdown } from '../../core/google/images_renderer.ts'
import type { ImageSearchOptions } from './serpapi.ts'

function sanitize_url(u?: string): string | undefined {
  if (!u) return undefined
  try {
    const url = new URL(u)
    if (url.searchParams.has('api_key')) {
      url.searchParams.set('api_key', '***')
    }
    return url.toString()
  } catch {
    return u
  }
}

export async function executeHybridWithPipeline(apiKey: string, query: string, options: ImageSearchOptions, jsonOutput: boolean = false, debugMode: boolean = false, hourlyLimit: number = 1000) {
  const startTime = Date.now()

  const pipeline = new SearchPipeline({
    apiKey,
    cacheDir: join(process.cwd(), '.cache', 'google_images_cli'),
    hourlyLimit,
    debug: debugMode
  })

  const result = await pipeline.search({
    query,
    mode: 'hybrid',
    maxCandidates: options.limit || 20,
    maxLightPages: options.lightPages || 1,
    pageToken: options.pageToken,
    // Pass through requireOriginal as provided; when undefined, pipeline may auto-enrich low-res
    requireOriginal: options.requireOriginal as any,
    resume: false,
    // Filters
    safe: options.safe as any,
    license: options.license as any,
    size: options.size as any,
    fileType: options.fileType as any,
    color: options.color as any,
    aspect: options.aspect as any,
    site: options.site,
    time: options.time as any,
    minWidth: options.minWidth,
    minHeight: options.minHeight
  })

  const elapsed = Date.now() - startTime

  // Merge winner enrichment when present
  let mergedCandidates = Array.isArray(result.candidates) ? [...result.candidates] : []
  if (result.winner) {
    const w = result.winner as any
    const idx = mergedCandidates.findIndex((c: any) => (w.link && c.link === w.link) || (w.title && c.title === w.title))
    if (idx >= 0) {
      mergedCandidates[idx] = { ...mergedCandidates[idx], ...w }
    } else if (mergedCandidates.length > 0) {
      mergedCandidates[0] = { ...mergedCandidates[0], ...w }
    } else {
      mergedCandidates = [w]
    }
  }

  const limit = options.limit || 20
  const aggregated = {
    images_results: mergedCandidates.slice(0, limit),
    search_metadata: {
      id: 'aggregated',
      status: 'Success',
      created_at: new Date().toISOString(),
      processed_at: new Date().toISOString(),
      total_time_taken: elapsed
    },
    search_parameters: {
      engine: 'google_images',
      q: query,
      api_key: '***'
    },
    serpapi_pagination: {
      current: 1,
      next: sanitize_url(result.metadata.nextPageUrl)
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify(aggregated, null, 2))
    return
  }

  const md = render_hybrid_markdown(aggregated as any, query, { limit, elapsed_ms: elapsed })
  console.log(md)
}

export async function executeLightWithPipeline(apiKey: string, query: string, options: ImageSearchOptions, jsonOutput: boolean = false, debugMode: boolean = false, hourlyLimit: number = 1000) {
  const startTime = Date.now()

  const pipeline = new SearchPipeline({
    apiKey,
    cacheDir: join(process.cwd(), '.cache', 'google_images_cli'),
    hourlyLimit,
    debug: debugMode
  })

  const result = await pipeline.search({
    query,
    mode: 'light',
    maxCandidates: options.limit || 20,
    maxLightPages: options.lightPages || 1,
    pageToken: options.pageToken,
    resume: false,
    // Filters
    safe: options.safe as any,
    license: options.license as any,
    size: options.size as any,
    fileType: options.fileType as any,
    color: options.color as any,
    aspect: options.aspect as any,
    site: options.site,
    time: options.time as any,
    minWidth: options.minWidth,
    minHeight: options.minHeight
  })

  const elapsed = Date.now() - startTime

  const limit = options.limit || 20
  const aggregated = {
    images_results: (result.candidates || []).slice(0, limit),
    search_metadata: {
      id: 'aggregated',
      status: 'Success',
      created_at: new Date().toISOString(),
      processed_at: new Date().toISOString(),
      total_time_taken: elapsed
    },
    search_parameters: {
      engine: 'google_images_light',
      q: query,
      api_key: '***'
    },
    serpapi_pagination: {
      current: 1,
      next: sanitize_url(result.metadata.nextPageUrl)
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify(aggregated, null, 2))
    return
  }

  const md = render_light_markdown(aggregated as any, query, { limit, elapsed_ms: elapsed })
  console.log(md)
}

export async function executeFullWithPipeline(apiKey: string, query: string, options: ImageSearchOptions, jsonOutput: boolean = false, debugMode: boolean = false, hourlyLimit: number = 1000) {
  const startTime = Date.now()

  const pipeline = new SearchPipeline({
    apiKey,
    cacheDir: join(process.cwd(), '.cache', 'google_images_cli'),
    hourlyLimit,
    debug: debugMode
  })

  const result = await pipeline.search({
    query,
    mode: 'full',
    pageToken: options.pageToken,
    // Filters
    safe: options.safe as any,
    license: options.license as any,
    size: options.size as any,
    fileType: options.fileType as any,
    color: options.color as any,
    aspect: options.aspect as any,
    site: options.site,
    time: options.time as any,
    minWidth: options.minWidth,
    minHeight: options.minHeight,
    retries: 2
  })

  const elapsed = Date.now() - startTime

  const limit = options.limit || 20
  const aggregated = {
    images_results: (result.candidates || []).slice(0, limit),
    search_metadata: {
      id: 'aggregated',
      status: 'Success',
      created_at: new Date().toISOString(),
      processed_at: new Date().toISOString(),
      total_time_taken: elapsed
    },
    search_parameters: {
      engine: 'google_images',
      q: query,
      api_key: '***'
    },
    serpapi_pagination: {
      current: 1,
      next: sanitize_url(result.metadata.nextPageUrl)
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify(aggregated, null, 2))
    return
  }

  const md = render_full_markdown(aggregated as any, query, { limit, elapsed_ms: elapsed })
  console.log(md)
}
