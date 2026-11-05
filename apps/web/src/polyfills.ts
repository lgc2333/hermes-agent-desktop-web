/**
 * 浏览器兼容兜底（Web 侧，非 vendor）。
 *
 * 上游渲染层自 v0.23.0 起用 `Promise.withResolvers`（voice-level-meter、
 * preview-act、preview-drive-channels）。Electron 44 自带，浏览器要 Chrome 119 /
 * Safari 17.4 / Firefox 121 起才有；Vite 只降级语法、不 polyfill API，更老的
 * 浏览器会在用到时抛 TypeError。这里补一个等价实现，须在 vendor 渲染树之前
 * import（见 main.tsx）。
 */
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function <T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })

    return { promise, resolve, reject }
  }
}

export {}
