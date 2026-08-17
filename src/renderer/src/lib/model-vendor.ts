/**
 * 模型的厂商归属。**这一层是模型选择器最要紧的东西,不是装饰。**
 *
 * 真机实测这把 key 的对话池有 56 个模型,纯按字母序排的话第一屏是 `123123` / `13` /
 * `chatgpt-4o-latest` —— 用户第一眼看到的全是他不要的。分组之后认得出的厂商在前、
 * 认不出的沉到「其他」,第一屏才是有意义的。媒体模型同理(`viduq2-pro` / `z-image-turbo`
 * 这种名字,不给厂商谁都认不出是哪家)。
 *
 * 形状照 WorkBuddy 的 `model-select`(`cb-chat-ui/src/components/chat-input/model-select/`):
 * 分组标题 `position:sticky; top:0`、28px 高、12px 次级色;每行左侧一个 16×16 圆角 4 的
 * 厂商标记。它用的是品牌 SVG,我们没有那批素材,改用同尺寸的首字母色块(设置页的
 * 提供商下拉早就是这么做的,见 `Models.tsx:PROVIDER_AVATARS`),形状一致、零素材依赖。
 *
 * 抽成单独一份是因为对话与媒体两个选择器要按同一套分组显示 —— 两处各留一份的话,
 * 迟早出现「同一个 doubao 在两个选择器里颜色不同」。
 */
export interface Vendor {
  id: string
  label: string
  mark: string
  color: string
  test: (id: string) => boolean
}

/**
 * 判定用小写模型 id 做子串匹配,顺序即优先级(先命中的赢)。
 *
 * 媒体那几家的判据来自真机 `/v1/models`(2026-08-13,477 条):出图 21 个、
 * 视频 15 个、语音 5 个,名字里都带着厂商标识,不需要另一套映射表。
 */
export const VENDORS: Vendor[] = [
  {
    id: 'claude',
    label: 'Claude',
    mark: 'C',
    color: '#D97757',
    test: (s) => s.includes('claude')
  },
  {
    id: 'openai',
    label: 'OpenAI',
    mark: 'O',
    color: '#10A37F',
    // tts-1 / dall-e / gpt-image 都归这里:它们本来就是 OpenAI 那套端点。
    test: (s) =>
      s.includes('gpt') ||
      /^o[1-9]/.test(s) ||
      s.includes('davinci') ||
      s.includes('babbage') ||
      s.includes('dall-e') ||
      s.startsWith('tts-')
  },
  {
    id: 'gemini',
    label: 'Gemini',
    mark: 'G',
    color: '#4285F4',
    // veo 是 Google 的视频模型,跟 Gemini 同一家,不另开一组。
    test: (s) => s.includes('gemini') || s.includes('veo')
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    mark: 'D',
    color: '#4D6BFE',
    test: (s) => s.includes('deepseek')
  },
  {
    id: 'qwen',
    label: '通义千问',
    mark: '通',
    color: '#615CED',
    // 万相(wan / wanx)是阿里的出图出视频线,归通义。
    test: (s) => s.includes('qwen') || s.includes('qwq') || s.includes('wan')
  },
  {
    id: 'kimi',
    label: 'Kimi',
    mark: 'K',
    color: '#1F1F24',
    test: (s) => s.includes('kimi') || s.includes('moonshot')
  },
  {
    id: 'glm',
    label: '智谱 GLM',
    mark: '智',
    color: '#3859FF',
    test: (s) => s.includes('glm') || s.includes('cogview') || s.includes('cogvideo')
  },
  {
    id: 'doubao',
    label: '豆包',
    mark: '豆',
    color: '#0C42D1',
    // seedream(出图)/ seedance(出视频)/ seededit 都是豆包同门,名字里不带 doubao 的也有。
    test: (s) => s.includes('doubao') || s.includes('seed')
  },
  {
    id: 'grok',
    label: 'Grok',
    mark: 'X',
    color: '#16161A',
    test: (s) => s.includes('grok')
  },
  {
    id: 'hunyuan',
    label: '混元',
    mark: '混',
    color: '#0052D9',
    test: (s) => s.includes('hunyuan')
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    mark: 'M',
    color: '#E8453C',
    // 海螺(hailuo)是 MiniMax 的视频线。
    test: (s) => s.includes('minimax') || s.includes('abab') || s.includes('hailuo')
  },
  {
    id: 'kling',
    label: '可灵',
    mark: '灵',
    color: '#1A1A2E',
    test: (s) => s.includes('kling')
  },
  {
    id: 'vidu',
    label: 'Vidu',
    mark: 'V',
    color: '#5B45E0',
    test: (s) => s.includes('vidu')
  },
  {
    id: 'flux',
    label: 'FLUX',
    mark: 'F',
    color: '#111114',
    test: (s) => s.includes('flux')
  },
  {
    id: 'pixverse',
    label: 'PixVerse',
    mark: 'P',
    color: '#0F8AF9',
    test: (s) => s.includes('pixverse')
  },
  {
    id: 'midjourney',
    label: 'Midjourney',
    mark: 'MJ',
    color: '#2C2C34',
    test: (s) => s.startsWith('mj_') || s.includes('midjourney')
  }
]

export const OTHER_VENDOR: Vendor = {
  id: 'other',
  label: '其他',
  mark: '·',
  color: '#8A94A6',
  test: () => true
}

/** 模型 id → 厂商;认不出就归「其他」。 */
export function vendorOf(id: string): Vendor {
  const s = id.toLowerCase()
  return VENDORS.find((v) => v.test(s)) ?? OTHER_VENDOR
}

/** 分组间的排序权重,「其他」垫底。 */
export function vendorRank(id: string): number {
  const i = VENDORS.findIndex((v) => v.id === id)
  return i < 0 ? 999 : i
}
