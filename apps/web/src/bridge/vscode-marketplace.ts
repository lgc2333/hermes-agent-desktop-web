/**
 * 浏览器端 VS Code Marketplace 主题供应商 —— electron/vscode-marketplace.ts 的移植。
 *
 * 桌面版在主进程用 node:https + node:zlib 做这套；这里直接用浏览器能力：
 *   - 官方 gallery ExtensionQuery 接口（POST）与 VSIX CDN 均回显
 *     `Access-Control-Allow-Origin: *`，浏览器 fetch 直连即可（实测预检放行
 *     content-type，无代理转发、无凭证 —— 纯公共 API，符合 ADR-0002 凭证模型）；
 *   - `.vsix` 是普通 zip，用 `DecompressionStream('deflate-raw')` 就地解压
 *     需要的条目，不引入任何解压库。
 *
 * 与桌面相同的安全边界：永远不执行扩展代码，只读 package.json + 引用的
 * `*.json` 主题文件，把原文交回渲染层转换。
 */

import type {
  DesktopMarketplaceSearchItem,
  DesktopMarketplaceThemeFile,
  DesktopMarketplaceThemeResult,
} from '@/global'

const GALLERY_QUERY_URL =
  'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery'
const VSIX_ASSET_TYPE = 'Microsoft.VisualStudio.Services.VSIXPackage'
const ID_RE = /^[\w-]+\.[\w-]+$/

/** POST 一个 ExtensionQuery 载荷并返回解析后的 gallery 响应。 */
async function queryGallery(payload: unknown): Promise<GalleryResponse> {
  const res = await fetch(GALLERY_QUERY_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json;api-version=3.0-preview.1',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  })

  if (!res.ok) {
    throw new Error(`Marketplace query failed (${res.status}).`)
  }

  return res.json() as Promise<GalleryResponse>
}

/**
 * "Themes" 类别里还混着 file-icon / product-icon 主题（gallery 没有纯颜色
 * 类别）。不下载看不出扩展实际贡献什么，所以按 tag + 名称/描述把明显的图标
 * 包过滤掉（与桌面实现同一启发式）。
 */
function looksLikeIconTheme(extension: GalleryExtension): boolean {
  const tags = (extension.tags ?? []).map((tag) => String(tag).toLowerCase())

  if (tags.includes('icon-theme') || tags.includes('product-icon-theme')) {
    return true
  }

  const text =
    `${extension.displayName ?? ''} ${extension.shortDescription ?? ''}`.toLowerCase()

  return /\b(?:icon theme|file icons?|product icons?|icon pack|fileicons)\b/.test(text)
}

/** 搜索颜色主题扩展；空查询返回安装量最高的那些。返回轻量卡片（不含下载）。 */
export async function searchMarketplaceThemes(
  query: string,
  limit = 20,
): Promise<DesktopMarketplaceSearchItem[]> {
  const text = String(query || '').trim()
  const pageSize = Math.min(Math.max(Number(limit) || 20, 1), 50)

  // FilterType: 8=Target, 5=Category, 10=SearchText, 12=ExcludeWithFlags。
  const criteria = [
    { filterType: 8, value: 'Microsoft.VisualStudio.Code' },
    { filterType: 5, value: 'Themes' },
    { filterType: 12, value: '4096' }, // Exclude unpublished (Unpublished = 0x1000)。
  ]

  if (text) {
    criteria.push({ filterType: 10, value: text })
  }

  const json = await queryGallery({
    // 多取一页，好让图标包过滤后仍留满一页。
    filters: [
      {
        criteria,
        pageNumber: 1,
        pageSize: Math.min(pageSize * 2, 50),
        sortBy: 4,
        sortOrder: 0,
      },
    ],
    // IncludeStatistics (0x100) | IncludeLatestVersionOnly (0x200) | IncludeCategoryAndTags (0x4)。
    flags: 772,
  })

  const extensions = json?.results?.[0]?.extensions ?? []

  return extensions
    .filter((extension) => !looksLikeIconTheme(extension))
    .slice(0, pageSize)
    .map((extension) => {
      const publisherName = extension.publisher?.publisherName ?? ''
      const installStat = (extension.statistics ?? []).find(
        (stat) => stat.statisticName === 'install',
      )

      return {
        extensionId: `${publisherName}.${extension.extensionName}`,
        displayName: extension.displayName || extension.extensionName,
        publisher: extension.publisher?.displayName || publisherName,
        description: extension.shortDescription || '',
        installs: Math.round(installStat?.value ?? 0),
      }
    })
}

/** 解析 `{ displayName, vsixUrl }`（扩展最新版本）。 */
async function resolveExtension(
  id: string,
): Promise<{ displayName: string; vsixUrl: string }> {
  const json = await queryGallery({
    // FilterType 7 = ExtensionName（完整 publisher.extension id）。
    filters: [{ criteria: [{ filterType: 7, value: id }], pageNumber: 1, pageSize: 1 }],
    // IncludeFiles | IncludeVersionProperties | IncludeAssetUri |
    // IncludeCategoryAndTags | IncludeLatestVersionOnly = 914。
    flags: 914,
  })

  const extension = json?.results?.[0]?.extensions?.[0]

  if (!extension) {
    throw new Error(`Extension "${id}" was not found on the Marketplace.`)
  }

  const version = extension.versions?.[0]

  if (!version) {
    throw new Error(`Extension "${id}" has no published versions.`)
  }

  const asset = (version.files ?? []).find((file) => file.assetType === VSIX_ASSET_TYPE)
  const vsixUrl = asset?.source

  if (!vsixUrl) {
    throw new Error(`Could not find a downloadable package for "${id}".`)
  }

  return { displayName: extension.displayName || id, vsixUrl }
}

/** 下载 `.vsix`，以 ArrayBuffer 返回。 */
async function downloadVsix(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })

  if (!res.ok) {
    throw new Error(`Download failed (${res.status}).`)
  }

  return res.arrayBuffer()
}

/** ─── 最小 zip 读取器 ─────────────────────────────────────────────────────── */

interface ZipRecord {
  method: number
  compressedSize: number
  localOffset: number
}

/** EOCD 签名 0x06054b50，从尾部往前扫（注释很少见）。 */
function findEndOfCentralDirectory(buf: ArrayBuffer): number {
  const view = new DataView(buf)

  for (let i = buf.byteLength - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      return i
    }
  }

  throw new Error('Not a valid zip archive (no end-of-central-directory).')
}

/** 解析中央目录为 name → record 映射。 */
export function readCentralDirectory(buf: ArrayBuffer): Map<string, ZipRecord> {
  const view = new DataView(buf)
  const eocd = findEndOfCentralDirectory(buf)
  const count = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  const records = new Map<string, ZipRecord>()
  const decoder = new TextDecoder()

  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      break
    }

    const method = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const nameLen = view.getUint16(offset + 28, true)
    const extraLen = view.getUint16(offset + 30, true)
    const commentLen = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    const name = decoder.decode(new Uint8Array(buf, offset + 46, nameLen))

    records.set(name, { method, compressedSize, localOffset })
    offset += 46 + nameLen + extraLen + commentLen
  }

  return records
}

/** 解压单条目为字符串；method 0=stored，8=deflate。 */
export async function extractEntry(
  buf: ArrayBuffer,
  record: ZipRecord,
): Promise<string> {
  const view = new DataView(buf)

  // 本地头可能给出与中央目录不同的 name/extra 长度，这里重读以定位压缩载荷。
  if (view.getUint32(record.localOffset, true) !== 0x04034b50) {
    throw new Error('Corrupt zip: bad local file header.')
  }

  const nameLen = view.getUint16(record.localOffset + 26, true)
  const extraLen = view.getUint16(record.localOffset + 28, true)
  const dataStart = record.localOffset + 30 + nameLen + extraLen
  const bytes = new Uint8Array(buf, dataStart, record.compressedSize)

  if (record.method === 0) {
    return new TextDecoder().decode(bytes)
  }

  if (record.method !== 8) {
    throw new Error(`Unsupported zip compression method: ${record.method}.`)
  }

  // 主题文件几乎总是 stored 或 deflate；deflate 用浏览器原生解压。
  const inflated = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
  const text = await new Response(inflated).text()

  return text
}

/** 规范化 package.json 里的主题路径为 zip 条目名。 */
function themeEntryName(themePath: string): string {
  const clean = String(themePath).replace(/^\.\//, '').replace(/^\//, '')

  return `extension/${clean}`
}

/** 从 `.vsix` 缓冲中提取其贡献的每个颜色主题 JSON。 */
export async function extractThemes(
  vsixBuffer: ArrayBuffer,
): Promise<DesktopMarketplaceThemeFile[]> {
  const records = readCentralDirectory(vsixBuffer)
  const pkgRecord = records.get('extension/package.json')

  if (!pkgRecord) {
    throw new Error('Package manifest missing from the extension.')
  }

  const pkg = JSON.parse(await extractEntry(vsixBuffer, pkgRecord)) as {
    displayName?: string
    name?: string
    contributes?: {
      themes?: Array<{ label?: string; id?: string; path?: string; uiTheme?: string }>
    }
  }
  const contributed = pkg?.contributes?.themes

  if (!Array.isArray(contributed) || contributed.length === 0) {
    return []
  }

  const themes: DesktopMarketplaceThemeFile[] = []

  for (const entry of contributed) {
    if (!entry?.path) {
      continue
    }

    const record = records.get(themeEntryName(entry.path))

    if (!record) {
      continue
    }

    try {
      themes.push({
        label:
          entry.label || entry.id || pkg.displayName || pkg.name || 'VS Code Theme',
        uiTheme: entry.uiTheme,
        contents: await extractEntry(vsixBuffer, record),
      })
    } catch {
      // 解不开的条目直接跳过，而不是让整个安装失败。
    }
  }

  return themes
}

/** 公共入口：解析、下载并提取 `id`（publisher.extension）贡献的颜色主题。 */
export async function fetchMarketplaceThemes(
  id: string,
): Promise<DesktopMarketplaceThemeResult> {
  const trimmed = String(id || '').trim()

  if (!ID_RE.test(trimmed)) {
    throw new Error('Expected a Marketplace id like "publisher.extension".')
  }

  const { displayName, vsixUrl } = await resolveExtension(trimmed)
  const vsix = await downloadVsix(vsixUrl)
  const themes = await extractThemes(vsix)

  return { extensionId: trimmed, displayName, themes }
}

// ─── gallery 响应的最小类型（只取用到的字段）───────────────────────────────

interface GalleryStatistic {
  statisticName: string
  value?: number
}

interface GalleryAsset {
  assetType: string
  source?: string
}

interface GalleryVersion {
  files?: GalleryAsset[]
}

interface GalleryPublisher {
  publisherName?: string
  displayName?: string
}

interface GalleryExtension {
  displayName?: string
  /** 发布扩展始终带有 extensionName（publisher.extension 的后半段）。 */
  extensionName: string
  shortDescription?: string
  tags?: string[]
  publisher?: GalleryPublisher
  statistics?: GalleryStatistic[]
  versions?: GalleryVersion[]
}

interface GalleryResponse {
  results?: Array<{ extensions?: GalleryExtension[] }>
}
