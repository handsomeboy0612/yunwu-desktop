import { describe, expect, it } from 'vitest'

import { deniesReading } from '../../openlux-plugin-account/src/media/documents.ts'

/**
 * A 200 with prose does not mean the document arrived.
 *
 * Every string below is a verbatim reply measured on 2026-08-23 while sending one
 * freshly made PDF (and a docx) through this route. They matter because the
 * document tool treats any non-empty answer as success, so a reply that only
 * *sounds* like an answer gets handed to the user as one — worse than an error,
 * which at least fails over to the next model.
 *
 * Two failure modes showed up, from different channels behind the same station:
 * the file silently vanishing, and the file being text-extracted upstream into
 * mojibake before the model ever saw it. The second one names the PDF, so it
 * slips past any "I didn't receive a document" check.
 *
 * The negative cases are the reason this is a pair of matchers rather than a
 * keyword list: a model that read the document and found nothing must not be
 * mistaken for a transport failure, or a correct answer gets thrown away and the
 * next model burns tokens re-deriving it.
 */
describe('deniesReading', () => {
  it('catches a silently dropped document', () => {
    // deepseek-v4-pro, 200 OK, right after the file part was accepted.
    expect(deniesReading('I cannot see any document. Please upload the document you want me to analyze.')).toBe(true)
    // claude-opus-5, 34s, 118 input tokens for a 28KB PDF.
    expect(deniesReading('我没有看到你上传的任何文档或图片。请上传包含验证码的文档或图片，我才能帮你识别。')).toBe(true)
  })

  it('catches a document that arrived as garbage', () => {
    // claude-opus-4-8 / 4-7 / sonnet-4-6: 4.5s, 2–6 reported input tokens.
    expect(deniesReading(
      'I cannot extract a verification code from this text. The PDF appears to contain encoded or shifted text '
      + 'that does not display any readable code.',
    )).toBe(true)
    expect(deniesReading(
      'I cannot reliably extract the verification code from this text. The content appears to be encoded or '
      + 'corrupted (possibly a character shift).',
    )).toBe(true)
    expect(deniesReading('文档内容是乱码，无法读取里面的验证码。')).toBe(true)
  })

  it('leaves real answers alone', () => {
    expect(deniesReading('570984')).toBe(false)
    expect(deniesReading('gemini-3.1-pro-preview 读过这份文档后说：570984')).toBe(false)
    // A finding, not a failure: the model read it and there was no code.
    expect(deniesReading('I read the document but it contains no verification code.')).toBe(false)
    expect(deniesReading('我读完了这份合同，里面没有验证码，只有签署日期。')).toBe(false)
    // Content that happens to talk about encodings must not trip the pair.
    expect(deniesReading('The contract stores the account number as an encoded field, value 4471.')).toBe(false)
  })
})
