import type { CatalogCategory, CatalogItem } from '../market/wire.ts'

/** Acronyms that should not be title-cased when an English name falls back to the slug. */
const ACRONYMS = new Map([
  ['ai', 'AI'],
  ['api', 'API'],
  ['crm', 'CRM'],
  ['docx', 'DOCX'],
  ['erp', 'ERP'],
  ['mcp', 'MCP'],
  ['pdf', 'PDF'],
  ['pptx', 'PPTX'],
  ['qcc', 'QCC'],
  ['wps', 'WPS'],
])

const HAN = /\p{Script=Han}/u

/**
 * Turn a stable catalog slug into a readable last-resort English label.
 *
 * The V2 wire already carries `name_zh` and `name_en`; the client used to
 * discard the latter, so changing locale could only translate the surrounding
 * chrome. Some connector rows still publish no `name_en`, therefore falling
 * back to Chinese would preserve the same bug for that partition. Their slugs
 * are deliberately English, stable product identifiers and are safer than a
 * client-owned translation table that can drift from the catalog.
 */
function nameFromSlug(slug: string): string {
  return slug
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase()
      return ACRONYMS.get(lower) ?? `${part.charAt(0).toUpperCase()}${part.slice(1)}`
    })
    .join(' ')
}

/**
 * Read one catalog item's name in the active desktop language.
 *
 * English prefers the published field. A brand-led mixed name such as
 * `DeepWiki 仓库问答` keeps its authored brand; a Chinese-only row falls back
 * to its English slug. Chinese keeps the catalog's stable default name.
 */
export function marketItemName(item: CatalogItem, language: 'zh' | 'en'): string {
  if (language === 'zh') return item.name
  const published = item.nameEn.trim()
  if (published !== '') return published
  if (!HAN.test(item.name)) return item.name

  const leadingBrand = item.name.split(HAN, 1)[0]?.trim().replace(/[-·:：\s]+$/u, '') ?? ''
  return leadingBrand === '' ? (nameFromSlug(item.slug) || item.name) : leadingBrand
}

/** Pick parallel localized arrays without losing an item when one translation is absent. */
function localizedList(
  zh: readonly string[],
  en: readonly string[],
  language: 'zh' | 'en',
): readonly string[] {
  const primary = language === 'en' ? en : zh
  const fallback = language === 'en' ? zh : en
  const length = Math.max(primary.length, fallback.length)
  const result: string[] = []
  for (let index = 0; index < length; index += 1) {
    const value = primary[index]?.trim() || fallback[index]?.trim()
    if (value !== undefined && value !== '' && !result.includes(value)) result.push(value)
  }
  return result
}

/** Tags shown on cards and details in the active language. */
export function marketItemTags(item: CatalogItem, language: 'zh' | 'en'): readonly string[] {
  return localizedList(item.tags, item.tagsEn, language)
}

/** Opening questions shown in details and staged into the composer. */
export function marketItemPrompts(item: CatalogItem, language: 'zh' | 'en'): readonly string[] {
  return localizedList(item.openingPrompts ?? [], item.openingPromptsEn ?? [], language)
}

/** Category chip and expert profession label in the active language. */
export function marketCategoryName(
  category: CatalogCategory,
  language: 'zh' | 'en',
): string {
  if (language === 'zh') return category.name || category.nameEn
  return category.nameEn.trim()
    || (!HAN.test(category.name) ? category.name : nameFromSlug(category.slug))
    || category.name
}
