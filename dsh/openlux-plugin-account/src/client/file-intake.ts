/**
 * What the kernel image intake accepts by default.
 *
 * Documents and mixed batches always stay on the path route.
 */
const KERNEL_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** Pure intake decision shared by click/drop/paste callers and node tests. */
export function fileIntakeRoute(
  files: readonly { readonly type: string }[],
  options: { readonly kernelTakesImages: boolean; readonly clipboardHasText: boolean },
): 'kernel' | 'path' {
  const allKernelImages = files.length > 0 && files.every(file => KERNEL_IMAGE_TYPES.has(file.type))
  if (!allKernelImages) return 'path'
  // Preserve the kernel's text+image paste transaction when every file is an
  // image. Documents never take that route, even when clipboard text exists.
  if (options.clipboardHasText) return 'kernel'
  return options.kernelTakesImages ? 'kernel' : 'path'
}
