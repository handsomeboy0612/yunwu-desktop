import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, Check, ChevronDown } from 'lucide-react'

interface Props {
  /** 可选模型全集。 */
  models: string[]
  /** 当前选中的模型。 */
  value: string
  /** 选中回调。 */
  onChange: (model: string) => void
  disabled?: boolean
  placeholder?: string
}

/**
 * 可搜索的模型下拉选择器(combobox)。
 *
 * 相较原生 <select>:支持关键字过滤、键盘上下/回车/Esc 导航、外部点击关闭,
 * 适配云雾返回的上百个模型的检索场景。
 */
export default function ModelCombobox({
  models,
  value,
  onChange,
  disabled,
  placeholder = '选择模型'
}: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)

  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  /** 依据关键字过滤(大小写不敏感的子串匹配)。 */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) {
      return models
    }
    return models.filter((m) => m.toLowerCase().includes(q))
  }, [models, query])

  /** 打开面板:重置搜索,把高亮定位到当前选中项,并聚焦输入框。 */
  function openMenu(): void {
    if (disabled) {
      return
    }
    setOpen(true)
    setQuery('')
    setHighlight(Math.max(models.indexOf(value), 0))
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  function select(model: string): void {
    onChange(model)
    setOpen(false)
    setQuery('')
  }

  // 外部点击关闭。
  useEffect(() => {
    if (!open) {
      return
    }
    const onDocMouseDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [open])

  // 过滤结果变化时,把高亮限制在有效范围内。
  useEffect(() => {
    setHighlight((h) => Math.min(Math.max(h, 0), Math.max(filtered.length - 1, 0)))
  }, [filtered.length])

  // 高亮项滚动进入可视区域。
  useEffect(() => {
    if (!open) {
      return
    }
    const el = listRef.current?.children[highlight] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlight, open])

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => Math.min(h + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const m = filtered[highlight]
      if (m) {
        select(m)
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      setQuery('')
    }
  }

  return (
    <div className="combobox" ref={rootRef}>
      <button
        type="button"
        className="combobox-trigger"
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        <span className={value ? 'combobox-value' : 'combobox-placeholder'}>
          {value || placeholder}
        </span>
        <ChevronDown size={16} className={'combobox-caret' + (open ? ' is-open' : '')} />
      </button>

      {open && (
        <div className="combobox-panel">
          <div className="combobox-search">
            <Search size={15} />
            <input
              ref={inputRef}
              type="text"
              value={query}
              placeholder="搜索模型…"
              onChange={(e) => {
                setQuery(e.target.value)
                setHighlight(0)
              }}
              onKeyDown={onKeyDown}
            />
          </div>
          <ul className="combobox-list" ref={listRef}>
            {filtered.length === 0 ? (
              <li className="combobox-empty">无匹配模型</li>
            ) : (
              filtered.map((m, i) => (
                <li
                  key={m}
                  className={
                    'combobox-option' +
                    (i === highlight ? ' is-active' : '') +
                    (m === value ? ' is-selected' : '')
                  }
                  onMouseEnter={() => setHighlight(i)}
                  onMouseDown={(e) => {
                    // mousedown + preventDefault:在输入框失焦/外部关闭之前完成选中。
                    e.preventDefault()
                    select(m)
                  }}
                >
                  <span className="combobox-option-label">{m}</span>
                  {m === value && <Check size={15} className="combobox-option-check" />}
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  )
}
