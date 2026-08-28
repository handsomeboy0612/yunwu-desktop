import type { HomePlaybook } from '../market/wire.ts'

function localizedText(zh: string, en: string, language: 'zh' | 'en'): string {
  const primary = language === 'en' ? en : zh
  const fallback = language === 'en' ? zh : en
  return primary.trim() || fallback.trim()
}

function localizedList(
  zh: readonly string[],
  en: readonly string[],
  language: 'zh' | 'en',
): readonly string[] {
  const primary = language === 'en' ? en : zh
  const fallback = language === 'en' ? zh : en
  return Array.from(
    { length: Math.max(primary.length, fallback.length) },
    (_, index) => primary[index]?.trim() || fallback[index]?.trim() || '',
  ).filter(Boolean)
}

/** All case metadata rendered around the artifact, selected in one place. */
export function playbookCopy(
  item: HomePlaybook,
  language: 'zh' | 'en',
): {
  readonly title: string
  readonly subtitle: string
  readonly description: string
  readonly initPrompt: string
  readonly cover: string
  readonly tags: readonly string[]
} {
  return {
    title: localizedText(item.title, item.titleEn, language),
    subtitle: localizedText(item.subtitle, item.subtitleEn, language),
    description: localizedText(item.description, item.descriptionEn, language),
    initPrompt: localizedText(item.initPrompt, item.initPromptEn, language),
    cover: localizedText(item.cover, item.coverEn, language),
    tags: localizedList(item.tags, item.tagsEn, language),
  }
}
