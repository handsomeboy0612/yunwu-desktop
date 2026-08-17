import { useEffect, useMemo, useRef, useState } from 'react'
import { ImagePlus, Send, ShieldCheck, Trash2, X } from 'lucide-react'
import type { FeedbackCategory, FeedbackSubmission } from '@shared/types'
import FloatingMask from './FloatingMask'

const MAX_IMAGES = 6
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_CONTENT = 10_000
const IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp'
])

const CATEGORIES: Array<{ value: FeedbackCategory; label: string }> = [
  { value: 'problem', label: '遇到问题' },
  { value: 'suggestion', label: '产品建议' },
  { value: 'other', label: '其他' }
]

interface Props {
  open: boolean
  page: string
  onClose: () => void
  onSuccess: (feedbackId: number) => void
}

/**
 * 通用反馈弹窗。
 *
 * 形状跟 WorkBuddy 当前 FeedbackModal 保持一致：一个弹窗承接多个入口、正文是唯一
 * 必填项、图片最多6张且单张10MB、诊断默认关闭；失败保留草稿，关闭后也只在内存中保留。
 */
export default function FeedbackModal({ open, page, onClose, onSuccess }: Props) {
  const [category, setCategory] = useState<FeedbackCategory>('problem')
  const [content, setContent] = useState('')
  const [images, setImages] = useState<File[]>([])
  const [includeDiagnostics, setIncludeDiagnostics] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const previews = useMemo(
    () => images.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [images]
  )
  useEffect(
    () => () => {
      previews.forEach(({ url }) => URL.revokeObjectURL(url))
    },
    [previews]
  )

  const addImages = (files: File[]): void => {
    setError('')
    const accepted: File[] = []
    for (const raw of files) {
      if (!IMAGE_TYPES.has(raw.type)) {
        setError('仅支持 JPG、PNG、GIF、WebP 和 BMP 图片')
        continue
      }
      if (raw.size > MAX_IMAGE_BYTES) {
        setError(`图片“${raw.name || '剪贴板图片'}”超过10MB`)
        continue
      }
      const extension = raw.type === 'image/jpeg' ? 'jpg' : raw.type.split('/')[1]
      accepted.push(
        raw.name
          ? raw
          : new File([raw], `pasted-${Date.now()}.${extension}`, { type: raw.type })
      )
    }
    setImages((current) => {
      const room = MAX_IMAGES - current.length
      if (accepted.length > room) {
        setError('最多添加6张图片')
      }
      return [...current, ...accepted.slice(0, Math.max(0, room))]
    })
  }

  const close = (): void => {
    if (!submitting) onClose()
  }

  const submit = async (): Promise<void> => {
    const trimmed = content.trim()
    if (!trimmed || submitting) return
    setSubmitting(true)
    setError('')
    try {
      const submission: FeedbackSubmission = {
        category,
        content: trimmed,
        page,
        includeDiagnostics,
        images: await Promise.all(
          images.map(async (file) => ({
            name: file.name,
            type: file.type,
            data: new Uint8Array(await file.arrayBuffer())
          }))
        )
      }
      const result = await window.api.submitFeedback(submission)
      if (!result.ok || !result.data) {
        throw new Error(result.error || '提交失败，请稍后重试')
      }
      const feedbackId = result.data.feedbackId
      setCategory('problem')
      setContent('')
      setImages([])
      setIncludeDiagnostics(false)
      onSuccess(feedbackId)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) return null

  return (
    <FloatingMask className="feedback-mask" onClick={close}>
      <section
        className="feedback-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-title"
        onClick={(event) => event.stopPropagation()}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files)
          if (files.length > 0) addImages(files)
        }}
      >
        <header className="feedback-head">
          <div>
            <h2 id="feedback-title">问题反馈</h2>
            <p>告诉我们哪里不好用，截图能帮助我们更快定位。</p>
          </div>
          <button className="icon-btn" title="关闭" disabled={submitting} onClick={close}>
            <X size={17} strokeWidth={1.8} />
          </button>
        </header>

        <div className="feedback-categories" aria-label="反馈类型">
          {CATEGORIES.map((item) => (
            <button
              key={item.value}
              type="button"
              className={category === item.value ? 'active' : ''}
              onClick={() => setCategory(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div
          className={`feedback-editor${dragging ? ' dragging' : ''}`}
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            addImages(Array.from(event.dataTransfer.files))
          }}
        >
          <textarea
            autoFocus
            value={content}
            maxLength={MAX_CONTENT}
            placeholder="请描述你遇到的问题、期望的结果，或想改进的地方…"
            onChange={(event) => setContent(event.target.value)}
          />
          <span className="feedback-count">{content.length}/{MAX_CONTENT}</span>
          {dragging && <div className="feedback-drop-hint">松开即可添加图片</div>}
        </div>

        {previews.length > 0 && (
          <div className="feedback-previews">
            {previews.map(({ file, url }, index) => (
              <div className="feedback-preview" key={`${file.name}-${file.lastModified}-${index}`}>
                <img src={url} alt={file.name || `反馈图片${index + 1}`} />
                <button
                  type="button"
                  title="移除图片"
                  onClick={() => setImages((current) => current.filter((_, i) => i !== index))}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="feedback-tools">
          <input
            ref={inputRef}
            hidden
            multiple
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp,image/bmp"
            onChange={(event) => {
              addImages(Array.from(event.target.files ?? []))
              event.target.value = ''
            }}
          />
          <button
            type="button"
            className="feedback-add-image"
            disabled={images.length >= MAX_IMAGES}
            onClick={() => inputRef.current?.click()}
          >
            <ImagePlus size={15} />
            添加图片
            <span>{images.length}/{MAX_IMAGES}</span>
          </button>
          <span className="feedback-paste-tip">支持拖放或 Ctrl+V 粘贴</span>
        </div>

        <label className="feedback-diagnostics">
          <input
            type="checkbox"
            checked={includeDiagnostics}
            onChange={(event) => setIncludeDiagnostics(event.target.checked)}
          />
          <ShieldCheck size={16} />
          <span>
            <b>附带诊断信息</b>
            <small>仅包含应用和运行环境，不含对话、文件内容或访问令牌</small>
          </span>
        </label>

        {error && <div className="feedback-error">{error}</div>}

        <footer className="feedback-actions">
          <button type="button" className="btn-ghost" disabled={submitting} onClick={close}>
            取消
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!content.trim() || submitting}
            onClick={() => void submit()}
          >
            <Send size={15} />
            {submitting ? '正在提交…' : '提交反馈'}
          </button>
        </footer>
      </section>
    </FloatingMask>
  )
}
