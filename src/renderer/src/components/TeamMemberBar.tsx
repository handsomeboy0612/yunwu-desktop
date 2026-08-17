import { useRef, useState, type ReactNode } from "react";
import { Check, Crown, X } from "lucide-react";
import LoadingLottie from "./LoadingLottie";
import type { MemberRunStatus } from "@shared/types";
import type { TeamRosterEntry } from "@shared/team-roster";

/**
 * 专家团成员条:输入框上方一排横向可拖动的成员芯片,负责人排第一位,
 * 每位成员显示头像 + 职业 + 姓名,右侧挂实时状态(进行中 / 已完成 / 失败)。
 *
 * 形状对齐 WorkBuddy 的 `team-member-bar`(24px 圆头像、双行文字上粗下细、999px 胶囊、
 * 6px 间距、横向溢出滚动且隐藏滚动条、按住可拖):专家团的价值在于"看得见有哪些人、
 * 谁在干活",只显示一个团队名等于把多 agent 编排藏了起来。
 *
 * 显示时机同样对齐 WorkBuddy,两个条件缺一不可:会话已有消息(`!showWelcome`),且**至少有一名
 * 成员真被召唤过**——它的成员来自会话运行时快照而非静态名册,所以主理人还没派活时整条不出现。
 * 传进来的 members 已由 Composer 过滤过,这里不再判断。
 *
 * 状态只认子会话的真实生命周期(见 AgentEvent 的 'member' 一支),不看 `sessions_spawn`
 * 的工具状态——那个工具派完活当场就返回,拿它当完成信号会让所有人瞬间变"已完成"。
 */

/** 头像兜底底色。按位次取,让同一团队里每个人颜色稳定且互不相同。 */
const AVATAR_COLORS = [
  "#f5a623",
  "#7b68ee",
  "#4fc3f7",
  "#81c784",
  "#e57373",
  "#ba68c8",
  "#ff8a65",
  "#4db6ac",
];

interface Props {
  teamName: string;
  teamProfession?: string;
  teamAvatar?: string;
  members: TeamRosterEntry[];
  /** 成员标识(TeamRosterEntry.key / legacyKey)→ 运行状态。 */
  runs?: Record<string, MemberRunStatus>;
  /** 负责人是否正在回复(任务流式中)。 */
  leaderBusy?: boolean;
}

/** 头像:http(s) 图片走 img,其余(emoji / 空)退化成文字底色块。 */
function Avatar({
  src,
  name,
  color,
}: {
  src?: string;
  name: string;
  color: string;
}): ReactNode {
  const isImage = !!src && /^https?:\/\//.test(src);
  return (
    <span
      className="tmb-avatar"
      style={{ background: isImage ? "transparent" : color }}
    >
      {isImage ? <img src={src} alt="" /> : src || name.slice(0, 1)}
    </span>
  );
}

function StatusMark({ status }: { status?: MemberRunStatus }): ReactNode {
  if (status === "running") {
    return <LoadingLottie size="xs" className="tmb-status" />;
  }
  if (status === "completed") {
    return (
      <span className="tmb-status tmb-status-done">
        <Check size={12} strokeWidth={2.4} />
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="tmb-status tmb-status-fail">
        <X size={10} strokeWidth={2.4} />
      </span>
    );
  }
  return null;
}

export default function TeamMemberBar({
  teamName,
  teamProfession,
  teamAvatar,
  members,
  runs,
  leaderBusy,
}: Props): ReactNode {
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; left: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const endDrag = (): void => {
    drag.current = null;
    setDragging(false);
  };

  return (
    <div
      className={`tmb${dragging ? " dragging" : ""}`}
      ref={scroller}
      onMouseDown={(e) => {
        if (!scroller.current) {
          return;
        }
        drag.current = { x: e.clientX, left: scroller.current.scrollLeft };
      }}
      onMouseMove={(e) => {
        const start = drag.current;
        if (!start || !scroller.current) {
          return;
        }
        const dx = e.clientX - start.x;
        // 小幅移动仍算点击,只有真的拖了才改滚动位置并压掉后续 click。
        if (!dragging && Math.abs(dx) < 4) {
          return;
        }
        setDragging(true);
        scroller.current.scrollLeft = start.left - dx;
      }}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
    >
      <span className="tmb-chip" title={teamName}>
        <Avatar src={teamAvatar} name={teamName} color={AVATAR_COLORS[0]} />
        <span className="tmb-text">
          <span className="tmb-line1">{teamProfession || teamName}</span>
          <span className="tmb-line2">
            {teamProfession ? teamName : "主理人"}
            <Crown size={11} strokeWidth={2} className="tmb-leader-icon" />
          </span>
        </span>
        {leaderBusy && <LoadingLottie size="xs" className="tmb-status" />}
      </span>

      {members.map((m, i) => (
        <span
          key={m.key}
          className="tmb-chip"
          title={m.profession ? `${m.name}·${m.profession}` : m.name}
        >
          <Avatar
            src={m.avatar}
            name={m.name}
            color={AVATAR_COLORS[(i + 1) % AVATAR_COLORS.length]}
          />
          <span className="tmb-text">
            <span className="tmb-line1">{m.profession || m.name}</span>
            {m.profession && <span className="tmb-line2">{m.name}</span>}
          </span>
          <StatusMark status={runs?.[m.key] ?? runs?.[m.legacyKey]} />
        </span>
      ))}
    </div>
  );
}
