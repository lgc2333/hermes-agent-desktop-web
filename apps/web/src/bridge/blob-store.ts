/**
 * ADR-0020 — 附件字节存储抽象：web-blobs/ 目录的读写清删。
 *
 * 存储模型二分（详见 docs/adr/0020）：
 *   - File（拖入）→ BrowserAdapter 内 Map<虚拟路径, File> 保留引用（零常驻）；
 *   - Blob（粘贴图片 / HTML 预览等内存字节）→ 本接口的 OPFS 实现落盘。
 *
 * 接口刻意小：只有写/读/删/清四操作；生命周期（页面载入清空、无 TTL）由
 * BrowserAdapter 初始化调用 clearAll() 保证。不支持 OPFS 的环境（老浏览器）
 * 不造回退（ADR-0020），测试用 MemoryBlobStore 注入。
 */

/** OPFS 里附件字节所在的根目录名（页面载入时整体清空）。 */
export const WEB_BLOBS_DIR = 'web-blobs'

/** 附件字节存储：web-blobs/ 目录的读写清删。 */
export interface AttachmentBlobStore {
  /** 清空整个 web-blobs/ 目录（页面载入初始化调用）。 */
  clearAll: () => Promise<void>
  /** 流式写入一个文件（OPFS: createWritable + file.stream()）。 */
  write: (name: string, blob: Blob) => Promise<void>
  /** 读回文件；不存在返回 null。 */
  read: (name: string) => Promise<Blob | null>
  /** 删除文件；不存在时静默。 */
  remove: (name: string) => Promise<void>
}

interface OpfsFileSystemDirectoryHandle {
  entries: () => AsyncIterable<[string, unknown]>
  getDirectoryHandle: (
    name: string,
    options?: { create?: boolean },
  ) => Promise<OpfsFileSystemDirectoryHandle>
  getFileHandle: (
    name: string,
    options?: { create?: boolean },
  ) => Promise<OpfsFileSystemFileHandle>
  removeEntry: (name: string) => Promise<void>
}

interface OpfsFileSystemFileHandle {
  createWritable: () => Promise<OpfsFileSystemWritableFileStream>
  getFile: () => Promise<File>
}

interface OpfsFileSystemWritableFileStream {
  write: (data: Blob | BlobPart[] | string) => Promise<void>
  close: () => Promise<void>
}

/** navigator.storage 的最小 OPFS 表型（避免依赖 lib.dom 的较新声明）。 */
interface OpfsNavigatorStorage {
  getDirectory: () => Promise<OpfsFileSystemDirectoryHandle>
}

function opfsStorage(): OpfsNavigatorStorage | null {
  const storage = (navigator as { storage?: OpfsNavigatorStorage }).storage

  return typeof storage?.getDirectory === 'function' ? storage : null
}

/** OPFS 实现：navigator.storage.getDirectory() → web-blobs/ 目录。 */
export class OpfsBlobStore implements AttachmentBlobStore {
  private dirPromise: Promise<OpfsFileSystemDirectoryHandle> | null = null

  private async getDir(): Promise<OpfsFileSystemDirectoryHandle> {
    if (!this.dirPromise) {
      this.dirPromise = this.openDir()
    }

    return this.dirPromise
  }

  private async openDir(): Promise<OpfsFileSystemDirectoryHandle> {
    const storage = opfsStorage()

    if (!storage) {
      throw new Error('OPFS unavailable')
    }

    const root = await storage.getDirectory()

    return root.getDirectoryHandle(WEB_BLOBS_DIR, { create: true })
  }

  async clearAll(): Promise<void> {
    const dir = await this.getDir()
    const entries = []

    for await (const [name] of dir.entries()) {
      entries.push(name)
    }

    await Promise.all(
      entries.map((name) => dir.removeEntry(name).catch(() => undefined)),
    )
  }

  async write(name: string, blob: Blob): Promise<void> {
    const dir = await this.getDir()
    const handle = await dir.getFileHandle(name, { create: true })
    const writable = await handle.createWritable()
    // 直接写 Blob：WritableFileStream 内部按流式传输（等价 blob.stream()，
    // 且兼容无 stream() 的 Blob 实现，如 jsdom 测试 fake）。
    await writable.write(blob)
    await writable.close()
  }

  async read(name: string): Promise<Blob | null> {
    try {
      const dir = await this.getDir()
      const handle = await dir.getFileHandle(name)

      return handle.getFile()
    } catch {
      return null
    }
  }

  async remove(name: string): Promise<void> {
    try {
      const dir = await this.getDir()
      await dir.removeEntry(name)
    } catch {
      // 已不存在：静默
    }
  }
}

/** 内存 fake（单测注入；不提供持久性，仅行为等价）。 */
export class MemoryBlobStore implements AttachmentBlobStore {
  private readonly blobs = new Map<string, Blob>()

  async clearAll(): Promise<void> {
    this.blobs.clear()
  }

  async write(name: string, blob: Blob): Promise<void> {
    this.blobs.set(name, blob)
  }

  async read(name: string): Promise<Blob | null> {
    return this.blobs.get(name) ?? null
  }

  async remove(name: string): Promise<void> {
    this.blobs.delete(name)
  }

  /** 测试辅助：当前存了哪些文件名。 */
  names(): string[] {
    return [...this.blobs.keys()]
  }
}
