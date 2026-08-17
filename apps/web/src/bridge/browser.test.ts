import { describe, expect, it, vi } from 'vitest'

import { MemoryBlobStore, OpfsBlobStore, WEB_BLOBS_DIR } from './blob-store'
import { BrowserAdapter } from './browser'

/**
 * ADR-0020 桥面 TDD：附件字节存储二分（File 引用 + OPFS）。
 *
 * 用 MemoryBlobStore 注入（jsdom 无 OPFS）验证行为契约；OpfsBlobStore 用
 * fake 目录 handle 验证 OPFS 语义（clearAll / write / read / remove）。
 */

describe('BlobStore 抽象', () => {
  it('MemoryBlobStore 行为等价：写读删清', async () => {
    const store = new MemoryBlobStore()
    const blob = new Blob(['hello'], { type: 'text/plain' })

    await store.write('a.txt', blob)
    expect(await store.read('a.txt')).not.toBeNull()
    expect((await store.read('a.txt'))?.text).toBeDefined()

    await store.remove('a.txt')
    expect(await store.read('a.txt')).toBeNull()

    await store.write('b.txt', blob)
    await store.clearAll()
    expect(store.names()).toEqual([])
  })

  it('OpfsBlobStore 用 navigator.storage.getDirectory 落到 web-blobs/ 目录', async () => {
    const files = new Map<string, { data: string; blob: Blob | null }>()
    const dirHandle = {
      entries: vi.fn(async function* () {
        for (const [name, entry] of files) {
          yield [name, entry]
        }
      }),
      getDirectoryHandle: vi.fn(
        async (name: string, options?: { create?: boolean }) => {
          if (options?.create !== false && options?.create !== undefined) {
            // sub directory handle not exercised here
          }
          throw new Error('not a directory op')
        },
      ),
      getFileHandle: vi.fn(async (name: string) => ({
        createWritable: vi.fn(async () => ({
          write: vi.fn(async (data: Blob) => {
            files.set(name, { data: await data.text(), blob: data })
          }),
          close: vi.fn(async () => undefined),
        })),
        getFile: vi.fn(async () => {
          const entry = files.get(name)

          if (!entry) {
            throw new Error('not found')
          }

          return new Blob([entry.data], { type: 'text/plain' })
        }),
      })),
      removeEntry: vi.fn(async (name: string) => {
        files.delete(name)
      }),
    }
    const rootHandle = {
      getDirectoryHandle: vi.fn(async (name: string) => {
        expect(name).toBe(WEB_BLOBS_DIR)
        return dirHandle
      }),
    }
    const storage = { getDirectory: vi.fn(async () => rootHandle) }
    vi.stubGlobal('navigator', { storage } as never)

    const store = new OpfsBlobStore()

    await store.write(
      'x/1.txt'.replace('/', '-'),
      new Blob(['abc'], { type: 'text/plain' }),
    )
    const readBack = await store.read('x-1.txt')
    expect(await readBack?.text()).toBe('abc')

    await store.clearAll()
    expect(files.size).toBe(0)
    vi.unstubAllGlobals()
  })
})

describe('BrowserAdapter 附件存储（ADR-0020）', () => {
  const makeAdapter = (store = new MemoryBlobStore()) => new BrowserAdapter(store)

  it('saveImageFile 对 File 保留引用（Map 命中，读回瞬态 b64）', async () => {
    const store = new MemoryBlobStore()
    const adapter = makeAdapter(store)
    const file = new File(['hello'], 'report.pdf', { type: 'application/pdf' })

    const path = await adapter.saveImageFile(file, 'report.pdf')
    expect(path).toMatch(/^web-blob:\/\/attach\/\d+-report\.pdf$/)

    // File 分支不写 OPFS：web-blobs/ 目录应为空。
    expect(store.names()).toEqual([])

    const dataUrl = await adapter.readFileDataUrl(path)
    expect(dataUrl).toBe('data:application/pdf;base64,aGVsbG8=')
  })

  it('saveImageFile 对 Blob 走 OPFS 落盘（MemoryBlobStore 命中，读回瞬态 b64）', async () => {
    const store = new MemoryBlobStore()
    const adapter = makeAdapter(store)
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })

    const path = await adapter.saveImageFile(blob, 'pasted.png')
    expect(path).toMatch(/^web-blob:\/\/attach\/\d+-pasted\.png$/)

    // Blob 分支不入 File 引用表：readFileDataUrl 从 OPFS 读。
    expect(store.names()).toHaveLength(1)
    expect(store.names()[0]).toMatch(/^\d+-pasted\.png$/)

    const dataUrl = await adapter.readFileDataUrl(path)
    expect(dataUrl).toBe('data:image/png;base64,AQID')
  })

  it('readFileDataUrl 对虚拟路径未命中返回空串（组合层兜底 gateway REST 不变）', async () => {
    const adapter = makeAdapter()

    expect(await adapter.readFileDataUrl('web-blob://attach/999-nope.pdf')).toBe('')
    expect(await adapter.readFileDataUrl('/repo/real.pdf')).toBe('')
  })

  it('releaseBlobFile 释放 File 引用（Map.delete：再读返回空）', async () => {
    const adapter = makeAdapter()
    const file = new File(['hello'], 'report.pdf', { type: 'application/pdf' })
    const path = await adapter.saveImageFile(file, 'report.pdf')

    await adapter.releaseBlobFile(path)
    expect(await adapter.readFileDataUrl(path)).toBe('')
  })

  it('releaseBlobFile 释放 OPFS 文件（remove：再读返回空）', async () => {
    const store = new MemoryBlobStore()
    const adapter = makeAdapter(store)
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
    const path = await adapter.saveImageFile(blob, 'pasted.png')

    await adapter.releaseBlobFile(path)
    expect(await adapter.readFileDataUrl(path)).toBe('')
    expect(store.names()).toEqual([])
  })

  it('saveImageBuffer 保留签名：bytes → Blob → OPFS 写，readFileDataUrl 读回', async () => {
    const store = new MemoryBlobStore()
    const adapter = makeAdapter(store)

    const path = await adapter.saveImageBuffer(new Uint8Array([1, 2, 3]), '.png')
    expect(path).toMatch(/^web-blob:\/\/attach\//)
    expect(store.names()).toHaveLength(1)
    expect(await adapter.readFileDataUrl(path)).toBe('data:image/png;base64,AQID')
  })

  it('页面载入初始化：构造时清空 web-blobs/ 目录（上一页残留不泄漏）', async () => {
    const store = new MemoryBlobStore()
    store.write('stale-from-previous-page.bin', new Blob(['x']))

    makeAdapter(store)
    expect(store.names()).toEqual([])
  })

  it('虚拟路径嵌真实文件名：pathLabel 语义取 basename 供 file.attach name 用', async () => {
    const adapter = makeAdapter()
    const file = new File(['hello'], 'quarterly report.pdf', {
      type: 'application/pdf',
    })

    const path = await adapter.saveImageFile(file, 'quarterly report.pdf')
    // web-blob://attach/<id>-<name>：末段 = <id>-<name>，嵌真实文件名。
    const basename = path.split(/[\\/]/).filter(Boolean).pop()
    expect(basename).toContain('quarterly report.pdf')
  })
})
