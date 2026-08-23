/**
 * Copy for the image card, under both of the tool names that share it.
 *
 * Its own namespace for the same reason the market has one: the card is
 * registered independently of the account surfaces, and a namespace is the unit
 * the kernel's locale registry hands out. One dictionary rather than two,
 * because the rows differ only in these titles — everything below them is the
 * same gallery.
 *
 * The generate row has two wordings because it does two things: an edit that
 * announces itself as a fresh drawing is the same comfortable lie the tool
 * refuses to tell on the model-facing side. The host says this a second time in
 * its own `presentCall`/`presentResult` (`media/tool.ts`) for a UI that has no
 * card of ours; when one side's wording changes the other has to follow, and
 * only the copy here is what the desktop actually shows.
 *
 * The `image.*` half is not ours by choice — the attachment atoms take every
 * string as a prop (`@deepseek-ai/dsh-client-ui-attachment` reads no
 * application state), so an owner has to resolve them. The wording follows the
 * kernel's own chat-history images so a generated picture and a pasted one
 * behave identically down to their tooltips.
 */

/** Simplified Chinese dictionary; the key set every other locale is checked against. */
export const zh = {
  'call.title': '生成图片',
  'call.pending': '生成中…',
  'result.title': '已生成 {count} 张图片',
  'result.failed': '出图失败',

  'edit.title': '修改图片',
  'edit.pending': '修改中…',
  'edit.result': '已改出 {count} 张图片',
  'edit.failed': '改图失败',

  'show.title': '展示图片',
  'show.pending': '读取中…',
  'show.result': '已展示 {count} 张图片',
  'show.failed': '展示失败',

  'image.label': '图片',
  'image.open': '查看原图',
  'image.openNamed': '查看原图：{label}',
  'image.loading': '加载中…',
  'image.loadFailed': '加载失败，点击重试',
  'image.preview': '图片预览',
  'image.closePreview': '关闭预览',
} satisfies Record<string, string>

/** Key union of this card's copy. */
export type MediaKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'call.title': 'Generate image',
  'call.pending': 'Generating…',
  'result.title': 'Generated {count} image(s)',
  'result.failed': 'Image generation failed',

  'edit.title': 'Edit image',
  'edit.pending': 'Editing…',
  'edit.result': 'Edited {count} image(s)',
  'edit.failed': 'Image edit failed',

  'show.title': 'Show image',
  'show.pending': 'Reading…',
  'show.result': 'Showing {count} image(s)',
  'show.failed': 'Could not show the image',

  'image.label': 'Image',
  'image.open': 'View original',
  'image.openNamed': 'View original: {label}',
  'image.loading': 'Loading…',
  'image.loadFailed': 'Load failed — click to retry',
  'image.preview': 'Image preview',
  'image.closePreview': 'Close preview',
} satisfies Record<MediaKey, string>
