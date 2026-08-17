import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  extractThemes,
  fetchMarketplaceThemes,
  searchMarketplaceThemes,
} from './vscode-marketplace'

const GALLERY_URL =
  'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery'

/** 最小 fetch mock：按 URL 返回预设的 gallery / vsix 结果。 */
function mockFetch(results: {
  gallery?: unknown
  vsix?: ArrayBuffer
  galleryError?: boolean
}): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)

    if (url === GALLERY_URL) {
      return {
        ok: !results.galleryError,
        json: async () => results.gallery,
      } as unknown as Response
    }

    return { ok: true, arrayBuffer: async () => results.vsix } as unknown as Response
  })

  vi.stubGlobal('fetch', fn)

  return fn
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('searchMarketplaceThemes', () => {
  it('POSTs a Themes-scoped gallery query and maps results to cards', async () => {
    mockFetch({
      gallery: {
        results: [
          {
            extensions: [
              {
                displayName: 'Dracula Theme Official',
                extensionName: 'theme-dracula',
                shortDescription: 'Dark theme for Dracula fans.',
                publisher: {
                  publisherName: 'dracula-theme',
                  displayName: 'Dracula Theme',
                },
                statistics: [{ statisticName: 'install', value: 12400 }],
              },
              {
                displayName: 'Some Icon Pack',
                extensionName: 'icon-pack',
                shortDescription: 'icon pack for the file tree.',
                publisher: { publisherName: 'iconpub', displayName: 'Icon Pub' },
              },
            ],
          },
        ],
      },
    })

    const cards = await searchMarketplaceThemes('dracula')

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ]
    expect(url).toBe(GALLERY_URL)
    expect(init.method).toBe('POST')
    const body = JSON.parse(String(init.body))
    // 只请求 Themes 类别，且带搜索词。
    const criteria = body.filters[0].criteria
    expect(criteria).toContainEqual({ filterType: 5, value: 'Themes' })
    expect(criteria).toContainEqual({ filterType: 10, value: 'dracula' })

    // 图标包被过滤掉；保留主题卡片并取整 instlalls。
    expect(cards).toHaveLength(1)
    expect(cards[0]).toEqual({
      extensionId: 'dracula-theme.theme-dracula',
      displayName: 'Dracula Theme Official',
      publisher: 'Dracula Theme',
      description: 'Dark theme for Dracula fans.',
      installs: 12400,
    })
  })
})

describe('extractThemes', () => {
  it('extracts contributed color themes from a stored (uncompressed) vsix', async () => {
    const zip = buildStoredZip([
      [
        'extension/package.json',
        JSON.stringify({
          displayName: 'Demo Theme',
          contributes: {
            themes: [
              {
                label: 'Demo Dark',
                uiTheme: 'vs-dark',
                path: './themes/demo-dark.json',
              },
              { label: 'Demo Light', path: './themes/demo-light.json' },
            ],
          },
        }),
      ],
      ['extension/themes/demo-dark.json', '{"name":"Demo Dark","colors":{}}'],
      ['extension/themes/demo-light.json', '{"name":"Demo Light","colors":{}}'],
    ])

    const themes = await extractThemes(zip)

    expect(themes).toHaveLength(2)
    expect(themes[0]).toEqual({
      label: 'Demo Dark',
      uiTheme: 'vs-dark',
      contents: '{"name":"Demo Dark","colors":{}}',
    })
    expect(themes[1].label).toBe('Demo Light')
  })

  it('skips missing theme files instead of failing the whole install', async () => {
    const zip = buildStoredZip([
      [
        'extension/package.json',
        JSON.stringify({
          displayName: 'Partial Theme',
          contributes: { themes: [{ label: 'Gone', path: './themes/missing.json' }] },
        }),
      ],
    ])

    await expect(extractThemes(zip)).resolves.toEqual([])
  })

  it('throws when the vsix has no package manifest', async () => {
    const zip = buildStoredZip([['extension/readme.md', 'hello']])

    await expect(extractThemes(zip)).rejects.toThrow(/Package manifest missing/)
  })
})

describe('fetchMarketplaceThemes', () => {
  it('validates the id format before any network call', async () => {
    mockFetch({ gallery: {} })

    await expect(fetchMarketplaceThemes('not-an-id')).rejects.toThrow(
      /publisher\.extension/,
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('resolves + downloads the latest vsix and returns theme family', async () => {
    const zip = buildStoredZip([
      [
        'extension/package.json',
        JSON.stringify({
          displayName: 'Dracula',
          contributes: { themes: [{ label: 'Dracula', path: './dracula.json' }] },
        }),
      ],
      ['extension/dracula.json', '{"name":"Dracula","colors":{}}'],
    ])

    mockFetch({
      gallery: {
        results: [
          {
            extensions: [
              {
                displayName: 'Dracula Theme Official',
                extensionName: 'theme-dracula',
                publisher: { publisherName: 'dracula-theme' },
                versions: [
                  {
                    files: [
                      {
                        assetType: 'Microsoft.VisualStudio.Services.VSIXPackage',
                        source: 'https://cdn.example/dracula.vsix',
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      vsix: zip,
    })

    const result = await fetchMarketplaceThemes('dracula-theme.theme-dracula')

    expect(result.extensionId).toBe('dracula-theme.theme-dracula')
    expect(result.displayName).toBe('Dracula Theme Official')
    expect(result.themes).toHaveLength(1)
    expect(result.themes[0].label).toBe('Dracula')
  })
})

// ─── 手工构造一个 stored（无压缩）zip ───────────────────────────────────────

/** entries: [name, content][]，全部以 method 0（stored）写入。 */
function buildStoredZip(entries: Array<[string, string]>): ArrayBuffer {
  const enc = new TextEncoder()
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let offset = 0

  for (const [name, content] of entries) {
    const nameBytes = enc.encode(name)
    const data = enc.encode(content)
    const local = new Uint8Array(30 + nameBytes.length + data.length)
    const lv = new DataView(local.buffer)

    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0, true)
    lv.setUint16(8, 0, true) // method 0 = stored
    lv.setUint32(14, 0, true) // crc (未校验)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true)
    local.set(nameBytes, 30)
    local.set(data, 30 + nameBytes.length)
    localParts.push(local)

    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)

    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(10, 0, true) // method 0
    cv.setUint32(16, 0, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint16(30, 0, true)
    cv.setUint16(32, 0, true)
    cv.setUint32(42, offset, true)
    central.set(nameBytes, 46)
    centralParts.push(central)

    offset += local.length
  }

  const cd = concatBytes(centralParts)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)

  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, cd.length, true)
  ev.setUint32(16, offset, true)

  return concatBytes([...localParts, cd, eocd]).buffer as ArrayBuffer
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let cursor = 0

  for (const part of parts) {
    out.set(part, cursor)
    cursor += part.length
  }

  return out
}
