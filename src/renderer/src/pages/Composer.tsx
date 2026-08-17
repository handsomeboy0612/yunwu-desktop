import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type ReactElement,
} from "react";
import {
  Palette,
  CircleHelp,
  ListChecks,
  Puzzle,
  GraduationCap,
  Cable,
  Paperclip,
  Cpu,
  Sparkles,
  ShieldCheck,
  Shield,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Plus,
  X,
  Mic,
  ArrowUp,
  Square,
  FileText,
  Check,
  FolderOpen,
  Wand2,
  Pencil,
  Compass,
  LayoutGrid,
  Search,
  type LucideIcon,
} from "lucide-react";
import type {
  PermissionMode,
  ChatMode,
  ChatModelOption,
  InstalledExpert,
  MemberRunStatus,
  ModelThinkPref,
  WorkspaceEntry,
} from "@shared/types";
import {
  THINKING_LABELS,
  canToggleThinking,
  isThinkingConfigurable,
  thinkingLevelOf,
  thinkingLevelsOf,
  thinkingOnOf,
} from "@shared/types";
import { resolveTeamRoster } from "@shared/team-roster";
import TeamMemberBar from "../components/TeamMemberBar";
import FloatingMask from "../components/FloatingMask";

interface Props {
  permission: PermissionMode;
  onPermissionChange: (mode: PermissionMode) => void;
  /** 当前对话行为模式(Craft/Ask/Plan)。 */
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
  onSend: (text: string, files: string[]) => void;
  /** 当前是否有正在运行的任务(决定发送键是否切换为终止键)。 */
  running?: boolean;
  /** 终止当前任务运行。 */
  onAbort?: () => void;
  /** 可选对话模型(来自模型管理配置,内核完整键 `<provider>/<model>`)。 */
  models?: ChatModelOption[];
  /** 当前选中的模型键 `<provider>/<model>`。 */
  model: string;
  onModelChange: (model: string) => void;
  /** 打开模型管理设置页。 */
  onOpenModelSettings?: () => void;
  /** 逐模型的思考偏好(键=模型键);改哪个模型的卡片就只写它自己那份。 */
  thinkPrefs: Record<string, ModelThinkPref>;
  onThinkPrefChange: (modelKey: string, patch: ModelThinkPref) => void;
  /** 本地已安装专家(驱动「+」菜单的专家选择器)。 */
  experts?: InstalledExpert[];
  /** 当前会话绑定的专家 slug(展示激活态);无则为通用助手。 */
  activeExpertSlug?: string | null;
  /** 选择/清除专家(传 null 表示清除,回到通用助手)。 */
  onSelectExpert?: (slug: string | null) => void;
  /**
   * 成员 agent id → 运行状态,驱动专家团成员条上的实时状态。
   * 由外层按任务维护(状态跨消息存活,属于会话而非某一轮回复)。
   */
  memberRuns?: Record<string, MemberRunStatus>;
  /**
   * 当前会话已选技能芯片(对齐 WorkBuddy「创建技能」后输入框内的 skill-creator 芯片)。
   * 仅作视觉与语义提示;内置技能已全局播种,内核按描述自动匹配触发。
   */
  activeSkill?: { slug: string; name: string } | null;
  /** 移除已选技能芯片。 */
  onClearSkill?: () => void;
  /**
   * 首页展开中的场景(对齐 WorkBuddy:选中场景后它作为一枚标签落在输入框内,
   * 与文件/技能标签同排 —— 见 createPhraseBlock(template.name, `scene://<id>`))。
   * 它同时是二级提示行的唯一出口,没有它用户回不到场景列表。
   */
  activeScene?: { slug: string; name: string } | null;
  /** 移除已选场景芯片(收起二级提示行,回到场景列表)。 */
  onClearScene?: () => void;
  /**
   * 外部预填信号(如点击首页场景卡):seq 变化即把 text 写入输入框(覆盖当前内容)。
   * 用 seq 而非直接受控,避免每次渲染回填、打断用户输入。
   */
  prefill?: { text: string; seq: number };
  /**
   * 输入框正文。**由外层按任务保存**,而不是 Composer 自己 useState:
   * Composer 全局只挂载一份,内部 state 会跨任务串味——在任务 A 打的草稿切到任务 B 还在。
   */
  text: string;
  /** 修改输入框正文;支持函数式更新(菜单里的 `/技能` 插入需要读旧值)。 */
  onTextChange: (value: string | ((prev: string) => string)) => void;
  /**
   * 当前任务标识。变化时清空已选附件——附件是本轮临时挂载的,
   * 跟着切任务带过去会造成"在任务 B 误发任务 A 的文件"。
   */
  taskKey?: string;
  /**
   * 是否处于已有任务会话(相对「新建任务」首页)。
   * 任务内对齐 WorkBuddy:无「选择工作空间」;「默认权限」紧跟「+」右侧。
   * 新建任务:卡片下方保留「选择工作空间 / 权限」subbar。
   */
  inTask?: boolean;
  /**
   * 是否处于欢迎页空态(会话还没有任何消息)。专家团成员条只在非空态显示 —— 见下方渲染处。
   */
  showWelcome?: boolean;
  /**
   * 是否在「设计创意」的空态首页。为真才挂「补图方式 / 设计风格」两枚芯片。
   *
   * 这个闸就是 WorkBuddy 的 `isDesignWelcome`:
   * `showWelcome && conversationsContext?.selectedWelcomeMode === 'design'`
   * (`wbStatusChipSlots`)。它那边这两枚芯片是 slot 注入进输入框底部的
   * `BottomSlotPositions.AFTER_MODEL_SELECTOR`,而 WorkBuddy 形态下模型选择器被
   * `modelSelectorPlacement: 'beforeSendButton'` 挪到了发送键左侧,所以这组 slot
   * 实际落在左下角「+」的右边 —— 我们没有 slot 机制,直接摆进 .tool-left 同一位置。
   */
  designWelcome?: boolean;
  /** 补图方式(素材不足时怎么补图)。 */
  imageMode?: ImageMode;
  onImageModeChange?: (mode: ImageMode) => void;
  /** 已选设计风格;null 为未选(芯片显示「设计风格」入口态)。 */
  designStyle?: DesignStyle | null;
  onDesignStyleChange?: (style: DesignStyle | null) => void;
  /**
   * 本次新建任务选定的工作空间;null 为「不使用工作空间」(落到按时间命名的一次性目录)。
   * 只在新建任务态有意义 —— 工作空间在会话建起来那一刻定型,之后不再改(同 WorkBuddy)。
   */
  workspace?: WorkspaceEntry | null;
  onWorkspaceChange?: (ws: WorkspaceEntry | null) => void;
}

/**
 * 补图方式。取值与文案都照 WorkBuddy 的 `IMAGE_MODE_OPTIONS`
 * (`placeholder` = 色块占位、`ai` = AI 生图)。
 */
export type ImageMode = "placeholder" | "ai";

/** 补图方式两项:标题 + 说明,原文照抄 WorkBuddy 的 i18n(仅把品牌名换成我们的)。 */
const IMAGE_MODES: {
  id: ImageMode;
  label: string;
  desc: string;
  icon: LucideIcon;
}[] = [
  {
    id: "placeholder",
    label: "色块占位",
    desc: "生成色块占位,方便后续替换",
    icon: LayoutGrid,
  },
  {
    id: "ai",
    label: "AI 生图",
    desc: "根据使用场景,自动生成图片,效果更佳",
    icon: Sparkles,
  },
];

/**
 * 一种设计风格。字段照 WorkBuddy 的 `DesignStyle`(`mapRawToStyle`:id / name / style /
 * coverUrl / designUrl / colorblocksUrl):行内小图标取 `colorblocksUrl`(色块图),
 * hover 大预览取 `coverUrl`。我们还没有风格库,所以两者都用一个 CSS 渐变 `swatch` 顶着。
 */
export interface DesignStyle {
  id: string;
  name: string;
  /** 占位色块(接入真实风格库后换成缩略图 URL)。 */
  swatch: string;
}

/**
 * **占位风格清单,不是真实数据。** 只为把面板形状摆出来。
 *
 * WorkBuddy 的风格来自它自己的远端风格库(`useDesignStyleCatalog` 拉
 * `static.d.gtimg.com/templates/{ui,ppt,art}.json`),按场景分 ui-design / slides /
 * poster 三组,`resolveStyleGroup` 决定用哪组。接入我们的风格库后整体替换成拉取结果。
 */
const DESIGN_STYLES: DesignStyle[] = [
  {
    id: "minimal",
    name: "极简留白",
    swatch: "linear-gradient(135deg,#f5f5f7,#d9dbe0)",
  },
  {
    id: "flat",
    name: "扁平明快",
    swatch: "linear-gradient(135deg,#4f8cff,#7cc4ff)",
  },
  {
    id: "glass",
    name: "玻璃拟态",
    swatch: "linear-gradient(135deg,#a0c4ff,#e3e6ff)",
  },
  {
    id: "neumorphism",
    name: "新拟物",
    swatch: "linear-gradient(135deg,#e6e9ef,#c7ccd6)",
  },
  {
    id: "dark",
    name: "暗色沉稳",
    swatch: "linear-gradient(135deg,#2b2f38,#4a5060)",
  },
  {
    id: "gradient",
    name: "渐变流光",
    swatch: "linear-gradient(135deg,#7b5cff,#ff7ac8)",
  },
  {
    id: "memphis",
    name: "孟菲斯",
    swatch: "linear-gradient(135deg,#ffd166,#ef476f)",
  },
  {
    id: "brutalism",
    name: "粗野主义",
    swatch: "linear-gradient(135deg,#111111,#f2f2f2)",
  },
  {
    id: "cyberpunk",
    name: "赛博朋克",
    swatch: "linear-gradient(135deg,#0ff1ce,#ff2e97)",
  },
  {
    id: "japanese",
    name: "日系素雅",
    swatch: "linear-gradient(135deg,#f7f3ea,#cdbfa6)",
  },
  {
    id: "swiss",
    name: "瑞士国际主义",
    swatch: "linear-gradient(135deg,#e4022b,#1a1a1a)",
  },
  {
    id: "business",
    name: "商务专业",
    swatch: "linear-gradient(135deg,#1f4e79,#5b8db8)",
  },
];

/** 对话模式清单:图标 + 名称 + 说明,用于「+」菜单的模式子面板。 */
const MODES: { id: ChatMode; label: string; desc: string; icon: LucideIcon }[] =
  [
    {
      id: "craft",
      label: "Craft",
      desc: "完整执行:可读写文件、运行命令",
      icon: Palette,
    },
    {
      id: "ask",
      label: "Ask",
      desc: "仅问答:只读分析,不改动文件",
      icon: CircleHelp,
    },
    {
      id: "plan",
      label: "Plan",
      desc: "先规划:先出方案,确认后执行",
      icon: ListChecks,
    },
  ];

/** 占位技能清单(接通网关后替换为真实技能注册表)。 */
const SKILLS = [
  { id: "pptx", label: "生成 PPT" },
  { id: "docx", label: "编辑 Word" },
  { id: "xlsx", label: "处理表格" },
  { id: "image", label: "图片处理" },
];

/** 「+」菜单的当前视图:根 / 模式 / 技能 / 专家 子面板。 */
type AddView = "root" | "mode" | "skills" | "experts";

/**
 * 富输入框(对齐 WorkBuddy 新版 composer 布局):
 *  - 左下:「+」→ 菜单(添加文件 / 模式 / 技能 / 专家 / 连接器);任务内紧跟权限;
 *  - 右下:模型选择 + 语音 + 圆形发送键;
 *  - 新建任务卡片下方 subbar:选择工作空间 / 权限;任务内无 subbar(权限已上移);
 *  - 回车发送,Shift+回车换行。
 */
export default function Composer({
  permission,
  onPermissionChange,
  mode,
  onModeChange,
  onSend,
  running = false,
  onAbort,
  models = [],
  model,
  onModelChange,
  onOpenModelSettings,
  thinkPrefs,
  onThinkPrefChange,
  experts = [],
  activeExpertSlug = null,
  onSelectExpert,
  memberRuns,
  activeSkill = null,
  onClearSkill,
  activeScene = null,
  onClearScene,
  prefill,
  text,
  onTextChange: setText,
  taskKey,
  inTask = false,
  showWelcome = false,
  designWelcome = false,
  imageMode = "ai",
  onImageModeChange,
  designStyle = null,
  onDesignStyleChange,
  workspace = null,
  onWorkspaceChange,
}: Props): React.JSX.Element {
  const activeExpert = experts.find((e) => e.slug === activeExpertSlug) ?? null;
  // 只有专家团才有成员条;单体专家的 roster 恒为空,芯片行整行不渲染。
  const teamRoster = useMemo(
    () =>
      activeExpert?.manifest.isTeam
        ? resolveTeamRoster(activeExpert.manifest, activeExpert.slug, experts)
        : [],
    [activeExpert, experts],
  );
  /**
   * 只留**本会话真被召唤过**的成员(memberRuns 里有记录的),对齐 WorkBuddy:它的成员条读的是
   * 会话运行时快照 `getTeamRuntimeSnapshot(sid)`,成员来自 `snapshot.members` 与
   * `snapshot.memberHistories`(见 `getTeamRuntimeMembers`),都是真跑起来才有的东西,
   * 名册里没被调用的人压根不进这个快照。
   *
   * 我们的 roster 是从 manifest 静态推的,不过滤就会在主理人还没派活时先把全团铺出来 ——
   * 那是我们自己发明的差异,不是内核逼的:memberRuns 由 AgentEvent 的 'member' 一支驱动,
   * 本就是同一份运行时事实。
   */
  const spawnedRoster = useMemo(
    // 两个键都要试:新任务的成员事件按 spawn 的 label 记账,存量任务按成员 agent id
    // (见 `@shared/team-roster` 的 TeamRosterEntry)。
    () =>
      teamRoster.filter(
        (m) => memberRuns?.[m.key] ?? memberRuns?.[m.legacyKey],
      ),
    [teamRoster, memberRuns],
  );
  const activeModel = models.find((m) => m.key === model);
  const modelLabel =
    activeModel?.label ?? (model ? model.split("/").pop() : "选择模型");
  const modelIsReasoning = activeModel?.reasoning ?? false;
  // 内置云雾账号模型 vs 用户自行添加的自定义模型(对齐 WorkBuddy「自定义模型」分组)。
  const builtinModels = models.filter((m) => !m.custom);
  const customModels = models.filter((m) => m.custom);
  const [files, setFiles] = useState<string[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [addView, setAddView] = useState<AddView>("root");
  const [modelOpen, setModelOpen] = useState(false);
  const [wsOpen, setWsOpen] = useState(false);
  /** 已知工作空间列表(打开菜单时拉一次;新建/打开文件夹后就地补进来)。 */
  const [wsList, setWsList] = useState<WorkspaceEntry[]>([]);
  const [wsQuery, setWsQuery] = useState("");
  /** 菜单内视图:列表 / 新建命名。 */
  const [wsCreating, setWsCreating] = useState(false);
  const [wsName, setWsName] = useState("");
  const [wsError, setWsError] = useState("");
  const [permOpen, setPermOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  /** 设计创意两枚芯片各自的弹层开合。 */
  const [imageModeOpen, setImageModeOpen] = useState(false);
  const [styleOpen, setStyleOpen] = useState(false);
  /**
   * 风格列表里正在 hover 的那条,驱动面板右侧的大预览。
   * 纯交互态,WorkBuddy 同样放在 `StyleListPanel` 内部(`hoveredStyle`)。
   */
  const [hoverStyle, setHoverStyle] = useState<DesignStyle | null>(null);
  /**
   * 模型菜单里正在 hover 的那条,以及它在面板内的纵向位置——驱动左侧浮出的模型卡片
   * (WorkBuddy 的 `ModelSubMenu`:240px 卡片,里面挂「思考强度」行 + 三级档位面板)。
   * `cardEffortOpen` 是那行展开的三级面板;鼠标要跨过卡片与列表之间的空隙,
   * 所以关闭走延时(WorkBuddy 的 `HoverSubMenu` 同样是 openDelay 140 / closeDelay 240)。
   */
  const [hoverModel, setHoverModel] = useState<ChatModelOption | null>(null);
  const [hoverCardTop, setHoverCardTop] = useState(0);
  const [cardEffortOpen, setCardEffortOpen] = useState(false);
  const modelPanelRef = useRef<HTMLDivElement | null>(null);
  const cardCloseTimer = useRef<number | null>(null);
  const cancelCardClose = (): void => {
    if (cardCloseTimer.current !== null) {
      window.clearTimeout(cardCloseTimer.current);
      cardCloseTimer.current = null;
    }
  };
  const openModelCard = (m: ChatModelOption, row: HTMLElement): void => {
    cancelCardClose();
    const panel = modelPanelRef.current;
    if (panel) {
      setHoverCardTop(
        row.getBoundingClientRect().top - panel.getBoundingClientRect().top,
      );
    }
    setHoverModel((cur) => {
      if (cur && cur.key !== m.key) {
        setCardEffortOpen(false);
      }
      return m;
    });
  };
  const closeModelCardSoon = (): void => {
    cancelCardClose();
    cardCloseTimer.current = window.setTimeout(() => {
      cardCloseTimer.current = null;
      setHoverModel(null);
      setCardEffortOpen(false);
    }, 240);
  };
  useEffect(() => {
    if (!modelOpen) {
      cancelCardClose();
      setHoverModel(null);
      setCardEffortOpen(false);
    }
    return cancelCardClose;
  }, [modelOpen]);
  /** 模型列表的一行。带卡片的那些行右侧给个箭头,照 WorkBuddy 的 `showArrow = hasSubMenu(primary)`。 */
  const renderModelRow = (
    m: ChatModelOption,
    custom: boolean,
  ): ReactElement => (
    <button
      key={m.key}
      className={`model-item${model === m.key ? " active" : ""}`}
      onClick={() => {
        onModelChange(m.key);
        setModelOpen(false);
      }}
      onMouseEnter={(e) => openModelCard(m, e.currentTarget)}
      onFocus={(e) => openModelCard(m, e.currentTarget)}
    >
      {model === m.key ? (
        <Check size={14} strokeWidth={2.4} className="model-check" />
      ) : custom ? (
        <Plus size={14} strokeWidth={2.2} className="model-custom-mark" />
      ) : (
        <span className="model-check-spacer" />
      )}
      <span className="model-name">{m.label}</span>
      {m.reasoning && (
        <Sparkles size={11} strokeWidth={2} className="model-item-think" />
      )}
      {isThinkingConfigurable(m) && (
        <ChevronRight size={12} strokeWidth={2} className="model-item-more" />
      )}
    </button>
  );
  /**
   * 卡片里的「思考强度」行 + 三级面板,照 WorkBuddy 的 `ModelSubMenu` / `ReasoningEffortPanel`:
   *  - 行右侧的值:能关且关着显示「未开启」,否则显示当前档位;没有档位可选就只说「已开启」
   *    (它的 `actionEffort ? label : t("model.effort.modeOn")`);
   *  - 三级面板:能关就先来一行「思考模式」开关,档位列表只在
   *    `effortItems.length > 0 && (canToggleThinking ? isThinking : true)` 时铺开。
   * 改的是这一行所属模型的偏好,不是当前选中模型的——所以不切模型,也不关菜单。
   */
  const renderEffortRow = (m: ChatModelOption): ReactElement => {
    const pref = thinkPrefs[m.key];
    const levels = thinkingLevelsOf(m);
    const canToggle = canToggleThinking(m);
    const on = thinkingOnOf(m, pref);
    const level = thinkingLevelOf(m, pref);
    const showLevels = levels.length > 0 && (canToggle ? on : true);
    return (
      <div className="model-card-effort">
        <button
          type="button"
          className={`model-card-row${cardEffortOpen ? " open" : ""}`}
          onClick={() => setCardEffortOpen((v) => !v)}
          onMouseEnter={() => setCardEffortOpen(true)}
        >
          <span className="model-card-label">思考强度</span>
          <span className="model-card-value">
            <span className="model-card-value-text">
              {canToggle && !on
                ? "未开启"
                : level
                  ? THINKING_LABELS[level]
                  : "已开启"}
            </span>
            <ChevronRight
              size={12}
              strokeWidth={2}
              className="model-card-chevron"
            />
          </span>
        </button>
        {cardEffortOpen && (
          <div className="model-card-panel">
            {canToggle && (
              <div className="card-panel-row">
                <span className="card-panel-label">思考模式</span>
                <button
                  type="button"
                  className={`switch${on ? " on" : ""}`}
                  aria-label="深度思考"
                  aria-pressed={on}
                  title={
                    on
                      ? "已开启,可选择思考强度"
                      : "已关闭,将按普通模式发送"
                  }
                  onClick={() => onThinkPrefChange(m.key, { on: !on })}
                >
                  <span className="switch-dot" />
                </button>
              </div>
            )}
            {showLevels && (
              <>
                {canToggle && <div className="model-card-sep" />}
                <div className="card-panel-section">思考强度</div>
                {levels.map((lv) => (
                  <button
                    key={lv}
                    type="button"
                    className={`card-panel-item${lv === level ? " active" : ""}`}
                    onClick={() =>
                      onThinkPrefChange(m.key, { on: true, level: lv })
                    }
                  >
                    <span>{THINKING_LABELS[lv]}</span>
                    {lv === level && (
                      <Check
                        size={14}
                        strokeWidth={2.4}
                        className="card-panel-check"
                      />
                    )}
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  /*
   * 这里原本有一个「activeExpertSlug 变化就填专家的第一句快捷提示」的 effect,已删除。
   *
   * 它把「预填」做成了由状态派生:而 activeExpertSlug 对已有任务取自 task.expertSlug,
   * 于是每次从别的任务切回专家任务,这个值都会从 null 变回该 slug,effect 重新触发,
   * 把召唤时那句起手语又塞回输入框——用户明明早就发过、也回答完了。
   *
   * 预填本质是一次**用户动作**(召唤专家 / 在菜单里选专家)的结果,不是某个状态的函数,
   * 所以改由外层在那两个动作里显式发 prefill 信号。
   */

  // 切任务清空附件(正文由外层按任务保存,不在这里重置)。
  useEffect(() => {
    setFiles([]);
  }, [taskKey]);

  // 外部预填信号(场景卡):seq 变化即覆盖写入输入框内容。
  useEffect(() => {
    if (prefill && prefill.text) {
      setText(prefill.text);
    }
    // 仅在 seq 变化时触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.seq]);

  const activeMode = MODES.find((m) => m.id === mode) ?? MODES[0];
  const ActiveModeIcon = activeMode.icon;
  const activeImageMode =
    IMAGE_MODES.find((m) => m.id === imageMode) ?? IMAGE_MODES[1];
  const ActiveImageModeIcon = activeImageMode.icon;

  // 离开设计创意 tab 时收起这两个弹层,免得回来时它自己是展开的。
  useEffect(() => {
    if (!designWelcome) {
      setImageModeOpen(false);
      setStyleOpen(false);
      setHoverStyle(null);
    }
  }, [designWelcome]);

  /** 打开/关闭工作空间菜单;打开时拉一次列表并复位到列表视图。 */
  function toggleWs(): void {
    setWsOpen((open) => {
      if (open) {
        return false;
      }
      setWsQuery("");
      setWsCreating(false);
      setWsName("");
      setWsError("");
      void window.api.listWorkspaces().then((res) => {
        if (res.ok && res.data) {
          setWsList(res.data);
        }
      });
      return true;
    });
  }

  /** 选定一个工作空间并收起菜单。 */
  function chooseWs(ws: WorkspaceEntry | null): void {
    onWorkspaceChange?.(ws);
    setWsOpen(false);
  }

  async function submitWsCreate(): Promise<void> {
    const res = await window.api.createWorkspace(wsName);
    if (!res.ok || !res.data) {
      setWsError(res.error || "创建工作空间失败,请重试");
      return;
    }
    setWsList((prev) => [res.data as WorkspaceEntry, ...prev]);
    chooseWs(res.data);
  }

  async function pickWsDir(): Promise<void> {
    const res = await window.api.pickWorkspaceDir();
    if (!res.ok) {
      setWsError(res.error || "打开文件夹失败,请重试");
      return;
    }
    // 用户在系统对话框里点了取消:什么都不做,菜单留在原处。
    if (!res.data) {
      return;
    }
    setWsList((prev) => [
      res.data as WorkspaceEntry,
      ...prev.filter((w) => w.path !== res.data?.path),
    ]);
    chooseWs(res.data);
  }

  function submit(): void {
    if (running) return;
    const t = text.trim();
    if (!t && files.length === 0) return;
    onSend(t, files);
    setText("");
    setFiles([]);
    onClearSkill?.();
  }

  /** 关闭「+」菜单并复位到根视图。 */
  function closeAdd(): void {
    setAddOpen(false);
    setAddView("root");
  }

  /** 合并追加文件路径(去重、过滤空值),供"+"选择与拖拽共用。 */
  function addFiles(paths: string[]): void {
    const valid = paths.filter((p) => p);
    if (!valid.length) return;
    setFiles((prev) => Array.from(new Set([...prev, ...valid])));
  }

  async function pickFiles(): Promise<void> {
    const res = await window.api.pickFiles();
    if (res.ok && res.data && res.data.length) {
      addFiles(res.data);
    }
  }

  /** 拖拽悬停:阻止默认(允许放置)并高亮落区。 */
  function handleDragOver(e: ReactDragEvent): void {
    if (Array.from(e.dataTransfer.types).includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      if (!dragOver) setDragOver(true);
    }
  }

  /** 离开落区时取消高亮(仅当真正移出容器,避免子元素间抖动)。 */
  function handleDragLeave(e: ReactDragEvent): void {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setDragOver(false);
    }
  }

  /** 放置:经 webUtils 取每个文件的本地绝对路径,加入附件。 */
  function handleDrop(e: ReactDragEvent): void {
    e.preventDefault();
    setDragOver(false);
    const dropped = Array.from(e.dataTransfer.files);
    if (!dropped.length) {
      return;
    }
    const paths = dropped
      .map((f) => {
        try {
          return window.api.getPathForFile?.(f) ?? "";
        } catch {
          return "";
        }
      })
      .filter((p) => p);
    if (paths.length) {
      addFiles(paths);
    } else {
      console.warn(
        "[composer] 拖拽未能解析文件路径,请完全退出并重启应用以加载新的 preload",
      );
    }
  }

  function baseName(p: string): string {
    return p.split(/[\\/]/).pop() || p;
  }

  return (
    <div
      className={`composer${dragOver ? " drag-over" : ""}`}
      onDragOver={handleDragOver}
      onDragEnter={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragOver && (
        <div className="composer-drop-hint">
          <Paperclip size={18} strokeWidth={1.8} />
          松开以引用文件
        </div>
      )}
      {/*
        两道闸都照 WorkBuddy 的 `inputBottomSlotElement`:
         - `!showWelcome` —— 成员条整段包在这个分支里,欢迎页那一支渲染的是 QuickActions 胶囊行;
         - 至少有一名成员真被召唤过 —— 它的条件是 `hasTeamForCurrentSession`,即
           `getTeamRuntimeMembers(getTeamRuntimeSnapshot(sid)).length > 0`。
        所以主理人自己在回话、还没派活的那一段是不显示成员条的。
      */}
      {!showWelcome && activeExpert && spawnedRoster.length > 0 && (
        <TeamMemberBar
          teamName={
            activeExpert.manifest.displayName?.trim() || activeExpert.name
          }
          teamProfession={activeExpert.manifest.profession}
          teamAvatar={activeExpert.manifest.avatar}
          members={spawnedRoster}
          runs={memberRuns}
          leaderBusy={running}
        />
      )}
      <div className="composer-card">
        <div className="composer-input-row">
          {activeScene && (
            <span
              className="scene-chip removable"
              title={`已选场景:${activeScene.name}`}
            >
              <Compass
                size={13}
                strokeWidth={1.8}
                className="scene-chip-icon"
              />
              <span className="scene-chip-name">{activeScene.name}</span>
              <button
                className="scene-chip-x"
                aria-label="移除场景"
                onClick={() => onClearScene?.()}
              >
                ×
              </button>
            </span>
          )}
          {activeSkill && (
            <span
              className="skill-chip removable"
              title={`已选技能:${activeSkill.name}`}
            >
              <Wand2 size={13} strokeWidth={1.8} className="skill-chip-icon" />
              <span className="skill-chip-name">{activeSkill.name}</span>
              <button
                className="skill-chip-x"
                aria-label="移除技能"
                onClick={() => onClearSkill?.()}
              >
                ×
              </button>
            </span>
          )}
          {files.map((f) => (
            <span key={f} className="file-chip removable" title={f}>
              <FileText
                size={14}
                strokeWidth={1.8}
                className="file-chip-icon"
              />
              <span className="file-chip-name">{baseName(f)}</span>
              <button
                className="file-chip-x"
                aria-label="移除"
                onClick={() => setFiles((prev) => prev.filter((x) => x !== f))}
              >
                ×
              </button>
            </span>
          ))}
          <textarea
            className="composer-input"
            value={text}
            placeholder="今天帮你做些什么? @ 引用对话文件, / 调用技能与指令"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
        </div>

        <div className="composer-toolbar">
          <div className="tool-left">
            <div className="tool-wrap">
              <button
                className={`icon-btn round add-btn${addOpen ? " active" : ""}`}
                onClick={() => {
                  setAddOpen((v) => !v);
                  setAddView("root");
                }}
                title="添加"
                aria-label="添加"
              >
                {addOpen ? (
                  <X size={19} strokeWidth={2} />
                ) : (
                  <Plus size={19} strokeWidth={1.8} />
                )}
              </button>
              {addOpen && (
                <>
                  <FloatingMask className="menu-mask" onClick={closeAdd} />
                  <div className="pop-menu up add-menu">
                    {addView === "root" && (
                      <>
                        <button
                          className="add-item"
                          onClick={() => {
                            closeAdd();
                            void pickFiles();
                          }}
                        >
                          <Paperclip
                            size={15}
                            strokeWidth={1.8}
                            className="add-ico"
                          />
                          <span className="add-name">添加文件</span>
                        </button>
                        <button
                          className="add-item"
                          onClick={() => setAddView("mode")}
                        >
                          <ActiveModeIcon
                            size={15}
                            strokeWidth={1.8}
                            className="add-ico"
                          />
                          <span className="add-name">模式</span>
                          <span className="add-val">{activeMode.label}</span>
                          <ChevronRight
                            size={14}
                            strokeWidth={2}
                            className="add-arrow"
                          />
                        </button>
                        <button
                          className="add-item"
                          onClick={() => setAddView("skills")}
                        >
                          <Puzzle
                            size={15}
                            strokeWidth={1.8}
                            className="add-ico"
                          />
                          <span className="add-name">技能</span>
                          <ChevronRight
                            size={14}
                            strokeWidth={2}
                            className="add-arrow"
                          />
                        </button>
                        <button
                          className="add-item"
                          onClick={() => setAddView("experts")}
                        >
                          <GraduationCap
                            size={15}
                            strokeWidth={1.8}
                            className="add-ico"
                          />
                          <span className="add-name">专家</span>
                          {activeExpert && (
                            <span className="add-val">{activeExpert.name}</span>
                          )}
                          <ChevronRight
                            size={14}
                            strokeWidth={2}
                            className="add-arrow"
                          />
                        </button>
                        <button className="add-item" disabled title="即将上线">
                          <Cable
                            size={15}
                            strokeWidth={1.8}
                            className="add-ico"
                          />
                          <span className="add-name">连接器</span>
                          <span className="add-soon">即将上线</span>
                        </button>
                      </>
                    )}
                    {addView === "mode" && (
                      <>
                        <button
                          className="add-back"
                          onClick={() => setAddView("root")}
                        >
                          <ChevronLeft size={15} strokeWidth={2} />
                          模式
                        </button>
                        {MODES.map((m) => {
                          const Icon = m.icon;
                          return (
                            <button
                              key={m.id}
                              className={`add-item${m.id === mode ? " active" : ""}`}
                              title={m.desc}
                              onClick={() => {
                                onModeChange(m.id);
                                closeAdd();
                              }}
                            >
                              <Icon
                                size={15}
                                strokeWidth={1.8}
                                className="add-ico"
                              />
                              <span className="add-name">{m.label}</span>
                              {m.id === mode && (
                                <Check
                                  size={14}
                                  strokeWidth={2.4}
                                  className="add-check"
                                />
                              )}
                            </button>
                          );
                        })}
                      </>
                    )}
                    {addView === "skills" && (
                      <>
                        <button
                          className="add-back"
                          onClick={() => setAddView("root")}
                        >
                          <ChevronLeft size={15} strokeWidth={2} />
                          技能
                        </button>
                        {SKILLS.map((s) => (
                          <button
                            key={s.id}
                            className="add-item"
                            onClick={() => {
                              setText((t) =>
                                t ? `${t} /${s.id} ` : `/${s.id} `,
                              );
                              closeAdd();
                            }}
                          >
                            <span className="add-name">{s.label}</span>
                          </button>
                        ))}
                      </>
                    )}
                    {addView === "experts" && (
                      <>
                        <button
                          className="add-back"
                          onClick={() => setAddView("root")}
                        >
                          <ChevronLeft size={15} strokeWidth={2} />
                          专家
                        </button>
                        <button
                          className={`add-item${!activeExpertSlug ? " active" : ""}`}
                          onClick={() => {
                            onSelectExpert?.(null);
                            closeAdd();
                          }}
                        >
                          <span className="add-name">通用助手</span>
                          {!activeExpertSlug && (
                            <Check
                              size={14}
                              strokeWidth={2.4}
                              className="add-check"
                            />
                          )}
                        </button>
                        {experts.length === 0 && (
                          <div className="model-empty-hint">
                            还没召唤过专家,去「设置 · 专家市场」挑一个。
                          </div>
                        )}
                        {experts.map((e) => (
                          <button
                            key={e.slug}
                            className={`add-item${e.slug === activeExpertSlug ? " active" : ""}`}
                            title={e.manifest.profession || e.name}
                            onClick={() => {
                              onSelectExpert?.(e.slug);
                              closeAdd();
                            }}
                          >
                            {e.manifest.avatar ? (
                              <img
                                className="add-avatar"
                                src={e.manifest.avatar}
                                alt=""
                                width={16}
                                height={16}
                              />
                            ) : (
                              <GraduationCap
                                size={15}
                                strokeWidth={1.8}
                                className="add-ico"
                              />
                            )}
                            <span className="add-name">{e.name}</span>
                            {e.slug === activeExpertSlug && (
                              <Check
                                size={14}
                                strokeWidth={2.4}
                                className="add-check"
                              />
                            )}
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
            {/* 任务内:权限紧跟「+」(对齐 WorkBuddy);新建任务仍放卡片下方 subbar。 */}
            {inTask && (
              <div className="tool-wrap">
                <button
                  className={`subbar-pill in-toolbar${permission === "full" ? " warn" : ""}`}
                  onClick={() => setPermOpen((v) => !v)}
                  title="文件访问权限"
                >
                  {permission === "full" ? (
                    <Shield size={14} strokeWidth={1.8} />
                  ) : (
                    <ShieldCheck size={14} strokeWidth={1.8} />
                  )}
                  {permission === "full" ? "完全访问权限" : "默认权限"}
                  <ChevronDown
                    size={12}
                    strokeWidth={2}
                    className="pill-caret"
                  />
                </button>
                {permOpen && (
                  <>
                    <FloatingMask
                      className="menu-mask"
                      onClick={() => setPermOpen(false)}
                    />
                    <div className="pop-menu up">
                      <button
                        className="pop-item"
                        onClick={() => {
                          onPermissionChange("default");
                          setPermOpen(false);
                        }}
                      >
                        <span className="pop-item-title">默认权限</span>
                        <span className="pop-desc">仅在受管工作区内读写</span>
                      </button>
                      <button
                        className="pop-item"
                        onClick={() => {
                          onPermissionChange("full");
                          setPermOpen(false);
                        }}
                      >
                        <span className="pop-item-title">完全访问权限</span>
                        <span className="pop-desc">
                          允许访问整台电脑(高风险)
                        </span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
            {/*
              设计创意专属的两枚芯片,只在空态 + 该 tab 下出现(WorkBuddy 的 isDesignWelcome)。
              这一版只做 UI:补图方式能真切,设计风格的弹层还是空的 —— 见下面各自的注释。
            */}
            {designWelcome && (
              <div className="tool-wrap">
                <button
                  className="pill chip-pill"
                  onClick={() => setImageModeOpen((v) => !v)}
                  title="补图方式"
                  aria-haspopup="listbox"
                  aria-expanded={imageModeOpen}
                >
                  <ActiveImageModeIcon size={15} strokeWidth={1.8} />
                  {activeImageMode.label}
                  <ChevronDown
                    size={13}
                    strokeWidth={2}
                    className="pill-caret"
                  />
                </button>
                {imageModeOpen && (
                  <>
                    <FloatingMask
                      className="menu-mask"
                      onClick={() => setImageModeOpen(false)}
                    />
                    <div className="pop-menu up chip-menu">
                      {/* 抬头照 WorkBuddy 的 imageMode.header,只把品牌名换成我们的。 */}
                      <div className="pop-head">
                        你提供的图片素材不足时,云雾助手如何处理?
                      </div>
                      {IMAGE_MODES.map((m) => (
                        <button
                          key={m.id}
                          className={`pop-item row${imageMode === m.id ? " active" : ""}`}
                          onClick={() => {
                            onImageModeChange?.(m.id);
                            setImageModeOpen(false);
                          }}
                        >
                          <m.icon
                            size={15}
                            strokeWidth={1.8}
                            className="pop-item-ico"
                          />
                          <span className="pop-item-text">
                            <span className="pop-item-title">{m.label}</span>
                            <span className="pop-desc">{m.desc}</span>
                          </span>
                          {imageMode === m.id && (
                            <Check
                              size={14}
                              strokeWidth={2.4}
                              className="pop-item-check"
                            />
                          )}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
            {designWelcome && (
              <div className="tool-wrap">
                {/*
                  已选态照 WorkBuddy 的 DesignStyleChip:图标换成风格色块、文字换成风格名、
                  chevron 换成移除键(所以这里是 div + 内嵌 button,button 不能套 button)。
                */}
                <div
                  className="pill chip-pill"
                  role="button"
                  tabIndex={0}
                  title={
                    designStyle ? `已选风格:${designStyle.name}` : "设计风格"
                  }
                  aria-haspopup="listbox"
                  aria-expanded={styleOpen}
                  onClick={() => setStyleOpen((v) => !v)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setStyleOpen((v) => !v);
                    }
                  }}
                >
                  {designStyle ? (
                    <span
                      className="style-swatch"
                      style={{ background: designStyle.swatch }}
                      aria-hidden="true"
                    />
                  ) : (
                    <Palette size={15} strokeWidth={1.8} />
                  )}
                  {designStyle?.name ?? "设计风格"}
                  {designStyle ? (
                    <button
                      type="button"
                      className="chip-x"
                      aria-label={`回退设计风格 ${designStyle.name} 为默认`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDesignStyleChange?.(null);
                      }}
                    >
                      ×
                    </button>
                  ) : (
                    <ChevronDown
                      size={13}
                      strokeWidth={2}
                      className="pill-caret"
                    />
                  )}
                </div>
                {styleOpen && (
                  <>
                    <FloatingMask
                      className="menu-mask"
                      onClick={() => setStyleOpen(false)}
                    />
                    <div className="pop-menu up style-menu">
                      {/*
                        列表形照 WorkBuddy 的 `StyleListPanel`:209×208 的滚动列表,行高 40,
                        [色块 16px][风格名 12px][选中勾],hover 的那条在面板右侧 16px 外
                        浮出 260×200 大预览(`preview`,pointer-events:none)。

                        它按场景分两种布局(`GROUP_LAYOUT`):ui-design 走 list、poster 走
                        4 列网格(`GRID_GEOMETRY`),PPT 那组干脆不给风格芯片。我们没有
                        场景→风格组的映射,而它未选场景时回落的正是 ui-design,
                        所以先只做 list;等有了场景映射再补 poster 的网格。
                      */}
                      <div className="style-panel">
                        <div
                          className="style-list"
                          role="listbox"
                          onMouseLeave={() => setHoverStyle(null)}
                        >
                          {DESIGN_STYLES.map((s) => (
                            <button
                              key={s.id}
                              type="button"
                              role="option"
                              aria-selected={designStyle?.id === s.id}
                              className={`style-row${designStyle?.id === s.id ? " selected" : ""}`}
                              title={s.name}
                              onClick={() => {
                                onDesignStyleChange?.(s);
                                setStyleOpen(false);
                              }}
                              onMouseEnter={() => setHoverStyle(s)}
                              onFocus={() => setHoverStyle(s)}
                            >
                              <span
                                className="style-swatch"
                                style={{ background: s.swatch }}
                                aria-hidden="true"
                              />
                              <span className="style-name">{s.name}</span>
                              {designStyle?.id === s.id && (
                                <Check
                                  size={14}
                                  strokeWidth={2}
                                  className="style-check"
                                />
                              )}
                            </button>
                          ))}
                        </div>
                        {hoverStyle && (
                          <div
                            className="style-preview"
                            style={{ background: hoverStyle.swatch }}
                            aria-hidden="true"
                          />
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
            {/* WorkBuddy:召唤后专家芯片贴在「+」/权限右侧,不占输入区上方。 */}
            {activeExpert && (
              <button
                type="button"
                className="composer-expert-chip"
                title={`${activeExpert.name}${activeExpert.manifest.profession ? " · " + activeExpert.manifest.profession : ""}(点击切换专家)`}
                onClick={() => {
                  setAddOpen(true);
                  setAddView("experts");
                }}
              >
                {activeExpert.manifest.avatar ? (
                  <img
                    src={activeExpert.manifest.avatar}
                    alt=""
                    className="composer-expert-avatar"
                  />
                ) : (
                  <span className="composer-expert-avatar fallback">
                    <GraduationCap size={12} strokeWidth={1.8} />
                  </span>
                )}
                <span className="composer-expert-name">
                  {activeExpert.name}
                </span>
              </button>
            )}
          </div>

          <div className="tool-right">
            <div className="tool-wrap">
              <button
                className="pill model-pill"
                onClick={() => setModelOpen((v) => !v)}
                title="模型与深度思考"
              >
                <Cpu size={15} strokeWidth={1.8} />
                {modelLabel}
                {modelIsReasoning && (
                  <Sparkles
                    size={12}
                    strokeWidth={2}
                    className="model-think-dot"
                  />
                )}
                <ChevronDown size={13} strokeWidth={2} className="pill-caret" />
              </button>
              {modelOpen && (
                <>
                  <FloatingMask
                    className="menu-mask"
                    onClick={() => setModelOpen(false)}
                  />
                  <div className="pop-menu up model-menu">
                    {/*
                      思考不在这层。WorkBuddy 的模型菜单顶部只有 Auto / Max 模式两个开关,
                      而它的「Max 模式」跟思考无关——原文是「最大化上下文窗口,关闭自动上下文
                      压缩」(`input.model.maxModeTooltip`),我们一直把它当成"思考拉满"接错了对象;
                      内核的对应旋钮在 agent-defaults 的 `compaction`(`zod-schema.agent-defaults.ts:158`),
                      是另一件事,没实现之前这里不摆一个语义为假的开关。

                      思考强度按模型走每条右侧浮出的卡片(见下面 `model-card`),对齐它的 `ModelSubMenu`。
                    */}
                    <div
                      className="model-panel"
                      ref={modelPanelRef}
                      onMouseLeave={closeModelCardSoon}
                      onMouseEnter={cancelCardClose}
                    >
                      <div className="model-list">
                      {models.length === 0 && (
                        <div className="model-empty-hint">
                          尚无可用模型,请在模型管理中配置。
                        </div>
                      )}
                        {builtinModels.map((m) => renderModelRow(m, false))}
                        {customModels.length > 0 && (
                          <>
                            <div className="model-section-label">
                              自定义模型
                            </div>
                            {customModels.map((m) => renderModelRow(m, true))}
                          </>
                        )}
                      </div>
                      {hoverModel && isThinkingConfigurable(hoverModel) && (
                        <div
                          className="model-card"
                          style={{ top: hoverCardTop }}
                          onMouseEnter={cancelCardClose}
                        >
                          <div className="model-card-head">
                            <span className="model-card-name">
                              {hoverModel.label}
                            </span>
                          </div>
                          <div className="model-card-sep" />
                          {renderEffortRow(hoverModel)}
                        </div>
                      )}
                    </div>
                    {onOpenModelSettings && (
                      <>
                        <div className="mode-menu-sep" />
                        <button
                          className="model-item manage"
                          onClick={() => {
                            setModelOpen(false);
                            onOpenModelSettings();
                          }}
                        >
                          <Pencil
                            size={14}
                            strokeWidth={1.8}
                            className="model-manage-ico"
                          />
                          <span className="model-name">配置自定义模型</span>
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>

            <button className="icon-btn round" title="语音">
              <Mic size={17} strokeWidth={1.8} />
            </button>
            {running ? (
              <button
                className="send-btn stop"
                onClick={onAbort}
                title="终止任务"
                aria-label="终止任务"
              >
                <Square size={13} strokeWidth={0} fill="currentColor" />
              </button>
            ) : (
              <button
                className="send-btn"
                onClick={submit}
                disabled={!text.trim() && files.length === 0}
                title="发送"
                aria-label="发送"
              >
                <ArrowUp size={18} strokeWidth={2.4} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 新建任务:卡片下方保留工作空间 + 权限;任务内无此栏(权限已上移到「+」后)。 */}
      {!inTask && (
        <div className="composer-subbar">
          <div className="tool-wrap">
            <button
              className={`subbar-pill${workspace ? " on" : ""}`}
              onClick={toggleWs}
              title={workspace ? workspace.path : "工作空间"}
            >
              <FolderOpen size={14} strokeWidth={1.8} />
              {workspace ? workspace.name : "选择工作空间"}
              <ChevronDown size={12} strokeWidth={2} className="pill-caret" />
            </button>
            {wsOpen && (
              <>
                <FloatingMask
                  className="menu-mask"
                  onClick={() => setWsOpen(false)}
                />
                {/*
                  形状照 WorkBuddy 的工作空间下拉:搜索框 → 列表(空态「未找到工作空间」)
                  → 新建工作空间 / 打开本地文件夹,已选时多一条「不使用工作空间」。
                  文案全部取自它的 taskStarter.* 原文。
                */}
                <div className="pop-menu up ws-menu">
                  {wsCreating ? (
                    <div className="ws-create">
                      <div className="ws-create-desc">
                        为工作空间命名,本地将自动创建同名文件夹,命名后不可随意更改
                      </div>
                      <input
                        className="ws-create-input"
                        autoFocus
                        value={wsName}
                        placeholder="输入工作空间名称"
                        onChange={(e) => {
                          setWsName(e.target.value);
                          setWsError("");
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void submitWsCreate();
                          }
                          if (e.key === "Escape") {
                            setWsCreating(false);
                          }
                        }}
                      />
                      {wsError && <div className="ws-error">{wsError}</div>}
                      <div className="ws-create-actions">
                        <button
                          className="ws-btn"
                          onClick={() => {
                            setWsCreating(false);
                            setWsError("");
                          }}
                        >
                          取消
                        </button>
                        <button
                          className="ws-btn primary"
                          disabled={!wsName.trim()}
                          onClick={() => void submitWsCreate()}
                        >
                          创建
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="ws-search">
                        <Search size={14} strokeWidth={1.8} />
                        <input
                          value={wsQuery}
                          placeholder="搜索工作空间"
                          onChange={(e) => setWsQuery(e.target.value)}
                        />
                      </div>
                      <div className="ws-list">
                        {wsList.filter((w) =>
                          w.name
                            .toLowerCase()
                            .includes(wsQuery.trim().toLowerCase()),
                        ).length === 0 ? (
                          <div className="ws-empty">未找到工作空间</div>
                        ) : (
                          wsList
                            .filter((w) =>
                              w.name
                                .toLowerCase()
                                .includes(wsQuery.trim().toLowerCase()),
                            )
                            .map((w) => (
                              <button
                                key={w.path}
                                className={`ws-item${workspace?.path === w.path ? " active" : ""}`}
                                title={w.path}
                                onClick={() => chooseWs(w)}
                              >
                                <FolderOpen
                                  size={14}
                                  strokeWidth={1.8}
                                  className="ws-item-ico"
                                />
                                <span className="ws-item-name">{w.name}</span>
                                {workspace?.path === w.path && (
                                  <Check
                                    size={14}
                                    strokeWidth={2.4}
                                    className="ws-item-check"
                                  />
                                )}
                              </button>
                            ))
                        )}
                      </div>
                      {wsError && <div className="ws-error">{wsError}</div>}
                      <div className="mode-menu-sep" />
                      <button
                        className="ws-action"
                        onClick={() => {
                          setWsCreating(true);
                          setWsName(wsQuery.trim());
                          setWsError("");
                        }}
                      >
                        <Plus size={15} strokeWidth={1.8} />
                        新建工作空间
                      </button>
                      <button
                        className="ws-action"
                        onClick={() => void pickWsDir()}
                      >
                        <FolderOpen size={15} strokeWidth={1.8} />
                        打开本地文件夹
                      </button>
                      {workspace && (
                        <button
                          className="ws-action"
                          onClick={() => chooseWs(null)}
                        >
                          <X size={15} strokeWidth={1.8} />
                          不使用工作空间
                        </button>
                      )}
                    </>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="tool-wrap">
            <button
              className={`subbar-pill${permission === "full" ? " warn" : ""}`}
              onClick={() => setPermOpen((v) => !v)}
              title="文件访问权限"
            >
              {permission === "full" ? (
                <Shield size={14} strokeWidth={1.8} />
              ) : (
                <ShieldCheck size={14} strokeWidth={1.8} />
              )}
              {permission === "full" ? "完全访问权限" : "默认权限"}
              <ChevronDown size={12} strokeWidth={2} className="pill-caret" />
            </button>
            {permOpen && (
              <>
                <FloatingMask
                  className="menu-mask"
                  onClick={() => setPermOpen(false)}
                />
                <div className="pop-menu up">
                  <button
                    className="pop-item"
                    onClick={() => {
                      onPermissionChange("default");
                      setPermOpen(false);
                    }}
                  >
                    <span className="pop-item-title">默认权限</span>
                    <span className="pop-desc">仅在受管工作区内读写</span>
                  </button>
                  <button
                    className="pop-item"
                    onClick={() => {
                      onPermissionChange("full");
                      setPermOpen(false);
                    }}
                  >
                    <span className="pop-item-title">完全访问权限</span>
                    <span className="pop-desc">允许访问整台电脑(高风险)</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
