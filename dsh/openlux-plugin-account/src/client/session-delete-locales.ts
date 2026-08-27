export const zh = {
  remove: '删除',
  untitled: '未命名会话',
  deleteTitle: '删除会话',
  deleteBody: '删除“{name}”？会话记录将从本机永久移除，无法恢复。',
  cancel: '取消',
  confirmDelete: '永久删除',
  deleting: '正在删除…',
  deleteFailed: '删除失败',
} as const

export type SessionDeleteKey = keyof typeof zh

export const en: Record<SessionDeleteKey, string> = {
  remove: 'Delete',
  untitled: 'Untitled session',
  deleteTitle: 'Delete session',
  deleteBody: 'Delete "{name}"? Its local record is removed permanently and cannot be recovered.',
  cancel: 'Cancel',
  confirmDelete: 'Delete permanently',
  deleting: 'Deleting…',
  deleteFailed: 'Delete failed',
}
