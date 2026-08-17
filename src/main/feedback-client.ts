import { app } from 'electron'
import { arch, platform, release } from 'os'
import type {
  FeedbackSubmitResult,
  FeedbackSubmission
} from '@shared/types'
import { marketBaseUrl, requireToken } from './market/market-client'

const MAX_IMAGES = 6
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_CONTENT_CHARS = 10_000
const IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp'
])

/**
 * Submit feedback to admin-server's dedicated desktop-product module.
 *
 * Feedback and the desktop market share admin-server address resolution and
 * the user's existing sk- identity, but feedback never enters ticket tables.
 */
export async function submitFeedback(
  submission: FeedbackSubmission
): Promise<FeedbackSubmitResult> {
  const content = submission.content.trim()
  if (!content) {
    throw new Error('请填写反馈内容')
  }
  if (content.length > MAX_CONTENT_CHARS) {
    throw new Error('反馈内容不能超过10000字')
  }
  if (!['problem', 'suggestion', 'other'].includes(submission.category)) {
    throw new Error('请选择反馈类型')
  }
  if (submission.images.length > MAX_IMAGES) {
    throw new Error('最多添加6张图片')
  }

  const form = new FormData()
  form.set('category', submission.category)
  form.set('content', content)
  form.set('page', submission.page.trim() || 'unknown')
  form.set('app_version', app.getVersion())
  form.set('platform', `${platform()} ${release()} (${arch()})`)

  if (submission.includeDiagnostics) {
    // 只上传运行环境，不读取日志、会话、工作区、令牌或用户文件。
    form.set('diagnostics', JSON.stringify({
      packaged: app.isPackaged,
      locale: app.getLocale(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    }, null, 2))
  }

  for (const image of submission.images) {
    if (!IMAGE_TYPES.has(image.type)) {
      throw new Error(`不支持图片格式：${image.name}`)
    }
    if (image.data.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(`图片“${image.name}”超过10MB`)
    }
    const bytes = Uint8Array.from(image.data)
    form.append('images', new Blob([bytes], { type: image.type }), image.name)
  }

  let response: Response
  try {
    response = await fetch(`${marketBaseUrl()}/api/desktop-feedback`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${requireToken()}` },
      body: form,
      signal: AbortSignal.timeout(60_000)
    })
  } catch (error) {
    throw new Error(`无法连接反馈服务：${error instanceof Error ? error.message : String(error)}`)
  }

  const body = (await response.json().catch(() => ({}))) as {
    success?: boolean
    message?: string
    data?: { feedback_id?: number }
  }
  const feedbackId = body.data?.feedback_id
  if (!response.ok || !body.success || !feedbackId) {
    throw new Error(body.message || `反馈服务返回 HTTP ${response.status}`)
  }
  return { feedbackId }
}
