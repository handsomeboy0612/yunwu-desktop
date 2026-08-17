/**
 * 助手回复里的 `MEDIA:` 指令解析(正文剥离 + 媒体附件)。
 *
 * 为什么要在客户端做这件事:内核把「生成的媒体怎么回到会话」定成了**文本内协议**,
 * 而不是给客户端一个结构化字段。内核 system prompt 的 Assistant Output Directives 段原文:
 *
 *   - Attach media in the final visible reply with `MEDIA:<path-or-url>` on its own line.
 *   - Tool/generated media paths are attachments, not prose; emit each as its own `MEDIA:` line.
 *   - Supported directives are stripped before rendering; channel config still decides delivery.
 *
 * `image_generate` 的后台任务完成后,内核唤醒会话并要求 agent
 * "write the normal final reply and attach every generated media path with final-reply MEDIA lines"
 * (见内核 buildMediaGenerationReplyInstruction)。也就是说:**带 `MEDIA:` 的原文会原样到客户端,
 * 由客户端负责拆解**——所以内核把同一份解析器打进了自己的 control-ui
 * (dist/control-ui/assets 里能搜到同样的 `/\bMEDIA:\s*`?([^\n]+)`?/gi` 与分段逻辑)。
 * 不拆的后果是用户直接看到一行 `MEDIA:C:\Users\...\xxx.png` 而图不出现。
 *
 * 本模块对齐的形状(control-ui 的 assistant 文本转内容块函数):
 *  1. 按行扫,代码围栏内一律原样保留(不能把示例里的 MEDIA: 当真指令);
 *  2. 命中行拆成媒体段,其余为文本段,相邻文本段合并;
 *  3. 校验不通过的路径**退回成字面文本**,而不是静默丢弃(宁可让用户看到也别凭空消失);
 *  4. 扩展名 → kind 的映射照 WorkBuddy 的 getArtifactFileIconKind(它的 IMAGE_EXTS 更全,
 *     avif/heic/tiff 都在)。
 *
 * 刻意不做的:markdown 图片语法 `![](path)` 不抽。内核那个解析器有 extractMarkdownImages
 * 开关,但只有 Telegram 出站适配器开它,control-ui 是关的——我们对齐 control-ui。
 */

/** 媒体 kind。照 WorkBuddy getArtifactFileIconKind 的分类口径。 */
export type MediaKind = 'image' | 'video' | 'audio' | 'file'

/** 图片扩展名。原样取自 WorkBuddy 的 IMAGE_EXTS。 */
const IMAGE_EXTS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'ico',
  'tiff',
  'tif',
  'avif',
  'heic'
])

/** 视频扩展名。原样取自 WorkBuddy 的 VIDEO_EXTS。 */
const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'flv', 'wmv'])

/** 音频扩展名。原样取自 WorkBuddy 的 AUDIO_EXTS。 */
const AUDIO_EXTS = new Set(['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma', 'opus'])

/** 取扩展名(小写、去查询串与锚点)。照 WorkBuddy 的 getFileExtension。 */
export function extensionOf(nameOrPath: string): string {
  if (typeof nameOrPath !== 'string') {
    return ''
  }
  const normalized = nameOrPath.split(/[?#]/)[0]?.trim().toLowerCase() ?? ''
  const last = normalized.split(/[\\/]/).pop() ?? normalized
  const dot = last.lastIndexOf('.')
  return dot >= 0 ? last.slice(dot + 1) : ''
}

/** 按扩展名判媒体 kind;认不出归 file(仍作附件展示,只是没有内联预览)。 */
export function mediaKindOf(nameOrPath: string): MediaKind {
  const ext = extensionOf(nameOrPath)
  if (IMAGE_EXTS.has(ext)) {
    return 'image'
  }
  if (VIDEO_EXTS.has(ext)) {
    return 'video'
  }
  if (AUDIO_EXTS.has(ext)) {
    return 'audio'
  }
  return 'file'
}

/** 是否图片(产出物卡片要据此决定渲染缩略图还是文件卡)。 */
export function isImagePath(nameOrPath: string): boolean {
  return mediaKindOf(nameOrPath) === 'image'
}

/** 扩展名 → 图片 mime。给 Blob 带上类型,不指望浏览器嗅探。认不出返回空串。 */
export function imageMimeOf(nameOrPath: string): string {
  switch (extensionOf(nameOrPath)) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'svg':
      return 'image/svg+xml'
    case 'bmp':
      return 'image/bmp'
    case 'ico':
      return 'image/x-icon'
    case 'tif':
    case 'tiff':
      return 'image/tiff'
    case 'avif':
      return 'image/avif'
    case 'heic':
      return 'image/heic'
    default:
      return ''
  }
}

const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const HAS_FILE_EXT = /\.\w{1,10}$/
const TRAVERSAL_RE = /(?:^|[/\\])\.\.(?:[/\\]|$)/

/** 去掉路径外层的引号/反引号/括号(模型常给 `MEDIA:`path`` 这种)。 */
function unwrap(raw: string): string {
  return raw.replace(/^[`"'[{(]+/, '').replace(/[`"'\\})\],]+$/, '')
}

/**
 * 判一个候选值是否像可渲染的媒体引用。口径照内核 payloads 模块:
 * 要么带 scheme(http/https/data/file),要么是本地路径(绝对 / 盘符 / UNC / 带分隔符的相对),
 * 且必须有文件扩展名;含 `..` 穿越的一律拒(拒了会退回字面文本,不会静默消失)。
 */
function isRenderableMediaRef(value: string): boolean {
  const v = value.trim()
  if (!v || TRAVERSAL_RE.test(v)) {
    return false
  }
  if (/^(https?|data):/i.test(v)) {
    return true
  }
  if (!HAS_FILE_EXT.test(v.split(/[?#]/)[0] ?? v)) {
    return false
  }
  if (v.startsWith('file://')) {
    return true
  }
  if (WINDOWS_DRIVE_RE.test(v) || v.startsWith('/') || v.startsWith('\\\\') || v.startsWith('~')) {
    return true
  }
  // 带分隔符的相对路径(排除误把 "foo:bar" 这类 scheme 当路径)。
  return !SCHEME_RE.test(v) && (v.includes('/') || v.includes('\\'))
}

/** `file://` 归一成本地路径;其余原样。照内核 normalizeMediaSource。 */
export function normalizeMediaSource(src: string): string {
  const v = src.trim()
  if (!v.toLowerCase().startsWith('file://')) {
    return v
  }
  try {
    const decoded = decodeURIComponent(new URL(v).pathname)
    // Windows 下 file:///C:/x 解出来是 /C:/x,要去掉前导斜杠。
    return /^\/[a-zA-Z]:\//.test(decoded) ? decoded.slice(1) : decoded
  } catch {
    return v.replace(/^file:\/\//i, '')
  }
}

/**
 * 从一条 `MEDIA:` 行的值里取出媒体引用。
 *
 * 一行可以带多个,但本地路径自己也可能含空格,两者冲突。内核的判定顺序是(不能颠倒):
 *  1. 整行被引号/反引号包起来 → 就是一个路径,空格属于路径;
 *  2. 否则**先按空白切**,逐个校验;
 *  3. 只有在「恰好一个切片通过、却还剩下别的碎片」时,才回头把整行当成一个带空格的
 *     路径来修补(典型如 `C:\my folder\a.png`:切完只有后半段像路径)。
 *
 * 一开始我写成「先整体试再切分」,于是 `MEDIA:/tmp/a.png /tmp/b.png` 被当成了单个
 * 名叫 `a.png /tmp/b.png` 的文件——两张图变一张不存在的。用例跑出来才发现。
 */
function refsFromDirectiveValue(value: string): string[] {
  const trimmed = value.trim()
  const quoted = /^([`"'])(.+)\1$/.exec(trimmed)?.[2]
  if (quoted) {
    const single = unwrap(quoted)
    return isRenderableMediaRef(single) ? [single] : []
  }

  const valid: string[] = []
  const leftovers: string[] = []
  for (const part of trimmed.split(/\s+/).filter(Boolean)) {
    const candidate = unwrap(part)
    if (isRenderableMediaRef(candidate)) {
      valid.push(candidate)
    } else {
      leftovers.push(part)
    }
  }
  if (valid.length === 1 && leftovers.length > 0 && /\s/.test(trimmed)) {
    const whole = unwrap(trimmed)
    if (isRenderableMediaRef(whole)) {
      return [whole]
    }
  }
  return valid
}

/** 文本段或媒体段。顺序即原文顺序(媒体在正文中的位置有语义)。 */
export type MediaSegment =
  | { type: 'text'; text: string }
  | { type: 'media'; url: string; kind: MediaKind; name: string }

/** 解析结果:剥离指令后的正文 + 按序的分段 + 去重后的媒体引用。 */
export interface ParsedMediaText {
  /** 剥掉 `MEDIA:` 行之后的正文(用于展示)。 */
  text: string
  segments: MediaSegment[]
  /** 去重后的媒体引用(已 file:// 归一),供产出物聚合使用。 */
  media: Array<{ url: string; kind: MediaKind; name: string }>
}

/** 行首(允许 3 空格缩进)的代码围栏标记。 */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/

/** 取路径末段作展示名。 */
function nameOf(ref: string): string {
  const base = ref.split(/[?#]/)[0] ?? ref
  return base.split(/[\\/]/).filter(Boolean).pop() || ref
}

/**
 * 拆分助手正文里的 `MEDIA:` 指令。
 *
 * 代码围栏内的行原样保留:技能文档/回答里出现的示例指令不能被当真,否则一段讲解
 * 会突然变成一张图。围栏判定用行首标记配对,与内核 parseFenceSpans 同效。
 */
export function parseMediaDirectives(raw: string): ParsedMediaText {
  const text = raw ?? ''
  // 绝大多数回复不含指令,先用一次廉价判断短路,避免每帧流式都走整套分行扫描。
  if (!text || !/media:/i.test(text)) {
    return { text, segments: text ? [{ type: 'text', text }] : [], media: [] }
  }

  const segments: MediaSegment[] = []
  const keptLines: string[] = []
  const seen = new Set<string>()
  const media: Array<{ url: string; kind: MediaKind; name: string }> = []

  const pushText = (line: string): void => {
    keptLines.push(line)
    const last = segments[segments.length - 1]
    if (last?.type === 'text') {
      last.text = `${last.text}\n${line}`
      return
    }
    segments.push({ type: 'text', text: line })
  }

  let fence: string | null = null
  for (const line of text.split('\n')) {
    const marker = FENCE_RE.exec(line)?.[1]
    if (marker) {
      // 同种标记且不短于开围栏才算闭合(照 markdown 规则,也照内核的 markerChar/markerLen 判定)。
      if (!fence) {
        fence = marker
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null
      }
      pushText(line)
      continue
    }
    if (fence) {
      pushText(line)
      continue
    }
    const trimmed = line.trimStart()
    if (!trimmed.toUpperCase().startsWith('MEDIA:')) {
      pushText(line)
      continue
    }
    const refs = refsFromDirectiveValue(trimmed.slice('MEDIA:'.length))
    if (refs.length === 0) {
      // 校验不过的照原样留在正文里,别让用户的东西凭空消失。
      pushText(line)
      continue
    }
    for (const ref of refs) {
      const url = normalizeMediaSource(ref)
      const kind = mediaKindOf(url)
      const name = nameOf(url)
      segments.push({ type: 'media', url, kind, name })
      if (!seen.has(url)) {
        seen.add(url)
        media.push({ url, kind, name })
      }
    }
  }

  return { text: keptLines.join('\n').trim(), segments, media }
}

/**
 * 流式渲染用:把末尾**尚未成行**的 `MEDIA:` 片段藏起来。
 *
 * 不做这一步,用户会看到 `MEDIA:C:\Users\000\.opencl` 一个字一个字长出来,
 * 直到整行到齐才消失。内核对自己的流式出站也是这么缓冲的(splitTrailingDirective
 * 会把末行是 `MEDIA:` 或 `MEDIA` 前缀的部分从可见文本里扣掉)。
 */
export function stripTrailingPartialMediaLine(text: string): string {
  if (!text) {
    return text
  }
  const nl = text.lastIndexOf('\n')
  const lastLine = nl < 0 ? text : text.slice(nl + 1)
  const trimmed = lastLine.trimStart()
  // 已成行的完整指令由 parseMediaDirectives 负责,这里只管「还没写完」的末行。
  if (/^MEDIA:/i.test(trimmed) || /^(M|ME|MED|MEDI|MEDIA)$/i.test(trimmed)) {
    return nl < 0 ? '' : text.slice(0, nl)
  }
  return text
}
