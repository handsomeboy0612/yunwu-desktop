import { useEffect, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, X, ArrowRight, ArrowUp, Check, Pencil } from 'lucide-react'
import type { AskQuestion, AskAnswer } from '@shared/types'

/**
 * 平台 UI 工具 `ask_user` 的作答面板。
 *
 * 对齐 WorkBuddy AskUserQuestion:
 *  - 内嵌对话区底部(盖住 composer),无遮罩;
 *  - 单选:编号行 + 右侧 →,点选即翻题/提交,末题不出发送键(除非只填了「其他补充」);
 *  - 多选:左侧方框复选框,点选切换;非末题右下「跳过」+ 圆形 →;末题圆形 ↑ 发送;
 *  - 底部「其他补充」自由输入。
 *
 * 本组件是纯受控的:**不订阅事件、不判断该不该显示**。要显示哪一问由上层从当前会话的
 * 时间线推导后传进来(照 WorkBuddy `QuestionFloating` + `useActiveQuestion` 的分工)。
 * 早先它自己订阅 onAskUser 并把提问存在内部 state 里,结果这张卡与会话脱钩 ——
 * 切到别的任务或首页它会跟着飘过去。
 */

type SelMap = Record<number, Set<number>>

interface Props {
  /** 这次提问的 id,作答回填时原样交回主进程以兑现被阻塞的工具调用。 */
  requestId: string
  /** 本次要问的题目(上层从时间线里取)。 */
  questions: AskQuestion[]
  /** 用户答完提交时触发(供对话时间线沉淀「用户回答卡片」)。 */
  onAnswered?: (answers: AskAnswer[]) => void
  /** 点 ✕ 关闭面板时额外触发(对齐 WorkBuddy:关闭即中止本次回答/运行)。 */
  onCancel?: (requestId: string) => void
}

export default function AskUserModal({
  requestId,
  questions,
  onAnswered,
  onCancel
}: Props): ReactNode {
  const [step, setStep] = useState(0)
  const [selected, setSelected] = useState<SelMap>({})
  const [custom, setCustom] = useState<Record<number, string>>({})
  // 当前行指针:对齐 WorkBuddy 默认高亮首行(浅灰底 + 显示 →),鼠标移入时跟随。
  const [focusIdx, setFocusIdx] = useState(0)

  // 每翻到新一题,当前行指针复位到首行。
  useEffect(() => {
    setFocusIdx(0)
  }, [step])

  const total = questions.length
  const q = questions[step]
  if (!q) {
    return null
  }
  const multi = q.multiSelect === true
  const isLast = step === total - 1
  // 是否已在「其他补充」输入内容:有则选项变灰。
  const hasCustom = (custom[step] ?? '').trim().length > 0

  /**
   * 用给定选择映射构造并回填答案。
   * 不再自己 setReq(null) 收起面板 —— 面板的去留由上层把时间线上这一项从 waiting 改掉后
   * 自然决定,组件里再存一份「已答」只会和时间线打架。
   */
  const finishWith = (sel: SelMap): void => {
    const answers: AskAnswer[] = questions.map((item, qi) => ({
      header: item.header,
      question: item.question,
      selected: Array.from(sel[qi] ?? [])
        .map((oi) => item.options?.[oi]?.label ?? '')
        .filter(Boolean),
      custom: custom[qi]?.trim() || undefined
    }))
    void window.api.answerAskUser(requestId, answers)
    onAnswered?.(answers)
  }

  const cancel = (): void => {
    // 先回填 cancelled 兑现被阻塞的工具调用(避免主进程侧 Promise 泄漏/超时),
    // 再中止本轮运行(对齐 WorkBuddy:关闭澄清框即结束本次回答)。
    void window.api.answerAskUser(requestId, { cancelled: true })
    onCancel?.(requestId)
  }

  /** 前进一题;末题则提交(用当前 selected 状态)。 */
  const advance = (): void => {
    if (isLast) {
      finishWith(selected)
    } else {
      setStep((s) => s + 1)
    }
  }

  /** 单选:记录并立即翻到下一题(末题直接用新选择提交,避免 setState 异步取到旧值)。 */
  const pickSingle = (oi: number): void => {
    const next: SelMap = { ...selected, [step]: new Set([oi]) }
    setSelected(next)
    if (isLast) {
      finishWith(next)
    } else {
      setStep((s) => s + 1)
    }
  }

  /** 多选:切换该项,不自动前进。 */
  const toggleMulti = (oi: number): void => {
    setSelected((prev) => {
      const cur = new Set(prev[step] ?? [])
      if (cur.has(oi)) {
        cur.delete(oi)
      } else {
        cur.add(oi)
      }
      return { ...prev, [step]: cur }
    })
  }

  return (
    <div className="ask-panel" role="group" aria-label="向你确认">
      <div className="ask-panel-head">
        <div className="ask-panel-q">
          <span className="ask-panel-qt">
            {q.question}
            {multi ? <span className="ask-multi-hint">可多选</span> : null}
          </span>
        </div>
        <div className="ask-panel-nav">
          <button
            type="button"
            className="ask-nav-btn"
            disabled={step === 0}
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            aria-label="上一题"
          >
            <ChevronLeft size={16} strokeWidth={2} />
          </button>
          <span className="ask-nav-count">
            {step + 1}/{total}
          </span>
          <button
            type="button"
            className="ask-nav-btn"
            disabled={isLast}
            onClick={advance}
            aria-label="下一题"
          >
            <ChevronRight size={16} strokeWidth={2} />
          </button>
          <button type="button" className="ask-nav-btn" onClick={cancel} aria-label="关闭">
            <X size={16} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div className={`ask-panel-opts${multi ? ' multi' : ''}${hasCustom ? ' dim' : ''}`}>
        {(q.options ?? []).map((opt, oi) => {
          const on = selected[step]?.has(oi) ?? false
          const focused = focusIdx === oi
          return (
            <button
              key={oi}
              type="button"
              className={`ask-row${on ? ' on' : ''}${focused ? ' focus' : ''}`}
              onMouseEnter={() => setFocusIdx(oi)}
              onClick={() => (multi ? toggleMulti(oi) : pickSingle(oi))}
            >
              {multi ? (
                <span className={`ask-check${on ? ' on' : ''}`} aria-hidden>
                  {on ? <Check size={11} strokeWidth={3} /> : null}
                </span>
              ) : (
                <span className="ask-row-num">{oi + 1}</span>
              )}
              <span className="ask-row-body">
                <span className="ask-row-label">{opt.label}</span>
                {opt.description ? <span className="ask-row-desc">{opt.description}</span> : null}
              </span>
              {!multi ? (
                <span className="ask-row-arrow" aria-hidden>
                  <ArrowRight size={15} strokeWidth={2} />
                </span>
              ) : null}
            </button>
          )
        })}

        <div className="ask-row ask-row-custom">
          {multi ? (
            <span className={`ask-check${hasCustom ? ' on' : ''}`} aria-hidden>
              {hasCustom ? <Check size={11} strokeWidth={3} /> : null}
            </span>
          ) : (
            <span className="ask-row-num">
              <Pencil size={13} strokeWidth={2} />
            </span>
          )}
          <input
            className="ask-row-input"
            placeholder="其他补充..."
            value={custom[step] ?? ''}
            onChange={(e) => setCustom((p) => ({ ...p, [step]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (custom[step] ?? '').trim()) {
                advance()
              }
            }}
          />
        </div>
      </div>

      <div className="ask-panel-foot">
        <div className="ask-foot-left" />
        <div className="ask-foot-right">
          {/* 非末题:「跳过」;多选另附圆形 → 推进(对齐 WorkBuddy)。 */}
          {!isLast && (
            <button type="button" className="ask-skip" onClick={advance}>
              跳过
            </button>
          )}
          {!isLast && multi ? (
            <button type="button" className="ask-send next" onClick={advance} aria-label="下一步">
              <ArrowRight size={16} strokeWidth={2.6} />
            </button>
          ) : null}
          {/*
            末题的黑色圆形 ↑ 确认发送。
            单选点选即提交,此时 ↑ 唯一能被点到的时机是「一个选项都没选」——那样只会回一个
            空答案给模型,所以单选仅在填了「其他补充」(需要鼠标提交入口)时才渲染它。
          */}
          {isLast && (multi || hasCustom) ? (
            <button type="button" className="ask-send" onClick={advance} aria-label="发送">
              <ArrowUp size={17} strokeWidth={2.6} />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
