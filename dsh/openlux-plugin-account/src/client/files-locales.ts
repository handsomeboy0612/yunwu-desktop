/**
 * Copy for the composer's file button.
 *
 * Its own namespace rather than a few more keys in the media one: that
 * dictionary is about the pictures and clips this plugin produces, and this is
 * about a file the user brought in.
 *
 * @module openlux-plugin-account/client/files-locales
 */

/** Simplified Chinese dictionary; the key set every other locale is checked against. */
export const zh = {
  'attach': '附带文件',
  'attaching': '正在附带…',
  // The button hands the model a path, so the refusals say "没附上" rather than
  // "上传失败": nothing was ever being uploaded.
  'tooLarge': '这个文件超过 {size}，没附上',
  'unreadable': '这个文件读不出来，没附上',
  'failed': '没附上：{reason}',
}

/** English dictionary. */
export const en = {
  'attach': 'Attach file',
  'attaching': 'Attaching…',
  'tooLarge': 'This file is over {size}; nothing was attached',
  'unreadable': 'This file could not be read; nothing was attached',
  'failed': 'Not attached: {reason}',
}

/** Key union of this namespace's dictionaries. */
export type FilesKey = keyof typeof zh
