export type ThemeMode = 'light' | 'dark'

const STORAGE_KEY = 'yunwu-theme'

/** 读取已保存的主题;默认浅色(对齐 WorkBuddy 默认外观)。 */
export function getStoredTheme(): ThemeMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

/** 应用主题:写入 <html data-theme> 并持久化。 */
export function applyTheme(mode: ThemeMode): void {
  document.documentElement.dataset.theme = mode
  try {
    localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

/** 应用启动时调用,尽早设置主题避免闪烁。 */
export function initTheme(): void {
  applyTheme(getStoredTheme())
}
