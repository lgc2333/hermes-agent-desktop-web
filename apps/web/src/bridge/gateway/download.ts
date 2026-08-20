/**
 * Gateway file download（ADR-0025）：把 Target 上的单个 gateway 文件交给
 * 浏览器下载管理器。不同于 Electron save dialog，Web 不能知道用户本机路径。
 */

import { getPrimaryConnection, readProfilePreference } from '../registry'

import { apiError, gatewayBaseUrl, proxyFetch } from './rest'

export interface SaveGatewayFilePayload {
  path: string
  profile?: null | string
  suggestedName?: string
}

export interface SaveGatewayFileResult {
  canceled?: boolean
  path?: string
  saved: boolean
}

function gatewayFilePath(rawPath: unknown): string {
  const value = String(rawPath || '').trim()

  if (!value) {
    return ''
  }

  if (!/^file:/i.test(value)) {
    return value
  }

  try {
    return decodeURIComponent(new URL(value).pathname)
  } catch {
    return value.replace(/^file:\/\//i, '')
  }
}

function basename(path: string): string {
  const clean = path.replace(/[\\/]+$/, '')
  const name = clean.split(/[\\/]/).pop() ?? ''

  return name || ''
}

function filenameFromContentDisposition(value: unknown): string {
  const text = String(value || '')
  const encoded = text.match(/filename\*=(?:UTF-8'')?([^;]+)/i)?.[1]
  const plain = text.match(/filename="?([^";]+)"?/i)?.[1]
  const raw = encoded || plain || ''

  if (!raw) {
    return ''
  }

  try {
    return basename(decodeURIComponent(raw.trim()))
  } catch {
    return basename(raw.trim())
  }
}

function dataUrlToBlob(dataUrl: string): Blob {
  const match = /^data:([^,]*),([\s\S]*)$/.exec(String(dataUrl || ''))

  if (!match) {
    throw new Error('Malformed data URL')
  }

  const meta = match[1] || ''
  const payload = match[2] || ''
  const mime = meta.split(';')[0] || 'application/octet-stream'

  if (/;base64/i.test(meta)) {
    const binary = atob(payload)
    const bytes = new Uint8Array(binary.length)

    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i)
    }

    return new Blob([bytes], { type: mime })
  }

  return new Blob([decodeURIComponent(payload)], { type: mime })
}

function gatewayFsPath(
  route: 'download' | 'read-data-url',
  filePath: string,
  profile?: null | string,
): string {
  const params = new URLSearchParams({ path: filePath })
  const scopedProfile = String(profile || '').trim()

  if (scopedProfile) {
    params.set('profile', scopedProfile)
  }

  return `/api/fs/${route}?${params.toString()}`
}

async function responseError(res: Response, path: string): Promise<Error> {
  const body = await res.text().catch(() => '')

  return apiError(res.status, path, body)
}

function downloadBlob(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')

  link.href = href
  link.download = filename
  link.rel = 'noopener noreferrer'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(href), 30_000)
}

export class GatewayFileDownloader {
  async saveGatewayFile(
    payload: SaveGatewayFilePayload,
  ): Promise<SaveGatewayFileResult> {
    const filePath = gatewayFilePath(payload.path)

    if (!filePath) {
      throw new Error('Missing gateway file path')
    }

    const suggested = basename(String(payload.suggestedName || '').trim())
    const fallbackName = basename(filePath) || suggested || 'download'
    const profile =
      payload.profile === undefined ? readProfilePreference() : payload.profile
    const downloadPath = gatewayFsPath('download', filePath, profile)
    const res = await this.fetchGateway(downloadPath)

    if (res.status === 404) {
      return this.saveViaDataUrl(filePath, suggested || fallbackName, profile)
    }

    if (!res.ok) {
      throw await responseError(res, downloadPath)
    }

    const filename =
      filenameFromContentDisposition(res.headers.get('Content-Disposition')) ||
      suggested ||
      fallbackName

    downloadBlob(await res.blob(), filename)

    return { path: filename, saved: true }
  }

  private async saveViaDataUrl(
    filePath: string,
    filename: string,
    profile?: null | string,
  ): Promise<SaveGatewayFileResult> {
    const path = gatewayFsPath('read-data-url', filePath, profile)
    const res = await this.fetchGateway(path)

    if (!res.ok) {
      throw await responseError(res, path)
    }

    const json = (await res.json().catch(() => null)) as { dataUrl?: string } | null
    const dataUrl = json?.dataUrl

    if (!dataUrl) {
      throw new Error('Gateway returned no file data')
    }

    downloadBlob(dataUrlToBlob(dataUrl), filename)

    return { path: filename, saved: true }
  }

  private fetchGateway(path: string): Promise<Response> {
    const conn = getPrimaryConnection()
    const oauth = conn.authMode === 'oauth'

    return proxyFetch(`${gatewayBaseUrl()}${path}`, {
      headers: {
        ...(oauth ? {} : { 'X-Hermes-Session-Token': conn.token }),
        'X-Hermes-Target': conn.url.replace(/\/+$/, ''),
      },
    })
  }
}
