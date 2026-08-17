import { Check } from 'lucide-react'
import {
  type TaskFilterDate,
  type TaskFilterStatus,
  type TaskFilterValues,
  hasActiveTaskFilter
} from '../lib/task-filter'

const STATUS_OPTIONS: Array<{ value: TaskFilterStatus | null; label: string }> = [
  { value: null, label: '全部状态' },
  { value: 'working', label: '进行中' },
  { value: 'completed', label: '已完成' },
  { value: 'failed', label: '失败' },
  { value: 'pending', label: '待处理' },
  { value: 'planning', label: '规划中' }
]

const DATE_OPTIONS: Array<{ value: TaskFilterDate | null; label: string }> = [
  { value: null, label: '全部时间' },
  { value: 'Today', label: '今天' },
  { value: 'Last 7 days', label: '最近 7 天' },
  { value: 'Last 30 days', label: '最近 30 天' }
]

interface Props {
  values: TaskFilterValues
  onChange: (next: TaskFilterValues) => void
  onClear: () => void
}

/**
 * 侧栏任务筛选菜单。选项、单选行为、分区标题与重置文案都照 WorkBuddy
 * `TaskFilterMenu`(asar 解包,见 align-with-claude-and-workbuddy 技能)。
 */
export default function TaskFilterMenu({ values, onChange, onClear }: Props): React.JSX.Element {
  const currentStatuses = values.sessionStatus
  const currentDate = values.date
  const hasFilter = hasActiveTaskFilter(values)

  function selectStatus(value: TaskFilterStatus | null): void {
    if (value === null) {
      onChange({ ...values, sessionStatus: [] })
      return
    }
    if (currentStatuses.includes(value)) {
      onChange({ ...values, sessionStatus: currentStatuses.filter((s) => s !== value) })
      return
    }
    onChange({ ...values, sessionStatus: [value] })
  }

  function selectDate(value: TaskFilterDate | null): void {
    if (value === null) {
      onChange({ ...values, date: null })
      return
    }
    onChange({ ...values, date: currentDate === value ? null : value })
  }

  return (
    <div className="task-filter-menu">
      <div className="task-filter-menu__section">
        <div className="task-filter-menu__section-title">筛选状态</div>
        <div className="task-filter-menu__options">
          {STATUS_OPTIONS.map((option) => {
            const selected =
              option.value === null ? currentStatuses.length === 0 : currentStatuses.includes(option.value)
            return (
              <button
                key={option.value ?? '__all_status'}
                type="button"
                className={`task-filter-menu__option${selected ? ' task-filter-menu__option--selected' : ''}`}
                onClick={() => selectStatus(option.value)}
              >
                <span className="task-filter-menu__option-label">{option.label}</span>
                {selected && (
                  <span className="task-filter-menu__option-check">
                    <Check size={14} strokeWidth={2.6} />
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>
      <div className="task-filter-menu__divider" />
      <div className="task-filter-menu__section">
        <div className="task-filter-menu__section-title">筛选时间</div>
        <div className="task-filter-menu__options">
          {DATE_OPTIONS.map((option) => {
            const selected = option.value === null ? currentDate === null : currentDate === option.value
            return (
              <button
                key={option.value ?? '__all_date'}
                type="button"
                className={`task-filter-menu__option${selected ? ' task-filter-menu__option--selected' : ''}`}
                onClick={() => selectDate(option.value)}
              >
                <span className="task-filter-menu__option-label">{option.label}</span>
                {selected && (
                  <span className="task-filter-menu__option-check">
                    <Check size={14} strokeWidth={2.6} />
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>
      <div className="task-filter-menu__divider" />
      <button
        type="button"
        className={`task-filter-menu__reset${hasFilter ? '' : ' task-filter-menu__reset--disabled'}`}
        disabled={!hasFilter}
        onClick={() => {
          if (hasFilter) onClear()
        }}
      >
        <span className="task-filter-menu__reset-label">重置筛选条件</span>
      </button>
    </div>
  )
}
