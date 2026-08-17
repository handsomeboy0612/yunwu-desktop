import { useEffect, useState } from "react";
import Mascot from "./Mascot";

/**
 * 会话就位期间盖住会话区的「正在准备执行」浮层。
 *
 * 照搬 WorkBuddy 的 `packages/agent-ui/src/components/workspace-preparing`(解包读到的):
 * 它的默认文案就是 "Preparing your workspace" / "This usually takes about 5 seconds for the
 * first time.",中文包里对应 `conversation.creating.title` = 「正在准备执行」、
 * `conversation.creating.description` = 「Agent 正在接手并进入工作状态。」——
 * 也就是说这个位置的等待它也有,做法是**用一个状态盖住**,不是消灭它。
 *
 * 我们要盖的是同一段:新装一个专家后,第一次开会话要等那轮 `agents.list` 热加载
 * (内核会 await 一遍模型上下文窗口缓存刷新,实测能堵十几秒,见 main/agent-manager)。
 * 写入本身已经挪到安装时,这里兜住「装完立刻召唤」那条还没跑完的缝。
 *
 * 两处照原样:
 *  - 假进度封顶 85%,永远走不到 100% —— 完成信号是浮层退场,进度条只用来表明「还在动」;
 *  - 吉祥物 + 标题(带动态省略号)+ 说明 + 进度条,一列居中;退场 scale(0.98) 淡出,跑完才卸载 DOM。
 * 两处不照原样:插图换成我们自己的 Lottie 吉祥物(项目动画规范要求矢量,不用 PNG);
 * 入场不淡入,理由见下面进出场那段注释。
 */

/** 假进度上限。到不了 100%:真正的完成信号是浮层退场。 */
const PROGRESS_CAP = 85;
const PROGRESS_TICK_MS = 200;
/** 退场动画时长,与 styles.css 里的 transition 对齐;到点才卸载 DOM。 */
const EXIT_MS = 350;

interface WorkspacePreparingProps {
  visible: boolean;
  title?: string;
  description?: string;
}

export default function WorkspacePreparing({
  visible,
  title = "正在准备执行",
  description = "Agent 正在接手并进入工作状态。",
}: WorkspacePreparingProps) {
  const [mounted, setMounted] = useState(visible);
  const [phase, setPhase] = useState<"entered" | "exiting">("entered");
  const [progress, setProgress] = useState(0);

  /**
   * 进出场。**入场是硬切,只有退场有动画**,这一处刻意不照原件。
   *
   * 原件是双层 rAF + 300ms 淡入,因为它盖的是欢迎页:`isCreatingConversation` 在
   * `createConversation` 一开始就置真,提示词是**随创建请求一起发出去**的
   * (`options.prompt` / `promptContentBlocks`),会话建好之前根本没有消息可渲染,
   * 淡入期间底下什么都没有。我们是先把用户消息插进任务再去建会话(两次 setState
   * 在同一批,一帧就都出来了),淡入的那 330 毫秒正好把刚插进去的消息露给用户看 ——
   * 用户报的「先看到消息再看到蒙层」就是这个。退场的淡出要留着:那一段是「揭开」,
   * 底下的内容本来就该被看见。
   *
   * 判断「该不该退场」看的是 mounted,**不能**用一个「visible 没翻转就 return」的守卫
   * (原件是那么写的,它的打包产物里没有 StrictMode 所以不出事)。
   */
  useEffect(() => {
    if (visible) {
      setMounted(true);
      setPhase("entered");
      return;
    }
    if (!mounted) {
      // 初始就是隐藏,或退场已经跑完:没有可退场的东西。
      return;
    }
    setPhase("exiting");
    const timer = window.setTimeout(() => setMounted(false), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [visible, mounted]);

  useEffect(() => {
    if (!mounted) {
      return;
    }
    setProgress(0);
    const id = window.setInterval(() => {
      setProgress((p) => Math.min(PROGRESS_CAP, p + Math.random() * 3));
    }, PROGRESS_TICK_MS);
    return () => window.clearInterval(id);
  }, [mounted]);

  if (!mounted) {
    return null;
  }

  return (
    <div
      className={`workspace-preparing${phase === "entered" ? "" : ` ${phase}`}`}
      role="status"
      aria-live="polite"
    >
      <div className="workspace-preparing-content">
        <div className="workspace-preparing-mascot">
          <Mascot />
        </div>
        <h2 className="workspace-preparing-title">
          {title}
          <span className="workspace-preparing-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </h2>
        <p className="workspace-preparing-desc">{description}</p>
        <div className="workspace-preparing-track">
          <div
            className="workspace-preparing-bar"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    </div>
  );
}
