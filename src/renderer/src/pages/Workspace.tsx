import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  PanelLeft,
  Search,
  SlidersHorizontal,
  Bot,
  FolderKanban,
  GraduationCap,
  Workflow,
  LayoutGrid,
  ChevronDown,
  Bell,
  Compass,
  Share2,
  History,
  PanelRight,
  CircleCheck,
  ChevronLeft,
  ChevronRight,
  ArrowDownRight,
  ArrowUpRight,
  Copy,
  ThumbsUp,
  ThumbsDown,
  Volume2,
  Ellipsis,
  Pin,
  Archive,
  Folder,
  FolderOpen,
  Pencil,
  Save,
  Trash2,
  CircleX,
  CircleAlert,
  FileText,
  RefreshCw,
  Circle,
  X,
  Sparkles,
  ListChecks,
  MessageCircleQuestion,
  Terminal,
  Globe,
  Users,
  CircleDot,
  Briefcase,
  Code2,
  Palette,
  CirclePlus,
  ChartColumn,
  Presentation,
  Video,
  Microscope,
  Wrench,
  ClipboardList,
  Landmark,
  Rocket,
  Boxes,
  Wand2,
  GitBranch,
  AppWindow,
  Image as ImageIcon,
  Smartphone,
  Component,
  LayoutDashboard,
  Gem,
  PenTool,
  MousePointer2,
  Maximize2,
  Minimize2,
  Hand,
  Ruler,
  Plus,
  Minus,
  Check,
  type LucideIcon,
} from "lucide-react";
import type {
  AccountSnapshot,
  ActivationConfig,
  GatewayStatus,
  PermissionMode,
  ChatMode,
  ChatThinking,
  ChatModelOption,
  AgentEvent,
  PreflightReport,
  PreflightStatus,
  TaskMeta,
  InstalledExpert,
  DesktopScene,
  DesktopScenePrompt,
  DesktopScenario,
  MarketItem,
  MediaTaskProgress,
  ArtifactRef,
  AskRequest,
  AskAnswer,
  WidgetRequest,
  PresentRequest,
  TimelineItem,
  MemberRunStatus,
  ModelThinkPref,
  WorkspaceEntry,
} from "@shared/types";
import { thinkingLevelOf, thinkingOnOf } from "@shared/types";
import {
  ARTIFACT_TOOL_NAMES,
  PLAN_TOOL_NAMES,
  parsePlanSteps,
  parseArtifactPath,
  parseWrittenPath,
  mediaArtifactsFromText,
} from "@shared/tool-parse";
import {
  imageMimeOf,
  isImagePath,
  parseMediaDirectives,
  stripTrailingPartialMediaLine,
} from "@shared/media-directives";
import { findActiveAsk } from "@shared/active-ask";
import { taskSessionKey, DEFAULT_TASK_AGENT_ID } from "@shared/session-key";
import { isWorkspaceDataPath } from "@shared/workspace-data";
import {
  diffStatsFromResult,
  diffStatsFromDiff,
  parseDiffLines,
  stepPreview,
  resultPreview,
  toolIconKind,
  previewTone,
  isCommandTool,
  execStatusText,
  type ToolIconKind,
} from "@shared/tool-step";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import Composer, { type DesignStyle, type ImageMode } from "./Composer";
import MarketGallery, {
  scenarioCover,
  scenarioMemberSlugs,
} from "./MarketGallery";
import Mascot from "../components/Mascot";
import LoadingLottie from "../components/LoadingLottie";
import RunningSpinner from "../components/RunningSpinner";
import AskUserModal from "../components/AskUserModal";
import FloatingMask from "../components/FloatingMask";
import WorkspacePreparing from "../components/WorkspacePreparing";
import TaskFilterMenu from "../components/TaskFilterMenu";
import {
  deriveTaskStatus,
  EMPTY_TASK_FILTER,
  hasActiveTaskFilter,
  matchesTaskFilter,
  taskTrailingKind,
  TASK_TRAILING_LABEL,
  type TaskFilterValues,
} from "../lib/task-filter";
import {
  batchDisabledReason,
  batchSummaryMessage,
  collectSelectableIds,
  filterEffectiveSelection,
  getSelectAllState,
  isBatchSelectable,
  runBatchOperation,
  toggleSelection,
  BATCH_NO_EFFECTIVE_TASK,
  type BatchAction,
} from "../lib/batch-selection";
import AccountBalanceRow from "../components/AccountBalanceRow";
import { useHorizontalScroll } from "../hooks/horizontal-scroll";
import Settings, { type PageId } from "./settings/Settings";
import { applyTheme, getStoredTheme, type ThemeMode } from "../theme";

interface Props {
  activation: ActivationConfig;
  onSignOut: () => void;
  /**
   * 云雾会话过期,回登录页重登一次(激活态不动:sk- 令牌、模型清单、任务都留着)。
   * 与 onSignOut 的区别就在这儿 —— 那个是真退出,这个只是去换一张新会话。
   */
  onRelogin: () => void;
  onOpenFeedback: () => void;
}

/**
 * 净化模型生成的内联 SVG:移除 <script>、on* 事件属性、javascript: 链接与外链引用,
 * 只保留可安全内联渲染的矢量内容(对齐 WorkBuddy show_widget 的自包含 SVG 约束)。
 */
function sanitizeSvgUncached(code: string): string {
  try {
    const doc = new DOMParser().parseFromString(code, "image/svg+xml");
    const svg = doc.documentElement;
    if (!svg || svg.nodeName.toLowerCase() === "parsererror") {
      return "";
    }
    svg.querySelectorAll("script, foreignObject").forEach((el) => el.remove());
    svg.querySelectorAll("*").forEach((el) => {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        const val = attr.value.trim().toLowerCase();
        if (name.startsWith("on") || val.startsWith("javascript:")) {
          el.removeAttribute(attr.name);
        }
        if (
          (name === "href" || name === "xlink:href") &&
          !val.startsWith("#")
        ) {
          el.removeAttribute(attr.name);
        }
      }
    });
    if (!svg.getAttribute("width")) {
      svg.setAttribute("width", "100%");
    }
    return new XMLSerializer().serializeToString(svg);
  } catch {
    return "";
  }
}

/**
 * 净化结果缓存。净化本身要 DOMParser 解析整张图、遍历所有节点、再序列化回字符串,
 * 而它是在 render 里调用的——流式期间每秒几十次重渲染就意味着几十次全图解析,
 * 是"文字卡顿成块"的主要来源之一。图一旦画完就不再变,按原文缓存即可。
 * 返回同一字符串实例还有个副作用好处:React 比对 dangerouslySetInnerHTML 时值不变,
 * 不会重设 innerHTML,浏览器也就不用重新解析和布局这张 SVG。
 */
const svgCache = new Map<string, string>();
/** 缓存上限:一次会话里的图示数量远小于此,纯粹防止长会话无界增长。 */
const SVG_CACHE_MAX = 64;

function sanitizeSvg(code: string): string {
  const hit = svgCache.get(code);
  if (hit !== undefined) {
    return hit;
  }
  const out = sanitizeSvgUncached(code);
  if (svgCache.size >= SVG_CACHE_MAX) {
    svgCache.clear();
  }
  svgCache.set(code, out);
  return out;
}

/**
 * 统一的 markdown 渲染(GFM 表格/任务列表等);链接改为不可点击的纯文本片段以规避外跳。
 *
 * **必须 memo**:流式期间每个增量都会 setTasks,整个消息列表随之重渲染,
 * 而 remark/rehype 解析一篇 markdown 是毫秒级开销。不 memo 的话,一条增量的代价
 * 是"会话里所有消息各解析一遍",会话越长越卡,表现为文字一顿一顿地成段蹦出来。
 * memo 之后只有正文真的变了的那一条才重新解析。
 */
const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md-body">
      {/*
        remarkBreaks:把段内单换行当成换行渲染。标准 markdown 会把它并成空格,
        但模型经常用单换行来分行(例如"定位公式:…" 换行 "适用人群:…"),
        按标准处理会被糊成一整行。它只产生一个 <br>,不像原先的 pre-wrap 那样凭空多出空行。
      */}
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          a: ({ children }) => <span className="md-link">{children}</span>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

/** 逐字铺开的节拍(毫秒)。低于 30ms 人眼已分辨不出,只是白烧 CPU;高于 100ms 会重新显得卡顿。 */
const REVEAL_INTERVAL_MS = 50;
/** 积压超过这个字数就直接补齐,不做动画:属于快照替换/断线重放,逐字追赶没有意义还会显得迟滞。 */
const REVEAL_SNAP_CHARS = 600;

/**
 * 流式正文:把成块到达的增量按节拍逐段铺开,恢复"字在往外流"的观感。
 *
 * 为什么需要这一层:上游其实是逐 token 下发的(实测一条 966 token 的回复分了 464 个增量,
 * 每个 1~8 个字),但内核网关为省带宽把 150ms 内的增量合并成一条再广播给客户端。
 * 直接照着渲染就是每秒 6~7 次、每次十几个字的跳变,看起来就是"整段整段地蹦",没有流式感。
 * 这里在渲染层把落差重新摊开:每拍吐一小段,步长随积压自适应,大约 300ms 内追平当前已收到的
 * 内容——既不会落后于模型,也不会一次蹦一整段。
 *
 * 铺开只在 streaming 期间生效;运行一结束立刻补齐,保证显示的内容永远不少于真实内容。
 */
function StreamingMarkdown({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  const [shown, setShown] = useState(() => (streaming ? 0 : text.length));

  useEffect(() => {
    if (!streaming || text.length - shown > REVEAL_SNAP_CHARS) {
      if (shown !== text.length) {
        setShown(text.length);
      }
      return;
    }
    if (shown >= text.length) {
      // 正文被换成了更短的快照(replace 语义):向下对齐,避免残留上一版的尾巴。
      if (shown > text.length) {
        setShown(text.length);
      }
      return;
    }
    const timer = setTimeout(() => {
      setShown((s) =>
        Math.min(
          text.length,
          s + Math.max(2, Math.ceil((text.length - s) / 6)),
        ),
      );
    }, REVEAL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [text, shown, streaming]);

  return <Markdown text={streaming ? text.slice(0, shown) : text} />;
}

/**
 * 图片字节(base64)→ blob objectURL,卸载时 revoke。
 *
 * 对齐 WorkBuddy 的 ImagePreviewComponent:它拿到 Blob 也是 createObjectURL + 清理时
 * revokeObjectURL,而不是塞一条 `data:` URL —— 一张 1MB 的 PNG 转 base64 是 1.4MB 字符串,
 * 挂在 state 上每次重渲染都要带着走。内核 control-ui 走的是网关一条带票据的 HTTP 路由,
 * 那是浏览器读不到本地文件被逼的,我们在 Electron 里不需要。
 */
function useImageObjectUrl(
  base64: string | undefined,
  name: string,
): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!base64) {
      setUrl(undefined);
      return;
    }
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    const mime = imageMimeOf(name);
    const objectUrl = URL.createObjectURL(
      new Blob([bytes], mime ? { type: mime } : undefined),
    );
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [base64, name]);
  return url;
}

/** 灯箱动效时长与曲线,取自 WorkBuddy 的 image-preview(IMAGE_PREVIEW_MOTION_MS=180)。 */
const LIGHTBOX_MOTION_MS = 180;

/**
 * 全屏看图。对齐 WorkBuddy:portal 到 body、Escape 关闭、遮罩点击关闭、
 * 淡入叠加 0.96→1 的缩放,退出走同一条曲线再卸载。
 *
 * 刻意没做的:缩放/旋转/镜像/拖拽那一排(WorkBuddy 有 useZoomControl + useRotateControl
 * + dnd-kit)。先把「点开能看清」这条主路铺通,那些是叠加在同一个壳上的增量。
 */
function ImageLightbox({
  url,
  name,
  onClose,
}: {
  url: string;
  name: string;
  onClose: () => void;
}): React.JSX.Element {
  const [closing, setClosing] = useState(false);
  const requestClose = (): void => setClosing(true);

  useEffect(() => {
    if (!closing) {
      return;
    }
    const timer = setTimeout(onClose, LIGHTBOX_MOTION_MS);
    return () => clearTimeout(timer);
  }, [closing, onClose]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        setClosing(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return createPortal(
    <div
      className={`image-lightbox${closing ? " closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={`预览 ${name}`}
      onClick={requestClose}
    >
      <div className="image-lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span className="image-lightbox-name">{name}</span>
        <button
          type="button"
          className="image-lightbox-close"
          title="关闭(Esc)"
          aria-label="关闭"
          onClick={requestClose}
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>
      {/* 图本身不吃点击:点在图上也算点遮罩,与 WorkBuddy 一致地随手就能关掉。 */}
      <img
        className="image-lightbox-img"
        src={url}
        alt={name}
        draggable={false}
      />
    </div>,
    document.body,
  );
}

/** 预览面板里的图片:点一下进灯箱看大图(对齐 WorkBuddy 缩略图 → 全屏的路径)。 */
function ArtifactImagePreview({
  base64,
  name,
}: {
  base64: string;
  name: string;
}): React.JSX.Element {
  const url = useImageObjectUrl(base64, name);
  const [zoomed, setZoomed] = useState(false);
  if (!url) {
    return (
      <div className="artifact-preview-loading">
        <LoadingLottie size="sm" />
      </div>
    );
  }
  return (
    <>
      <img
        className="artifact-preview-img"
        src={url}
        alt={name}
        title="点击查看大图"
        onClick={() => setZoomed(true)}
      />
      {zoomed && (
        <ImageLightbox url={url} name={name} onClose={() => setZoomed(false)} />
      )}
    </>
  );
}

/** 会产出文件的工具(用于「同一文件的连续操作合并成一组」的判定)。 */
function isFileTool(name: string | undefined): boolean {
  return !!name && /write|edit|patch|create_file|str_replace/.test(name);
}

/** 动作图标(按 toolIconKind 分类)。淡灰色,与 WorkBuddy 一致。 */
const STEP_ICONS: Record<ToolIconKind, LucideIcon> = {
  edit: Pencil,
  search: Search,
  read: FileText,
  exec: Terminal,
  web: Globe,
  plan: ListChecks,
  agent: Users,
  custom: CircleDot,
};

/**
 * 步骤行首图标。
 *
 * 对齐 WorkBuddy:成功的步骤显示**动作图标**(铅笔 / 放大镜 / 圆点)而非绿色 ✓——
 * 一屏十几行全是对勾会盖掉正文。只有失败才用红色 ✗ 提醒,进行中用 Lottie。
 */
function StepIcon({
  status,
  name,
}: {
  status: string;
  name?: string;
}): React.JSX.Element {
  if (status === "failed") {
    return <CircleX size={14} strokeWidth={2} className="step-fail" />;
  }
  if (status !== "completed") {
    return <LoadingLottie size="xs" />;
  }
  const Icon = STEP_ICONS[toolIconKind(name ?? "")];
  return <Icon size={13} strokeWidth={1.8} className="step-icon" />;
}

/** 预览块内的 markdown 记号高亮:标题、列表符、**加粗**。行内正则,不引第三方高亮器。 */
function highlightInline(text: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) {
      out.push(text.slice(last, m.index));
    }
    out.push(
      <span key={`${keyPrefix}-b${i}`} className="stp-strong">
        <span className="stp-mark">**</span>
        {m[1]}
        <span className="stp-mark">**</span>
      </span>,
    );
    last = m.index + m[0].length;
    i += 1;
  }
  if (last < text.length) {
    out.push(text.slice(last));
  }
  return out;
}

/** 预览正文:按行做轻量 markdown 着色(标题加粗着色、记号淡化),其余原样保留。 */
function PreviewBody({
  text,
  tone,
}: {
  text: string;
  tone: "add" | "neutral";
}): React.JSX.Element {
  if (tone === "neutral") {
    return <pre className="step-preview neutral">{text}</pre>;
  }
  return (
    <pre className="step-preview">
      {text.split("\n").map((line, idx) => {
        const heading = line.match(/^(#{1,6})\s+(.*)$/);
        if (heading) {
          return (
            <div key={idx} className="stp-line">
              <span className="stp-mark">{heading[1]} </span>
              <span className="stp-h">{heading[2]}</span>
            </div>
          );
        }
        const list = line.match(/^(\s*(?:[-*]|\d+\.)\s)(.*)$/);
        if (list) {
          return (
            <div key={idx} className="stp-line">
              <span className="stp-mark">{list[1]}</span>
              {highlightInline(list[2], `l${idx}`)}
            </div>
          );
        }
        return (
          <div key={idx} className="stp-line">
            {highlightInline(line, `p${idx}`)}
          </div>
        );
      })}
    </pre>
  );
}

/**
 * 改文件的 diff:带行号的加减色块。
 *
 * 数据是内核执行后给的那份(`toolResult.details.diff`),不是我们从入参猜的——
 * 入参里只有 old/new 两段文字,既没有真实行号,同时有增有删时行数也数不准。
 * 形态照 WorkBuddy 的 write-file 渲染器:只分加/减两色 + 行号,不做左右分栏
 * (它把左右对照留给点开文件之后的编辑器,气泡里只回答"改了哪几行")。
 */
function DiffBody({ diff }: { diff: string }): React.JSX.Element {
  const lines = parseDiffLines(diff);
  return (
    <pre className="step-diff">
      {lines.map((line, idx) => (
        <div key={idx} className={`dl dl-${line.kind}`}>
          <span className="dl-num">{line.num}</span>
          <span className="dl-sign">
            {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
          </span>
          <span className="dl-text">{line.text}</span>
        </div>
      ))}
    </pre>
  );
}

/** 预览默认展开的行数上限:短内容(memory / overview 之类)直接摊开,长产物折起来避免刷屏。 */
const PREVIEW_OPEN_LINES = 24;

/**
 * 一条工具步骤:动作图标 + 中文动作 + 目标路径(有多长写多长)+ `+33 -0` 行数增删。
 * 有内容的步骤可展开查看,内容块按工具类型着色(写入=绿底新增块,交付=灰底入参)。
 */
function StepLine({
  item,
}: {
  item: Extract<TimelineItem, { kind: "tool" }>;
}): React.JSX.Element {
  // title 形如「创建 <完整路径>」;把路径拆出来单独着色,动作与路径视觉分层。
  // 兜底:write 有时入参不带 path、内核标题只有「创建」,而 item.path 是从结果文本
  // 兜底解析出来的——此时标题里并不含该路径,仍要把它单独补上,避免出现「创建」后面空着。
  const path = item.path ?? "";
  const titleHasPath = path !== "" && item.title.includes(path);
  const label = titleHasPath
    ? item.title.slice(0, item.title.indexOf(path)).trim()
    : item.title;
  const head = (
    <>
      <StepIcon status={item.status} name={item.name} />
      <span className="step-label">{label}</span>
      {path && (
        <span className="step-path" title={path}>
          {path}
        </span>
      )}
      {item.stats && (
        <span className="step-stats">
          <span className="step-add">+{item.stats.added}</span>
          <span className="step-del">-{item.stats.removed}</span>
        </span>
      )}
    </>
  );
  // 命令类步骤:输出走等宽块,底下补一条状态(运行成功 / 退出码 N / 还在后台跑)。
  // 依据是 WorkBuddy 的 `.execute-command .stdout-content`:12px/18px 等宽、限高 200 自带
  // 滚动、**没有黑底终端皮**;空输出显示「运行成功」,还在跑显示「运行中」。
  const command = isCommandTool(item.name ?? "");
  const status = command
    ? execStatusText(item.exec, {
        hasOutput: !!item.preview,
        failed: item.status === "failed",
        running: item.status === "running",
      })
    : undefined;
  const body = command ? (
    <div className="step-command">
      {item.preview && <pre className="step-output">{item.preview}</pre>}
      {status && (
        <div className={`step-exec-status ${status.tone}`}>{status.text}</div>
      )}
    </div>
  ) : item.diff ? (
    // 改文件:画内核给的那份带行号 diff(加绿减红),不是把新内容整段摊开。
    // 抄 WorkBuddy 的 write-file 渲染器口径:它也只给增删两色 + 行号,不做左右分栏。
    <DiffBody diff={item.diff} />
  ) : item.preview ? (
    <PreviewBody text={item.preview} tone={previewTone(item.name ?? "")} />
  ) : null;
  if (!body) {
    return <div className="msg-step">{head}</div>;
  }
  const lines = (item.diff ?? item.preview ?? "").split("\n").length;
  return (
    <details
      className="msg-step step-expandable"
      open={lines <= PREVIEW_OPEN_LINES}
    >
      <summary className="step-summary">{head}</summary>
      {body}
    </details>
  );
}

/**
 * 深度思考块。
 *
 * 思考进行中(active)自动展开,让用户能实时读到推理;一旦开始输出正文或调工具就自动收起,
 * 只留一行「深度思考 ›」——过程区里同时摊开多段推理会把真正的动作和结论淹掉。
 *
 * 用户在思考期间手动收起的意图必须保住:推理是逐字流进来的,每个增量都会重渲染,
 * 若只写 open={active},用户刚点上就会被下一个 token 顶开。
 */
function ReasoningBlock({
  text,
  active,
  attempt,
}: {
  text: string;
  active: boolean;
  /** >1 表示这段思考来自内核的第 N 次重跑(见 TimelineItem.attempt)。 */
  attempt?: number;
}): React.JSX.Element {
  /**
   * 展开状态必须自己存一份 state。
   *
   * 原先写成 `open={active && !userClosed}`:`<details>` 的 open 一旦受控,浏览器那次点击
   * 展开不会通知 React,于是**下一次重渲染就把它按旧值打回去**——思考结束后(active=false)
   * 用户点开这一块,气泡里任何一处更新都会让它自己合上。改成把点击结果写回 state。
   */
  const [open, setOpen] = useState(active);
  // 思考中自动展开、结束自动收起;这一句只在 active 翻转时跑,所以流式期间用户手动
  // 收起的意图不会被下一个 token 顶开。
  useEffect(() => {
    setOpen(active);
  }, [active]);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // 推理是逐字流进来的,而容器只有 200px 高:不贴底的话用户盯着的永远是最早那几行,
    // 越想越看不见。WorkBuddy 为此单开了一个 reasoning-scroll 模块,我们这一句等效。
    const el = bodyRef.current;
    if (active && el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [text, active]);
  return (
    <details
      className="msg-reasoning"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="reasoning-summary">
        {/* 思考中整行走流光(WorkBuddy 的 `_loadingText_`,同一条 shining-text sweep)。 */}
        <span className={active ? "status-shimmer" : undefined}>深度思考</span>
        {/*
         * 内核重跑这条 prompt 时我们只留最后一次的思考(否则几段一模一样的堆在一起)。
         * 但"悄悄换掉"同样让人费解,所以把次数说出来:用户至少知道它重试过。
         */}
        {attempt && attempt > 1 && (
          <span className="reasoning-attempt">第 {attempt} 次尝试</span>
        )}
      </summary>
      {/* 推理正文也是 markdown:模型在这里列条目、贴代码,当纯文本渲染会糊成一坨。 */}
      <div className="reasoning-body" ref={bodyRef}>
        <Markdown text={text} />
      </div>
    </details>
  );
}

/**
 * 单个时间线项(思考段 / 工具步骤 / 待办清单 / 图示卡 / 问答卡)。
 * `active`:该项是否为「运行中的最新一项」,目前只有思考段用它决定是否自动展开。
 */
function TimelineNode({
  item,
  active = false,
}: {
  item: TimelineItem;
  active?: boolean;
}): React.JSX.Element {
  if (item.kind === "tool") {
    return <StepLine item={item} />;
  }
  if (item.kind === "plan") {
    // 结构对齐 WorkBuddy:标题行在面板**外**(灰色小字 + 折叠箭头),
    // 下方一块整宽浅灰面板承载所有步骤,每行右侧留一个 › 指示位。
    return (
      <details className="msg-plan" open>
        <summary className="msg-plan-head">
          <ListChecks size={13} strokeWidth={2} />
          <span>任务列表</span>
          <ChevronDown size={13} strokeWidth={2} className="msg-plan-caret" />
        </summary>
        <ul className="msg-plan-list">
          {item.steps.map((s, si) => (
            <li key={si} className={`msg-plan-item ${s.status}`}>
              {s.status === "completed" ? (
                <CircleCheck size={14} strokeWidth={2} className="step-ok" />
              ) : s.status === "in_progress" ? (
                <LoadingLottie size="xs" />
              ) : (
                <Circle size={14} strokeWidth={2} className="plan-pending" />
              )}
              <span className="msg-plan-text">{s.text}</span>
              <ChevronRight
                size={14}
                strokeWidth={2}
                className="msg-plan-row-caret"
              />
            </li>
          ))}
        </ul>
      </details>
    );
  }
  if (item.kind === "widget") {
    const svg = sanitizeSvg(item.code);
    return (
      // 壳标题固定为「展示详情」(对齐 WorkBuddy);模型给的标题作为 tooltip,
      // 图本身已含标题文字,避免壳内外重复。
      <details className="msg-widget" open>
        <summary className="msg-widget-head" title={item.title || undefined}>
          <LayoutGrid size={14} strokeWidth={2} />
          <span>展示详情</span>
        </summary>
        {svg ? (
          <div
            className="msg-widget-body"
            // 已净化(去 script/on*/外链)的自包含 SVG,内联渲染。
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <div className="msg-widget-empty">该可视化内容无法安全渲染</div>
        )}
      </details>
    );
  }
  if (item.kind === "ask") {
    if (item.status === "waiting") {
      return (
        <div className="msg-ask">
          <div className="msg-ask-head">
            <MessageCircleQuestion size={14} strokeWidth={2} />
            向用户提问
          </div>
          <div className="msg-ask-waiting">
            <LoadingLottie size="xs" />
            等待用户确认
          </div>
        </div>
      );
    }
    if (item.status === "cancelled") {
      return (
        <div className="msg-ask">
          <div className="msg-ask-head muted">
            <MessageCircleQuestion size={14} strokeWidth={2} />
            向用户提问(已取消)
          </div>
        </div>
      );
    }
    return (
      <div className="msg-ask">
        <div className="msg-ask-head">
          <MessageCircleQuestion size={14} strokeWidth={2} />
          向用户提问
        </div>
        <div className="msg-ask-qa">
          {(item.answers ?? []).map((a, ai) => {
            const ans = [...a.selected, ...(a.custom ? [a.custom] : [])]
              .filter(Boolean)
              .join("、");
            return (
              <div key={ai} className="msg-ask-item">
                <div className="msg-ask-q">{a.question}</div>
                <div className="msg-ask-a">{ans || "(已跳过)"}</div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }
  return (
    <ReasoningBlock
      text={item.text}
      active={active}
      {...(item.attempt ? { attempt: item.attempt } : {})}
    />
  );
}

/**
 * 一轮回复的「执行过程」。
 *
 * 正文按各项的 `at` 偏移切片穿插进来:内核下发的正文是整轮累计、只增不减的,
 * 不能把正文搬进时间线(下一个 delta 会把它带回来造成重复),只能记偏移再切。
 * 同一文件的连续写改、且中间没有正文的,合并成一个可折叠组(对齐 WorkBuddy「修改 xxx.md ∨」)。
 *
 * 最末一项之后的那段正文不在这里渲染——那是「最终回答」,由调用方显示在过程块之外。
 */
function RunTimeline({
  items,
  content,
  streaming = false,
}: {
  items: TimelineItem[];
  content: string;
  streaming?: boolean;
}): React.JSX.Element {
  // 「正在思考」= 本轮还在跑 + 思考段是时间线最末一项 + 它之后还没吐出正文。
  // 三者任一不成立(工具跟上来了 / 正文开始输出 / 整轮结束)即视为思考已过去,自动收起。
  const lastIdx = items.length - 1;
  const last = lastIdx >= 0 ? items[lastIdx] : undefined;
  const activeThinkingIdx =
    streaming &&
    last &&
    last.kind === "thinking" &&
    content.length <= (last.at ?? 0)
      ? lastIdx
      : -1;
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    const at = Math.min(Math.max(it.at ?? cursor, cursor), content.length);
    if (at > cursor) {
      // 与最终回答同样要剥掉 `MEDIA:` 指令:媒体走产出物卡片,指令本身不是给人看的。
      const chunk = parseMediaDirectives(content.slice(cursor, at)).text;
      if (chunk) {
        nodes.push(<Markdown key={`text-${cursor}`} text={chunk} />);
      }
      cursor = at;
    }
    if (it.kind === "tool" && it.path && isFileTool(it.name)) {
      // 往后收集同文件、同偏移(中间没有正文)的连续文件操作。
      const group = [it];
      let j = i + 1;
      while (j < items.length) {
        const nx = items[j];
        if (
          nx.kind === "tool" &&
          nx.path === it.path &&
          isFileTool(nx.name) &&
          Math.min(Math.max(nx.at ?? at, cursor), content.length) === at
        ) {
          group.push(nx);
          j += 1;
          continue;
        }
        break;
      }
      if (group.length > 1) {
        nodes.push(
          <details className="msg-step-group" key={`group-${it.itemId}`}>
            <summary className="step-summary">
              <Pencil size={13} strokeWidth={1.8} className="step-group-icon" />
              <span className="step-label">修改</span>
              <span className="step-path">{baseName(it.path)}</span>
              <span className="step-count">{group.length}</span>
            </summary>
            <div className="msg-step-group-body">
              {group.map((g) => (
                <StepLine key={g.itemId} item={g} />
              ))}
            </div>
          </details>,
        );
        i = j;
        continue;
      }
    }
    nodes.push(
      <TimelineNode
        key={timelineKey(it)}
        item={it}
        active={i === activeThinkingIdx}
      />,
    );
    i += 1;
  }
  return <>{nodes}</>;
}

/** 时间线项的稳定 key。 */
function timelineKey(it: TimelineItem): string {
  return it.kind === "thinking" ? `think-${it.id}` : `${it.kind}-${it.itemId}`;
}

/**
 * 滤掉内核在「只有签名、没有摘要文本」时塞进思考块的英文内部提示。
 *
 * 部分渠道(实测云雾的 claude-opus-4-8)返回的 thinking 块正文为空、只带 signature,内核
 * 的 extractAssistantThinking 便原样吐出这句占位。它对用户零信息量且是英文,展示出来只会
 * 让人以为坏了;滤成空串后思考块自然不渲染,正文照常输出。
 */
const NATIVE_REASONING_PLACEHOLDER =
  "Native reasoning was produced; no summary text was returned.";
function stripReasoningPlaceholder(text: string | undefined): string {
  if (!text) {
    return "";
  }
  return text
    .split("\n")
    .filter((l) => l.trim() !== NATIVE_REASONING_PLACEHOLDER)
    .join("\n")
    .trim();
}

/**
 * 助手回复时间线项:把「深度思考段」与「工具步骤」合成一条有序序列,
 * 按内核多轮运行的到达时序交错渲染(对齐 WorkBuddy:思考 ↔ 工具 逐段穿插)。
 */
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** 用户消息引用的本地文件绝对路径(用于渲染附件卡片,与正文分离)。 */
  files?: string[];
  /**
   * 助手消息所属的运行轮次 id(与网关事件 runId 对应)。
   * 新建占位时为空(待认领);收到本轮首个事件后绑定,
   * 用于把后续事件精确路由到本轮消息,并隔离网关重放的历史轮次事件。
   */
  runId?: string;
  /** 助手消息是否仍在流式输出中。 */
  streaming?: boolean;
  /**
   * 运行中的状态文案(「等待模型响应」/「生成回复中」/「正在写入文件」…)。
   * 由事件流逐次改写:一条 agent 回复要跨很多阶段(等模型 → 出思考 → 出正文 → 调工具 → 再等模型),
   * 只显示一句固定的"生成回复中"会让"正在等上游"和"正在吐字"看起来完全一样,
   * 上游慢的时候用户只能理解成卡死。
   */
  liveStatus?: string;
  /** 本轮回复的有序时间线(思考段 + 工具步骤交错);实时运行时填充。 */
  timeline?: TimelineItem[];
  /** 本轮产出物文件(由 write/edit/apply_patch 工具聚合去重;对标 WorkBuddy 产出物卡片)。 */
  artifacts?: ArtifactRef[];
  /** 深度思考内容(历史恢复时的单块快照;实时运行改用 timeline 逐段展示)。 */
  thinking?: string;
  /** 错误信息(发送失败或运行出错)。 */
  error?: string;
  /** 本轮是否被中止(用户主动或系统中止,统一表示"未正常完成")。 */
  aborted?: boolean;
  /**
   * 本轮是「主动让出」:agent 调 sessions_yield 收尾,挂起等子会话(专家)回信,收到后自动续跑。
   * 这是正常收尾而非中止,不能显示「回复已中断」去劝用户重试——重试反而会打断在跑的子会话。
   */
  yielded?: boolean;
  /** 中止是否由用户主动点击停止触发(用于区分文案:用户已取消 vs 回复已中断)。 */
  userAborted?: boolean;
  /** 非用户主动中止时的原因(已转成中文),附在「回复已中断」后面便于判断是否值得重试。 */
  abortReason?: string;
  /**
   * 本条气泡里「上一轮已经说完的正文」有多长。
   *
   * 只有服务端自己发起的续轮(媒体补投、成员回传)会用到:那一轮并进同一条气泡,而内核给的
   * `text` 是**本轮**的累计快照,直接赋给 content 会把上一轮说过的话整段吞掉;时间线上那些
   * 按旧偏移记的步骤又会把新正文从头砍掉同样长度(真机复现:上一轮 2 字 → 新正文少 2 字)。
   * 记下这个基准,续轮的正文接在它后面写。
   */
  contentBase?: number;
  /**
   * 这一轮被内核重跑到第几次(1 = 没重跑)。
   *
   * 内核遇到「只有思考、没有可见回答」的一轮会原样重跑同一条 prompt,上限 2 次
   * (`DEFAULT_REASONING_ONLY_RETRY_LIMIT`)。我们只保留最后一次的思考,用这个数字
   * 把重试说出来。边界取 lifecycle start,不取思考帧——一次尝试的思考帧会来好几拨。
   */
  attempts?: number;
  /** 本轮开始时间(创建占位时记录),用于结束后计算「已完成 Ns」。 */
  startedAt?: number;
  /** 本轮耗时(毫秒),结束时结算,用于顶层运行状态显示「已完成 Ns」。 */
  elapsedMs?: number;
}

/**
 * 把内核的英文中止原因转成用户能据此决策的中文。
 * 只翻译我们确实见过的几类;其余原样带出,便于反馈时保留可检索的原文。
 */
/**
 * 媒体任务已用时长。出图 20~50 秒、出视频 1~6 分钟,所以过一分钟就换成「N 分 M 秒」——
 * 一直显示「已用 214 秒」读起来要算术。
 */
function mediaElapsedLabel(startedAt: number): string {
  const sec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (sec < 60) {
    return `已用 ${sec} 秒`;
  }
  return `已用 ${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
}

function humanizeAbortReason(raw: string): string {
  const idle = raw.match(/idle timeout \((\d+)s\)/i);
  if (idle) {
    return `模型 ${idle[1]} 秒无响应`;
  }
  /**
   * 内核的 incomplete-turn 报错(`run.ts:3849`)。它的成因很具体:模型这一轮只吐了思考,
   * 既没有正文也没有工具调用,内核原样重跑 2 次(`DEFAULT_REASONING_ONLY_RETRY_LIMIT`)
   * 仍是这样,才把这句抛给用户。原文是英文且只说"再试一次",按我们观察到的成因写清楚——
   * 真机上这是弱模型(deepseek-v4-flash)在满编工具表下的固定表现,换模型比重试有效。
   */
  if (/couldn't generate a response/i.test(raw)) {
    return "模型只输出了思考、没有给出回答(已自动重跑两次)。可以重发,或换个模型再试。";
  }
  if (/aborted|cancell?ed/i.test(raw) && raw.length < 40) {
    return "运行被中止";
  }
  // 原文形如「503 分组 X、Y 下模型 Z 无可用渠道(distributor)(request id: ...)」。
  // 这句话的实际含义是「**当前 Key 所属分组**里没有该模型的渠道」,最常见的成因不是上游抖动,
  // 而是给这个模型配错了 Key(比如把只含 gpt 分组的 Key 配给了 claude 模型)——那种情况下
  // 重试一万次也不会好。所以文案要指向 Key 分组,不能笼统说"稍后重试"。
  // request id 是客服侧排查的唯一线索,保留。
  if (/无可用渠道|no available channel/i.test(raw) || /\b503\b/.test(raw)) {
    const model = raw.match(/下模型\s*([\w.:-]+)\s*无可用渠道/);
    const rid = raw.match(/request id:\s*([\w:.-]+)/i);
    return (
      `当前 API Key 所属分组下没有${model ? `「${model[1]}」` : "该模型"}的可用渠道,` +
      `请在「设置 → 模型管理」中确认该模型配置的 Key 是否支持它${rid ? `(请求号 ${rid[1]})` : ""}`
    );
  }
  return raw;
}

/** 等待上游模型返回时的状态文案(工具跑完到下一段内容到达之间的空窗)。 */
const STATUS_WAITING = "等待模型响应";
/** 正文正在流式输出。 */
const STATUS_REPLYING = "生成回复中";

/**
 * 工具运行中的状态文案:说"正在做什么"的人话,而不是内部工具名。
 * 认不出的工具退回通用文案——宁可笼统,也不要把 `yw__present_files` 这种内部标识甩给用户。
 */
function toolRunningLabel(toolName: string): string {
  const n = toolName.toLowerCase();
  if (n.includes("ask_user")) {
    return "等待你回复";
  }
  if (n.includes("show_widget")) {
    return "正在渲染组件";
  }
  if (n.includes("present_files")) {
    return "正在交付文件";
  }
  if (PLAN_TOOL_NAMES.has(n)) {
    return "正在整理任务清单";
  }
  // 会话/专家类元数据工具(内核的 sessions_* / agents_list)名字里同样带 search、list,
  // 必须排在下面的网页检索与文件查阅之前,否则 sessions_search 会被说成"正在检索网页"。
  if (n.startsWith("sessions_") || n.includes("conversation")) {
    return "正在查阅历史会话";
  }
  if (n.startsWith("agents_")) {
    return "正在查看可用专家";
  }
  // 只认真正的网页检索;其余带 search 的(grep 之类)交给下面的文件分支。
  if (n.includes("web_search") || n.includes("websearch") || n === "search") {
    return "正在检索网页";
  }
  if (n.includes("fetch")) {
    return "正在读取网页";
  }
  // edit / apply_patch 先于 write 判断:apply_patch 语义是改而不是新建。
  if (n.includes("edit") || n.includes("patch")) {
    return "正在修改文件";
  }
  if (n.includes("write")) {
    return "正在写入文件";
  }
  if (
    n.includes("read") ||
    n.includes("glob") ||
    n.includes("grep") ||
    n.includes("list")
  ) {
    return "正在查阅文件";
  }
  if (
    n.includes("bash") ||
    n.includes("shell") ||
    n.includes("command") ||
    n === "exec"
  ) {
    return "正在执行命令";
  }
  if (n.includes("task") || n.includes("agent")) {
    return "正在委派子任务";
  }
  return "正在调用工具";
}

/** 取路径文件名(兼容 Windows/POSIX 分隔符)。 */
function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

/** 文件大小的人读格式(与产出物卡片副标题一致:1 位小数,如 `9.3 KB`)。 */
function formatBytes(size: number | undefined): string {
  if (size === undefined) {
    return "";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 产出物角标:扩展名 + 配色。用文字扩展名而不是各家真实 logo,
 * 既能覆盖任意文件类型,也免去为每种类型维护图标资源。
 */
const BADGE_TONE: Record<string, string> = {
  md: "md",
  markdown: "md",
  txt: "txt",
  csv: "sheet",
  tsv: "sheet",
  xlsx: "sheet",
  json: "code",
  jsonl: "code",
  yaml: "code",
  yml: "code",
  js: "code",
  ts: "code",
  py: "code",
  go: "code",
  html: "code",
  css: "code",
  pdf: "doc",
  docx: "doc",
  doc: "doc",
  // 图片也走同一份卡片列表(对话区不铺图),所以它们得有自己的色档,
  // 否则一张生成图会顶着灰色的 FILE 底色,与 WorkBuddy 那枚彩色图片图标差得远。
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  bmp: "image",
  mp4: "media",
  webm: "media",
  mov: "media",
  mp3: "media",
  wav: "media",
};

function fileBadge(name: string): { text: string; tone: string } {
  const ext = (name.split(".").pop() || "").toLowerCase();
  // 无扩展名或扩展名过长(多半不是真扩展名)时退回通用角标。
  if (!ext || ext === name.toLowerCase() || ext.length > 4) {
    return { text: "FILE", tone: "txt" };
  }
  return { text: ext.toUpperCase(), tone: BADGE_TONE[ext] ?? "txt" };
}

/** 自检步骤状态图标。 */
function prepIcon(status: PreflightStatus) {
  switch (status) {
    case "ok":
      return <CircleCheck size={15} strokeWidth={2} className="step-ok" />;
    case "warn":
      return <CircleCheck size={15} strokeWidth={2} className="step-warn" />;
    case "fail":
      return <CircleX size={15} strokeWidth={2} className="step-fail" />;
    case "running":
      return <LoadingLottie size="xs" />;
    default:
      return <Circle size={15} strokeWidth={2} className="step-pending" />;
  }
}

interface Task {
  id: string;
  title: string;
  /** 稳定会话 key:与 OpenClaw 网关一一对应,保证上下文连续。 */
  sessionKey: string;
  messages: ChatMessage[];
  pinned?: boolean;
  /** 是否已在内核创建 agent 并纳入持久化(首次发消息后置 true;从磁盘恢复的任务为 true)。 */
  persisted?: boolean;
  /** 创建时间戳(用于恢复后排序)。 */
  createdAt: number;
  /** 该会话绑定的专家 slug(由某专家发起);普通会话留空。绑定在 agent 创建时定型。 */
  expertSlug?: string;
  /** 专家展示名快照(渲染会话头/助手头像)。 */
  expertName?: string;
  /** 专家头像 URL 快照。 */
  expertAvatar?: string;
  /**
   * 专家团成员的运行状态(成员 agent id → running/completed/failed),驱动成员条。
   * 挂在任务上而非某条消息上:成员的活会跨越负责人的多轮回复,按消息存会一换轮就清零。
   * 不做持久化——重开任务时子会话早已结束,拿旧状态渲染只会显示一排假的"进行中"。
   */
  memberRuns?: Record<string, MemberRunStatus>;
}

/**
 * 搜索结果右侧显示任务工作目录的友好名称。
 *
 * WorkBuddy 把 cwd 归一成 `2026-08-14-16-10-21` 后放进固定宽度的信息列；
 * 我们真实目录末尾另有 4 位防碰撞后缀，那是存储细节，不放进搜索列表。专家任务
 * 没有这种时间戳友好名时显示专家名。
 */
function taskSearchMeta(task: Task): string {
  if (task.expertName) {
    return task.expertName;
  }
  const d = new Date(task.createdAt);
  if (!task.createdAt || Number.isNaN(d.getTime())) {
    return "";
  }
  const pad = (value: number): string => String(value).padStart(2, "0");
  const timestamp =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return timestamp;
}

/** WorkBuddy 搜索结果会用品牌色标出标题与目录中命中的片段。 */
function TaskSearchText({ text, query }: { text: string; query: string }) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return <>{text}</>;
  }
  const normalizedText = text.toLocaleLowerCase();
  const matchAt = normalizedText.indexOf(normalizedQuery);
  if (matchAt < 0) {
    return <>{text}</>;
  }
  const matchEnd = matchAt + normalizedQuery.length;
  return (
    <>
      {text.slice(0, matchAt)}
      <mark className="task-search-highlight">{text.slice(matchAt, matchEnd)}</mark>
      {text.slice(matchEnd)}
    </>
  );
}

/**
 * 空态的模式 tab(日常办公 / 代码开发 / 设计创意)。
 *
 * id 直接取 WorkBuddy 的 mode 键(working / coding / design):首页场景自带 mode,
 * 两边必须是同一套键才能按模式分组。此前这里是我们自己起的 office/code/creative,
 * 对不上任何场景数据,于是那行胶囊只能摆「精选场景」(专家中心大卡)的文案。
 *
 * 这里刻意**不带本地兜底文案**。曾经每个模式写死过 4 条建议,理由是「总比留一行空胶囊好」,
 * 结果运营把某个模式的场景删空之后,那 4 条顶上来,看着像是数据没删干净。
 * WorkBuddy 的 `.wb-home-composer` 是三分支:有数据渲染 QuickActions、加载中给 4 个骨架条、
 * 加载完仍为空就只留一个 `aria-hidden` 的空占位(`--empty`,CSS 只有 height:32px),
 * 一条写死文案都没有。我们的 `.home-chips-scroller` 本身有 `min-height:32px`,
 * 空着时高度不塌,与它那个占位等效。
 */
interface ModeTab {
  id: string;
  label: string;
  /** tab 左侧 16px 图标(WorkBuddy `.wb-scene-tabs__icon`)。 */
  icon: LucideIcon;
}
const MODE_TABS: ModeTab[] = [
  { id: "working", label: "日常办公", icon: Briefcase },
  { id: "coding", label: "代码开发", icon: Code2 },
  { id: "design", label: "设计创意", icon: Palette },
];

/**
 * 场景图标键 → 本地图标。
 *
 * 后端下发的是图标**键**(documentation / financial-services…),不是图片地址。
 * 我们用 lucide 顶上,未命中一律走 Sparkles 兜底:运营新加场景时哪怕忘填 icon,
 * 胶囊也不会缺一块。
 */
const SCENE_ICONS: Record<string, LucideIcon> = {
  documentation: FileText,
  "documentation-tools": FileText,
  "financial-services": Landmark,
  "data-visualization": ChartColumn,
  "tool-case": Wrench,
  "deep-research": Microscope,
  "video-generation": Video,
  "slides-creation": Presentation,
  "product-management": ClipboardList,
  "daily-development": Code2,
  "website-development": Globe,
  "agent-apps": Boxes,
  "skill-development": Wand2,
  "ci-cd": GitBranch,
  web: Globe,
  slide: Presentation,
  phone: Smartphone,
  paint: Palette,
  mouse: MousePointer2,
  rocket: Rocket,
};

/**
 * 场景名 → 本地图标,优先于上面的 icon 键。
 *
 * **这一层才是 WorkBuddy 的做法**:它的 `getSceneIcon(sceneName)` 是
 * `SCENE_ICON_MAP[SCENE_NAME_ALIAS_MAP[name] ?? name] ?? DEFAULT_SCENE_ICON`
 * ——按**场景名**取内联 SVG,每个场景一张,连「PPT 设计 / PPT设计」「Web App / WebApp /
 * Web 应用」这种写法差异都在别名表里抹平,压根没用 icon 字段。
 *
 * 我们原来只按 icon 键映射,design 那批就露馅了:视觉海报、品牌设计、图标&插画三条
 * 在种子数据里共用一个 `mouse` 键,按键映射只能给同一个图标,而它们在 WorkBuddy 里
 * 是三张不同的 SVG。所以补这一层按名字的覆盖,键仍作回落。
 */
const SCENE_NAME_ICONS: Record<string, LucideIcon> = {
  网站设计: AppWindow,
  PPT设计: Presentation,
  视觉海报: ImageIcon,
  移动端App: Smartphone,
  设计系统: Component,
  "Web App": LayoutDashboard,
  品牌设计: Gem,
  "图标&插画": PenTool,
};

/** 场景胶囊的图标:先按名字(对齐 WorkBuddy),再按 icon 键,最后兜底。 */
function sceneIconOf(scene: DesktopScene): LucideIcon {
  return (
    SCENE_NAME_ICONS[scene.name] ?? SCENE_ICONS[scene.icon ?? ""] ?? Sparkles
  );
}

/**
 * 两次拉到的场景列表是不是同一份内容。
 *
 * 照 WorkBuddy `useTemplates` 的 `isTemplatesEqual`:先比条数,再逐条比参与渲染的字段
 * (胶囊显示 name/icon,按 mode 分组,slug 作 key,展开后渲染 prompts)。
 * `prompts` 是服务端下发的 JSON 字符串而不是数组,直接比字符串即可。
 */
function sameScenes(a: DesktopScene[], b: DesktopScene[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((x, i) => {
    const y = b[i];
    return (
      x.slug === y.slug &&
      x.name === y.name &&
      x.mode === y.mode &&
      x.icon === y.icon &&
      x.prompts === y.prompts
    );
  });
}

/**
 * 首拉未回来时那几条骨架的宽度,原样取 WorkBuddy
 * `.wb-home-composer__chips-skeleton:nth-child(n)` 的 120 / 96 / 132 / 64。
 * 宽度不等是故意的 —— 等宽四条看着像加载失败的占位框,长短参差才像一排真胶囊。
 */
const SCENE_SKELETON_WIDTHS = [120, 96, 132, 64];

/**
 * 回到前台重拉首页场景/案例的最小间隔。
 * 窗口来回切时 focus 会连着来,没有节流就是连着几次请求;取 10 秒是因为运营改完数据
 * 切回来最快也要一两秒,这个窗口既压掉抖动又不会让人觉得"没更新"。
 */
const HOME_REFETCH_MIN_INTERVAL_MS = 10_000;

/** 案例区一屏几张卡。照 WorkBuddy `HomeRelatedPlaybooks` 的 `VISIBLE_COUNT = 5`。 */
const PLAYBOOK_VISIBLE_COUNT = 5;

/**
 * 产物预览的缩放档位。**百分比是相对设计稿真实尺寸的**,不是相对预览框——
 * 照 Ardot(WorkBuddy 那 32 条设计类案例嵌的腾讯设计工具)的口径:它显示的 62% / 30% / 15%
 * 就是「1440 宽的稿现在按多大画出来」。100% 才是一比一看原稿。
 */
const PLAYBOOK_ZOOM_STEPS = [0.1, 0.15, 0.25, 0.5, 0.75, 1, 1.5, 2, 3];

/** 画布四周留白。作品是「摆在台面上的一张稿」而不是贴边铺满,与 Ardot 一致。 */
const PLAYBOOK_STAGE_PAD = 16;

/**
 * 平移到边界时至少留在台面里的那一条。
 *
 * 白布的语义就在这个数上:作品能一路拖到快要移出去为止,而不是「装得下就不给拖」。
 * 2026-08-12 按 WorkBuddy 真机截图定的 —— 它那条长网页可以一直往下滑,滑到整稿只剩
 * 底边一条挂在台面顶部。留这一条是防止拖丢了找不回来。
 */
const PLAYBOOK_PAN_KEEP = 80;

/**
 * 看图视角的初值。**默认是标注态**(2026-08-12 按用户要求改的):打开就能 hover 出元素尺寸,
 * 想拖动画布才切到移动。`zoom: 0` 表示「还没手动缩放过,按适应档算」。
 *
 * 这是一条**明知的、与 Ardot 相反的取舍** —— 它打开设计稿默认选中的是手形,我们原来照它做。
 * 代价要认:两个模式互斥(抓手是盖在 iframe 上的一层,它在时产物收不到 mousemove),而滚轮
 * 也只有那一层收得到(跨源 iframe 上的 wheel 父页拿不到),**所以默认态下滚轮平移与
 * ctrl+滚轮缩放都是不响应的**,要拖要滚得先按 H / 点移动。缩放仍可用右下角的缩放器与 +/-/0。
 *
 * 只对有桥的产物生效(模式键与抓手层的渲染条件都带 playbookMeta):上游那批 html 工具页
 * 是要点进去用的,既不盖拖拽面也不开测量。
 */
const PLAYBOOK_VIEW_INIT = {
  zoom: 0,
  x: 0,
  y: 0,
  hand: false,
  measure: true,
};

/** 产物桥上报的设计稿信息(见 admin-server/scripts/inject-playbook-bridge.cjs)。 */
type PlaybookMeta = {
  /** 设计稿宽(px) */
  w: number;
  /** 设计稿高;长页类为 0,高度看 contentH */
  h: number;
  /** contain=定尺作品宽高都要装下;width=长页只按宽缩放、垂直可滚 */
  fit: "contain" | "width";
  /** 多页演示的总页数,单页作品为 1 */
  pages: number;
  /** 内容全高(未缩放),长页类算「整页」档要用 */
  contentH: number;
};

/**
 * 这条案例是不是我们自产的设计稿作品。
 *
 * 判据取 `artifact_url` 指向 Ardot:上游那 32 条设计类案例是 `artifact_type=link` + 一个
 * Ardot 活文档地址,我们照 prompt 自产了 HTML 顶上去,灌库时把类型改成 html、**把来源地址
 * 原样留在 artifact_url**(`import_local_artifacts.go`)。2026-08-12 全量核对:命中恰好 32 条、
 * 全部有自产 key,上游真 html 那批这个字段是空串,零误伤。
 *
 * 为什么不等产物桥上报再判:自动放大必须在打开那一瞬就定,等桥握手(实测 14~52ms)会先
 * 闪一下小窗。桥上报的尺寸信息是另一回事,晚到无所谓。
 */
function isDesignPlaybook(sc: { artifact_url?: string } | null): boolean {
  return !!sc?.artifact_url?.includes("ardot.tencent.com");
}

/**
 * 画布在某一轴上的基准位置:装得下就居中,装不下就贴到起点。
 *
 * 长稿打开先看顶部而不是正中间 —— 首屏才是作品的门面,Ardot 也是这么摆的。
 */
function playbookBase(box: number, stage: number): number {
  return box <= stage - PLAYBOOK_STAGE_PAD * 2
    ? (stage - box) / 2
    : PLAYBOOK_STAGE_PAD;
}

/**
 * 平移边界:作品是摆在白布上的一张稿,拖到只剩 PLAYBOOK_PAN_KEEP 一条为止。
 *
 * **不是「产物比台面小的方向就不给拖」** —— 那条旧规则让适应档下的抓手完全是死的
 * (适应档的画布正好等于台面可用区,两个方向算出来的余量都是 0),而 WorkBuddy 那边
 * 定尺稿一样能拖着挪。
 */
function clampPlaybookPan(
  x: number,
  y: number,
  frameW: number,
  frameH: number,
  stageW: number,
  stageH: number,
): { x: number; y: number } {
  const axis = (v: number, box: number, stage: number): number => {
    const base = playbookBase(box, stage);
    // 画布本身比这条还窄时按它自己的尺寸留,否则小画布会被判成「已经拖出去了」
    const keep = Math.min(PLAYBOOK_PAN_KEEP, box);
    return Math.min(stage - keep - base, Math.max(keep - box - base, v));
  };
  return {
    x: axis(x, frameW, stageW),
    y: axis(y, frameH, stageH),
  };
}

/** 解析后台下发的 JSON 字符串标签数组;脏数据一律当没有,不让详情弹窗崩掉。 */
function parseTagList(raw?: string): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((t): t is string => typeof t === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * 解析场景的二级提示。
 *
 * 后端把它作为 JSON 字符串下发(与 member_slugs / tags 同一口径,见 model.DesktopScene),
 * 运营手填的内容进不了 schema 校验,所以脏数据不能让首屏崩:解析失败、不是数组、
 * 条目缺 prompt 一律当不存在处理。title 缺失时退回 prompt 正文当展示文案。
 */
function parseScenePrompts(scene: DesktopScene | null): DesktopScenePrompt[] {
  if (!scene?.prompts) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(scene.prompts);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((raw) => {
        const item = (raw ?? {}) as Partial<DesktopScenePrompt>;
        const prompt =
          typeof item.prompt === "string" ? item.prompt.trim() : "";
        const title =
          typeof item.title === "string" && item.title.trim() !== ""
            ? item.title.trim()
            : prompt;
        return { title, prompt };
      })
      .filter((p) => p.prompt !== "");
  } catch {
    return [];
  }
}

/**
 * 侧边栏导航项(对齐 WorkBuddy;除「专家」外当前为视觉占位,后续里程碑接入)。
 * 「专家 · 技能 · 连接器」在 WorkBuddy 里是一整条主标签(三者同一个入口),
 * 不是「主标签 + 次级尾注」;只有「更多」才带灰色尾注。
 */
const NAV_ITEMS: {
  id: string;
  icon: LucideIcon;
  label: string;
  tail?: string;
}[] = [
  { id: "assistant", icon: Bot, label: "助理" },
  { id: "project", icon: FolderKanban, label: "项目" },
  { id: "experts", icon: GraduationCap, label: "专家 · 技能 · 连接器" },
  { id: "automation", icon: Workflow, label: "自动化" },
  { id: "more", icon: LayoutGrid, label: "更多", tail: "资料库 · 灵感" },
];

/**
 * 侧栏分组默认只渲染前几条,其余折进「查看更多」。
 * 两个参考实现取的都是 5:WorkBuddy 的 conversation-list 与 cb-sidebar-nav 都是
 * `SHOW_MORE_THRESHOLD = 5`,openclaw 控制台侧栏是 `.slice(0, 5)`。
 */
const SHOW_MORE_THRESHOLD = 5;

/**
 * 行内菜单的宽度,和 `.task-menu` 的 width 保持一致(靠右对齐要用)。
 *
 * 这里**故意没有**对应的高度常量:高度必须渲染后实测,见 openTaskMenu 上方那段。
 */
const TASK_MENU_WIDTH = 172;

/** 吉祥物活动气泡的正文。卡片里只显示两行,全文挂在 title 上。 */
const NOTICE_TEXT =
  "云雾助手抢先体验:本地办公 Agent 全能力开放,一次导入令牌,文档 / 表格 / PPT 全在本机搞定。";

/** 筛选气泡宽度,与 `.task-filter-popover` / WorkBuddy `.wb-popover.task-filter-popover` 一致。 */
const TASK_FILTER_WIDTH = 240;
/** WorkBuddy TaskFilter Popover `offsetDistance: 4`。 */
const TASK_FILTER_GAP = 4;

/**
 * 拼这个任务的会话键:决定它挂哪个内核 agent、身份怎么带。
 *
 * 一律挂内核默认的 `main`,专家身份(含专家团负责人)编进键的第四段,由人设插件按会话注入
 * (见 `@shared/session-key.ts` 与 main/persona-bundle.ts)。这样一个专家在 `agents.list`
 * 里一条都不占 —— 内核冷启动的 provider auth 预热是逐个 agent 扫的,84 个 agent 时实测
 * 预热 49.5 秒,期间事件循环被占满,用户看到的就是「发送要等半分钟」。
 *
 * 专家团的成员也不占条目:负责人**自己 spawn**,成员身份走 `sessions_spawn` 的 `label`,
 * 见 `@shared/team-roster` 的模块头。
 *
 * 任务之间靠会话隔离上下文、靠 `spawnedCwd` 隔离工作目录,两样都不依赖独立 agent。
 */
function taskKeyFor(taskId: string, expert?: InstalledExpert | null): string {
  return expert
    ? taskSessionKey(DEFAULT_TASK_AGENT_ID, taskId, expert.slug)
    : taskSessionKey(DEFAULT_TASK_AGENT_ID, taskId);
}

function newTask(): Task {
  const id = `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  /**
   * 草稿先按通用助手拼键。真正的键在**发送时**才定型 —— 挂哪个 agent 取决于那一刻
   * 有没有选专家,而用户可以在草稿里反复改。见 send() 里重算 sessionKey 的地方。
   */
  return {
    id,
    title: "新对话",
    sessionKey: taskSessionKey(DEFAULT_TASK_AGENT_ID, id),
    messages: [],
    createdAt: Date.now(),
  };
}

/**
 * 恢复完成前的空兜底任务(仅用于渲染占位,不进入持久化)。
 * 避免任务列表加载期间 active 为 undefined 导致主区崩溃。
 */
const EMPTY_TASK: Task = {
  id: "__loading__",
  title: "新对话",
  sessionKey: "agent:__loading__:main",
  messages: [],
  createdAt: 0,
};

/** 任务排序:置顶优先,其次按创建时间倒序(新建在前)。 */
function sortTasks(arr: Task[]): Task[] {
  return [...arr].sort(
    (a, b) =>
      Number(b.pinned ?? false) - Number(a.pinned ?? false) ||
      b.createdAt - a.createdAt,
  );
}

/**
 * 侧栏任务项右侧的相对时间。
 * 形状取自 WorkBuddy 任务卡 `._time_11ei8_231`:只给一个极短的相对量,
 * 超过一周就退回日期,避免「37天前」这种读不出信息的字串把宽度撑开。
 */
function formatTaskTime(ts: number): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}小时前`;
  const day = Math.floor(hour / 24);
  if (day < 7) return `${day}天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 把持久化的任务元数据还原为运行时 Task(消息留空,切换时懒加载历史)。 */
function metaToTask(meta: TaskMeta): Task {
  return {
    id: meta.id,
    title: meta.title,
    sessionKey: meta.sessionKey,
    pinned: meta.pinned,
    createdAt: meta.createdAt,
    messages: [],
    persisted: true,
    expertSlug: meta.expertSlug,
    expertName: meta.expertName,
    expertAvatar: meta.expertAvatar,
  };
}

/** 就地修补任务中最后一条助手消息(流式增量的落点)。 */
function patchLastAssistant(
  task: Task,
  patch: (m: ChatMessage) => ChatMessage,
): Task {
  const messages = [...task.messages];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      messages[i] = patch(messages[i]);
      return { ...task, messages };
    }
  }
  return task;
}

/**
 * 定位事件应落到的助手消息下标(在传入的 messages 副本上就地认领 runId)。
 *  1) 优先匹配相同 runId 的助手消息(本轮后续增量的稳定落点);
 *  2) 否则认领"最后一条待认领(尚未绑定 runId 且仍在流式)的占位",并绑定该 runId;
 *  3) 都没有则返回 -1,表示这是网关重放的历史轮次事件或迟到事件,应忽略,
 *     避免污染当前占位——这是"第二轮先显示上一轮内容再重渲染"问题的根因。
 */
function locateTargetIndex(messages: ChatMessage[], runId?: string): number {
  if (runId) {
    const matched = messages.findIndex(
      (m) => m.role === "assistant" && m.runId === runId,
    );
    if (matched >= 0) {
      return matched;
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant" || !m.streaming) {
      continue;
    }
    // 无 runId 的事件(如 session.message 提取的思考):归属当前流式助手,
    // 即便该占位已认领 runId(思考事件本身不携带 runId,无法按轮次匹配)。
    if (!runId) {
      return i;
    }
    // 有 runId 但占位尚未认领:认领并归属本轮;已认领为其它 runId 的则跳过(视为历史重放)。
    if (!m.runId) {
      messages[i] = { ...m, runId };
      return i;
    }
  }
  return -1;
}

/** 把一个 AgentEvent 应用到任务上(按 runId 精确路由到对应助手消息)。 */
function applyAgentEvent(task: Task, evt: AgentEvent): Task {
  // 成员状态是任务级的,必须在消息路由之前处理:成员可能在负责人两轮回复之间的空档里跑完,
  // 那时没有任何流式占位可挂,落到下面的 locateTargetIndex 会被当成迟到事件丢掉。
  if (evt.kind === "member") {
    return {
      ...task,
      memberRuns: { ...task.memberRuns, [evt.memberKey]: evt.status },
    };
  }
  /**
   * **服务端自己发起的一轮**要先补一条占位,否则整轮事件会被下面当成迟到事件丢掉。
   *
   * 界面的助手消息是用户点发送时本地建的(`{userMsg, placeholder}`),而有两类轮次不是用户
   * 发起的:媒体产物的补投(`main/media-relay.ts`)与成员产出回传(`main/team-relay.ts`)——
   * 它们都走 `chat.send` 唤醒会话,此时上一条助手消息早已收尾,没有任何 streaming 占位可认领。
   * 2026-08-13 真机现形:出图补投之后内核那侧一切正常(抄本里模型已带 `MEDIA:` 路径作答),
   * 而界面上一片空白 —— 事件全被 `locateTargetIndex` 判为历史重放丢掉了。
   *
   * 两条守卫防重放误建:runId 已经在某条消息上(那就是重放,交给下面按 runId 精确路由),
   * 或此刻还有未认领的流式占位(那是用户刚发的这一轮,别插队)。
   */
  if (evt.kind === "lifecycle" && evt.phase === "start" && evt.runId) {
    const known = task.messages.some(
      (m) => m.role === "assistant" && m.runId === evt.runId,
    );
    const claimable = task.messages.some(
      (m) => m.role === "assistant" && m.streaming,
    );
    if (!known && !claimable) {
      const last = task.messages[task.messages.length - 1];
      /**
       * **并进上一条助手气泡,而不是新建一条**(2026-08-14 按用户截图改)。
       *
       * 模型调完 `video_generate` / `image_generate` 就 yield 了,产物回来我们把它唤醒,
       * 它才接着说「视频生成好了,请查收」。那是同一次请求的后半截:新建气泡会让一次请求
       * 显示成两条「已完成」,第一条只剩一个光秃秃的工具名、没有正文。
       *
       * 只在末条就是助手气泡时并入——用户在等待期间又说了话就不能并,那确实是新的一轮。
       * 历史那侧同口径(`main/session-history.ts` 遇到中继信封不收尾上一轮),
       * 两条路径必须一起改,否则刷新前后长得不一样。
       */
      const merged =
        last && last.role === "assistant"
          ? task.messages.map((m, i) =>
              i === task.messages.length - 1
                ? {
                    ...m,
                    runId: evt.runId,
                    streaming: true,
                    // 续写而不是覆盖:内核给的是本轮累计快照,详见 contentBase 的说明。
                    content: m.content ? `${m.content}\n\n` : "",
                    contentBase: m.content ? m.content.length + 2 : 0,
                    // 上一轮的收尾提示到此为止。补投唤醒的那条气泡,上一轮正是「yield 挂起」
                    // 收的尾,不清的话「本轮回复已中断」+「已挂起等待专家回信」会一直挂到
                    // 这一轮结束——用户看到的是「已完成」下面还劝他点重试。
                    aborted: false,
                    yielded: false,
                    userAborted: false,
                    abortReason: undefined,
                    error: undefined,
                    // 新的一轮从第 1 次尝试算起,别把上一轮的重试次数带过来。
                    attempts: 1,
                  }
                : m,
            )
          : [
              ...task.messages,
              { role: "assistant" as const, content: "", streaming: true, runId: evt.runId },
            ];
      return applyAgentEvent({ ...task, messages: merged }, evt);
    }
  }
  const messages = [...task.messages];
  const idx = locateTargetIndex(messages, evt.runId);
  if (idx < 0) {
    // 无匹配轮次、也无待认领占位:历史重放 / 迟到事件,直接忽略以防污染当前占位。
    return task;
  }
  const target = messages[idx];
  switch (evt.kind) {
    case "delta":
      messages[idx] = {
        ...target,
        streaming: true,
        liveStatus: STATUS_REPLYING,
        // 优先用累计快照 text;缺失时回退为增量追加。快照是**本轮**的,所以要接在
        // contentBase(上一轮说完的那段)后面写,不能整条覆盖。
        content:
          evt.text && evt.text.length
            ? target.content.slice(0, target.contentBase ?? 0) + evt.text
            : target.content + evt.deltaText,
      };
      break;
    case "thinking": {
      // 按轮次 id 定位思考段:同轮更新、新轮追加,使思考与工具在时间线上交错。
      const id = evt.messageId ?? "live";
      const timeline = [...(target.timeline ?? [])];
      let tIdx = timeline.findIndex(
        (s) => s.kind === "thinking" && s.id === id,
      );
      // 同一段思考会到达两次:先是实时流(无 messageId → 占位 id 'live'),轮末
      // session.message 再带 messageId 整段重发一次。后者要**认领**前者(改写为真实 id),
      // 否则同一轮会并排出现两个「深度思考」块。下一轮的实时流会重新占用 'live'。
      if (tIdx < 0 && evt.messageId) {
        tIdx = timeline.findIndex(
          (s) => s.kind === "thinking" && s.id === "live",
        );
      }
      const incoming = stripReasoningPlaceholder(evt.thinkingText);
      const delta = stripReasoningPlaceholder(evt.thinkingDelta);
      /**
       * 要新起一段,但上一项也是思考段、而且它之后一个字正文都没有 —— 那不是"又想了一次",
       * 是**内核把这条 prompt 重跑了**:它遇到「只有思考、没有可见回答」的一轮会原样重试
       * (`openclaw/.../run.ts:3746`,上限 2 次)。几次尝试的思考几乎逐字相同,一段段堆着
       * 就是用户报的「一条思考出现两个同样的」。所以顶掉上一段,只把次数记下来。
       *
       * 次数由 lifecycle start 那一侧数(见下面 case "lifecycle"),这里不自己加:
       * 一次尝试里思考帧会到达好几拨(实时流 + 轮末重播 + 重播之后的尾帧),按帧数
       * 数出来的是帧数不是尝试数——真机上 3 次尝试被数成 4 次。
       */
      const attempt = target.attempts ?? 1;
      if (tIdx < 0) {
        const lastIdx = timeline.length - 1;
        const last = timeline[lastIdx];
        if (
          last?.kind === "thinking" &&
          (last.at ?? 0) >= target.content.length
        ) {
          tIdx = lastIdx;
        }
      }
      const found = tIdx >= 0 ? timeline[tIdx] : undefined;
      const prev = found?.kind === "thinking" ? found.text : "";
      // 顶掉上一次尝试时正文要从头来(那是另一次模型输出),不能接在旧文后面。
      const restart =
        found?.kind === "thinking" && attempt > (found.attempt ?? 1);
      const text = evt.replace
        ? incoming || prev
        : incoming.length
          ? incoming
          : restart
            ? delta
            : prev + delta;
      if (text) {
        const attemptNo =
          found?.kind === "thinking" ? Math.max(attempt, found.attempt ?? 1) : attempt;
        if (tIdx >= 0) {
          timeline[tIdx] = {
            kind: "thinking",
            id,
            text,
            at: found?.at,
            ...(attemptNo > 1 ? { attempt: attemptNo } : {}),
          };
        } else {
          timeline.push({
            kind: "thinking",
            id,
            text,
            at: target.content.length,
          });
        }
        messages[idx] = {
          ...target,
          streaming: true,
          liveStatus: "深度思考中",
          timeline,
        };
      }
      break;
    }
    case "final": {
      // 若时间线已按轮拿到思考段,则不再用单块 thinking 兜底(避免与时间线重复)。
      const hasTimelineThinking = (target.timeline ?? []).some(
        (s) => s.kind === "thinking",
      );
      const finalContent =
        evt.text && evt.text.length
          ? target.content.slice(0, target.contentBase ?? 0) + evt.text
          : target.content;
      // 媒体产出物只在轮末聚合,不在 delta 里做:流式的半行 `MEDIA:C:\a\b.pn` 也能骗过
      // 扩展名校验,那样会先落一张指向不存在文件的卡,等真路径到齐又多出一张。
      //
      // 正文解析**不能是唯一来源**:内核广播 chat 之前就把 `MEDIA:` 行剥掉了,实时路径靠
      // 它一张图也拿不到(用户报的「重启客户端才出图」就是这个)。内核把路径另放在
      // `evt.mediaPaths` 里,拼成指令行一起交给同一个解析器,去重与 kind 判定都复用它。
      // 正文那条留着:历史还原读的是模型原话,`MEDIA:` 行还在。
      const mediaDirectives = (evt.mediaPaths ?? [])
        .map((p) => `MEDIA:${p}`)
        .join("\n");
      const mediaAdded = mediaArtifactsFromText(
        mediaDirectives ? `${finalContent}\n${mediaDirectives}` : finalContent,
        target.artifacts ?? [],
      );
      messages[idx] = {
        ...target,
        streaming: false,
        elapsedMs: target.startedAt
          ? Date.now() - target.startedAt
          : target.elapsedMs,
        content: finalContent,
        ...(mediaAdded.length
          ? { artifacts: [...(target.artifacts ?? []), ...mediaAdded] }
          : {}),
        // 兜底:仅当时间线里没有思考段时,用最终消息里提取的思考块补显。
        thinking: hasTimelineThinking
          ? target.thinking
          : target.thinking && target.thinking.length
            ? target.thinking
            : stripReasoningPlaceholder(evt.thinking) || undefined,
      };
      break;
    }
    case "tool": {
      const timeline = [...(target.timeline ?? [])];
      const toolName = (evt.name ?? "").toLowerCase();
      // 工具跑起来 → 显示这一步在做什么;结束(completed / failed)→ 回到"等模型下一段",
      // 因为内核这时正把工具结果发回上游、等下一轮响应,那段空窗才是最长的。
      const liveStatus =
        evt.status === "running" ? toolRunningLabel(toolName) : STATUS_WAITING;

      // 平台 UI 工具 ask_user(server 名 yw → 工具名 yw__ask_user):不渲染成普通步骤条,
      // 其「向用户提问 / 等待用户确认 / 用户回答卡片」由渲染层经 onAsk/onAnswered 驱动的
      // ask 时间线项承载(见 handleAsk/handleAnswered),避免与之重复。
      if (toolName.includes("ask_user")) {
        // 步骤条不渲染,但状态行仍要跟着走:提问期间显示「等待你回复」。
        messages[idx] = { ...target, streaming: true, liveStatus };
        break;
      }

      // show_widget:可视化卡本身即是结果(由 handleWidget 落成 widget 项),
      // 完成后移除步骤条避免与卡片重复——对齐 WorkBuddy 只留「展示详情」卡的观感。
      // present_files 不同:WorkBuddy 会把这一步留在过程里(可展开看交付清单),故走通用分支。
      if (toolName.includes("show_widget")) {
        const i = timeline.findIndex(
          (s) => s.kind === "tool" && s.itemId === evt.itemId,
        );
        if (evt.status === "completed") {
          if (i >= 0) {
            timeline.splice(i, 1);
          }
        } else {
          const item: TimelineItem = {
            kind: "tool",
            itemId: evt.itemId,
            name: toolName,
            title: "展示详情",
            status: evt.status,
            at: target.content.length,
          };
          if (i >= 0) {
            timeline[i] = { ...item, at: timeline[i].at };
          } else {
            timeline.push(item);
          }
        }
        messages[idx] = { ...target, streaming: true, liveStatus, timeline };
        break;
      }

      // update_plan → 可勾选待办清单:同轮内持续替换为最新一份(单张演进卡片)。
      if (PLAN_TOOL_NAMES.has(toolName)) {
        const steps = parsePlanSteps(evt.input);
        if (steps.length > 0) {
          // 入参延后到达时,之前可能已用同 itemId 落了一条普通步骤条(见下方兜底),
          // 落卡片前先把它清掉,避免「更新任务清单」孤行与勾选卡并存。
          const gIdx = timeline.findIndex(
            (s) => s.kind === "tool" && s.itemId === evt.itemId,
          );
          if (gIdx >= 0) {
            timeline.splice(gIdx, 1);
          }
          const pIdx = timeline.findIndex((s) => s.kind === "plan");
          if (pIdx >= 0) {
            timeline[pIdx] = {
              kind: "plan",
              itemId: evt.itemId,
              steps,
              at: timeline[pIdx].at,
            };
          } else {
            timeline.push({
              kind: "plan",
              itemId: evt.itemId,
              steps,
              at: target.content.length,
            });
          }
          messages[idx] = { ...target, streaming: true, liveStatus, timeline };
          break;
        }
        // 入参尚未到达(原生工具入参可能延后/流式下发)→ 只推进状态行,绝不落普通步骤条:
        // 否则会出现无意义的「更新任务清单」孤行(用户看到的正是这个)。待入参到达的
        // 后续事件再落成勾选卡;若本轮实时始终拿不到,重开历史也能由 arguments 完整还原。
        messages[idx] = { ...target, streaming: true, liveStatus, timeline };
        break;
      }

      // 产出路径:优先从入参取;write 有时不带 path 键,则从标题/结果文本
      // (「Successfully wrote N bytes to <path>」)兜底提取。
      //
      // 两条兜底**只给产出物类工具**:它们认路径的办法是「标题里找一段像文件名的」,
      // 而这条正则(`([\w.\-/\\]+\.[A-Za-z0-9]+)`)在命令标题上会咬到别的东西——
      // 真机撞见 `1..80 | ForEach-Object {…}` 里的 `1..80` 被当成路径,于是那条步骤行
      // 被切成「执行命令」+「1..80」,管道后面的命令**整段不见了**(2026-08-17)。
      const artifactTool = ARTIFACT_TOOL_NAMES.has(toolName);
      const stepPath = artifactTool
        ? parseArtifactPath(evt.input, evt.title) ||
          parseWrittenPath(evt.result ?? "")
        : parseArtifactPath(evt.input);

      // write/edit/apply_patch → 聚合产出物(去重);仍保留步骤条以显示动作。
      // 工作空间数据目录(项目记忆日志)不算交付物,见 @shared/workspace-data。
      let artifacts = target.artifacts;
      if (
        artifactTool &&
        evt.status === "completed" &&
        stepPath &&
        !isWorkspaceDataPath(stepPath)
      ) {
        const list = [...(target.artifacts ?? [])];
        if (!list.some((a) => a.path === stepPath)) {
          list.push({ path: stepPath, name: baseName(stepPath) });
          artifacts = list;
        }
      }

      // 步骤行的富信息与历史还原走同一套算法(@shared/tool-step),
      // 保证同一次运行"跑的时候"和"重开之后"显示一致。
      // edit 的改动明细在内核 details.diff 里(带行号),行数也按它数才准;
      // 拿不到(write / 旧数据)才退回从入参推算。
      const stats =
        (evt.diff ? diffStatsFromDiff(evt.diff) : undefined) ??
        diffStatsFromResult(toolName, evt.input, evt.result ?? "");
      // 入参型预览(write/edit 正文)拿不到时,回退到结果型预览(命令 stdout)。
      // 有 diff 时不要入参预览:那是「新内容片段」,diff 是「改了哪几行」,后者信息更全。
      const preview = evt.diff
        ? ""
        : stepPreview(toolName, evt.input) ||
          resultPreview(toolName, evt.result ?? "");
      const sIdx = timeline.findIndex(
        (s) => s.kind === "tool" && s.itemId === evt.itemId,
      );
      const item: TimelineItem = {
        kind: "tool",
        itemId: evt.itemId,
        name: toolName,
        title: evt.title,
        status: evt.status,
        at: target.content.length,
        ...(stepPath ? { path: stepPath } : {}),
        ...(stats ? { stats } : {}),
        ...(preview ? { preview } : {}),
        ...(evt.exec ? { exec: evt.exec } : {}),
        ...(evt.diff ? { diff: evt.diff } : {}),
      };
      if (sIdx >= 0) {
        timeline[sIdx] = { ...item, at: timeline[sIdx].at };
      } else {
        timeline.push(item);
      }
      messages[idx] = {
        ...target,
        streaming: true,
        liveStatus,
        timeline,
        artifacts,
      };
      break;
    }
    case "lifecycle":
      // 本轮的**终态有两个**:`end` 是正常收束,`error` 是内核判定失败(上游 503、
      // fallback 链耗尽等)。只认 end 的话,失败轮永远停在上一条状态("正在收尾")转圈,
      // 用户既等不到结果、也看不到原因——实测上游 503 时正是如此。
      if (evt.phase === "end" || evt.phase === "error") {
        // 主动让出:内核给的 stopReason 同样是 aborted、还会合成一句 `agent run aborted`,
        // 只认 aborted 会把「等专家回信」误报成「运行被中止」。内核自身也是先判 yielded
        // 再决定要不要当错误处理的,这里对齐。
        if (evt.yielded === true) {
          messages[idx] = { ...target, streaming: false, yielded: true };
        } else {
          const reason = evt.errorMessage
            ? humanizeAbortReason(evt.errorMessage)
            : undefined;
          const aborted = target.aborted || evt.aborted === true;
          // 失败(非用户中止)走 error 字段:红色错误条,与"回复已中断"的语义区分开。
          const failed = evt.phase === "error" && !aborted;
          messages[idx] = {
            ...target,
            streaming: false,
            aborted,
            ...(reason
              ? failed
                ? { error: reason }
                : { abortReason: reason }
              : failed
                ? { error: "本轮运行失败,请重试" }
                : {}),
          };
        }
      } else if (evt.phase === "start") {
        /**
         * 上一段就是思考、而且它之后没有正文 → 这个 start 是**内核在重跑同一条 prompt**
         * (reasoning-only 重试),不是新的一轮。真正的尝试边界只在这里能看准:
         * 思考帧一次尝试要来好几拨,数帧数会多数出一次。
         */
        const last = target.timeline?.[(target.timeline?.length ?? 0) - 1];
        const retrying =
          last?.kind === "thinking" && (last.at ?? 0) >= target.content.length;
        // 刚开跑,模型还没吐任何东西:这段等待要如实说出来,不能显示"生成回复中"。
        messages[idx] = {
          ...target,
          streaming: true,
          liveStatus: STATUS_WAITING,
          ...(retrying ? { attempts: (target.attempts ?? 1) + 1 } : {}),
        };
      } else if (evt.phase === "finishing") {
        messages[idx] = { ...target, streaming: true, liveStatus: "正在收尾" };
      }
      // 其余阶段不改内容;messages 可能已因认领而更新 runId,一并返回保存。
      break;
    default:
      break;
  }
  return { ...task, messages };
}

/**
 * 工作台:chat-first 布局(高保真对齐 WorkBuddy)。
 *  - 进入即自动后台启动网关,用户无感;状态收敛到左下角账户区。
 *  - 左侧:品牌 + 导航 + 任务/空间分区 + 底部账户。
 *  - 主区:圆角浮层卡片,顶栏操作图标 + 对话 + 富输入框 + 免责声明。
 */
export default function Workspace({
  activation,
  onSignOut,
  onRelogin,
  onOpenFeedback,
}: Props) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  /** 是否处于「新建任务」草稿态(未发送前不在侧栏任务列表中显示)。 */
  const [composingNew, setComposingNew] = useState<boolean>(false);
  /** 草稿任务对象(仅 composingNew 时使用,首条消息发送后写入 tasks)。 */
  const [draftTask, setDraftTask] = useState<Task | null>(null);
  /** 任务列表是否仍在从磁盘/内核恢复(启动首屏用于显示"恢复中"而非占位空任务)。 */
  const [restoring, setRestoring] = useState<boolean>(true);
  const [status, setStatus] = useState<GatewayStatus>({
    running: false,
    port: 18789,
  });
  const [preflight, setPreflight] = useState<PreflightReport | null>(null);
  const [permission, setPermission] = useState<PermissionMode>("default");
  const [mode, setMode] = useState<ChatMode>("craft");
  // 会话级模型:内核完整键 `<provider>/<model>`;默认取账户默认模型(primary)。
  const [selectedModel, setSelectedModel] = useState<string>(
    `yunwu/${activation.defaultModel}`,
  );
  // 可选对话模型(来自模型管理配置,含推理标记),驱动 Composer 模型选择器。
  const [chatOptions, setChatOptions] = useState<ChatModelOption[]>([]);
  // 设置外壳:非空时打开,值为初始定位的页签(账户/模型/系统…)。
  const [settingsInitial, setSettingsInitial] = useState<PageId | null>(null);
  // 思考偏好按模型存:WorkBuddy 的开关与档位都挂在每个模型自己的卡片上,改未选中的模型
  // 只写它的偏好、不切模型(`onEffortPreferenceChange(id, effort)`)。缺省项的默认值
  // 由 `thinkingOnOf` / `thinkingLevelOf` 按该模型的能力声明推出来。
  const [thinkPrefs, setThinkPrefs] = useState<Record<string, ModelThinkPref>>(
    {},
  );
  const handleThinkPrefChange = useCallback(
    (modelKey: string, patch: ModelThinkPref) => {
      setThinkPrefs((prev) => ({
        ...prev,
        [modelKey]: { ...prev[modelKey], ...patch },
      }));
    },
    [],
  );
  // 本地已安装专家(驱动 Composer 专家选择器)。
  const [experts, setExperts] = useState<InstalledExpert[]>([]);
  /**
   * 在跑的媒体后台任务,按 sessionKey 一条(同时最多一条:内核 duplicateGuard 按工具+provider 锁)。
   * 只有等待期用得上,终态即由生产者撤走,详见下面订阅处的注释。
   */
  const [mediaTasks, setMediaTasks] = useState<Map<string, MediaTaskProgress>>(
    new Map(),
  );
  /**
   * 服务端首页场景(驱动输入框上方那行胶囊,按 mode 分组)。
   *
   * `null` 专门表示**一次都还没拉过**,骨架条只认这一个状态;拉完(无论成功、空结果还是
   * 失败)一律至少落成 `[]`。
   *
   * 起初是另开一个 `scenesLoading` 布尔,那就有两个状态要保持同步,而它们真的错开过:
   * dev 下 react-refresh 保留了旧 hooks 状态,挂载 effect 不再重跑,窗口 focus 监听里绑的
   * 还是改动前的闭包(那一版不碰 `scenesLoading`)—— 于是请求一直在发、骨架一直在扫。
   * 「有没有拉过」本来就是这份数据自己的属性,不该由第二个状态复述一遍。
   */
  const [serverScenes, setServerScenes] = useState<DesktopScene[] | null>(null);
  /**
   * 上次拉首页场景/案例的时刻,给回到前台的重拉做节流。
   * 初值取挂载时刻,免得首屏那次加载之后紧接着的一个 focus 事件又拉一遍。
   */
  const lastHomeFetchRef = useRef(Date.now());
  /** 当前展开的场景 slug:选中后一级胶囊行换成该场景的提示标题二级行。 */
  const [activeSceneSlug, setActiveSceneSlug] = useState<string | null>(null);
  /**
   * 补图方式(设计创意 tab 的输入框芯片)。放在这一层而不是 Composer 内部,是照
   * WorkBuddy 把 `userImageModeChoice` 放在 main-content 层:它将来要跟着提交一起走,
   * 状态先放对位置,接功能时不用搬家。
   *
   * 默认 `ai` 取自它的 `getDefaultImageModeForScene(null)`,源码注释写着「2026-07 稿产品
   * 要求:主推 AI 生图能力,用户可改」。它选中场景后还会按场景改默认值、甚至锁死不让切
   * (视觉海报强依赖生图),那套判定依赖它写死的场景 id(32/36/37)与 ardot 技能映射,
   * 我们没有对应数据,所以只做「换场景退回默认」这一条。
   */
  const [imageMode, setImageMode] = useState<ImageMode>("ai");
  /** 已选设计风格(同上,对应 WorkBuddy 的 `selectedDesignStyle`)。 */
  const [designStyle, setDesignStyle] = useState<DesignStyle | null>(null);
  // 服务端精选场景(驱动输入框下方那行案例大卡;按 scene_slug 归到某个首页场景下)。
  const [serverScenarios, setServerScenarios] = useState<DesktopScenario[]>([]);
  /** 案例区「换一批」的起始下标:照 WorkBuddy 的 batchStart,环形取 5 条。 */
  const [playbookBatchStart, setPlaybookBatchStart] = useState(0);
  /** 打开中的案例详情(点大卡打开;null 为关闭)。 */
  const [activePlaybook, setActivePlaybook] = useState<DesktopScenario | null>(
    null,
  );
  /**
   * 案例产物的预览直链。每次打开弹窗现换一条 —— 服务端存的是对象存储 key,签出来的 URL
   * 默认 24 小时过期,而过期不报错,iframe 只会白着。
   */
  const [playbookArtifact, setPlaybookArtifact] = useState<{
    phase: "loading" | "ready" | "error";
    url?: string;
  } | null>(null);
  /** 预览放大态(照 WorkBuddy 的 `.dc-detail-page.is-enlarged`:640×644 → 960×720)。 */
  const [playbookEnlarged, setPlaybookEnlarged] = useState(false);
  /**
   * 看图视角:缩放比例(相对设计稿)+ 平移偏移 + 抓手 + 测量开关。
   *
   * WorkBuddy 那套查看器界面(缩放百分比、抓手、演示图层、元素尺寸绿标)**不是它自己写的**,
   * 是它 iframe 里嵌的腾讯 Ardot 页面自带的 —— 三次解包搜证:「演示图层」「创意引擎已启动」
   * 在它 1079 个 renderer 文件里一条都搜不到,而同屏的「一键做同款」搜得到;它自己那侧唯一与
   * 缩放有关的代码是一段注释,说 wasm 端 `window_operator.cc::setWindowSize` 已经内建了
   * zoom + 平移补偿,它再叠一层会打架,所以只发一条 fit 指令。
   *
   * 所以界面抄不过来,但能力不依赖 Ardot:产物 iframe 在我们自己手里,而且产物是我们自产的,
   * 可以让它自己带一座桥(`inject-playbook-bridge.cjs`)——设计稿尺寸、页数、hover 元素矩形
   * 都由产物 postMessage 报上来,外壳只管画。这与 Ardot 那侧的分工是同一个形状。
   *
   * 缩放靠**改 iframe 的像素尺寸**,不是给它套 `transform: scale()`:我们的产物都是「固定设计
   * 画布 + fit 脚本」,iframe 一变尺寸它就自己按新视口重算 `--s`,得到的是矢量重绘;transform
   * 那条路是把已渲染的画面拉大。原型实测精确相符(整页档 iframe 274 宽时产物自报 0.199,
   * 与 274/1440 一致)。注意 fit 是**下一帧**才生效,量的时候要等一帧。
   */
  const [playbookView, setPlaybookView] = useState<{
    zoom: number;
    x: number;
    y: number;
    hand: boolean;
    measure: boolean;
  }>(PLAYBOOK_VIEW_INIT);
  /**
   * 缩放档位菜单开着没有。照 WorkBuddy:它右下角那颗百分比是可以点开的,
   * 里面是「缩放以适合 / 缩放至 50%·100%·200%」加一个能直接输数字的框。
   */
  const [playbookZoomMenu, setPlaybookZoomMenu] = useState(false);
  /** 产物桥报上来的设计稿信息;没有桥(上游那批 html 工具页)就一直是 null。 */
  const [playbookMeta, setPlaybookMeta] = useState<PlaybookMeta | null>(null);
  /** 桥报的当前页与 hover 测量框,都只在有桥时才有值。 */
  const [playbookPage, setPlaybookPage] = useState(1);
  const [playbookMeasure, setPlaybookMeasure] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
    label: string;
  } | null>(null);
  const playbookStageRef = useRef<HTMLDivElement>(null);
  const playbookFrameRef = useRef<HTMLIFrameElement>(null);
  /**
   * 台面尺寸。必须进 state 而不是渲染时读 ref:两态切换靠的是 CSS 类,尺寸要等这一帧
   * 布局完才变,渲染函数里读到的还是旧值 —— 从小窗切到放大会拿 588 去算 958 台面的适应比例。
   */
  const [playbookStageSize, setPlaybookStageSize] = useState({ w: 0, h: 0 });
  // Composer 外部预填信号(点击场景卡时触发):seq 递增即回填 text。
  const [composerPrefill, setComposerPrefill] = useState<{
    text: string;
    seq: number;
  }>({
    text: "",
    seq: 0,
  });
  // 新会话草稿绑定的专家 slug(仅新建态生效;发送后定型到该任务)。
  const [selectedExpertSlug, setSelectedExpertSlug] = useState<string | null>(
    null,
  );
  // Composer 已选技能芯片(对齐 WorkBuddy「创建技能」→ 输入框挂 skill-creator 芯片)。
  const [composerSkill, setComposerSkill] = useState<{
    slug: string;
    name: string;
  } | null>(null);
  /**
   * 新建任务草稿选定的工作空间(null = 不使用,落到一次性受管目录)。
   *
   * 只服务草稿:发送后工作空间随会话在主进程落成绑定,之后由任务 id 决定,
   * 这里就该清空,免得下一个新任务默认还带着上一个的工作空间(那不是用户选的)。
   */
  const [draftWorkspace, setDraftWorkspace] = useState<WorkspaceEntry | null>(
    null,
  );
  // 产出物预览面板(点击产出物卡片时打开;对标 WorkBuddy present_files 右侧预览)。
  const [artifactPreview, setArtifactPreview] = useState<{
    loading: boolean;
    name: string;
    path: string;
    abs?: string;
    content: string;
    /** 图片字节;有值即走图片分支(主进程只对图片扩展名返回它)。 */
    imageBase64?: string;
    previewable: boolean;
    truncated: boolean;
    error?: string;
  } | null>(null);
  /** 预览面板 DOM 引用:用于判定「点击是否落在面板之外」。 */
  const artifactPreviewRef = useRef<HTMLElement | null>(null);
  /** 产出物文件大小(路径 → 字节),用于卡片副标题;由 statArtifacts 批量填充。 */
  const [artifactSizes, setArtifactSizes] = useState<Record<string, number>>(
    {},
  );

  /**
   * 点击面板外部即收起预览(对齐 WorkBuddy 的抽屉行为)。
   *
   * 用 mousedown 而非 click:点击外部时应立即收起,不必等鼠标抬起。
   * 需要放行的是「会打开/切换预览的入口」——产出物卡片与「查看全部」按钮:
   * 它们的 mousedown 先于自身 click 触发,不放行就会出现「先关闭再打开」的闪烁。
   * 面板内部的标签页天然被 contains() 放行,无需单独列出。
   */
  useEffect(() => {
    if (!artifactPreview) {
      return;
    }
    const onPointerDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null;
      if (!target) {
        return;
      }
      if (artifactPreviewRef.current?.contains(target)) {
        return;
      }
      if (target.closest(".artifact-card, .artifact-all")) {
        return;
      }
      setArtifactPreview(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [artifactPreview]);
  /**
   * 各任务的输入框草稿(任务 id → 正文)。
   * 放在这里而不是 Composer 内部:Composer 全局只挂载一份,状态留在它内部会跨任务串味。
   */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // 专家/技能/连接器画廊是否打开(主窗口一等入口,搬出设置)。
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  /**
   * 账户余额快照(账户菜单里那一行)。null = 还没取过。
   *
   * 取数时机照 WorkBuddy:它的 UserMenu 只在**菜单打开**时拉一次
   * (effect 依赖里就有 `userMenu.isOpen`,进去先 `setCreditsFetchStatus("loading")`),
   * 平时不轮询。我们多一层主进程 30 秒节流,原因是 React 严格模式下 effect 会跑两遍、
   * 用户连着开合也会连着触发;余额在 30 秒内不会变到需要区分的程度。
   */
  const [accountSnap, setAccountSnap] = useState<AccountSnapshot | null>(null);
  /** 正在取余额(菜单里显示「获取中」;有旧值时旧值继续显示,不闪)。 */
  const [accountFetching, setAccountFetching] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(getStoredTheme());
  const [taskOpen, setTaskOpen] = useState(true);
  const [spaceOpen, setSpaceOpen] = useState(true);
  /**
   * 侧栏收起。桌面端收起后整条侧栏不渲染,而不是留一条图标 rail ——
   * WorkBuddy 的 conversation-list 就是 `if (collapsed) return isLocalMode ? [] : <48px rail>`,
   * rail 只给 IDE 插件形态用。状态不落盘,参考实现同样只放在内存里。
   */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  /** 空间下的条目本身也可展开(WorkBuddy 的空间项挂二级列表);当前为占位。 */
  const [spaceItemOpen, setSpaceItemOpen] = useState(false);
  /** 空态当前选中的模式 tab(working / coding / design),决定胶囊行展示哪一组场景。 */
  const [sceneMode, setSceneMode] = useState<string>(MODE_TABS[0].id);
  /**
   * 各模式 tab 的输入框正文(mode → 正文)。三个 tab 是三个独立起点,内容不该互相串。
   *
   * 形状照 WorkBuddy 的 `switchModeWithInputHistory`(它自己的注释:「切换 mode 时统一
   * 保存/恢复输入框内容……所有 mode 切换入口均应调用此函数,避免多处重复实现导致漏改」):
   * 一个 Map 型 ref,切换时先把 fromMode 的当前值存进去,再取 toMode 的历史顶上。
   * 用 ref 而非 state —— 它只在切换那一刻读写,不参与渲染;也不落盘,参考实现同样只在内存里。
   */
  const modeDraftsRef = useRef<Map<string, string>>(new Map());
  /** 吉祥物活动通知气泡是否展开(用户可关闭)。 */
  const [noticeOpen, setNoticeOpen] = useState(true);
  /**
   * 行内「更多」菜单。侧栏任务区现在是滚动容器,菜单若仍用 absolute 定位会被滚动区裁掉,
   * 故改为 fixed + 触发按钮的视口坐标。
   */
  /**
   * 行内菜单只记「锚在谁身上」,不记算好的坐标 —— 坐标要等菜单渲染出来量到真高度才算得准。
   * anchor 存的是触发按钮的视口矩形(菜单是 position:fixed,视口坐标即最终坐标)。
   */
  const [taskMenu, setTaskMenu] = useState<{
    id: string;
    anchor: { top: number; bottom: number; right: number };
  } | null>(null);
  const taskMenuRef = useRef<HTMLDivElement>(null);
  /** 实测定位结果;null 表示还没量,此时菜单先不可见,免得在错位置上闪一帧。 */
  const [taskMenuPos, setTaskMenuPos] = useState<{
    top: number;
    left: number;
  } | null>(null);
  /** 任务分组是否已展开全部(「查看更多」/「收起」)。 */
  const [tasksShowAll, setTasksShowAll] = useState(false);
  /** 侧栏头部放大镜打开的任务搜索模态框。 */
  const [picker, setPicker] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  /**
   * 侧栏任务筛选(漏斗图标)。选项与单选行为照 WorkBuddy TaskFilterMenu;
   * 只活在本次进程,不写盘 —— 它那边是 URL query,我们没有这条路由。
   */
  const [taskFilter, setTaskFilter] = useState<TaskFilterValues>(EMPTY_TASK_FILTER);
  const [filterMenu, setFilterMenu] = useState<{
    anchorTop: number;
    anchorLeft: number;
  } | null>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const [filterPos, setFilterPos] = useState<{ top: number; left: number } | null>(
    null,
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  /**
   * 批量操作态。照 WorkBuddy `useBatchOperations`:选择态「动作中立」,
   * 进入时按「能不能操作」判定,点删除/归档时再按该动作过滤一次。
   */
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  /** 正在执行的动作(执行期间禁掉勾选、退出与 ESC),null 表示空闲。 */
  const [operatingAction, setOperatingAction] = useState<BatchAction | null>(
    null,
  );
  /** 二次确认框:记动作与首次计算出的目标数(标题要用)。 */
  const [batchConfirm, setBatchConfirm] = useState<{
    action: BatchAction;
    count: number;
  } | null>(null);
  /** 执行进度,对位它的 `batch.confirm.progress`;null 表示还没开跑。 */
  const [batchProgress, setBatchProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  /** 没有可执行目标时把确认框文案换掉(它的 `batch.confirm.emptyError`),而不是静默关闭。 */
  const [batchEmptyError, setBatchEmptyError] = useState(false);
  const [batchToast, setBatchToast] = useState<string | null>(null);
  /** 正在懒加载历史的任务 id 集合;用于加载态渲染,避免切换瞬间闪现「新建任务」欢迎页。 */
  const [historyLoadingIds, setHistoryLoadingIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  /** 会话就位是否慢到需要盖「正在准备执行」浮层(见 handleSend 里的 PREPARING_DELAY_MS)。 */
  const [preparing, setPreparing] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  /** 最新 tasks 快照(供事件回调读取,避免闭包过期)。 */
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  /** 上一次网关运行态,用于识别"断线→重连"的上升沿。 */
  const prevRunningRef = useRef(false);
  /** 已懒加载过历史的任务 id 集合,避免重复拉取。 */
  const loadedHistoryRef = useRef(new Set<string>());
  /** 上次已持久化的任务元数据签名,用于跳过流式期间无意义的重复写盘。 */
  const lastSavedSigRef = useRef("");

  const active =
    composingNew && draftTask
      ? draftTask
      : (tasks.find((t) => t.id === activeId) ?? tasks[0] ?? EMPTY_TASK);

  /** 当前会话 key(供 []-依赖的事件订阅内判断是否为当前会话,规避闭包读到旧值)。 */
  const activeSessionKeyRef = useRef("");
  activeSessionKeyRef.current = active.sessionKey;

  /**
   * 当前会话正在等的媒体产物(没有则 undefined)。
   * 不用另起计时器刷"已用 N 秒":生产者每 2 秒推一次进度,这个 Map 换一次身份就重渲染一次。
   */
  const mediaWaiting = active.sessionKey
    ? mediaTasks.get(active.sessionKey)
    : undefined;

  const filterActive = hasActiveTaskFilter(taskFilter);
  const operating = operatingAction !== null;
  /** 筛完的任务;侧栏列表与计数都走这份,搜索气泡仍看全量(那是「找任意一条」)。 */
  const filteredTasks = useMemo(
    () => tasks.filter((t) => matchesTaskFilter(t, taskFilter)),
    [tasks, taskFilter],
  );

  /**
   * 侧栏实际渲染的任务:折叠时只给前 SHOW_MORE_THRESHOLD 条。
   *
   * 批量态一律铺开。它的 `batchVisibleConversations` 取的是筛选后的**全量**块(不受
   * 「查看更多」影响),全选自然覆盖全部;我们若还折着,就会出现「全选(24) 但只看得见 5 行」
   * ——选了什么、要删什么全都看不见。铺开之后可见集与选择集才是同一份。
   */
  const visibleTasks =
    batchMode || tasksShowAll
      ? filteredTasks
      : filteredTasks.slice(0, SHOW_MORE_THRESHOLD);

  /** 「全部任务」面板的搜索结果。 */
  const pickerResults = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    return q ? tasks.filter((t) => t.title.toLowerCase().includes(q)) : tasks;
  }, [tasks, pickerQuery]);

  /** 打开行内菜单:只记锚点,真正的坐标交给下面那个 useLayoutEffect 量完再算。 */
  function openTaskMenu(id: string, trigger: HTMLElement): void {
    const r = trigger.getBoundingClientRect();
    setTaskMenu({
      id,
      anchor: { top: r.top, bottom: r.bottom, right: r.right },
    });
    setTaskMenuPos(null);
  }

  /**
   * 菜单定位:先渲染(不可见)、量到真实高度、再决定朝下还是朝上翻。
   *
   * **不要退回写死一个高度常量。** 那样翻转后的位置必然偏:估大了菜单往上飘、和触发按钮
   * 之间空出一截,看着就像锚在上一个任务上;估小了则会盖住按钮。这个 bug 犯过两次 ——
   * 之前的 `TASK_MENU_HEIGHT = 226`,而拿这份 CSS 实测出来的高度是 188px,多估 38px,
   * 比一整行任务还高,于是点最后一条任务时菜单直接飘到上一条上面去了。
   * 菜单项一增减、字号一改,任何写死的数都会重新过期,所以只能实测。
   *
   * 用 `visibility: hidden` 而不是 `display: none` 占位:前者仍参与布局,量到的
   * `offsetHeight` 就是 188;后者恒为 0,量了等于没量。
   *
   * 形状取 WorkBuddy:它的浮层走 `@floating-ui/react-dom`(打包产物里有独立
   * chunk),flip 中间件同样是拿浮层的真实尺寸去判断放不放得下,不是估算。
   * 我们只有两个浮层,没必要为此引一整个库,但"先量后放"这一步必须一样。
   */
  useLayoutEffect(() => {
    if (!taskMenu) {
      return;
    }
    const el = taskMenuRef.current;
    if (!el) {
      return;
    }
    const height = el.offsetHeight;
    const {
      top: anchorTop,
      bottom: anchorBottom,
      right: anchorRight,
    } = taskMenu.anchor;
    const below = anchorBottom + 6;
    // 下面放不下就朝上开,让菜单底边贴住按钮上沿(同样留 6px)。
    const flip = below + height > window.innerHeight - 8;
    setTaskMenuPos({
      top: flip ? Math.max(8, anchorTop - 6 - height) : below,
      left: Math.max(8, anchorRight - TASK_MENU_WIDTH),
    });
  }, [taskMenu]);

  /** WorkBuddy 当前版本的任务搜索是居中 Modal，不再锚定侧栏按钮。 */
  function openTaskPicker(): void {
    setFilterMenu(null);
    setTaskMenu(null);
    setPickerQuery("");
    setPicker(true);
  }

  /**
   * 打开任务筛选。placement 取 WorkBuddy 的 bottom-start + offset 4:
   * 气泡贴触发按钮下沿、左对齐,超出视口再翻到上方 / 往左收。
   */
  function openTaskFilter(trigger: HTMLElement): void {
    const r = trigger.getBoundingClientRect();
    setPicker(false);
    setTaskMenu(null);
    setFilterMenu({ anchorTop: r.bottom, anchorLeft: r.left });
    setFilterPos(null);
  }

  useLayoutEffect(() => {
    if (!filterMenu) {
      return;
    }
    const el = filterRef.current;
    if (!el) {
      return;
    }
    const height = el.offsetHeight;
    const below = filterMenu.anchorTop + TASK_FILTER_GAP;
    const flip = below + height > window.innerHeight - 8;
    setFilterPos({
      top: flip
        ? Math.max(8, filterMenu.anchorTop - height - TASK_FILTER_GAP)
        : below,
      left: Math.min(
        Math.max(8, filterMenu.anchorLeft),
        window.innerWidth - TASK_FILTER_WIDTH - 8,
      ),
    });
  }, [filterMenu]);

  useEffect(() => {
    if (!picker && !filterMenu) {
      return;
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        setPicker(false);
        setFilterMenu(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picker, filterMenu]);

  /**
   * 批量态按 ESC 退出。照它的 `useExitBatchOnEscape`:执行中不响应(免得误中断),
   * `defaultPrevented` 守卫让「关确认框」那一下不顺带把批量态也退了。
   */
  useEffect(() => {
    if (!batchMode) {
      return;
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.defaultPrevented || operating) {
        return;
      }
      exitBatchMode();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [batchMode, operating]);

  useEffect(() => {
    if (batchToast == null) {
      return;
    }
    const timer = window.setTimeout(() => setBatchToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [batchToast]);

  /**
   * 取一次余额。force=true 是用户点了刷新(绕过主进程的节流窗口)。
   *
   * cancelled 守卫照 WorkBuddy 的同一处 effect:菜单可能在请求回来之前就关了,
   * 那时再 setState 只会让下次打开闪一下旧状态。
   */
  const loadAccount = useCallback(
    async (force: boolean, alive: () => boolean = () => true): Promise<void> => {
      setAccountFetching(true);
      try {
        const res = await window.api.accountSnapshot(force);
        if (!alive()) {
          return;
        }
        setAccountSnap(
          res.ok && res.data
            ? res.data
            : { status: "unavailable", balance: null, message: res.error },
        );
      } catch (err) {
        // invoke 本身抛(主进程没起来 / 通道不在)也要落到「获取失败」这一档,
        // 否则余额那一格会永远停在「获取中」。
        if (alive()) {
          setAccountSnap({
            status: "unavailable",
            balance: null,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        if (alive()) {
          setAccountFetching(false);
        }
      }
    },
    [],
  );

  /**
   * 挂载时先预取一次,让用户点头像之前手里已经有数。
   *
   * WorkBuddy 不需要这一步:它的 account 对象在登录时就带 usageLeft,所以 UserMenu 的
   * creditsFetchStatus 初值直接是 success。我们的余额来自单独的 /api/user/self,
   * 光靠开菜单那一下,第一次点必然闪一次「获取中」——刚登录进工作台这条路尤其明显,
   * 它不经过 App 启动时那次预取,主进程缓存是凉的。
   * 这一次通常命中主进程的节流窗口(启动预取刚放进去),不额外打后端;真打也在点击之前打完。
   */
  useEffect(() => {
    let cancelled = false;
    void loadAccount(false, () => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadAccount]);

  // 菜单打开时再取一次(WorkBuddy 的 UserMenu 就是这个时机,平时不轮询)。
  useEffect(() => {
    if (!accountOpen) {
      return;
    }
    let cancelled = false;
    void loadAccount(false, () => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [accountOpen, loadAccount]);

  /** 当前任务的输入框草稿。 */
  const draftText = drafts[active.id] ?? "";

  /** 写当前任务的草稿。支持函数式更新(菜单里插入 `/技能` 需要读旧值)。 */
  function setDraftText(value: string | ((prev: string) => string)): void {
    const id = active.id;
    setDrafts((d) => {
      const prev = d[id] ?? "";
      const next = typeof value === "function" ? value(prev) : value;
      if (next === prev) {
        return d;
      }
      // 清空就把键删掉,免得任务多了攒一堆空串。
      if (!next) {
        const rest = { ...d };
        delete rest[id];
        return rest;
      }
      return { ...d, [id]: next };
    });
  }

  /**
   * 切换空态的模式 tab:存旧、取新。
   *
   * 对齐 WorkBuddy 的 `switchModeWithInputHistory(fromMode, toMode)`——
   * `inputHistoryRef.current.set(fromMode, inputValueRef.current)` 之后
   * `setInputValue(inputHistoryRef.current.get(toMode) ?? [])`,没有历史就是清空。
   * 切 mode 的入口只有这一个,新增入口也要走这里。
   *
   * 它那边还要多推一次 `chatInputBlocks$.next(restored)`,因为它的输入框是富文本块 + rx 流、
   * 自己存着一份状态;我们的 `<textarea value={text}>` 完全受控于外层,写 draft 即到位。
   *
   * 附件(Composer 内部的 `files`)不跟着分槽:它只在 taskKey 变化时清空,而切 mode 不换任务。
   */
  function switchSceneMode(toMode: string): void {
    if (toMode === sceneMode) {
      return;
    }
    modeDraftsRef.current.set(sceneMode, draftText);
    setDraftText(modeDraftsRef.current.get(toMode) ?? "");
    setSceneMode(toMode);
    // 切模式清掉展开的场景(WorkBuddy 切 mode 也 setSelectedQuickAction(void 0)):
    // 上一模式的二级提示留在新模式下会对不上号。
    setActiveSceneSlug(null);
  }

  // 当前任务是否有正在进行的运行:最后一条助手消息仍在流式中。
  const lastMsg = active.messages[active.messages.length - 1];
  const isRunning = lastMsg?.role === "assistant" && lastMsg.streaming === true;

  // 空态当前模式 tab(未命中时回退首个)。
  const activeModeTab =
    MODE_TABS.find((t) => t.id === sceneMode) ?? MODE_TABS[0];
  /** 该模式下的场景。服务端已按 mode / sort_order 排好序,这里只过滤不重排。 */
  const modeScenes = (serverScenes ?? []).filter(
    (s) => s.mode === activeModeTab.id,
  );
  /** 展开中的场景(切模式后 slug 可能不在本组里,故从本组内查)。 */
  const activeScene = activeSceneSlug
    ? (modeScenes.find((s) => s.slug === activeSceneSlug) ?? null)
    : null;
  const activeScenePrompts = parseScenePrompts(activeScene);
  /**
   * 当前场景下的案例。照 WorkBuddy:案例行只在选中场景时出现
   * (`homePlaybooksEnabled && selectedQuickAction ? allCases.filter(c => c.scenario === selectedQuickAction) : []`),
   * 没选场景就整块不渲染 —— 不是「没选时展示全部」。
   */
  const scenePlaybooks = activeScene
    ? serverScenarios.filter((sc) => sc.scene_slug === activeScene.slug)
    : [];
  /** 可见的 5 张:环形取,越界回头,和 WorkBuddy 的 `(batchStart + i) % total` 一致。 */
  const visiblePlaybooks = scenePlaybooks.length
    ? Array.from(
        { length: Math.min(PLAYBOOK_VISIBLE_COUNT, scenePlaybooks.length) },
        (_, i) => {
          return scenePlaybooks[
            (playbookBatchStart + i) % scenePlaybooks.length
          ];
        },
      )
    : [];
  /** 只有多于一屏才给「换一批」,否则点了也是原样五张。 */
  const canRefreshPlaybooks = scenePlaybooks.length > PLAYBOOK_VISIBLE_COUNT;

  // 自检/预热态派生:结束且 ok(或网关已在跑)= 就绪;结束且非 ok = 失败;其余为准备中。
  const preflightFailed =
    preflight !== null && !preflight.running && !preflight.ok;
  const ready =
    (preflight !== null && !preflight.running && preflight.ok) ||
    status.running;

  /** 触发一次完整自检(内部会启动网关并预热连接)。 */
  function runPreflight(): void {
    void window.api.runPreflight("full").then((res) => {
      if (res.ok && res.data) setPreflight(res.data);
    });
  }

  // 进入即执行完整自检(定位内核→版本→配置→启动网关→连接→探活),用户无感预热。
  useEffect(() => {
    const offStatus = window.api.onGatewayStatus((s) => setStatus(s));
    const offPre = window.api.onPreflightStep((r) => setPreflight(r));
    runPreflight();
    return () => {
      offStatus();
      offPre();
    };
  }, []);

  // 订阅 agent 运行事件,按 sessionKey 路由到对应任务的最后一条助手消息,增量渲染。
  useEffect(() => {
    const off = window.api.onAgentEvent((evt: AgentEvent) => {
      setTasks((prev) =>
        prev.map((t) =>
          t.sessionKey === evt.sessionKey ? applyAgentEvent(t, evt) : t,
        ),
      );
      // 当前会话写文件完成 → 自动打开右侧预览抽屉并实时刷新(对齐 WorkBuddy 编辑态自动预览)。
      if (
        evt.kind === "tool" &&
        evt.status === "completed" &&
        evt.sessionKey === activeSessionKeyRef.current &&
        ARTIFACT_TOOL_NAMES.has((evt.name ?? "").toLowerCase())
      ) {
        const path =
          parseArtifactPath(evt.input, evt.title) ||
          parseWrittenPath(evt.result ?? "");
        // 记忆日志也是 write,但它不是给人看的交付物:自动弹预览会在每段工作收尾时
        // 把用户正在看的东西顶掉(见 @shared/workspace-data)。
        if (path && !isWorkspaceDataPath(path)) {
          void openArtifact(evt.sessionKey, { path, name: baseName(path) });
        }
      }
    });
    return off;
  }, []);

  /**
   * 订阅媒体后台任务进度(出图/出视频),按会话存一条。
   *
   * 为什么需要它:出图/出视频在会话里一律是后台任务,模型调完工具就 yield,这一轮就"结束"了 ——
   * 界面上只剩「本轮回复已中断」+「已挂起等待专家回信」,而产物其实还在路上(甚至已经出来了,
   * 只是内核投不回我们的 `acp:` 会话,详见 main/media-relay.ts)。有了这条通道,等待期才能画成
   * 「正在出图 · 已用 N 秒」,这也是成熟产品的通行做法:提交即落占位卡、原地更新语义化阶段。
   *
   * 终态(done/failed)由生产者负责撤走:那时结果已经作为新的一轮消息进对话了。
   */
  useEffect(() => {
    return window.api.onMediaProgress((p) => {
      setMediaTasks((prev) => {
        const next = new Map(prev);
        if (p.phase === "done" || p.phase === "failed") {
          next.delete(p.sessionKey);
        } else {
          next.set(p.sessionKey, p);
        }
        return next;
      });
    });
  }, []);

  // 订阅平台 UI 工具 ask_user / show_widget / present_files,统一落到会话最后一条助手消息。
  // ask 只负责入库:作答面板显不显示由时间线推导(见 activeAsk),订阅这里不持有任何提问状态。
  useEffect(() => {
    const offAsk = window.api.onAskUser((req) => handleAsk(req));
    const offWidget = window.api.onShowWidget((req) => handleWidget(req));
    const offPresent = window.api.onPresentFiles((req) => handlePresent(req));
    return () => {
      offAsk();
      offWidget();
      offPresent();
    };
  }, []);

  /** 从模型管理配置(providers.json)加载可选对话模型;并保证当前选中模型仍有效。 */
  function refreshChatModels(): void {
    void window.api.listProviders().then((res) => {
      if (!res.ok || !res.data) {
        return;
      }
      const opts: ChatModelOption[] = [];
      for (const p of res.data) {
        for (const m of p.models) {
          if (m.category === "chat") {
            opts.push({
              key: `${p.id}/${m.id}`,
              label: m.name || m.id,
              reasoning: m.reasoning,
              providerLabel: p.label,
              custom: !p.builtin,
              onlyReasoning: m.onlyReasoning,
              canDisableThinking: m.canDisableThinking,
              thinkingLevels: m.thinkingLevels,
              defaultThinkingLevel: m.defaultThinkingLevel,
              // 漏了它,Grok 4+ 会拿到一个看着能用其实什么都不下发的假开关。
              thinkingEffort: m.thinkingEffort,
              thinkingFormat: m.thinkingFormat,
            });
          }
        }
      }
      setChatOptions(opts);
      setSelectedModel((cur) =>
        opts.some((o) => o.key === cur) ? cur : (opts[0]?.key ?? cur),
      );
    });
  }

  // 首次挂载加载可选模型。
  useEffect(() => {
    refreshChatModels();
  }, []);

  /** 加载本地已安装专家(用于 Composer 选择器);安装/卸载后可重新调用刷新。 */
  function refreshExperts(): void {
    void window.api.listInstalledExperts().then((res) => {
      if (res.ok && res.data) {
        setExperts(res.data);
      }
    });
  }

  // 首次挂载加载已安装专家。
  useEffect(() => {
    refreshExperts();
  }, []);

  /**
   * 加载服务端首页场景(输入框上方那行胶囊);失败/离线时静默留空,不阻塞首屏。
   *
   * 内容没变就保持原引用不 setState,照 WorkBuddy `useTemplates` 里的 `isTemplatesEqual`:
   * 它每次重拉都先深比对再决定要不要 set,因为这行胶囊是横向滚动容器,
   * 无谓的重渲染会把用户的滚动位置和展开的二级提示抖掉。
   */
  function refreshScenes(): void {
    void window.api
      .listScenes()
      .then((res) => {
        if (res.ok && res.data) {
          const next = res.data;
          setServerScenes((prev) =>
            prev && sameScenes(prev, next) ? prev : next,
          );
        }
      })
      // 失败也要落成空数组来收掉骨架:否则离线时那四条会一直扫,比空着更像卡住了。
      .finally(() => setServerScenes((prev) => prev ?? []));
  }

  /**
   * 加载首页实践案例(输入框下方那行大卡);同样静默容错。
   *
   * 只要 playbook 那一档:同一张表里还有 9 条专家中心的场景大卡(scene_slug 为空),
   * 它们永远匹配不上下面的 `sc.scene_slug === activeScene.slug`,拉回来纯属白费。
   */
  function refreshScenarios(): void {
    void window.api.listScenarios('playbook').then((res) => {
      if (res.ok && res.data) {
        setServerScenarios(res.data);
      }
    });
  }

  // 首次挂载加载首页场景与案例。
  useEffect(() => {
    refreshScenes();
    refreshScenarios();
  }, []);

  /**
   * 回到前台就静默重拉一次场景与案例。
   *
   * 照 WorkBuddy `useSkillsUpdateBadge`:挂载跑一次 + `visibilitychange` 且
   * `visibilityState === 'visible'` 时重跑。这两份数据都在 admin-server 的库里,
   * 运营在 admin-cloud 改完之后客户端没有任何事件能知道(WorkBuddy 的模板来自本地插件
   * 文件,所以它还能订阅 `onPluginsChanged`,那个事件源我们没有),不重拉就只能靠重启应用。
   *
   * **比 WorkBuddy 多监听一个 `window` 的 focus**,这条是被桌面端形态逼的:
   * 2026-08-11 实测,把窗口最小化再恢复会触发 `visibilitychange`(admin-server 收到了那次
   * 重拉),但只是切到别的应用、我们的窗口仍可见时**不触发**——Chromium 的遮挡检测不认这种
   * 失焦。而"切去浏览器改完再切回来"恰恰是运营改完数据后最常见的动作,只听
   * `visibilitychange` 就会漏掉它。WorkBuddy 那个 hook 漏掉不要紧,它还有 1 小时的
   * `setInterval` 和 `onPluginsChanged` 兜着;我们只有这一个触发器。
   */
  useEffect(() => {
    function refreshIfStale(): void {
      if (
        Date.now() - lastHomeFetchRef.current <
        HOME_REFETCH_MIN_INTERVAL_MS
      ) {
        return;
      }
      lastHomeFetchRef.current = Date.now();
      refreshScenes();
      refreshScenarios();
    }
    function onVisible(): void {
      if (document.visibilityState === "visible") {
        refreshIfStale();
      }
    }
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", refreshIfStale);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", refreshIfStale);
    };
  }, []);

  // 换场景就把案例翻页归零(照 WorkBuddy 对 chipName 的 `setBatchStart(0)`):
  // 沿用上一个场景的偏移量,新场景第一屏会莫名其妙从第六条开始。
  useEffect(() => {
    setPlaybookBatchStart(0);
  }, [activeSceneSlug]);

  /**
   * 弹窗一打开就去换产物直链,不等用户点。
   *
   * 照 WorkBuddy:预览区就是弹窗主体(`.dc-detail-modal-preview` 占满剩余高度),它在
   * 详情数据到手时就把 previewUrl 算好了,没有「点一下才加载」这一步。
   * link 类没有可签的产物(内容在第三方那儿),直接跳过,弹窗里只显示封面 + 去原站的入口。
   */
  useEffect(() => {
    /**
     * 设计稿类作品打开即放大态 —— 照 WorkBuddy:它对 Ardot 案例有一段专门的自动放大
     * (`if (!isArdotEmbedUrl(previewUrl)) return; setEnlarged(true)`),对 html / video / 图片
     * 都不放。我们那 32 条自产产物对位的正是它这批 Ardot 案例,所以判据换成 isDesignPlaybook,
     * 结果一致:一张 1440 宽的设计稿摆进 588×401 的小窗里,正文本来就已经小到读不动了。
     */
    setPlaybookEnlarged(isDesignPlaybook(activePlaybook));
    // zoom 给 0 表示「还没定」,等桥报回设计稿尺寸再算适应比例;没有桥的产物一直是 0,
    // 走的就是改动前那套「iframe 铺满预览框」。
    setPlaybookView(PLAYBOOK_VIEW_INIT);
    setPlaybookZoomMenu(false);
    setPlaybookMeta(null);
    setPlaybookPage(1);
    setPlaybookMeasure(null);
    const id = activePlaybook?.id;
    const type = activePlaybook?.artifact_type;
    if (!id || (type !== "html" && type !== "video")) {
      setPlaybookArtifact(null);
      return;
    }
    let cancelled = false;
    setPlaybookArtifact({ phase: "loading" });
    void window.api.scenarioArtifact(id).then((res) => {
      if (cancelled) return;
      setPlaybookArtifact(
        res.ok && res.data?.url
          ? { phase: "ready", url: res.data.url }
          : { phase: "error" },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [activePlaybook]);

  /**
   * 打开画廊:先刷新已安装专家,再展开。
   * 画廊自己会拉一遍精选场景(见 MarketGallery 的 listScenarios),这里不必代它拉。
   */
  function openGallery(): void {
    refreshExperts();
    // 打开画廊时退出「新建任务」草稿选中,避免侧栏「新建任务」与「专家」同时高亮。
    setComposingNew(false);
    setGalleryOpen(true);
  }

  /**
   * 点首页场景胶囊。形状取自 WorkBuddy 的 `handleSecondLevelClick`:
   * 同一条再点一次是取消选中,选中后一级胶囊行整体隐藏(它是 `display:none`),
   * 换成该场景的提示标题二级行。
   *
   * 只切 UI,不开新会话也不预填 —— 真正落到输入框是点二级提示那一下(handleScenePrompt)。
   * 场景自带的 plugin_names 这里不消费:它在 WorkBuddy 是「选中场景 → 本次会话启用这些
   * 专家团插件」(buildScenePluginSessionSettings → sessionSettings.enabledPlugins),
   * 而 openclaw 没有会话级插件启用,这是被内核逼出来的差异,不是我们漏做。
   */
  function handleSceneChip(scene: DesktopScene): void {
    setActiveSceneSlug((prev) => (prev === scene.slug ? null : scene.slug));
    // 换场景把补图方式与设计风格退回默认,对齐 WorkBuddy 的
    // `if (isSceneChanged) { setSelectedDesignStyle(null); setUserImageModeChoice(null) }`
    // ——这两个选择都是「针对这个场景」的,场景一换就不该继续生效。
    setImageMode("ai");
    setDesignStyle(null);
  }

  /**
   * 点二级提示:预填进输入框而不直接发送(WorkBuddy 同样只 setInputValue + focusInput),
   * 这些提示动辄几百字、常需要用户替换其中的对象或数据,直接发出去多半要重来一遍。
   */
  function handleScenePrompt(prompt: DesktopScenePrompt): void {
    setComposerPrefill((p) => ({ text: prompt.prompt, seq: p.seq + 1 }));
  }

  useEffect(() => {
    const el = playbookStageRef.current;
    if (!el) {
      setPlaybookStageSize({ w: 0, h: 0 });
      return;
    }
    const sync = (): void =>
      setPlaybookStageSize({ w: el.clientWidth, h: el.clientHeight });
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [activePlaybook, playbookEnlarged, playbookMeta?.pages]);

  /** 台面可用区(去掉四周留白)。 */
  function playbookStageBox(): { w: number; h: number } {
    return {
      w: playbookStageSize.w - PLAYBOOK_STAGE_PAD * 2,
      h: playbookStageSize.h - PLAYBOOK_STAGE_PAD * 2,
    };
  }

  /**
   * 「适应」档:定尺作品宽高都装下,长页只按宽装下(垂直可滚)——后者与产物自身 fit 脚本
   * 的语义一致,长页强行整页装下会小到看不清,那是「整页」档的事。
   */
  function playbookFitZoom(meta: PlaybookMeta | null): number {
    if (!meta) return 1;
    const { w, h } = playbookStageBox();
    if (w <= 0 || h <= 0) return 1;
    return meta.fit === "contain"
      ? Math.min(w / meta.w, h / meta.h)
      : w / meta.w;
  }

  /** 「整页」档:连内容全高一起装下,长页作品一眼看全(对标 Ardot 那个 12% 的整页视图)。 */
  function playbookPageZoom(meta: PlaybookMeta | null): number {
    if (!meta) return 1;
    const { w, h } = playbookStageBox();
    if (w <= 0 || h <= 0) return 1;
    return Math.min(w / meta.w, h / (meta.contentH || meta.h));
  }

  /** 当前生效的缩放:用户还没动过就用适应档。 */
  function playbookZoom(): number {
    return playbookView.zoom || playbookFitZoom(playbookMeta);
  }

  /**
   * iframe 的像素尺寸。**缩放就是改这个值**,产物自己的 fit 脚本会按新视口重算 `--s`,
   * 拿到矢量重绘而不是拉大的位图。没有桥的产物退回「铺满台面」,与改动前一致。
   */
  function playbookFrameBox(): { w: number; h: number } {
    const { w: sw, h: sh } = playbookStageSize;
    if (!playbookMeta) return { w: sw, h: sh };
    const z = playbookZoom();
    // 长页**撑到内容全高**,让整份长稿成为一块完整画布、靠平移查看。
    // 曾经把它夹在台面高度内(超出的部分靠产物自己内滚),那样长稿就不是「摆在白布上的
    // 一张纸」而是「一个开了窗的网页」,抓手也拖不动 —— 见 clampPlaybookPan 上的注释。
    const design =
      playbookMeta.fit === "contain"
        ? playbookMeta.h
        : playbookMeta.contentH || playbookMeta.h;
    return {
      w: Math.round(playbookMeta.w * z),
      h: Math.round(design * z) || sh,
    };
  }

  /**
   * 缩放到某个比例,并保持**台面中心对着产物上的同一个点** —— 不这么算的话,
   * 每次放大都会跳回中心,用户得重新拖一遍才能找回刚才在看的地方。
   */
  function zoomPlaybookTo(next: number): void {
    if (!playbookMeta) return;
    const { w: sw, h: sh } = playbookStageSize;
    const from = playbookZoom();
    const zoom = Math.min(3, Math.max(0.05, next));
    setPlaybookView((v) => {
      const ratio = zoom / from;
      // 以台面中心为锚:偏移量随比例同步放大,中心点下方的内容保持不动。
      const next = clampPlaybookPan(
        v.x * ratio,
        v.y * ratio,
        playbookMeta.w * zoom,
        (playbookMeta.fit === "contain"
          ? playbookMeta.h
          : playbookMeta.contentH) * zoom,
        sw,
        sh,
      );
      return { ...v, zoom, ...next };
    });
  }

  /**
   * 产物桥的上报(见 `admin-server/scripts/inject-playbook-bridge.cjs`)。
   *
   * 必须**按 source 认人**:演示图层那几个缩略图 iframe 加载的是同一个产物、也带桥、
   * 也会上报 ready 与 page。原型第一轮就栽在这:8 个缩略图各报一次,把主预览的画布比例
   * 覆盖成 130/1280=0.10,主图当场缩成一小块。
   */
  useEffect(() => {
    if (!activePlaybook) return;
    const onMsg = (e: MessageEvent): void => {
      const d = e.data as
        | (Partial<PlaybookMeta> & {
            wb?: number;
            type?: string;
            page?: number;
            hit?: boolean;
            x?: number;
            y?: number;
            label?: string;
          })
        | null;
      if (!d || d.wb !== 1) return;
      if (e.source !== playbookFrameRef.current?.contentWindow) return;
      if (d.type === "ready") {
        setPlaybookMeta({
          w: d.w ?? 0,
          h: d.h ?? 0,
          fit: d.fit === "width" ? "width" : "contain",
          pages: d.pages ?? 1,
          contentH: d.contentH ?? d.h ?? 0,
        });
        setPlaybookPage(d.page ?? 1);
      } else if (d.type === "page") {
        setPlaybookPage(d.page ?? 1);
      } else if (d.type === "scale") {
        // 长页产物的内容全高要等图片布局完才准,晚到的这次才是「整页」档的依据。
        setPlaybookMeta((m) =>
          m && d.contentH ? { ...m, contentH: d.contentH } : m,
        );
      } else if (d.type === "measure") {
        setPlaybookMeasure(
          d.hit
            ? {
                x: d.x ?? 0,
                y: d.y ?? 0,
                w: d.w ?? 0,
                h: d.h ?? 0,
                label: d.label ?? "",
              }
            : null,
        );
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [activePlaybook]);

  /** 给产物发指令。 */
  function sendToPlaybook(msg: Record<string, unknown>): void {
    playbookFrameRef.current?.contentWindow?.postMessage(
      { wb: 1, ...msg },
      "*",
    );
  }

  /**
   * 把标注模式同步给桥,一处收口。
   *
   * 桥那侧 `mOn` 默认是关的、只有收到 `measure on` 才开 hover 检测
   * (`admin-server/scripts/inject-playbook-bridge.cjs`),而默认模式已经是标注 ——
   * 所以**桥一 ready 就得补这一发**,不能只在点按钮时发。切模式的入口有四个
   * (两颗模式键、H 键、放大/收起复位),各自记得发一次迟早会漏,交给这个 effect。
   *
   * **缩放与放大/收起也要重发**:框是外壳按上报的视口坐标画的,台面一变旧框就画错位置;
   * 而重发的副作用正好是清掉桥那侧的 `lastEl` —— 不清的话鼠标仍停在同一个元素上时,
   * 桥判「没变化」直接 return,框就再也不回来了(2026-08-12 真机撞到:收起小窗后 hover 无框)。
   *
   * 依赖取 `playbookBridged` 而不是 `playbookMeta` 本身:长页产物 load 后还会补报一次
   * contentH,那会换掉 meta 的引用、把测量白白重置一遍。
   */
  const playbookBridged = !!playbookMeta;
  useEffect(() => {
    if (!playbookBridged) return;
    setPlaybookMeasure(null);
    sendToPlaybook({ type: "measure", on: playbookView.measure });
  }, [
    playbookBridged,
    playbookView.measure,
    playbookView.zoom,
    playbookEnlarged,
  ]);

  /**
   * 键盘操作。H 切抓手是照 Ardot 那套工具的习惯(它标着「手形工具 H」),
   * `+/-/0` 是看图类界面的通用约定。
   */
  useEffect(() => {
    if (!activePlaybook || !playbookMeta) return;
    const onKey = (e: KeyboardEvent): void => {
      // 档位菜单开着时把键全让出去:里面那个百分比输入框要能打字,
      // 而 Esc 该先关菜单再轮到关弹窗(弹窗那侧的 Esc 挂在更外层)。
      if (playbookZoomMenu) {
        if (e.key === "Escape") {
          e.stopPropagation();
          setPlaybookZoomMenu(false);
        }
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const z = playbookZoom();
      // 档位表里找下一个比当前大/小的档,不用 indexOf:当前值多半是适应档算出来的
      // 任意小数(如 0.43),在表里根本没有对应项。
      if (e.key === "h" || e.key === "H") {
        // 与工具条同一套互斥。关测量、撤框都由上面那个同步 effect 收口
        setPlaybookView((v) => ({ ...v, hand: true, measure: false }));
      } else if (e.key === "+" || e.key === "=") {
        zoomPlaybookTo(
          PLAYBOOK_ZOOM_STEPS.find((s) => s > z + 1e-4) ??
            PLAYBOOK_ZOOM_STEPS[PLAYBOOK_ZOOM_STEPS.length - 1],
        );
      } else if (e.key === "-" || e.key === "_") {
        zoomPlaybookTo(
          [...PLAYBOOK_ZOOM_STEPS].reverse().find((s) => s < z - 1e-4) ??
            PLAYBOOK_ZOOM_STEPS[0],
        );
      } else if (e.key === "0") {
        zoomPlaybookTo(1);
      } else if (e.key === "ArrowRight" && playbookMeta.pages > 1) {
        sendToPlaybook({ type: "goto", page: playbookPage + 1 });
      } else if (e.key === "ArrowLeft" && playbookMeta.pages > 1) {
        sendToPlaybook({ type: "goto", page: playbookPage - 1 });
      } else {
        return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    activePlaybook,
    playbookMeta,
    playbookView.zoom,
    playbookPage,
    playbookZoomMenu,
  ]);

  /**
   * 案例「一键做同款」。WorkBuddy 的 `usePlaybookLaunch.launch` 落点是
   * `requestInsertContentBlocks({ contentBlocks: [场景芯片, 技能芯片…], promptText, expert })`
   * —— 新开一个任务、把芯片和提示塞进输入框,**不发送**。这里照同一口径:
   * 开新草稿 → 绑定案例关联的专家(仅在本机已装时,未装不静默下载,那是市场召唤的活)
   * → 预填起手提示,把发不发的决定权留给用户。
   */
  function handlePlaybookLaunch(sc: DesktopScenario): void {
    setActivePlaybook(null);
    setComposingNew(true);
    setDraftTask(newTask());
    setActiveId("");
    setComposerSkill(null);
    const slug = scenarioMemberSlugs(sc)[0];
    if (slug && experts.some((e) => e.slug === slug)) {
      handleSelectExpert(slug);
    } else {
      setSelectedExpertSlug(null);
    }
    const prompt = sc.init_prompt?.trim();
    if (prompt) {
      setComposerPrefill((p) => ({ text: prompt, seq: p.seq + 1 }));
    }
  }

  /**
   * 技能/连接器「试一试」:关画廊 → 新建草稿 → 预填「请使用「xxx」帮我：」起手语。
   * 对齐 WorkBuddy 安装后点「试一试」落到可直接发送的新会话。
   */
  /** 打开产出物预览面板:读取该会话产出的文件正文(含越权防护与大小上限)。 */
  async function openArtifact(
    sessionKey: string,
    ref: ArtifactRef,
  ): Promise<void> {
    setArtifactPreview({
      loading: true,
      name: ref.name,
      path: ref.path,
      content: "",
      previewable: true,
      truncated: false,
    });
    const res = await window.api.readArtifact(sessionKey, ref.path);
    if (res.ok && res.data) {
      setArtifactPreview({ loading: false, ...res.data });
    } else {
      setArtifactPreview({
        loading: false,
        name: ref.name,
        path: ref.path,
        content: "",
        previewable: false,
        truncated: false,
        error: res.error || "读取失败",
      });
    }
  }

  async function handleTrySkill(item: MarketItem): Promise<void> {
    setGalleryOpen(false);
    setComposingNew(true);
    setDraftTask(newTask());
    setActiveId("");
    setSelectedExpertSlug(null);
    setComposerSkill(null);
    const prompt = `请使用「${item.name}」技能帮我：`;
    setComposerPrefill((p) => ({ text: prompt, seq: p.seq + 1 }));
  }

  /**
   * 通用「开新任务 + 预填模板」:用于市场「查找技能 / 创建技能」——
   * 对齐 WorkBuddy,这两者不是弹窗,而是开一个新对话并预填模板提示,由内置的
   * find-skills / skill-creator 技能(启动已播种)按描述自动匹配完成后续工作。
   */
  function handleComposePrefill(
    text: string,
    skill?: { slug: string; name: string },
  ): void {
    setGalleryOpen(false);
    setComposingNew(true);
    setDraftTask(newTask());
    setActiveId("");
    setSelectedExpertSlug(null);
    setComposerSkill(skill ?? null);
    setComposerPrefill((p) => ({ text, seq: p.seq + 1 }));
  }

  /**
   * 从画廊「召唤」一个专家:MarketPage 已确保其安装(下载 persona)。
   * 拉最新已安装列表 → 切新建草稿并绑定 → 预填「试试这样问我」第一句 → 关画廊。
   * 对齐 WorkBuddy:召唤后落到可直接发送的新会话,输入框已带起手提示。
   */
  async function handleSummonExpert(
    item: MarketItem,
    opts?: { prefill?: string },
  ): Promise<void> {
    // 召唤即取最新:每次都从市场重装该专家(persona/清单/捆绑技能),确保新会话用最新版本
    // (对齐 WorkBuddy「每次召唤直接用最新」)。重装为覆盖式、幂等;失败回退已装版本。
    // 仅影响新开会话;已存在的专家会话 agent 已内联旧 persona,不受影响。
    const upd = await window.api.installMarketItem(item);
    if (!upd.ok) {
      console.warn("[summon] 更新专家到最新失败,回退已装版本:", upd.error);
    }
    const res = await window.api.listInstalledExperts();
    const list = res.ok && res.data ? res.data : experts;
    setExperts(list);
    setComposerSkill(null);
    handleSelectExpert(item.slug);
    const installed = list.find((e) => e.slug === item.slug);
    const prompt =
      opts?.prefill?.trim() ||
      installed?.manifest.defaultInitPrompt?.trim() ||
      installed?.manifest.quickPrompts?.[0]?.trim();
    if (prompt) {
      setComposerPrefill((p) => ({ text: prompt, seq: p.seq + 1 }));
    }
    setGalleryOpen(false);
  }

  // 启动时从磁盘恢复任务列表(内核已持久化 agent/session,这里恢复 UI 元数据)。
  // 消息不随元数据存储,切换到具体任务时再从内核 session 懒加载,避免双写不一致。
  useEffect(() => {
    void (async () => {
      // 第一步:读本地元数据(毫秒级),命中即秒开首屏。
      const res = await window.api.loadTasks();
      const local = sortTasks(
        res.ok && res.data ? res.data.map(metaToTask) : [],
      );
      if (local.length) {
        setTasks(local);
        // 启动默认进入「新建任务」欢迎页,不自动打开第一条历史任务(对齐 WorkBuddy)。
        setActiveId("");
        setComposingNew(true);
        setDraftTask(newTask());
        setRestoring(false);
      }
      // 第二步:后台向内核校正孤儿任务(首次迁移/外部改动),不阻塞首屏。
      const orphanRes = await window.api.discoverTaskOrphans(
        local.map((t) => t.id),
      );
      const orphans =
        orphanRes.ok && orphanRes.data ? orphanRes.data.map(metaToTask) : [];
      if (local.length) {
        // 已秒开:仅把新发现的孤儿去重追加。
        if (orphans.length) {
          setTasks((prev) => {
            const has = new Set(prev.map((t) => t.id));
            return sortTasks([
              ...prev,
              ...orphans.filter((o) => !has.has(o.id)),
            ]);
          });
        }
      } else {
        // 本地为空:用孤儿完成首屏;若仍无任务则进入「新建草稿」态(侧栏不占位)。
        const finalTasks = orphans.length ? sortTasks(orphans) : [];
        setTasks(finalTasks);
        setActiveId("");
        setComposingNew(true);
        setDraftTask(newTask());
        setRestoring(false);
      }
    })();
  }, []);

  // 切换到某持久化任务且其消息尚未加载时,从内核 session 懒加载历史消息。
  useEffect(() => {
    const t = tasksRef.current.find((x) => x.id === activeId);
    if (
      !t ||
      !t.persisted ||
      t.messages.length > 0 ||
      loadedHistoryRef.current.has(t.id)
    ) {
      return;
    }
    loadedHistoryRef.current.add(t.id);
    setHistoryLoadingIds((prev) => new Set(prev).add(t.id));
    void window.api
      .getTaskHistory(t.sessionKey)
      .then((res) => {
        if (res.ok && res.data && res.data.length) {
          const history = res.data;
          setTasks((prev) =>
            prev.map((x) =>
              x.id === t.id && x.messages.length === 0
                ? {
                    ...x,
                    messages: history.map((m) => ({
                      role: m.role,
                      content: m.content,
                      ...(m.thinking ? { thinking: m.thinking } : {}),
                      // 完整执行过程(分段思考 / 工具步骤 / 问答卡 / 图示)由主进程按
                      // 内核落盘记录还原,结构与实时运行同构,直接喂给同一套渲染。
                      ...(m.timeline && m.timeline.length
                        ? { timeline: m.timeline }
                        : {}),
                      ...(m.artifacts && m.artifacts.length
                        ? { artifacts: m.artifacts }
                        : {}),
                      // 「只有思考、没有产出」的一轮:内核那句报错不落抄本,由还原侧判定,
                      // 否则重开历史时失败的一轮会显示成干净的「已完成」。
                      ...(m.error ? { error: m.error } : {}),
                    })),
                  }
                : x,
            ),
          );
        }
      })
      .finally(() => {
        setHistoryLoadingIds((prev) => {
          if (!prev.has(t.id)) return prev;
          const next = new Set(prev);
          next.delete(t.id);
          return next;
        });
      });
  }, [activeId]);

  // 任务元数据变更时持久化(仅已建 agent 的任务;消息不写,靠 session jsonl 恢复)。
  useEffect(() => {
    const metas = tasks
      .filter((t) => t.persisted)
      .map((t) => ({
        id: t.id,
        title: t.title,
        sessionKey: t.sessionKey,
        pinned: t.pinned,
        createdAt: t.createdAt,
        expertSlug: t.expertSlug,
        expertName: t.expertName,
        expertAvatar: t.expertAvatar,
      }));
    // 流式期间消息高频变化但元数据不变:签名相同则跳过,避免无谓写盘。
    const sig = JSON.stringify(metas);
    if (sig === lastSavedSigRef.current) {
      return;
    }
    const timer = setTimeout(() => {
      lastSavedSigRef.current = sig;
      void window.api.saveTasks(metas);
    }, 400);
    return () => clearTimeout(timer);
  }, [tasks]);

  // 断线→重连(网关运行态 false→true)时,对仍在流式中的任务重放当前轮缓冲,
  // 补齐断连窗口内丢失的增量。重放走幂等的 applyAgentEvent(快照替换 / 按 itemId 覆盖),
  // 重复应用不会产生重复文本或重复步骤。
  useEffect(() => {
    const wasRunning = prevRunningRef.current;
    prevRunningRef.current = status.running;
    if (wasRunning || !status.running) {
      return;
    }
    for (const t of tasksRef.current) {
      const lm = t.messages[t.messages.length - 1];
      if (lm?.role === "assistant" && lm.streaming) {
        void window.api.replayAgent(t.sessionKey).then((res) => {
          if (res.ok && res.data && res.data.length) {
            const events = res.data;
            setTasks((prev) =>
              prev.map((x) =>
                x.id === t.id
                  ? events.reduce((acc, e) => applyAgentEvent(acc, e), x)
                  : x,
              ),
            );
          }
        });
      }
    }
  }, [status.running]);

  const isStreaming = active.messages.some((m) => m.streaming);

  /** 当前**这条会话**里待作答的提问(推导自它自己的时间线,没有全局提问状态)。 */
  const activeAsk = useMemo(
    () => findActiveAsk(active.messages),
    [active.messages],
  );

  /** 历史仍在从内核载入:此时空消息列表不代表空态,不能当作欢迎页。 */
  const historyLoading = historyLoadingIds.has(active.id);
  /**
   * 是否正在显示欢迎页(新建任务空态)。
   * 该态下顶栏对齐 WorkBuddy:去掉任务标题与工具按钮,只留成长计划入口。
   */
  const showWelcome = active.messages.length === 0 && !historyLoading;

  /**
   * 首页胶囊行的横向滚动。胶囊不换行,溢出靠滚动收口 —— 照 WorkBuddy
   * `.quick-actions__list`(flex:1 + overflow-x:auto + 藏滚动条 + 两端渐隐/箭头)。
   * enabled 必须跟着"胶囊行渲没渲出来"走,否则数据异步到达后滚轮监听挂不上。
   */
  const chipScroll = useHorizontalScroll(showWelcome && ready);

  /**
   * 用户此刻是否贴在底部。流式期间只有贴底才继续跟随:
   * 之前是无条件每次增量都 `scrollTop = scrollHeight`,导致回复期间根本无法上滑回看,
   * 手一松就被拽回底部。
   */
  const followRef = useRef(true);
  /** 上一帧的内容高度,用于判断"内容是否真的长高了"。 */
  const logHeightRef = useRef(0);

  /**
   * 「是否已回到底部」的判定容差。只用于**恢复**跟随,不用于**取消**跟随。
   *
   * 取消跟随必须由用户的输入(滚轮/触控板)直接决定,不能靠位置判断:Chromium 的滚轮是
   * 平滑滚动,每帧只走几个像素并各触发一次 scroll,位置长时间落在容差内。一旦用容差去判
   * "还贴着底",跟随就永远不会关闭,用户滚上去的那几像素会被下一帧原样拽回——表现就是
   * 滚轮完全失灵,而拖动滚动条因为单次位移够大能一次跳出容差,反而是可用的。
   */
  const BOTTOM_TOLERANCE_PX = 24;

  /** 回到底部就恢复跟随(滚轮往下滚回底部、拖滚动条到底都走这里)。 */
  function handleLogScroll(): void {
    const el = logRef.current;
    if (!el) return;
    if (
      el.scrollHeight - el.scrollTop - el.clientHeight <=
      BOTTOM_TOLERANCE_PX
    ) {
      followRef.current = true;
    }
  }

  /** 用户主动向上滚,即刻停止跟随——这是"我要自己看"的明确信号,与当前位置无关。 */
  function handleLogWheel(e: React.WheelEvent<HTMLDivElement>): void {
    if (e.deltaY < 0) {
      followRef.current = false;
    }
  }

  // 切任务 / 新增消息:绘制前直接落到底部,避免可见的"滑到底"过程。
  useLayoutEffect(() => {
    const el = logRef.current;
    if (!el) return;
    followRef.current = true;
    el.scrollTop = el.scrollHeight;
    logHeightRef.current = el.scrollHeight;
  }, [activeId, active.messages.length]);

  /**
   * 流式期间按帧跟随底部,而不是在每个增量的 useLayoutEffect 里滚。
   *
   * 原写法每来一个增量就读一次 scrollHeight,那是一次强制同步布局,且发生在刚重渲染完
   * 一大棵 markdown 树之后——正文越长越贵,和渲染开销叠加成肉眼可见的卡顿。
   * 改成 rAF 循环后,滚动与浏览器的绘制节奏对齐:内容在长时布局本就要做,内容没长时
   * 读 scrollHeight 命中干净布局,近乎免费。
   *
   * **只在内容真的长高的那一帧才动 scrollTop**。无条件每帧都写,等于在整个运行期间把视图
   * 钉死在底部;而运行期可能长时间没有新内容(比如卡在 ask_user 等用户作答),用户此时
   * 完全无法翻看上文。
   */
  useEffect(() => {
    if (!isStreaming) {
      return;
    }
    let raf = 0;
    const tick = (): void => {
      const el = logRef.current;
      if (el) {
        const h = el.scrollHeight;
        if (h !== logHeightRef.current) {
          logHeightRef.current = h;
          if (followRef.current) {
            el.scrollTop = h;
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isStreaming]);

  /** 当前任务的全部产出物(按出现顺序去重),供预览抽屉的文件切换条使用。 */
  const taskArtifacts: ArtifactRef[] = [];
  const seenArtifactPath = new Set<string>();
  for (const m of active.messages) {
    for (const a of m.artifacts ?? []) {
      if (!seenArtifactPath.has(a.path)) {
        seenArtifactPath.add(a.path);
        taskArtifacts.push(a);
      }
    }
  }
  const artifactPathsKey = taskArtifacts.map((a) => a.path).join("|");

  /**
   * 批量补齐产出物文件大小(卡片副标题)。
   * 依赖只有「路径集合」和「是否还在生成」,不随文字增量触发;运行结束时再统计一次,
   * 拿到编辑收尾后的最终大小。
   */
  useEffect(() => {
    if (!artifactPathsKey) {
      setArtifactSizes((prev) => (Object.keys(prev).length ? {} : prev));
      return;
    }
    // preload 是随主进程一起构建的,改完不重启就还是旧版本(开发时很常见)。
    // 缺这个接口只是卡片少一行文件大小,不该让整个渲染层抛异常。
    if (typeof window.api.statArtifacts !== "function") {
      return;
    }
    let cancelled = false;
    void window.api
      .statArtifacts(active.sessionKey, artifactPathsKey.split("|"))
      .then((r) => {
        if (cancelled || !r.ok || !r.data) {
          return;
        }
        const next: Record<string, number> = {};
        for (const it of r.data) {
          next[it.path] = it.size;
        }
        setArtifactSizes(next);
      });
    return () => {
      cancelled = true;
    };
  }, [active.sessionKey, artifactPathsKey, isStreaming]);

  function updateActive(mutator: (t: Task) => Task): void {
    setTasks((prev) => prev.map((t) => (t.id === activeId ? mutator(t) : t)));
  }

  // ---- 平台 UI 工具 ask_user:把提问/作答沉淀到当前助手消息的时间线(对齐 WorkBuddy)----
  /**
   * 收到提问:在发起会话的最后一条助手消息上追加「向用户提问 / 等待用户确认」的 ask 时间线项。
   *
   * 按 sessionKey 认领而不是按 activeId,与 handleWidget 同口径:订阅是 []-依赖的,
   * 闭包里的 activeId 会是挂载时那一份,拿它去改任务等于往错的任务上写。
   */
  function handleAsk(req: AskRequest): void {
    const key = activeSessionKeyRef.current;
    // 草稿态/占位任务的 sessionKey 是空串,拿它去匹配会一次命中所有没有 key 的任务,
    // 把同一个提问糊到好几条会话上。能发起 ask 的一定是已建会话,所以空 key 直接不认领。
    if (!key) {
      return;
    }
    setTasks((prev) =>
      prev.map((t) =>
        t.sessionKey === key
          ? patchLastAssistant(t, (m) => {
              const timeline = [...(m.timeline ?? [])];
              const item: TimelineItem = {
                kind: "ask",
                itemId: req.id,
                status: "waiting",
                questions: req.questions,
                at: m.content.length,
              };
              const i = timeline.findIndex(
                (it) => it.kind === "ask" && it.itemId === req.id,
              );
              if (i >= 0) {
                timeline[i] = { ...item, at: timeline[i].at };
              } else {
                timeline.push(item);
              }
              return { ...m, streaming: true, timeline };
            })
          : t,
      ),
    );
  }

  /** 用户答完:把最近一个待答的 ask 项落定为「用户回答卡片」。 */
  function handleAnswered(answers: AskAnswer[]): void {
    updateActive((t) =>
      patchLastAssistant(t, (m) => {
        const timeline = [...(m.timeline ?? [])];
        for (let i = timeline.length - 1; i >= 0; i--) {
          const it = timeline[i];
          if (it.kind === "ask" && it.status === "waiting") {
            timeline[i] = { ...it, status: "answered", answers };
            break;
          }
        }
        return { ...m, timeline };
      }),
    );
  }

  /** 点 ✕ 关闭提问:标记该 ask 项已取消,并中止本轮运行。 */
  function handleCancelAsk(): void {
    updateActive((t) =>
      patchLastAssistant(t, (m) => {
        const timeline = [...(m.timeline ?? [])];
        for (let i = timeline.length - 1; i >= 0; i--) {
          const it = timeline[i];
          if (it.kind === "ask" && it.status === "waiting") {
            timeline[i] = { ...it, status: "cancelled" };
            break;
          }
        }
        return { ...m, timeline };
      }),
    );
    void handleAbort();
  }

  /** show_widget:把模型交付的可视化卡追加到当前会话最后一条助手消息的时间线。 */
  function handleWidget(req: WidgetRequest): void {
    const key = activeSessionKeyRef.current;
    setTasks((prev) =>
      prev.map((t) =>
        t.sessionKey === key
          ? patchLastAssistant(t, (m) => {
              const timeline = [...(m.timeline ?? [])];
              const item: TimelineItem = {
                kind: "widget",
                itemId: req.id,
                title: req.title,
                code: req.widgetCode,
                at: m.content.length,
              };
              const i = timeline.findIndex(
                (it) => it.kind === "widget" && it.itemId === req.id,
              );
              if (i >= 0) {
                timeline[i] = { ...item, at: timeline[i].at };
              } else {
                timeline.push(item);
              }
              return { ...m, streaming: true, timeline };
            })
          : t,
      ),
    );
  }

  /** present_files:把交付文件并入当前助手消息的产物列表,并自动打开右侧预览抽屉。 */
  function handlePresent(req: PresentRequest): void {
    const key = activeSessionKeyRef.current;
    const refs: ArtifactRef[] = req.files.map((p) => ({
      path: p,
      name: baseName(p),
    }));
    setTasks((prev) =>
      prev.map((t) =>
        t.sessionKey === key
          ? patchLastAssistant(t, (m) => {
              const merged = [...(m.artifacts ?? [])];
              for (const r of refs) {
                if (!merged.some((a) => a.path === r.path)) {
                  merged.push(r);
                }
              }
              return { ...m, artifacts: merged };
            })
          : t,
      ),
    );
    if (refs[0]) {
      void openArtifact(key, refs[0]);
    }
  }

  function handleCreateTask(): void {
    setGalleryOpen(false);
    setComposingNew(true);
    setDraftTask(newTask());
    setActiveId("");
    // 新建任务回到通用助手;若需专家会话由用户在 Composer 重新选择。
    setSelectedExpertSlug(null);
    setComposerSkill(null);
    // 场景是「这一段草稿从哪个场景起手」的上下文,换草稿就该收起,否则新任务的输入框里
    // 会挂着上一段留下的场景芯片。
    setActiveSceneSlug(null);
  }

  /**
   * 选择/清除专家:专家绑定在会话(agent)创建时定型,故切换专家意味着"开一段新会话"。
   *  - 传 slug 且当前不在新建草稿态:先切到新建草稿,再绑定该专家(不污染已有会话);
   *  - 传 null:清除草稿绑定,回到通用助手。
   */
  function handleSelectExpert(slug: string | null): void {
    let freshDraft = false;
    if (slug && !composingNew) {
      // 从任意上下文(含专家画廊)切到「绑定专家的新建草稿」时,关掉画廊,避免与「专家」导航抢选中。
      setGalleryOpen(false);
      setComposingNew(true);
      setDraftTask(newTask());
      setActiveId("");
      setComposerSkill(null);
      freshDraft = true;
    }
    setSelectedExpertSlug(slug);
    if (!slug) {
      return;
    }
    // 填入该专家的第一句快捷提示。这以前是 Composer 里「专家变了就填」的 effect,
    // 但那样切回已有专家任务也会重填一次早已发过的起手语,故改成只在"选专家"这个动作里做。
    // 已有草稿不覆盖(新开的草稿必然为空,不受影响)。
    if (!freshDraft && draftText.trim()) {
      return;
    }
    const m = experts.find((e) => e.slug === slug)?.manifest;
    const prompt = m?.defaultInitPrompt?.trim() || m?.quickPrompts?.[0]?.trim();
    if (prompt) {
      setComposerPrefill((p) => ({ text: prompt, seq: p.seq + 1 }));
    }
  }

  /** 选中侧栏已有任务,退出新建草稿态。 */
  function selectTask(id: string): void {
    setGalleryOpen(false);
    setComposingNew(false);
    setDraftTask(null);
    setActiveId(id);
    setComposerSkill(null);
  }

  /** 置顶:标记 pinned 并移动到列表首位。 */
  function handlePin(id: string): void {
    setTaskMenu(null);
    setTasks((prev) => {
      const target = prev.find((t) => t.id === id);
      if (!target) return prev;
      const rest = prev.filter((t) => t.id !== id);
      return [{ ...target, pinned: true }, ...rest];
    });
  }

  /**
   * 从列表移除任务(归档/删除的共同底层实现)。
   *  - 基于当前 tasks 计算,不在 setState 更新函数里做副作用;
   *  - 若删除的是当前激活任务,则激活切换到剩余列表首位;
   *  - 若清空则补建一个新任务并激活,避免空列表。
   */
  function removeTask(id: string): void {
    // persisted(会话已建)或已有消息的任务:删除时一并回收其会话/任务目录/缓冲。
    // 注意:恢复的持久化任务在未切换查看前 messages 为空,必须靠 persisted 判定,
    // 否则删除后内核里的会话残留,会被下次启动的孤儿发现重新补回(删不掉)。
    const target = tasks.find((t) => t.id === id);
    if (target && (target.persisted || target.messages.length > 0)) {
      void window.api.deleteTask(target.sessionKey);
    }
    // 顺带回收该任务的输入框草稿,免得任务删了草稿还留在内存里。
    setDrafts((d) => {
      if (!(id in d)) {
        return d;
      }
      const rest = { ...d };
      delete rest[id];
      return rest;
    });
    const next = tasks.filter((t) => t.id !== id);
    if (next.length === 0) {
      setTasks([]);
      setGalleryOpen(false);
      setComposingNew(true);
      setDraftTask(newTask());
      setActiveId("");
      return;
    }
    setTasks(next);
    if (id === activeId) {
      // 删的是当前任务:切到下一条并退出画廊/新建草稿,保证侧栏只高亮该任务。
      setGalleryOpen(false);
      setComposingNew(false);
      setDraftTask(null);
      setActiveId(next[0].id);
    }
  }

  /** 归档:轻量移除,无需二次确认。 */
  function handleArchive(id: string): void {
    setTaskMenu(null);
    removeTask(id);
  }

  /**
   * 批量成功后统一收尾:一次性把这些任务从列表里摘掉。
   *
   * 不能循环调 `removeTask` —— 它读的是闭包里的 `tasks`,连着调多次每次都基于同一份旧快照,
   * 后一次的结果会把前一次覆盖掉,最终只删掉一条。会话回收那半边已经在 worker 里逐条做过了。
   */
  function applyTasksRemoved(ids: ReadonlySet<string>): void {
    setDrafts((d) => {
      let touched = false;
      const rest = { ...d };
      for (const id of ids) {
        if (id in rest) {
          delete rest[id];
          touched = true;
        }
      }
      return touched ? rest : d;
    });
    const next = tasks.filter((t) => !ids.has(t.id));
    if (next.length === 0) {
      setTasks([]);
      setGalleryOpen(false);
      setComposingNew(true);
      setDraftTask(newTask());
      setActiveId("");
      return;
    }
    setTasks(next);
    if (ids.has(activeId)) {
      setGalleryOpen(false);
      setComposingNew(false);
      setDraftTask(null);
      setActiveId(next[0].id);
    }
  }

  /** 进入批量态:触发那条若可选就预勾上(它的 `enterBatchMode`)。 */
  function enterBatchMode(id: string): void {
    setTaskMenu(null);
    const target = tasks.find((t) => t.id === id);
    const selectable = target ? isBatchSelectable(deriveTaskStatus(target)) : false;
    setBatchMode(true);
    setSelectedIds(selectable && target ? new Set([target.id]) : new Set());
  }

  function exitBatchMode(): void {
    setBatchMode(false);
    setSelectedIds(new Set());
    setBatchConfirm(null);
    setBatchProgress(null);
    setBatchEmptyError(false);
  }

  /** 勾选一条。执行中不响应,不可选的点了也没反应(与它一致)。 */
  function toggleTaskSelected(id: string): void {
    if (operating) {
      return;
    }
    const target = tasks.find((t) => t.id === id);
    if (!target || !isBatchSelectable(deriveTaskStatus(target))) {
      return;
    }
    setSelectedIds((prev) => toggleSelection(prev, id));
  }

  /** 全选 / 全不选:只针对当前可见(筛选后)那批。 */
  function toggleSelectAll(): void {
    if (operating) {
      return;
    }
    const selectable = collectSelectableIds(filteredTasks, deriveTaskStatus);
    setSelectedIds((prev) => {
      for (const id of selectable) {
        if (!prev.has(id)) {
          return selectable;
        }
      }
      return new Set<string>();
    });
  }

  /** 点删除/归档:先算目标数、开确认框(真正的执行在 runBatch)。 */
  function requestBatch(action: BatchAction): void {
    const selectable = collectSelectableIds(filteredTasks, deriveTaskStatus);
    const effective = filterEffectiveSelection(selectedIds, selectable);
    setBatchEmptyError(false);
    setBatchProgress(null);
    setBatchConfirm({ action, count: effective.size });
  }

  /**
   * 执行批量。目标在**点确认的那一刻**重算一遍 —— 从打开确认框到点下去这段时间里,
   * 某条任务可能已经跑起来了,拿旧集合执行就会误删正在运行的会话。
   */
  async function runBatch(action: BatchAction): Promise<void> {
    const selectable = collectSelectableIds(filteredTasks, deriveTaskStatus);
    const effective = filterEffectiveSelection(selectedIds, selectable);
    const targets = filteredTasks.filter((t) => effective.has(t.id));
    if (targets.length === 0) {
      setBatchEmptyError(true);
      return;
    }
    setOperatingAction(action);
    setBatchProgress({ done: 0, total: targets.length });
    try {
      const summary = await runBatchOperation({
        action,
        items: targets,
        worker: async (t) => {
          // 与单条删除同口径:只有建过会话的才需要回收内核那份,否则会被孤儿发现补回来。
          if (t.persisted || t.messages.length > 0) {
            const res = await window.api.deleteTask(t.sessionKey);
            return { id: t.id, success: res.ok !== false };
          }
          return { id: t.id, success: true };
        },
        onProgress: (done, total) => setBatchProgress({ done, total }),
      });
      if (summary.successIds.length > 0) {
        applyTasksRemoved(new Set(summary.successIds));
      }
      setBatchToast(batchSummaryMessage(summary));
      setBatchConfirm(null);
      if (summary.successIds.length > 0) {
        exitBatchMode();
      }
    } catch (err) {
      if (err instanceof Error && err.message === BATCH_NO_EFFECTIVE_TASK) {
        setBatchEmptyError(true);
      } else {
        setBatchToast("操作失败,请稍后重试");
        setBatchConfirm(null);
      }
    } finally {
      setOperatingAction(null);
      setBatchProgress(null);
    }
  }

  /** 请求删除:打开二次确认弹窗(防误删)。 */
  function requestDelete(id: string): void {
    setTaskMenu(null);
    setDeleteId(id);
  }

  /** 确认删除:执行移除并关闭弹窗。 */
  function confirmDelete(): void {
    if (!deleteId) return;
    removeTask(deleteId);
    setDeleteId(null);
  }

  /** 开始重命名:进入行内编辑态。 */
  function startRename(id: string, title: string): void {
    setTaskMenu(null);
    setEditingId(id);
    setEditText(title);
  }

  /** 提交重命名:非空则写回标题。 */
  function commitRename(): void {
    const id = editingId;
    if (!id) return;
    const title = editText.trim();
    if (title) {
      setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)));
    }
    setEditingId(null);
    setEditText("");
  }

  /** 终止当前任务运行:即时把最后一条助手消息标记为已取消,并向网关发送中断。 */
  async function handleAbort(): Promise<void> {
    const sessionKey = active.sessionKey;
    updateActive((t) =>
      patchLastAssistant(t, (m) => ({
        ...m,
        streaming: false,
        aborted: true,
        userAborted: true,
      })),
    );
    await window.api.abortAgent(sessionKey);
  }

  async function handleSend(text: string, files: string[]): Promise<void> {
    // 发送给 agent 的文本仍需带上文件绝对路径(agent 据此读写);
    // 但 UI 展示时把文件与正文分离,正文只保留用户输入的纯文本。
    const refs = files.length
      ? `\n\n引用文件:\n${files.map((f) => `· ${f}`).join("\n")}`
      : "";
    // 按对话模式注入系统指令前缀(仅进入发送内容,不进入 UI 展示)。
    // openclaw 工具白名单为配置级、不支持每轮传参,故此处以 prompt 软约束实现模式差异。
    const modePrompt =
      mode === "ask"
        ? "【对话模式:仅问答】请只进行只读分析与回答,不要修改任何文件、不要执行有副作用的命令或工具。\n\n"
        : mode === "plan"
          ? "【对话模式:规划】请先输出一份清晰的分步执行计划,不要直接修改文件或执行命令;等我确认后再执行。\n\n"
          : "";
    const sentContent = modePrompt + text + refs;
    // 任务列表尚未就绪(占位任务)时忽略发送,避免为 '__loading__' 创建无效 agent。
    if (active.id === EMPTY_TASK.id) {
      return;
    }

    const userMsg: ChatMessage = {
      role: "user",
      content: text,
      files: files.length ? files : undefined,
    };
    const placeholder: ChatMessage = {
      role: "assistant",
      content: "",
      streaming: true,
      // 请求刚发出、内核还没回任何事件,此刻就是在等模型。
      liveStatus: STATUS_WAITING,
      timeline: [],
      startedAt: Date.now(),
    };

    let sessionKey: string;
    let taskId: string;

    // 该会话绑定的专家 slug:新建态取草稿选中的专家,否则沿用已有任务的绑定。
    // 它同时决定任务挂在哪个 agent 上,所以必须在拼 sessionKey 之前定下来。
    const expertSlugForEnsure = composingNew
      ? (selectedExpertSlug ?? undefined)
      : active.expertSlug;

    if (composingNew) {
      // 首条消息发送时才把任务写入侧栏列表(对齐 WorkBuddy)。
      const t = draftTask ?? newTask();
      taskId = t.id;
      // 绑定草稿选中的专家(若有):快照名/头像用于渲染,slug 用于人设注入。
      const boundExpert = selectedExpertSlug
        ? experts.find((e) => e.slug === selectedExpertSlug)
        : undefined;
      /**
       * 键在这里才定型:草稿阶段按通用助手拼的,而用户可能在发送前才选了专家。
       * 晚一步算,省掉一路同步草稿键的麻烦。
       */
      sessionKey = taskKeyFor(taskId, boundExpert);
      const title = text.slice(0, 20) || t.title;
      setTasks((prev) => [
        {
          ...t,
          sessionKey,
          title,
          messages: [userMsg, placeholder],
          expertSlug: boundExpert?.slug,
          expertName: boundExpert?.name,
          expertAvatar: boundExpert?.manifest.avatar,
        },
        ...prev,
      ]);
      setActiveId(taskId);
      setComposingNew(false);
      setDraftTask(null);
      // 场景只服务于「起手」:消息已发出,输入框里的场景芯片就该收掉
      // (WorkBuddy 那边同理——场景标签是输入块的一部分,随消息一起消费掉)。
      setActiveSceneSlug(null);
    } else {
      sessionKey = active.sessionKey;
      taskId = active.id;
      updateActive((t) => ({
        ...t,
        title: t.messages.length === 0 ? text.slice(0, 20) || t.title : t.title,
        messages: [...t.messages, userMsg, placeholder],
      }));
    }

    // 本轮要绑定的工作空间:只有新建任务那一刻才谈得上选择,已有任务沿用它建会话时定下的。
    const workspaceForEnsure = composingNew
      ? (draftWorkspace?.path ?? undefined)
      : undefined;

    // 新会话已定型,清除草稿绑定(下一次新建默认回到通用助手 / 不使用工作空间)。
    if (composingNew) {
      setSelectedExpertSlug(null);
      setDraftWorkspace(null);
    }
    /**
     * 惰性把任务就位(首次发消息时):建会话 + 指定工作目录;幂等,重复调无副作用。
     *
     * 通常是亚秒级,但两种情况会卡住:「刚装完专家立刻召唤」撞上那轮 `agents.list` 热加载
     * (见 main/agent-manager),以及冷网关那 17~32 秒的 provider auth 预热(事件循环被占满,
     * 任何就位请求都排在后面)。这段用 WorkBuddy 同位置的「正在准备执行」浮层盖住。
     *
     * **只有新建任务才盖**:那时对话区是空的,盖住是「先准备后露对话」,顺序照 WorkBuddy——
     * 它的 WorkspacePreparing 也是 z-index 盖在 CBChat 之上、创建完成才淡出。已有任务不盖:
     * 它有历史消息 + 流式占位「等待模型响应」,盖上去反而挡住内容。
     * 也**不再延迟**:新建任务立刻盖,免得像之前那样先闪一下空对话再被盖住。
     */
    if (composingNew) {
      setPreparing(true);
    }
    const ensured = await window.api
      .ensureTaskSession(sessionKey, expertSlugForEnsure, workspaceForEnsure)
      .finally(() => setPreparing(false));
    if (!ensured.ok) {
      setTasks((prev) =>
        prev.map((t) =>
          t.sessionKey === sessionKey
            ? patchLastAssistant(t, (m) => ({
                ...m,
                streaming: false,
                error: ensured.error || "任务初始化失败,请稍后重试。",
              }))
            : t,
        ),
      );
      return;
    }
    // 会话已就绪:标记该任务纳入持久化(重启后可恢复,历史从 session 读取)。
    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, persisted: true } : t)),
    );

    // 本轮的思考档位:界面显示什么就发什么,判定与 Composer 共用 `@shared/types` 里那几个函数。
    const selOption = chatOptions.find((o) => o.key === selectedModel);
    const selPref = selectedModel ? thinkPrefs[selectedModel] : undefined;
    const isExpertSession = !!expertSlugForEnsure;
    const wantThinking = thinkingOnOf(selOption, selPref);
    let effectiveThinking: ChatThinking = "off";
    if (wantThinking) {
      // 档位未知时退到内核自己的会话默认档 medium(`sessions/defaults.ts:9`),不是我们猜的值;
      // 内核再按该模型的 thinkingLevelMap 限幅。档位不可控的族(Grok 4+ / o1 的两个老快照)
      // 也走这条:它们的 compat.supportsReasoningEffort=false,内核压根不会把档位发给上游
      // (`openai-completions.ts:751,755`),但思考正文照旧解析。
      effectiveThinking =
        thinkingLevelOf(selOption, selPref) ??
        (isExpertSession ? "high" : "medium");
    }
    const res = await window.api.sendAgent(sessionKey, sentContent, {
      model: selectedModel || undefined,
      thinking: effectiveThinking,
      // 与档位解耦地告诉主进程"这一轮要不要思考正文"。原先是从档位反推(≠off 即要),
      // 于是"会思考但档位不可控"的模型只能传 off,顺带把思考正文也关掉了。
      reasoning: wantThinking,
    });
    if (!res.ok) {
      // 发送失败:把最后一条助手消息标记为错误态。
      setTasks((prev) =>
        prev.map((t) =>
          t.sessionKey === sessionKey
            ? patchLastAssistant(t, (m) => ({
                ...m,
                streaming: false,
                error: res.error || "发送失败,请确认本地引擎已就绪后重试。",
              }))
            : t,
        ),
      );
    }
  }

  /**
   * 收起侧栏前先关掉挂在侧栏按钮上的浮层。
   * 行内菜单与「全部任务」气泡都是 fixed 定位、坐标锚在触发按钮上,
   * 按钮随侧栏一起卸载后它们会孤零零留在屏幕上,点空白才消失。
   */
  const collapseSidebar = (): void => {
    setTaskMenu(null);
    setPicker(false);
    setFilterMenu(null);
    setAccountOpen(false);
    setSidebarCollapsed(true);
  };

  return (
    <div className="app-shell">
      {!sidebarCollapsed && (
        <aside className="sidebar">
          <div className="sidebar-head">
            <div className="brand-sm">
              <div className="brand-text">
                <span className="brand-name">云雾助手</span>
                <span className="brand-ver">v0.1.0</span>
              </div>
            </div>
            <div className="head-icons">
              <button
                className="icon-btn"
                title="收起侧边栏"
                aria-label="收起侧边栏"
                onClick={collapseSidebar}
              >
                <PanelLeft size={15} strokeWidth={1.6} />
              </button>
              <button
                className="icon-btn"
                title="搜索任务"
                onClick={openTaskPicker}
              >
                <Search size={15} strokeWidth={1.6} />
              </button>
              <span className="task-filter-trigger">
                <button
                  className={`icon-btn${filterMenu ? " on" : ""}`}
                  title="筛选"
                  aria-label="筛选"
                  aria-pressed={filterActive}
                  onClick={(e) => openTaskFilter(e.currentTarget)}
                >
                  <SlidersHorizontal size={15} strokeWidth={1.6} />
                </button>
                {filterActive && (
                  <span className="task-filter-trigger__dot" aria-hidden />
                )}
              </span>
            </div>
          </div>

          <nav className="nav">
            <button
              className={`nav-item primary${composingNew && !galleryOpen ? " active" : ""}`}
              onClick={handleCreateTask}
              disabled={restoring}
            >
              {/* ⊕ 与折叠态顶栏的新建任务同一个图标(WorkBuddy 两处也是同一个)。 */}
              <CirclePlus size={16} strokeWidth={1.8} className="nav-ico" />
              <span className="nav-label">新建任务</span>
            </button>
            {NAV_ITEMS.map((n) => {
              // 「专家」为已上线的画廊入口;其余仍为占位。
              const isExperts = n.id === "experts";
              return (
                <button
                  key={n.id}
                  className={`nav-item${isExperts && galleryOpen ? " active" : ""}`}
                  title={isExperts ? undefined : "即将上线"}
                  onClick={isExperts ? openGallery : undefined}
                >
                  <n.icon
                    size={16}
                    strokeWidth={1.8}
                    className="nav-ico"
                    fill={isExperts && galleryOpen ? "currentColor" : "none"}
                  />
                  <span className="nav-label">{n.label}</span>
                  {n.tail && <span className="nav-tail">{n.tail}</span>}
                </button>
              );
            })}
          </nav>

          {/*
          唯一的滚动区。侧栏本身 overflow:hidden、头尾 flex-shrink:0,中间这层
          flex:1 + min-height:0 —— 形状取自内核自带控制台的
          .sidebar-shell__body / .sidebar-nav,任务再多也不会把账户区顶出可视区。
        */}
          <div className="sidebar-body" onScroll={() => setTaskMenu(null)}>
            <div className="side-section">
              {/* caret 紧跟标题、常驻显示 —— 照 WorkBuddy 一级分区 `.conversation-section-chevron`
                (14px,只靠旋转表达展开/收起)。 */}
              <button
                className="side-section-title"
                onClick={() => setTaskOpen((v) => !v)}
              >
                <span className="sec-label">
                  任务 (
                  {restoring && tasks.length === 0 ? "…" : filteredTasks.length})
                </span>
                <ChevronDown
                  size={14}
                  strokeWidth={2}
                  className={`sec-caret ${taskOpen ? "" : "collapsed"}`}
                />
              </button>
              {taskOpen && restoring && tasks.length === 0 && (
                <ul className="task-list">
                  <li className="task-item">
                    <LoadingLottie size="xs" />
                    <span className="task-title">正在恢复任务…</span>
                  </li>
                </ul>
              )}
              {taskOpen && !(restoring && tasks.length === 0) && (
                <>
                  <ul className="task-list">
                    {visibleTasks.length === 0 && (
                      <li className="task-filter-empty">
                        {filterActive ? "没有匹配的任务" : "暂无任务"}
                      </li>
                    )}
                    {visibleTasks.map((t) => {
                      const batchSelectable =
                        batchMode && isBatchSelectable(deriveTaskStatus(t));
                      const batchDisabled = batchMode && !batchSelectable;
                      return (
                      <li
                        key={t.id}
                        /* menu-open:菜单一打开,遮罩就整片盖住侧栏,这一行的 :hover 立刻失效
                           —— 行的底色、行尾三个操作按钮全靠 hover 显示,于是菜单还开着、
                           被操作的那一行却已经"没了"。照 WorkBuddy 的 `_menuOpen_11ei8_297`
                           补一个显式类,把 hover 那几条规则原样镜像一遍(见 styles.css)。 */
                        className={[
                          "task-item",
                          !composingNew &&
                          !galleryOpen &&
                          !batchMode &&
                          t.id === activeId
                            ? "active"
                            : "",
                          taskMenu?.id === t.id ? "menu-open" : "",
                          batchMode ? "batch" : "",
                          batchDisabled ? "batch-disabled" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        title={
                          batchDisabled
                            ? (batchDisabledReason(deriveTaskStatus(t)) ?? undefined)
                            : undefined
                        }
                        onClick={() => {
                          if (batchMode) {
                            toggleTaskSelected(t.id);
                            return;
                          }
                          if (editingId !== t.id) {
                            selectTask(t.id);
                          }
                        }}
                      >
                        {batchMode && (
                          <span
                            className={`task-check${selectedIds.has(t.id) ? " on" : ""}`}
                            aria-hidden
                          >
                            {selectedIds.has(t.id) && (
                              <Check size={11} strokeWidth={3} />
                            )}
                          </span>
                        )}
                        {t.pinned && (
                          <Pin
                            size={12}
                            strokeWidth={2}
                            className="task-pin-mark"
                          />
                        )}
                        {editingId === t.id ? (
                          <input
                            className="task-rename"
                            value={editText}
                            autoFocus
                            onChange={(e) => setEditText(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            onBlur={commitRename}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitRename();
                              if (e.key === "Escape") {
                                setEditingId(null);
                                setEditText("");
                              }
                            }}
                          />
                        ) : (
                          <>
                            <span className="task-title">{t.title}</span>
                            {/* 行尾:状态图标与相对时间二选一,hover 时两者都让位给操作按钮。
                              照 WorkBuddy AgentCard trailingStatus:
                              working/planning → 绿转圈;pending → 待确认;failed → 红叹号;
                              completed 故意不画(`shouldHideStatusIcon`),只留时间。 */}
                            {(() => {
                              const kind = taskTrailingKind(t);
                              if (kind) {
                                const label = TASK_TRAILING_LABEL[kind];
                                return (
                                  <span
                                    className={`task-status task-status-${kind}`}
                                    title={label}
                                    aria-label={label}
                                  >
                                    {kind === "working" && <RunningSpinner />}
                                    {kind === "pending" && (
                                      <MessageCircleQuestion
                                        size={14}
                                        strokeWidth={1.8}
                                      />
                                    )}
                                    {kind === "failed" && (
                                      <CircleAlert size={14} strokeWidth={1.8} />
                                    )}
                                  </span>
                                );
                              }
                              return (
                                t.createdAt > 0 && (
                                  <span className="task-time">
                                    {formatTaskTime(t.createdAt)}
                                  </span>
                                )
                              );
                            })()}
                          </>
                        )}
                        {/* 批量态下行尾操作按钮整组撤走:此时整行是一个复选框,
                          再摆三个会点错(它那边同样只剩勾选)。 */}
                        {!batchMode && (
                          <div
                            className="task-actions"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              className="task-act"
                              title="更多"
                              onClick={(e) =>
                                taskMenu?.id === t.id
                                  ? setTaskMenu(null)
                                  : openTaskMenu(t.id, e.currentTarget)
                              }
                            >
                              <Ellipsis size={15} strokeWidth={2} />
                            </button>
                            <button
                              className="task-act"
                              title="归档"
                              onClick={() => handleArchive(t.id)}
                            >
                              <Archive size={14} strokeWidth={1.8} />
                            </button>
                            <button
                              className="task-act"
                              title="置顶"
                              onClick={() => handlePin(t.id)}
                            >
                              <Pin size={14} strokeWidth={1.8} />
                            </button>
                          </div>
                        )}
                      </li>
                      );
                    })}
                  </ul>
                  {!batchMode && filteredTasks.length > SHOW_MORE_THRESHOLD && (
                    <button
                      className="task-show-more"
                      onClick={() => setTasksShowAll((v) => !v)}
                    >
                      {tasksShowAll
                        ? "收起"
                        : `查看更多 (${filteredTasks.length - SHOW_MORE_THRESHOLD})`}
                    </button>
                  )}
                </>
              )}
            </div>

            <div className="side-section">
              <button
                className="side-section-title"
                onClick={() => setSpaceOpen((v) => !v)}
              >
                <span className="sec-label">空间 (1)</span>
                <ChevronDown
                  size={14}
                  strokeWidth={2}
                  className={`sec-caret ${spaceOpen ? "" : "collapsed"}`}
                />
              </button>
              {/* 空间项自身可展开出二级列表(WorkBuddy「项目新手引导 ⌄」下面挂子项);
                二级内容尚未接入 —— 应用里根本没有空间/项目这个数据模型(任务元数据
                没有 projectId/cwd 之类的归属字段,主进程也没有对应 IPC),所以展开后给
                一条占位而不是伪造条目。等真有了空间数据再把这里换成真实列表。 */}
              {spaceOpen && (
                <ul className="task-list">
                  <li
                    className="task-item group"
                    onClick={() => setSpaceItemOpen((v) => !v)}
                  >
                    <span className="task-title">项目新手指引</span>
                    <ChevronDown
                      size={12}
                      strokeWidth={2}
                      className={`task-caret${spaceItemOpen ? "" : " collapsed"}`}
                    />
                  </li>
                  {spaceItemOpen && (
                    <li className="task-item sub placeholder">
                      <span className="task-title">暂无内容</span>
                    </li>
                  )}
                </ul>
              )}
            </div>
          </div>

          {/* 批量态占掉账户区那一格:第一行全选 + 已选数 + 退出,第二行删除 / 归档。
            布局与顺序照 WorkBuddy `BatchOperationBar`(conversation-batch-bar)。 */}
          {batchMode ? (
            <div className="sidebar-foot batch-bar" role="region" aria-label="批量操作">
              <div className="batch-bar-top">
                <button
                  className="batch-selectall"
                  onClick={toggleSelectAll}
                  disabled={operating}
                >
                  {(() => {
                    const { allSelected, indeterminate } = getSelectAllState(
                      filteredTasks,
                      selectedIds,
                      deriveTaskStatus,
                    );
                    return (
                      <span
                        className={`task-check${allSelected ? " on" : indeterminate ? " part" : ""}`}
                        aria-hidden
                      >
                        {allSelected && <Check size={11} strokeWidth={3} />}
                        {!allSelected && indeterminate && (
                          <Minus size={11} strokeWidth={3} />
                        )}
                      </span>
                    );
                  })()}
                  <span>全选</span>
                  {selectedIds.size > 0 && (
                    <span className="batch-count">({selectedIds.size})</span>
                  )}
                </button>
                <button
                  className="icon-btn"
                  title="退出批量操作"
                  aria-label="退出批量操作"
                  disabled={operating}
                  onClick={exitBatchMode}
                >
                  <X size={15} strokeWidth={1.8} />
                </button>
              </div>
              <div className="batch-bar-actions">
                {/* 刻意不复用 .btn-ghost.sm:那条更靠后,会把字号压回 12.5、把红边换成淡红,
                  而这两个按钮要的是它 foundation Button medium 档 + danger outline。 */}
                <button
                  className="batch-act danger"
                  disabled={selectedIds.size === 0 || operating}
                  onClick={() => requestBatch("delete")}
                >
                  <Trash2 size={15} strokeWidth={1.8} />
                  删除
                </button>
                <button
                  className="batch-act"
                  disabled={selectedIds.size === 0 || operating}
                  onClick={() => requestBatch("archive")}
                >
                  <Archive size={15} strokeWidth={1.8} />
                  归档
                </button>
              </div>
            </div>
          ) : (
          <div className="sidebar-foot">
            <div className="account">
              {/*
              就绪后只留头像(WorkBuddy 底栏就是「头像 + 右侧铃铛/发现」,没有账户名那两行)。
              但准备中 / 启动失败时保留文字:网关从启动到 ready 要 20s 以上,
              这段时间把唯一的进度提示压缩成一个小圆点,用户只会以为程序卡死了。
            */}
              <button
                className="account-trigger"
                onClick={() => setAccountOpen((v) => !v)}
                title="云雾账户"
              >
                <div className="avatar sm">
                  云
                  <span className={`avatar-badge ${ready ? "on" : "off"}`} />
                </div>
                {!ready && (
                  <span className="account-sub">
                    {preflightFailed ? "启动失败" : "准备中…"}
                  </span>
                )}
              </button>
              <button className="icon-btn" title="通知">
                <Bell size={15} strokeWidth={1.6} />
              </button>
              <button className="icon-btn" title="发现">
                <Compass size={15} strokeWidth={1.6} />
              </button>
              {accountOpen && (
                <>
                  <FloatingMask
                    className="menu-mask"
                    onClick={() => setAccountOpen(false)}
                  />
                  <div className="account-menu up">
                    {/*
                      头部照 WorkBuddy 的 MenuHeader:账号名(16px/600)+ 复制 UID 的小按钮,
                      下面一行副标题给次要身份信息(它放手机号,我们放站点域名)。
                      它头部**没有头像** —— 头像在下面那颗触发器上,菜单里不再重复一遍。
                    */}
                    <div className="account-menu-header">
                      <div className="account-menu-name">
                        <span className="account-menu-name-text">
                          {accountSnap?.balance?.username ?? activation.username}
                        </span>
                        <button
                          className="account-menu-copy"
                          title="复制 UID"
                          aria-label="复制 UID"
                          onClick={() => {
                            void navigator.clipboard
                              .writeText(String(activation.userId))
                              .then(() => setBatchToast("已复制 UID"))
                              .catch(() => setBatchToast("复制失败"));
                          }}
                        >
                          <Copy size={13} strokeWidth={1.8} />
                        </button>
                      </div>
                      <div className="account-menu-sub">
                        UID {activation.userId} ·{" "}
                        {activation.baseUrl.replace(/^https?:\/\//, "")}
                      </div>
                    </div>
                    <div className="account-sep" />
                    <AccountBalanceRow
                      snapshot={accountSnap}
                      fetching={accountFetching}
                      onRefresh={() => void loadAccount(true)}
                      onRelogin={() => {
                        setAccountOpen(false);
                        onRelogin();
                      }}
                    />
                    <div className="account-sep" />
                    <div className="account-row">
                      <span>默认模型</span>
                      <b className="mono">{activation.defaultModel}</b>
                    </div>
                    <div className="account-row">
                      <span>可用模型</span>
                      <b>{activation.models.length}</b>
                    </div>
                    <div className="account-sep" />
                    <div className="account-appearance">
                      <span>外观</span>
                      <div className="seg-toggle">
                        <button
                          className={theme === "light" ? "on" : ""}
                          onClick={() => {
                            applyTheme("light");
                            setTheme("light");
                          }}
                        >
                          浅色
                        </button>
                        <button
                          className={theme === "dark" ? "on" : ""}
                          onClick={() => {
                            applyTheme("dark");
                            setTheme("dark");
                          }}
                        >
                          深色
                        </button>
                      </div>
                    </div>
                    <div className="account-sep" />
                    <button
                      className="account-action"
                      onClick={() => {
                        setAccountOpen(false);
                        setSettingsInitial("account");
                      }}
                    >
                      设置
                    </button>
                    <button
                      className="account-action"
                      onClick={() => {
                        setAccountOpen(false);
                        setSettingsInitial("models");
                      }}
                    >
                      模型管理
                    </button>
                    <button
                      className="account-action"
                      onClick={() => window.api.openWorkspaceDir()}
                    >
                      打开工作区文件夹
                    </button>
                    <button
                      className="account-action danger"
                      onClick={async () => {
                        await window.api.clearActivation();
                        onSignOut();
                      }}
                    >
                      退出登录
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
          )}
        </aside>
      )}

      {/* 行内菜单渲染在滚动区之外,fixed 定位,否则会被 .sidebar-body 裁掉。 */}
      {taskMenu &&
        (() => {
          const t = tasks.find((x) => x.id === taskMenu.id);
          if (!t) {
            return null;
          }
          return (
            <>
              <FloatingMask
                className="menu-mask"
                onClick={() => setTaskMenu(null)}
              />
              {/* 首帧还没量到高度,先渲染出来但不可见 —— 拿不到 offsetHeight 就没法定位。 */}
              <div
                className="task-menu"
                ref={taskMenuRef}
                style={{
                  top: taskMenuPos?.top ?? 0,
                  left: taskMenuPos?.left ?? 0,
                  visibility: taskMenuPos ? "visible" : "hidden",
                }}
              >
                {/* 「批量操作」排第一项,与 WorkBuddy 的任务右键菜单同序。 */}
                <button
                  className="task-menu-item"
                  onClick={() => enterBatchMode(t.id)}
                >
                  <ListChecks size={15} strokeWidth={1.8} />
                  批量操作
                </button>
                <button
                  className="task-menu-item"
                  onClick={() => {
                    void window.api.openTaskDir(t.sessionKey);
                    setTaskMenu(null);
                  }}
                >
                  <FolderOpen size={15} strokeWidth={1.8} />
                  打开文件夹
                </button>
                <button
                  className="task-menu-item"
                  onClick={() => startRename(t.id, t.title)}
                >
                  <Pencil size={15} strokeWidth={1.8} />
                  重命名
                </button>
                <button
                  className="task-menu-item"
                  title="即将支持"
                  onClick={() => setTaskMenu(null)}
                >
                  <Save size={15} strokeWidth={1.8} />
                  保存到工作空间
                </button>
                <button
                  className="task-menu-item"
                  title="即将支持"
                  onClick={() => setTaskMenu(null)}
                >
                  <Share2 size={15} strokeWidth={1.8} />
                  分享任务
                </button>
                <div className="task-menu-sep" />
                <button
                  className="task-menu-item danger"
                  onClick={() => requestDelete(t.id)}
                >
                  <Trash2 size={15} strokeWidth={1.8} />
                  删除任务
                </button>
              </div>
            </>
          );
        })()}

      {/* WorkBuddy `conversation-search-modal`：居中遮罩、固定头部、仅结果列表滚动。 */}
      {picker && (
        <FloatingMask className="task-picker-mask" onClick={() => setPicker(false)}>
          <div
            className="task-picker"
            role="dialog"
            aria-modal="true"
            aria-label="搜索任务"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="task-picker-head">
              <div className="task-picker-search">
                <Search size={16} strokeWidth={1.8} />
                <input
                  autoFocus
                  value={pickerQuery}
                  placeholder="搜索任务"
                  onChange={(e) => setPickerQuery(e.target.value)}
                />
              </div>
              <button
                type="button"
                className="task-picker-close"
                title="关闭"
                aria-label="关闭"
                onClick={() => setPicker(false)}
              >
                <X size={16} strokeWidth={1.8} />
              </button>
            </div>
            <div className="task-picker-body">
              {pickerResults.length === 0 && (
                <div className="task-picker-empty">没有匹配的任务</div>
              )}
              {pickerResults.length > 0 && (
                <>
                  <div className="task-picker-count">
                    {pickerQuery
                      ? `搜索到 ${pickerResults.length} 个任务`
                      : "最近任务"}
                  </div>
                  <div className="task-picker-list">
                    {pickerResults.map((t) => {
                      const meta = taskSearchMeta(t);
                      return (
                        <button
                          type="button"
                          key={t.id}
                          className="task-picker-item"
                          onClick={() => {
                            selectTask(t.id);
                            setPicker(false);
                          }}
                        >
                          <span className="task-picker-title">
                            <TaskSearchText text={t.title} query={pickerQuery} />
                          </span>
                          {meta && (
                            <span className="task-picker-meta" title={meta}>
                              <Folder
                                size={14}
                                strokeWidth={1.7}
                                className="task-picker-meta-icon"
                              />
                              <span className="task-picker-meta-text">
                                <TaskSearchText text={meta} query={pickerQuery} />
                              </span>
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </div>
        </FloatingMask>
      )}

      {filterMenu && (
        <>
          <FloatingMask
            className="menu-mask"
            onClick={() => setFilterMenu(null)}
          />
          <div
            className="task-filter-popover"
            ref={filterRef}
            role="menu"
            style={{
              top: filterPos?.top ?? 0,
              left: filterPos?.left ?? filterMenu.anchorLeft,
              visibility: filterPos ? "visible" : "hidden",
            }}
          >
            <TaskFilterMenu
              values={taskFilter}
              onChange={setTaskFilter}
              onClear={() => setTaskFilter(EMPTY_TASK_FILTER)}
            />
          </div>
        </>
      )}

      <main
        className={`main${sidebarCollapsed ? " full" : ""}${showWelcome ? " welcome" : ""}`}
      >
        {artifactPreview && (
          <aside className="artifact-preview" ref={artifactPreviewRef}>
            <header className="artifact-preview-head">
              <FileText size={15} strokeWidth={1.8} />
              <span className="artifact-preview-titles">
                <span
                  className="artifact-preview-name"
                  title={artifactPreview.abs || artifactPreview.path}
                >
                  {artifactPreview.name}
                </span>
                {(artifactPreview.abs || artifactPreview.path) && (
                  <button
                    type="button"
                    className="artifact-preview-path"
                    title={`点击定位:${artifactPreview.abs || artifactPreview.path}`}
                    onClick={() =>
                      void window.api.revealArtifact(
                        active.sessionKey,
                        artifactPreview.path,
                      )
                    }
                  >
                    {artifactPreview.abs || artifactPreview.path}
                  </button>
                )}
              </span>
              <button
                className="artifact-preview-close"
                title="在文件夹中显示该文件"
                aria-label="在文件夹中显示该文件"
                onClick={() =>
                  void window.api.revealArtifact(
                    active.sessionKey,
                    artifactPreview.path,
                  )
                }
              >
                <FolderOpen size={15} strokeWidth={1.8} />
              </button>
              <button
                className="artifact-preview-close"
                aria-label="关闭预览"
                onClick={() => setArtifactPreview(null)}
              >
                <X size={16} strokeWidth={2} />
              </button>
            </header>
            {/* 同一任务产出多份文件时给一条切换条,「查看所有产出物」才名副其实。 */}
            {taskArtifacts.length > 1 && (
              <div className="artifact-preview-tabs">
                {taskArtifacts.map((a) => (
                  <button
                    key={a.path}
                    className={`artifact-preview-tab${a.path === artifactPreview.path ? " active" : ""}`}
                    title={a.path}
                    onClick={() => void openArtifact(active.sessionKey, a)}
                  >
                    {a.name}
                  </button>
                ))}
              </div>
            )}
            <div className="artifact-preview-body">
              {artifactPreview.loading ? (
                <div className="artifact-preview-loading">
                  <LoadingLottie size="sm" />
                </div>
              ) : artifactPreview.error ? (
                <div className="artifact-preview-empty">
                  {artifactPreview.error}
                </div>
              ) : artifactPreview.imageBase64 ? (
                <ArtifactImagePreview
                  base64={artifactPreview.imageBase64}
                  name={artifactPreview.name}
                />
              ) : !artifactPreview.previewable ? (
                <div className="artifact-preview-empty">
                  {isImagePath(artifactPreview.name)
                    ? "图片过大,不做预览"
                    : "该文件类型不支持文本预览"}
                </div>
              ) : (
                <>
                  {/^#|\.md$/i.test(artifactPreview.path) ||
                  /(^|\n)\s{0,3}#{1,6}\s|\|.*\|/.test(
                    artifactPreview.content,
                  ) ? (
                    <div className="artifact-preview-md">
                      <Markdown text={artifactPreview.content} />
                    </div>
                  ) : (
                    <pre className="artifact-preview-pre">
                      {artifactPreview.content}
                    </pre>
                  )}
                  {artifactPreview.truncated && (
                    <div className="artifact-preview-more">
                      内容较大,仅预览前 512KB
                    </div>
                  )}
                </>
              )}
            </div>
          </aside>
        )}
        <header className="main-head">
          {/* 收起后由顶栏接管这两个入口(展开在前、新建任务在后),
              位置与顺序照 WorkBuddy topbar:两个按钮都渲染在标题容器之前。 */}
          {sidebarCollapsed && (
            <div className="head-lead">
              <button
                className="icon-btn"
                title="展开侧边栏"
                aria-label="展开侧边栏"
                onClick={() => setSidebarCollapsed(false)}
              >
                <PanelLeft size={15} strokeWidth={1.6} />
              </button>
              <button
                className="icon-btn"
                title="新建任务"
                aria-label="新建任务"
                onClick={handleCreateTask}
                disabled={restoring}
              >
                <CirclePlus size={16} strokeWidth={1.8} />
              </button>
            </div>
          )}
          {!showWelcome && (
            <div className="main-title-wrap">
              {editingId === active.id ? (
                <input
                  className="main-title-input"
                  value={editText}
                  autoFocus
                  onChange={(e) => setEditText(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") {
                      setEditingId(null);
                      setEditText("");
                    }
                  }}
                  aria-label="任务名称"
                />
              ) : (
                <>
                  <div className="main-title" title={active.title}>
                    {active.title}
                  </div>
                  {active.id !== "__loading__" && (
                    <button
                      className="main-title-edit"
                      title="修改任务名称"
                      aria-label="修改任务名称"
                      onClick={() => startRename(active.id, active.title)}
                    >
                      <Pencil size={14} strokeWidth={1.8} />
                    </button>
                  )}
                </>
              )}
            </div>
          )}
          {!showWelcome && (
            <div className="head-actions">
              <button className="icon-btn" title="搜索">
                <Search size={15} strokeWidth={1.6} />
              </button>
              <button className="icon-btn" title="分享">
                <Share2 size={15} strokeWidth={1.6} />
              </button>
              <button className="icon-btn" title="历史">
                <History size={15} strokeWidth={1.6} />
              </button>
              <button className="icon-btn" title="侧栏">
                <PanelRight size={15} strokeWidth={1.6} />
              </button>
            </div>
          )}
        </header>

        {/* 必须挂在 .main-head 之后:画廊整片盖住会话区,而 Windows 的原生拖拽区
            按几何位置判定、不认谁盖在谁前面,只按 DOM 顺序把各元素的矩形叠成
            并集再减去 no-drag。排在 .main-head 之前的话,画廊头部自己声明的
            drag / no-drag 都会被后面 .main-head 的 drag 覆盖回去 —— 表现是
            搜索框和 tab 点不动。画廊是 absolute,挪位置不影响布局。
            **这是全局唯一一处**:当初从 <main> 开头挪过来时旧的那份没删,于是两份完全重叠地
            各渲染一遍、各拉一遍市场快照与精选场景。两份叠在同一坐标上,肉眼看不出来,
            是 2026-08-12 数卡片数(9 条数据渲染出 18 张)才露的马脚。 */}
        {galleryOpen && (
          <MarketGallery
            onSummonExpert={handleSummonExpert}
            onTrySkill={handleTrySkill}
            onComposePrefill={handleComposePrefill}
          />
        )}

        {/* 会话就位慢时盖住会话区与输入框(顶栏留着,不然窗口拖不动)。
            顺带把输入框挡住:就位没完就再发一条,只会排在同一个队列后面白等。 */}
        <WorkspacePreparing visible={preparing} />

        <div
          className={`chat-log${showWelcome ? " welcome" : ""}`}
          ref={logRef}
          onScroll={handleLogScroll}
          onWheel={handleLogWheel}
        >
          {active.messages.length === 0 ? (
            historyLoading ? (
              <div className="chat-history-loading">
                <LoadingLottie size="lg" label="正在载入" />
                <span>正在载入对话…</span>
              </div>
            ) : (
              <div className="empty-state">
                <h2>今天需要我帮你做点什么?</h2>
                {ready ? (
                  /* 场景胶囊不在这里 —— 它属于输入区(见下方 .home-chips),
                   对齐 WorkBuddy 的 .wb-home-composer(chips + 输入框,gap 12px)。 */
                  <div className="scenario-tabs">
                    {MODE_TABS.map((t) => (
                      <button
                        key={t.id}
                        className={`scenario-tab${t.id === sceneMode ? " active" : ""}`}
                        onClick={() => switchSceneMode(t.id)}
                      >
                        <t.icon
                          size={16}
                          strokeWidth={1.8}
                          className="scenario-tab-icon"
                        />
                        {t.label}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="prepare-panel">
                    <div className="prepare-head">
                      {preflightFailed ? (
                        <span className="prepare-title fail">
                          启动检查未通过
                        </span>
                      ) : (
                        <span className="prepare-title">
                          <LoadingLottie size="xs" />
                          正在准备本地引擎…
                        </span>
                      )}
                    </div>
                    <div className="prepare-steps">
                      {(preflight?.steps ?? []).map((s) => (
                        <div key={s.id} className={`prep-step ${s.status}`}>
                          {prepIcon(s.status)}
                          <span className="prep-label">{s.label}</span>
                          {(s.hint || s.error) && (
                            <span className="prep-hint">
                              {s.error || s.hint}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                    {preflightFailed && (
                      <button className="prepare-retry" onClick={runPreflight}>
                        <RefreshCw size={14} strokeWidth={2} />
                        重试
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          ) : (
            active.messages.map((m, i) => {
              if (m.role !== "assistant") {
                return (
                  <div key={`${active.id}-${i}`} className="msg user">
                    {(m.content || (m.files && m.files.length > 0)) && (
                      <div className="msg-content">
                        {m.files?.map((f) => (
                          <span key={f} className="file-chip inline" title={f}>
                            <FileText
                              size={14}
                              strokeWidth={1.8}
                              className="file-chip-icon"
                            />
                            <span className="file-chip-name">
                              {baseName(f)}
                            </span>
                          </span>
                        ))}
                        {m.content}
                      </div>
                    )}
                  </div>
                );
              }
              const items = m.timeline ?? [];
              const hasTimelineThinking = items.some(
                (it) => it.kind === "thinking",
              );
              const hasRun = !!(items.length || m.thinking);
              const elapsedSec = m.elapsedMs
                ? Math.max(1, Math.round(m.elapsedMs / 1000))
                : 0;
              // 最末一项之后的正文即「最终回答」,渲染在过程块之外;它之前的正文由
              // RunTimeline 按偏移切片穿插进过程里(对齐 WorkBuddy 展开「已完成」看到的交错)。
              const lastAt = items.length
                ? Math.min(
                    Math.max(...items.map((it) => it.at ?? 0)),
                    m.content.length,
                  )
                : 0;
              // `MEDIA:<path>` 是内核的附件指令而非正文,内核 system prompt 明说
              // 「Supported directives are stripped before rendering」——不剥的话用户会
              // 看到一行赤裸的本地路径。指令对应的文件已在轮末进了 m.artifacts,以卡片呈现。
              // 流式期间还要额外藏掉末尾那条没写完的,否则路径会一个字一个字地长出来。
              const rawFinalText = m.content.slice(lastAt);
              const finalText = parseMediaDirectives(
                m.streaming
                  ? stripTrailingPartialMediaLine(rawFinalText)
                  : rawFinalText,
              ).text;
              // 图片与其它文件走**同一份卡片列表**:2026-08-17 实跑本地 WorkBuddy(同一个
              // deepseek-v4-flash、同一句出图请求)看到的对话区就是一行产物文件卡 +
              // 「文件位置」,大图在右侧预览面板里,气泡里不铺图。读数见
              // references/workbuddy-ui.md 的「生成图在对话区是文件卡」。
              const artifacts = m.artifacts ?? [];
              const runNodes = (
                <>
                  {!hasTimelineThinking && m.thinking && (
                    // 走同一个组件:历史那份原先是就地抄的一段 details,两处一改一漏,
                    // 重开任务看到的推理块就跟实时那份长得不一样。
                    <ReasoningBlock text={m.thinking} active={false} />
                  )}
                  <RunTimeline
                    items={items}
                    content={m.content}
                    streaming={!!m.streaming}
                  />
                </>
              );
              return (
                // key 带上任务 id:切任务时下标相同但消息已换人,不带 id 会复用组件实例,
                // 把上一条消息的逐字进度、折叠展开状态带过来。
                <div key={`${active.id}-${i}`} className="msg assistant">
                  <div className="msg-head">
                    {active.expertAvatar ? (
                      <img
                        className="msg-avatar"
                        src={active.expertAvatar}
                        alt=""
                      />
                    ) : (
                      <div className="msg-avatar">
                        {active.expertName
                          ? active.expertName.slice(0, 1)
                          : "云"}
                      </div>
                    )}
                    <span className="msg-name">
                      {active.expertName || "云雾助手"}
                    </span>
                  </div>
                  {/* 运行过程(思考 / 工具 / 图示)在正文之上;完成后整体折叠进「已完成 Ns」。 */}
                  {m.streaming ? (
                    <div className="run-body">{runNodes}</div>
                  ) : hasRun ? (
                    <details className="run-block">
                      {/*
                        失败的一轮不能顶着一句绿色「已完成」:内核把 incomplete-turn 当**正常
                        投递**发出来(phase 仍是 end),所以光看生命周期分不出成败,得看这一轮
                        有没有留下错误。用户 2026-08-17 那条出图任务就是「已完成」压着一条红字。
                      */}
                      <summary className="run-status">
                        {m.error ? (
                          <CircleAlert
                            size={14}
                            strokeWidth={2}
                            className="step-fail"
                          />
                        ) : (
                          <CircleCheck
                            size={14}
                            strokeWidth={2}
                            className="step-ok"
                          />
                        )}
                        {m.error ? "未完成" : "已完成"}
                        {elapsedSec ? ` ${elapsedSec}s` : ""}
                      </summary>
                      <div className="run-body">{runNodes}</div>
                    </details>
                  ) : null}
                  {finalText && (
                    <div className="msg-content">
                      <StreamingMarkdown
                        text={finalText}
                        streaming={!!m.streaming}
                      />
                    </div>
                  )}
                  {artifacts.length > 0 && (
                    <div className="msg-artifacts">
                      {artifacts.map((a) => {
                        const badge = fileBadge(a.name);
                        const size = formatBytes(artifactSizes[a.path]);
                        const dirLabel = a.path
                          .slice(0, a.path.length - a.name.length)
                          .replace(/[\\/]+$/, "");
                        return (
                          <div
                            key={a.path}
                            className="artifact-card"
                            role="button"
                            tabIndex={0}
                            title={a.path}
                            onClick={() =>
                              void openArtifact(active.sessionKey, a)
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                void openArtifact(active.sessionKey, a);
                              }
                            }}
                          >
                            <span
                              className={`artifact-badge tone-${badge.tone}`}
                            >
                              {badge.text}
                            </span>
                            <span className="artifact-meta">
                              <span className="artifact-name">{a.name}</span>
                              <span className="artifact-sub">
                                {dirLabel && (
                                  <span className="artifact-dir">
                                    {dirLabel}
                                  </span>
                                )}
                                {size && (
                                  <span className="artifact-size">{size}</span>
                                )}
                              </span>
                            </span>
                            <button
                              type="button"
                              className="artifact-reveal"
                              title="在文件夹中显示"
                              aria-label="在文件夹中显示"
                              onClick={(e) => {
                                e.stopPropagation();
                                void window.api.revealArtifact(
                                  active.sessionKey,
                                  a.path,
                                );
                              }}
                            >
                              <FolderOpen size={14} strokeWidth={1.8} />
                            </button>
                            <ArrowUpRight
                              size={15}
                              strokeWidth={1.8}
                              className="artifact-open"
                            />
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {/* 「查看全部」独立成块:一条消息可能产出好几件,这个入口直接开到预览面板
                      (面板顶上按件分页签),与 WorkBuddy 的「查看所有产物 (N) ›」同位置同语义。 */}
                  {artifacts.length > 1 && (
                    <div className="msg-artifacts">
                      <button
                        className="artifact-all"
                        onClick={() =>
                          void openArtifact(
                            active.sessionKey,
                            artifacts[artifacts.length - 1],
                          )
                        }
                      >
                        查看所有产出物 ({artifacts.length})
                        <ChevronRight size={13} strokeWidth={2} />
                      </button>
                    </div>
                  )}
                  {/* 运行状态行固定在整条消息的最末:正文是向下生长的,状态压在正文上方
                      会变成"先看到状态、文字在它下面往外冒",阅读顺序是反的。 */}
                  {m.streaming && (
                    <div className="run-status live">
                      <LoadingLottie size="xs" />
                      {/* 只给文字套流光:整行套的话 color: transparent 会波及 Lottie */}
                      <span className="status-shimmer">
                        {m.liveStatus || STATUS_REPLYING}
                      </span>
                    </div>
                  )}
                  {m.error && <div className="msg-error">{m.error}</div>}
                  {/*
                    等媒体产物的这一轮不是「出错」也不是「用户取消」:模型调完 image_generate /
                    video_generate 就 yield 了(内核把这两个工具设计成后台任务),产物还在路上。
                    此时那两句「本轮回复已中断 / 已挂起等待专家回信」是误报——用户什么都没做错,
                    也不需要点「继续」。所以这一轮改画进度卡,照成熟产品的做法:占位卡 + 原地更新。
                    只压最后一条消息:历史轮里的中断是真中断。
                  */}
                  {mediaWaiting && i === active.messages.length - 1 ? (
                    <div className="msg-media-task">
                      <LoadingLottie size="xs" />
                      <span>
                        {mediaWaiting.phase === "delivering"
                          ? `${mediaWaiting.label}已生成,正在送回对话`
                          : `正在生成${mediaWaiting.label}`}
                      </span>
                      <em>{mediaElapsedLabel(mediaWaiting.startedAt)}</em>
                    </div>
                  ) : (
                    <>
                      {m.aborted && (
                        <div className="msg-cancelled">
                          {m.userAborted
                            ? "用户已取消"
                            : m.abortReason
                              ? `本轮回复已中断(${m.abortReason}),请点击「继续」或重试`
                              : "本轮回复已中断,请点击「继续」或重试"}
                        </div>
                      )}
                      {m.yielded && (
                        <div className="msg-cancelled">
                          已挂起等待专家回信,收到后会自动继续
                        </div>
                      )}
                    </>
                  )}
                  {!m.streaming &&
                    !m.error &&
                    !m.aborted &&
                    !m.yielded &&
                    !m.content &&
                    !hasRun && (
                      <div className="msg-cancelled">
                        本轮未返回文本内容,请点击「继续」或重试
                      </div>
                    )}
                  {!m.streaming &&
                    !m.error &&
                    (m.content || m.aborted || hasRun) && (
                      <div className="msg-actions">
                        <button
                          className="msg-act"
                          title="复制"
                          onClick={() =>
                            navigator.clipboard?.writeText(m.content)
                          }
                        >
                          <Copy size={15} strokeWidth={1.8} />
                        </button>
                        <button className="msg-act" title="赞">
                          <ThumbsUp size={15} strokeWidth={1.8} />
                        </button>
                        <button className="msg-act" title="踩">
                          <ThumbsDown size={15} strokeWidth={1.8} />
                        </button>
                        <button className="msg-act" title="朗读">
                          <Volume2 size={15} strokeWidth={1.8} />
                        </button>
                        <button className="msg-act" title="更多">
                          <Ellipsis size={15} strokeWidth={1.8} />
                        </button>
                      </div>
                    )}
                </div>
              );
            })
          )}
        </div>

        {/*
          首页场景胶囊行,紧贴输入框上沿、与输入卡同 inset 左对齐。
          形状取自 WorkBuddy `.wb-home-composer`:chips 与 input-slot 是同一个 frame 的
          两个子项(itemSpacing 12),而不是「胶囊留在对话区、输入框钉在底部」——后者会在
          两者之间留出一大片空洞。

          三级结构照 WorkBuddy 的 QuickActions:
            模式 tab(上方 .scenario-tabs) → 该模式的场景胶囊 → 选中后换成该场景的提示标题。
          选中态下一级列表在它那边是 `style={{ display: 'none' }}`,我们直接不渲染 ——
          效果一致,且不必让不可见的按钮继续参与横滚宽度计算。选中的场景本身作为可移除
          芯片挂在输入框里(见 Composer 的 activeScene),否则二级行就成了没有出口的死角。
        */}
        {showWelcome && ready && (
          <div className="home-chips">
            <div
              className={`home-chips-scroller${chipScroll.canScrollLeft ? " fade-left" : ""}${
                chipScroll.canScrollRight ? " fade-right" : ""
              }`}
            >
              {chipScroll.canScrollLeft && (
                <button
                  type="button"
                  className="home-chips-arrow left"
                  aria-label="向前"
                  onClick={() => chipScroll.scrollByStep("left")}
                >
                  <ChevronLeft size={13} strokeWidth={2} />
                </button>
              )}
              <div
                ref={chipScroll.containerRef}
                className={`home-chips-list${chipScroll.isDragging ? " is-dragging" : ""}`}
                {...chipScroll.bind}
              >
                {activeScene
                  ? activeScenePrompts.map((p) => (
                      <button
                        key={p.title}
                        className="scenario-chip scenario-chip--sub"
                        // 提示正文动辄几百字,title 里放全文会弹出一整屏 tooltip;截断到一句。
                        title={
                          p.prompt.length > 120
                            ? `${p.prompt.slice(0, 120)}…`
                            : p.prompt
                        }
                        onClick={() => handleScenePrompt(p)}
                      >
                        <span className="scenario-chip-text">{p.title}</span>
                        <ArrowDownRight
                          size={14}
                          strokeWidth={1.6}
                          className="scenario-chip-arrow"
                        />
                      </button>
                    ))
                  : modeScenes.length > 0
                    ? modeScenes.map((sc) => {
                        const SceneIcon = sceneIconOf(sc);
                        return (
                          <button
                            key={sc.slug}
                            className="scenario-chip"
                            onClick={() => handleSceneChip(sc)}
                            title={sc.name}
                          >
                            <span className="scenario-chip-icon">
                              <SceneIcon size={16} strokeWidth={1.8} />
                            </span>
                            <span className="scenario-chip-text">
                              {sc.name}
                            </span>
                          </button>
                        );
                      })
                    : /*
                       一次都还没拉到(serverScenes 仍是 null)时摆骨架条,照 WorkBuddy
                       `.wb-home-composer` 的三分支:有数据 → QuickActions;加载中且无数据 →
                       4 个骨架条;加载完仍为空 → 空占位。它的判据是
                       `quickActionsLoading && !hasQuickActions` —— 已经有胶囊时即便在重拉也不
                       退回骨架,所以静默重拉不会让这一行闪一下;我们用 null 表达同一件事。
                      */
                      serverScenes === null &&
                      SCENE_SKELETON_WIDTHS.map((w, i) => (
                        <span
                          key={i}
                          className="home-skeleton home-chips-skeleton"
                          style={{ width: w }}
                          aria-hidden="true"
                        />
                      ))}
              </div>
              {chipScroll.canScrollRight && (
                <button
                  type="button"
                  className="home-chips-arrow right"
                  aria-label="更多"
                  onClick={() => chipScroll.scrollByStep("right")}
                >
                  <ChevronRight size={13} strokeWidth={2} />
                </button>
              )}
            </div>
          </div>
        )}

        <div className={`composer-zone${showWelcome ? " home" : ""}`}>
          {active.messages.length === 0 &&
            ready &&
            !historyLoadingIds.has(active.id) && (
              <div className="mascot-dock">
                {noticeOpen && (
                  <div className="mascot-notice">
                    {/* 关闭键与标题同处一行(flex space-between),不是绝对定位盖在角上 ——
                      照 WorkBuddy 的结构,这样标题再长也不会钻到 ✕ 底下。 */}
                    <div className="mascot-notice-head">
                      <div className="mascot-notice-title">
                        <Sparkles
                          size={16}
                          strokeWidth={2}
                          className="mascot-notice-icon"
                        />
                        活动
                      </div>
                      <button
                        className="mascot-notice-x"
                        onClick={() => setNoticeOpen(false)}
                        title="关闭"
                        aria-label="关闭通知"
                      >
                        <X size={14} strokeWidth={2.2} />
                      </button>
                    </div>
                    {/* 正文在样式里封顶两行,超出会被省略号截掉,所以把全文挂到 title 上。 */}
                    <div className="mascot-notice-text" title={NOTICE_TEXT}>
                      {NOTICE_TEXT}
                    </div>
                    <button
                      className="mascot-notice-cta"
                      onClick={() => setNoticeOpen(false)}
                    >
                      查看详情
                    </button>
                  </div>
                )}
                <button
                  className="mascot"
                  onClick={() => setNoticeOpen((v) => !v)}
                  title="云雾助手"
                  aria-label="云雾助手"
                >
                  <Mascot />
                </button>
              </div>
            )}

          {/* 平台 UI 工具 ask_user 作答面板:浮层盖在 composer 上(对齐 WorkBuddy)。
              只在「这条会话自己有待答提问」时出现,所以换任务/回首页它不会跟过来。
              key 挂 itemId:换一次提问就是一个全新面板,翻页与已选项不会串到下一问。 */}
          {activeAsk && (
            <AskUserModal
              key={activeAsk.itemId}
              requestId={activeAsk.itemId}
              questions={activeAsk.questions}
              onAnswered={handleAnswered}
              onCancel={handleCancelAsk}
            />
          )}

          <Composer
            permission={permission}
            onPermissionChange={setPermission}
            mode={mode}
            onModeChange={setMode}
            onSend={handleSend}
            running={isRunning}
            onAbort={() => void handleAbort()}
            models={chatOptions}
            model={selectedModel}
            onModelChange={setSelectedModel}
            onOpenModelSettings={() => setSettingsInitial("models")}
            thinkPrefs={thinkPrefs}
            onThinkPrefChange={handleThinkPrefChange}
            experts={experts}
            activeExpertSlug={
              composingNew ? selectedExpertSlug : (active.expertSlug ?? null)
            }
            onSelectExpert={handleSelectExpert}
            memberRuns={active.memberRuns}
            activeSkill={composingNew ? composerSkill : null}
            onClearSkill={() => setComposerSkill(null)}
            activeScene={
              activeScene
                ? { slug: activeScene.slug, name: activeScene.name }
                : null
            }
            onClearScene={() => setActiveSceneSlug(null)}
            prefill={composerPrefill}
            text={draftText}
            onTextChange={setDraftText}
            taskKey={active.id}
            inTask={!composingNew}
            showWelcome={showWelcome}
            designWelcome={showWelcome && sceneMode === "design"}
            imageMode={imageMode}
            onImageModeChange={setImageMode}
            designStyle={designStyle}
            onDesignStyleChange={setDesignStyle}
            workspace={composingNew ? draftWorkspace : null}
            onWorkspaceChange={setDraftWorkspace}
          />
        </div>

        {/*
          案例区:输入框下方那行最佳实践大卡,照 WorkBuddy `HomeRelatedPlaybooks`。
          三条口径都取自它的实现,别按"看起来更合理"改:
            · 只在选中场景时出现 —— 它是 `selectedQuickAction ? allCases.filter(...) : []`,
              没选场景整块不渲染,而不是没选时铺全部;
            · 一屏 5 张、环形取,`换一批` 只在多于 5 条时才给;
            · 点卡先开详情弹窗,不直接开会话 —— 案例正文动辄几百字,得先让人看清是什么。

          外面这层 .home-reserve 无条件渲染,它就是 WorkBuddy 的
          `.wb-home-page__main-content { padding-bottom: 220px }`:那 220px 不是留白,
          是给案例区占的位(它那边案例区是 `absolute; bottom: 56px` 浮在这段预留里)。
          我们让案例区正常占流,但预留必须常在 —— 否则选中场景时整个输入栈会往上跳。
        */}
        {showWelcome && (
          <div className="home-reserve">
            {ready && visiblePlaybooks.length > 0 && (
              <section
                className="home-playbooks"
                aria-label={`${activeScene?.name ?? ""} 相关案例`}
              >
                <div className="home-playbooks-head">
                  <span className="home-playbooks-title">
                    不知道做什么,试试最佳实践案例
                  </span>
                  {canRefreshPlaybooks && (
                    <button
                      type="button"
                      className="home-playbooks-refresh"
                      onClick={() =>
                        setPlaybookBatchStart(
                          (prev) =>
                            (prev + PLAYBOOK_VISIBLE_COUNT) %
                            scenePlaybooks.length,
                        )
                      }
                      title="换一批"
                    >
                      <RefreshCw size={14} strokeWidth={2} />
                      换一批
                    </button>
                  )}
                </div>
                <div className="home-playbooks-row" role="list">
                  {visiblePlaybooks.map((sc, idx) => (
                    <button
                      key={`${sc.id}-${idx}`}
                      type="button"
                      role="listitem"
                      className="home-playbook-card"
                      title={sc.title}
                      onClick={() => setActivePlaybook(sc)}
                    >
                      <span className="home-playbook-cover" aria-hidden="true">
                        <img
                          src={scenarioCover(sc)}
                          alt=""
                          loading="lazy"
                          draggable={false}
                        />
                      </span>
                      <span className="home-playbook-title">{sc.title}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        <div className="disclaimer">内容由 AI 生成,请核实重要信息</div>
      </main>

      {/* 案例详情弹窗(照 WorkBuddy 的 .dc-detail-modal:640×644、24 圆角、正文区 + 预览 + 右下主按钮)。 */}
      {activePlaybook && (
        <div
          className="playbook-overlay"
          onClick={() => setActivePlaybook(null)}
        >
          <div
            className={`playbook-modal${playbookEnlarged ? " is-enlarged" : ""}`}
            onClick={(e) => e.stopPropagation()}
          >
            {/* 放大态不渲染关闭按钮 —— 照 WorkBuddy(它的 `.dc-detail-page.is-enlarged` 里
                写着「× 关闭按钮放大态不 render」)。放大后预览铺满整块,浮在产物上的按钮越少
                越好;退出走 footer 里的收起按钮或点遮罩。 */}
            {!playbookEnlarged && (
              <button
                className="playbook-modal-x"
                onClick={() => setActivePlaybook(null)}
                title="关闭"
                aria-label="关闭"
              >
                <X size={14} strokeWidth={2.2} />
              </button>
            )}
            <div className="playbook-modal-body">
              <div className="playbook-modal-text">
                <div className="playbook-modal-title-row">
                  <h3 className="playbook-modal-title">
                    {activePlaybook.title}
                  </h3>
                </div>
                {(() => {
                  // 正文优先、副标题兜底:照 WorkBuddy,这一行渲染的是 description(截两行,
                  // 全文靠悬浮提示),运营手建的案例往往只填了 subtitle。
                  const blurb =
                    activePlaybook.description || activePlaybook.subtitle;
                  if (!blurb) return null;
                  return (
                    <p className="playbook-modal-subtitle" title={blurb}>
                      {blurb}
                    </p>
                  );
                })()}
                {(() => {
                  // chip 行:关联专家优先(它才是"这案例由谁做的"),没有专家时退回运营填的标签。
                  const memberNames = scenarioMemberSlugs(activePlaybook)
                    .map(
                      (slug) =>
                        experts.find((e) => e.slug === slug)?.name ?? slug,
                    )
                    .slice(0, 4);
                  const chips = memberNames.length
                    ? memberNames
                    : parseTagList(activePlaybook.tags);
                  if (chips.length === 0) return null;
                  return (
                    <div className="playbook-modal-chips">
                      {chips.map((c) => (
                        <span key={c} className="playbook-modal-chip">
                          {c}
                        </span>
                      ))}
                    </div>
                  );
                })()}
              </div>
              {/* 图层侧栏与预览区并排,底下的 footer 仍跨整宽 —— 与 Ardot 的版面一致。
                  只有一个子元素时这层等价于原来的直接布局。 */}
              <div className="playbook-modal-stage">
              {/* 演示图层:多页作品才有,照 Ardot 那条侧栏。每个缩略图就是同一个产物的一个
                  小 iframe,load 完先让它进缩略图态(藏翻页器 + 挡交互)再跳到对应页——
                  原型实测 8 个 iframe 全部 load 只要 99ms,产物本身是单文件、离线、无外链。 */}
              {playbookEnlarged &&
                playbookMeta &&
                playbookMeta.pages > 1 &&
                playbookArtifact?.phase === "ready" && (
                  <div className="playbook-layers">
                    <div className="playbook-layers-title">演示图层</div>
                    <div className="playbook-layers-list">
                      {Array.from({ length: playbookMeta.pages }, (_, i) => (
                        <button
                          key={i}
                          className={`playbook-layer${playbookPage === i + 1 ? " is-on" : ""}`}
                          onClick={() =>
                            sendToPlaybook({ type: "goto", page: i + 1 })
                          }
                          title={`第 ${i + 1} 页`}
                        >
                          <span className="playbook-layer-no">{i + 1}</span>
                          <iframe
                            src={playbookArtifact.url}
                            title={`第 ${i + 1} 页`}
                            tabIndex={-1}
                            sandbox="allow-scripts allow-same-origin"
                            referrerPolicy="no-referrer"
                            onLoad={(e) => {
                              const win = e.currentTarget.contentWindow;
                              // 等一帧:桥要先跑完自己的 fit 才认得出页数
                              setTimeout(() => {
                                win?.postMessage({ wb: 1, type: "thumb" }, "*");
                                win?.postMessage(
                                  { wb: 1, type: "goto", page: i + 1 },
                                  "*",
                                );
                              }, 30);
                            }}
                          />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              <div
                className={`playbook-modal-preview${playbookView.hand ? " is-panning" : ""}${playbookMeta ? " has-canvas" : ""}`}
                ref={playbookStageRef}
              >
                {(() => {
                  const type = activePlaybook.artifact_type;
                  const cover = (
                    <img
                      src={scenarioCover(activePlaybook)}
                      alt=""
                      draggable={false}
                    />
                  );

                  /**
                   * link 类(上游那 32 条设计稿)只给封面,既不嵌也不给外链。
                   *
                   * 上游对这批**根本没有产物文件**:2026-08-11 查 registry,32 条的
                   * `artifacts` 全是空数组、`preview` 全是空串,只有一个指向第三方设计工具的
                   * `external_url` —— 它嵌的是那个工具里的活文档,不是导出的文件,所以我们
                   * 无从转存。三种口径也都试过,内容都拿不到:照它的用法 iframe 嵌 embed 地址
                   * (连那组 sandbox 一起照抄)、浏览器 top-level 打开同一个地址(302 到
                   * `/file/<id>`),得到的都是该工具的空白工作台引导页。它能看是因为带着自家
                   * 账号握手换 token,我们不在那个账号体系里。
                   *
                   * 给外链等于让用户白点一次进一张更像"坏了"的空白页。封面本身就是作品截图,
                   * 案例真正可用的部分是「一键做同款」那段 prompt(这 32 条的 prompt 完整,
                   * 中位 589 字,连配色 hex 和分屏结构都写明)。
                   */
                  if (type !== "html" && type !== "video") return cover;
                  if (
                    !playbookArtifact ||
                    playbookArtifact.phase === "loading"
                  ) {
                    return <div className="playbook-preview-loading" />;
                  }
                  // 换链接失败(离线/令牌过期/产物被清)就退回封面,别把弹窗弄成一片空白。
                  if (
                    playbookArtifact.phase !== "ready" ||
                    !playbookArtifact.url
                  )
                    return cover;

                  if (type === "video") {
                    // 照 WorkBuddy 的 PreviewVideo:原生 video + controls + preload=metadata。
                    return (
                      <video
                        className="playbook-preview-video"
                        src={playbookArtifact.url}
                        controls
                        preload="metadata"
                      />
                    );
                  }
                  /**
                   * HTML 产物:iframe 指向产物直链。
                   *
                   * 不用 srcdoc —— 那条路在我们这儿是死的:renderer 的 CSP 是
                   * `default-src 'self'`,srcdoc 文档继承它,产物里的内联脚本一行都跑不了
                   * (页面看着渲染出来了,但所有交互是死的)。指向 URL 的 iframe 是独立文档,
                   * 不继承父页 CSP,2026-08-11 真机实测脚本正常执行。
                   *
                   * sandbox 里给 allow-same-origin 是刻意的,也是与 WorkBuddy 的一处差异:
                   * 它桌面端这里用的是 Electron <webview>(自带完整 origin),iframe + 严格
                   * sandbox 只用在它的 Web 端。我们用 iframe,不给这个标志的话产物里的
                   * localStorage 会抛异常 —— 实测「打工人小账本」会自己顶出一条红色降级提示
                   * 「本地存储不可用」。产物永远来自对象存储/后端域名,与 renderer 的 file://
                   * 不同源,所以给了它也拿不到我们的 origin。
                   */
                  /* 缩放靠改 iframe 的像素尺寸让产物自己重新 fit,不是 transform:scale。
                     没有桥的产物(上游那批 html 工具页)拿不到设计稿尺寸,退回铺满台面。 */
                  const box = playbookFrameBox();
                  const { w: sw, h: sh } = playbookStageSize;
                  // 没有桥的产物(上游那批 html 工具页)是**铺满台面**,不进留白那套:
                  // 它的 box 正好等于台面,套 playbookBase 会平白推出 16px、右下角被裁掉。
                  const base = playbookMeta
                    ? { x: playbookBase(box.w, sw), y: playbookBase(box.h, sh) }
                    : { x: 0, y: 0 };
                  return (
                    <iframe
                      ref={playbookFrameRef}
                      className="playbook-preview-frame"
                      src={playbookArtifact.url}
                      title={activePlaybook.title}
                      sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
                      allow="fullscreen"
                      referrerPolicy="no-referrer"
                      style={{
                        width: `${box.w}px`,
                        height: `${box.h}px`,
                        left: `${Math.round(base.x + playbookView.x)}px`,
                        top: `${Math.round(base.y + playbookView.y)}px`,
                      }}
                    />
                  );
                })()}
                {/* 元素尺寸标注。矩形是产物按自己的视口坐标报上来的,这里只补 iframe 的偏移;
                    文案是**设计稿尺寸**(产物已把缩放除回去),与 Ardot 那个绿标一致。 */}
                {playbookMeasure &&
                  (() => {
                    const fr = playbookFrameRef.current;
                    const ox = fr?.offsetLeft ?? 0;
                    const oy = fr?.offsetTop ?? 0;
                    return (
                      <div className="playbook-measure">
                        <div
                          className="playbook-measure-box"
                          style={{
                            left: `${ox + playbookMeasure.x}px`,
                            top: `${oy + playbookMeasure.y}px`,
                            width: `${playbookMeasure.w}px`,
                            height: `${playbookMeasure.h}px`,
                          }}
                        />
                        <div
                          className="playbook-measure-tag"
                          style={{
                            left: `${ox + playbookMeasure.x + playbookMeasure.w / 2}px`,
                            top: `${oy + playbookMeasure.y + playbookMeasure.h + 4}px`,
                          }}
                        >
                          {playbookMeasure.label}
                        </div>
                      </div>
                    );
                  })()}
                {/* 抓手的拖拽面。必须是**盖在 iframe 上的一层**:产物与我们不同源,它一旦吃到
                    pointerdown,后续的 move/up 全在它那个文档里,父页一个事件都收不到,
                    拖拽会在跨进产物区域的瞬间断掉。只在抓手激活时挂,平时不挡产物自身的交互。 */}
                {playbookView.hand && playbookMeta && (
                  <div
                    className="playbook-preview-grab"
                    /* 滚轮也归这一层管:跨源 iframe 上的 wheel 父页根本收不到,只有盖着
                       这层时才拿得到。**所以滚轮只在移动态有效** —— 默认的标注态必须撤走
                       这一层(否则产物收不到 mousemove),那时滚轮平移与 ctrl+滚轮缩放
                       都不响应,缩放走右下角缩放器与 +/-/0。
                       ctrl/⌘ + 滚轮缩放是看图类界面的通用约定。 */
                    onWheel={(e) => {
                      if (e.ctrlKey || e.metaKey) {
                        const z = playbookZoom();
                        zoomPlaybookTo(
                          Math.min(3, Math.max(0.05, z * (e.deltaY > 0 ? 0.9 : 1.1))),
                        );
                        return;
                      }
                      const box = playbookFrameBox();
                      const { w: sw, h: sh } = playbookStageSize;
                      setPlaybookView((v) => ({
                        ...v,
                        ...clampPlaybookPan(
                          v.x - e.deltaX,
                          v.y - e.deltaY,
                          box.w,
                          box.h,
                          sw,
                          sh,
                        ),
                      }));
                    }}
                    onPointerDown={(e) => {
                      const box = playbookFrameBox();
                      const { w: sw, h: sh } = playbookStageSize;
                      const from = {
                        px: e.clientX,
                        py: e.clientY,
                        x: playbookView.x,
                        y: playbookView.y,
                      };
                      e.currentTarget.setPointerCapture(e.pointerId);
                      const move = (ev: PointerEvent): void =>
                        setPlaybookView((v) => ({
                          ...v,
                          ...clampPlaybookPan(
                            from.x + (ev.clientX - from.px),
                            from.y + (ev.clientY - from.py),
                            box.w,
                            box.h,
                            sw,
                            sh,
                          ),
                        }));
                      const up = (): void => {
                        window.removeEventListener("pointermove", move);
                        window.removeEventListener("pointerup", up);
                      };
                      window.addEventListener("pointermove", move);
                      window.addEventListener("pointerup", up);
                    }}
                  />
                )}
                {/* 模式键。照 Ardot 摆在**画布顶部居中**的一颗白胶囊里(WorkBuddy 真机截图上
                    是「▶ 播放 / ✋ 移动」两枚圆钮),我们没有原型播放,对位的是移动与标注。
                    两者**互斥**不是设计取舍而是必须:抓手是盖在 iframe 上的一层,它在的时候
                    产物收不到 mousemove,而测量恰恰是产物自己在 hover 检测。 */}
                {playbookMeta && playbookArtifact?.phase === "ready" && (
                  <div className="playbook-mode-tools">
                    <button
                      className={`playbook-mode${playbookView.hand ? " is-on" : ""}`}
                      onClick={() => {
                        setPlaybookView((v) => ({
                          ...v,
                          hand: true,
                          measure: false,
                        }));
                      }}
                      title="移动 H"
                      aria-label="移动"
                    >
                      <Hand size={15} strokeWidth={2} />
                    </button>
                    <button
                      className={`playbook-mode${playbookView.measure ? " is-on" : ""}`}
                      onClick={() => {
                        setPlaybookView((v) => ({
                          ...v,
                          hand: false,
                          measure: true,
                        }));
                      }}
                      title="标注元素尺寸"
                      aria-label="标注元素尺寸"
                    >
                      <Ruler size={15} strokeWidth={2} />
                    </button>
                  </div>
                )}
                {/* 缩放器。照 Ardot 摆在**右下角**;两态都给 —— 它小窗态一样有
                    (36% / 15% 那两张就是小窗态截的)。只在有桥的产物上给:上游那批 html 工具页
                    没有设计稿尺寸可言,百分比无从谈起;video 走原生 <video>,缩放 iframe 对它无效。 */}
                {playbookMeta && playbookArtifact?.phase === "ready" && (
                  <div className="playbook-preview-tools">
                    <button
                      className="playbook-tool"
                      onClick={() =>
                        zoomPlaybookTo(
                          [...PLAYBOOK_ZOOM_STEPS]
                            .reverse()
                            .find((s) => s < playbookZoom() - 1e-4) ??
                            PLAYBOOK_ZOOM_STEPS[0],
                        )
                      }
                      disabled={playbookZoom() <= PLAYBOOK_ZOOM_STEPS[0]}
                      title="缩小 −"
                      aria-label="缩小"
                    >
                      <Minus size={13} strokeWidth={2} />
                    </button>
                    {/* 点百分比弹档位菜单,照 WorkBuddy 那颗「62% ∨」。
                        它没有独立的 ± 键所以把放大缩小也塞进菜单,我们有,菜单里就只放档位。 */}
                    <button
                      className={`playbook-tool playbook-tool-zoom${playbookZoomMenu ? " is-on" : ""}`}
                      onClick={() => setPlaybookZoomMenu((v) => !v)}
                      title="缩放档位"
                      aria-haspopup="menu"
                      aria-expanded={playbookZoomMenu}
                    >
                      {Math.round(playbookZoom() * 100)}%
                      <ChevronDown size={11} strokeWidth={2.5} />
                    </button>
                    <button
                      className="playbook-tool"
                      onClick={() =>
                        zoomPlaybookTo(
                          PLAYBOOK_ZOOM_STEPS.find(
                            (s) => s > playbookZoom() + 1e-4,
                          ) ??
                            PLAYBOOK_ZOOM_STEPS[
                              PLAYBOOK_ZOOM_STEPS.length - 1
                            ],
                        )
                      }
                      disabled={
                        playbookZoom() >=
                        PLAYBOOK_ZOOM_STEPS[PLAYBOOK_ZOOM_STEPS.length - 1]
                      }
                      title="放大 +"
                      aria-label="放大"
                    >
                      <Plus size={13} strokeWidth={2} />
                    </button>
                    {playbookZoomMenu && (
                      <>
                        {/* 点空白关菜单。用一层全屏透明遮罩而不是 document 监听:
                            这块界面本来就层层叠叠(抓手层、测量层、footer),监听要处处
                            stopPropagation 才不误关,遮罩一层就够且不会漏。 */}
                        <div
                          className="playbook-zoom-menu-scrim"
                          onClick={() => setPlaybookZoomMenu(false)}
                        />
                        <div className="playbook-zoom-menu" role="menu">
                          <input
                            className="playbook-zoom-input"
                            defaultValue={Math.round(playbookZoom() * 100)}
                            aria-label="缩放百分比"
                            onKeyDown={(e) => {
                              if (e.key !== "Enter") return;
                              const pct = Number(
                                (e.target as HTMLInputElement).value.replace(
                                  /[^\d.]/g,
                                  "",
                                ),
                              );
                              if (!Number.isFinite(pct) || pct <= 0) return;
                              zoomPlaybookTo(pct / 100);
                              setPlaybookZoomMenu(false);
                            }}
                          />
                          <button
                            className="playbook-zoom-item"
                            role="menuitem"
                            onClick={() => {
                              setPlaybookView((v) => ({
                                ...v,
                                zoom: 0,
                                x: 0,
                                y: 0,
                              }));
                              setPlaybookZoomMenu(false);
                            }}
                          >
                            缩放以适合
                          </button>
                          {/* 「整页」只对长页有意义:定尺作品的适应档本来就是整页 */}
                          {playbookMeta.fit === "width" && (
                            <button
                              className="playbook-zoom-item"
                              role="menuitem"
                              onClick={() => {
                                setPlaybookView((v) => ({
                                  ...v,
                                  zoom: playbookPageZoom(playbookMeta),
                                  x: 0,
                                  y: 0,
                                }));
                                setPlaybookZoomMenu(false);
                              }}
                            >
                              缩放至整页
                            </button>
                          )}
                          {[0.5, 1, 2].map((z) => (
                            <button
                              key={z}
                              className="playbook-zoom-item"
                              role="menuitem"
                              onClick={() => {
                                zoomPlaybookTo(z);
                                setPlaybookZoomMenu(false);
                              }}
                            >
                              <span>缩放至 {z * 100}%</span>
                              {z === 1 && (
                                <span className="playbook-zoom-key">0</span>
                              )}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
              </div>
              <div className="playbook-modal-footer">
                {/* 放大/收起:照 WorkBuddy 的 `.dc-detail-preview-toggle` —— 它「永位 footer 内,
                    与做同款相邻」,不是浮在预览上的按钮(先前做成预览区右上角浮按钮是自己发明的,
                    放大态还会和关闭按钮挤在一起)。只有真有产物可看时才给。 */}
                {playbookArtifact?.phase === "ready" && (
                  <button
                    className="playbook-preview-toggle"
                    onClick={() => {
                      setPlaybookEnlarged((v) => !v);
                      // 换态时视角复位:台面尺寸变了,原来的缩放比例与偏移都不再合适,
                      // zoom 归 0 表示「重新按新台面算适应档」。
                      setPlaybookView(PLAYBOOK_VIEW_INIT);
                      setPlaybookZoomMenu(false);
                    }}
                    title={playbookEnlarged ? "收起" : "放大"}
                    aria-label={playbookEnlarged ? "收起" : "放大"}
                  >
                    {playbookEnlarged ? (
                      <Minimize2 size={14} strokeWidth={2} />
                    ) : (
                      <Maximize2 size={14} strokeWidth={2} />
                    )}
                  </button>
                )}
                <button
                  className="playbook-modal-cta"
                  onClick={() => handlePlaybookLaunch(activePlaybook)}
                >
                  一键做同款
                  <ArrowUpRight size={14} strokeWidth={2} />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {settingsInitial && (
        <Settings
          activation={activation}
          initial={settingsInitial}
          onClose={() => {
            setSettingsInitial(null);
            // 关闭设置时刷新专家列表(用户可能在专家市场安装/卸载)。
            refreshExperts();
            // 顺手重拉首页场景与案例:运营可能刚上架/改了内容,这是用户离开设置后必经的一次刷新点。
            refreshScenes();
            refreshScenarios();
          }}
          onSignOut={onSignOut}
          onModelsChanged={refreshChatModels}
          onOpenFeedback={() => {
            setSettingsInitial(null);
            onOpenFeedback();
          }}
        />
      )}

      {/* 批量二次确认。标题带条数、内容说清后果,执行期间原地换成进度文案并锁住两个按钮
        —— 全是 WorkBuddy `confirmAndRun` 的形状(它用 Modal.confirm + handle.update)。 */}
      {batchConfirm && (
        <FloatingMask
          className="modal-mask"
          onClick={() => !operating && setBatchConfirm(null)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">
              {batchConfirm.action === "delete"
                ? `确认删除 ${batchConfirm.count} 项任务?`
                : `确认归档 ${batchConfirm.count} 项任务?`}
            </h3>
            <p className="modal-text">
              {batchEmptyError
                ? "没有可执行的任务,请重新选择"
                : batchProgress
                  ? `正在处理,请勿关闭(${batchProgress.done}/${batchProgress.total})`
                  : batchConfirm.action === "delete"
                    ? "删除后这些任务将从列表中移除,且无法恢复。"
                    : "归档后这些任务将从列表中移除。"}
            </p>
            <div className="modal-actions">
              <button
                className="btn-ghost"
                disabled={operating}
                onClick={() => setBatchConfirm(null)}
              >
                取消
              </button>
              <button
                className={
                  batchConfirm.action === "delete" ? "btn-danger" : "btn-primary"
                }
                disabled={operating}
                onClick={() => void runBatch(batchConfirm.action)}
              >
                {batchConfirm.action === "delete" ? "删除" : "归档"}
              </button>
            </div>
          </div>
        </FloatingMask>
      )}

      {batchToast != null && (
        <div className="feedback-toast" role="status">
          {batchToast}
        </div>
      )}

      {deleteId && (
        <FloatingMask className="modal-mask" onClick={() => setDeleteId(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">删除对话</h3>
            <p className="modal-text">
              删除后不可恢复,确定删除「
              {tasks.find((t) => t.id === deleteId)?.title ?? "该对话"}」吗?
            </p>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setDeleteId(null)}>
                取消
              </button>
              <button className="btn-danger" onClick={confirmDelete}>
                删除
              </button>
            </div>
          </div>
        </FloatingMask>
      )}
    </div>
  );
}
