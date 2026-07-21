# Yunwu Desktop（云雾桌面客户端）

像 WorkBuddy 一样,在用户本地电脑上运行 **OpenClaw** agent,直接操作本地文件（PPT / Word / 表格等）。模型调用统一走 **云雾（new-yunwu-api）** 的 OpenAI 兼容网关,计费自动复用云雾账号额度。

> 本项目是独立的 Electron 客户端,与 `new-yunwu-api`（服务端）、`ClawManager`（云端实例调度）解耦,仅通过 HTTP 对接云雾。

## 架构

```
Yunwu Desktop (本项目, Electron + React)
  ├─ 主进程:管理本地 OpenClaw 网关进程 + 写配置 + 云雾令牌校验
  ├─ 本地拉起 openclaw gateway (127.0.0.1:18789)
  └─ OpenClaw workspace = 用户真实电脑 → 操作本地文件
         │
         └─ 调模型 ──► 云雾 /v1 网关（Bearer 令牌，自动计费）
```

- **agent 内核 = OpenClaw**（`npm i -g openclaw`,Node 应用,原生支持 Win/Mac/Linux）——本项目不重写 agent,只负责"本地拉起 + 配置 + UI"。
- **云雾 = 底座**:账号、令牌、模型网关、计费全部复用。
- **ClawManager / K8s 不参与**:那是云端实例线,与桌面线无交集。

## 前置条件

- Node.js 22.19+ 或 24（OpenClaw 运行时要求）
- 本机安装 OpenClaw:`npm install -g openclaw@latest`
  - 或用环境变量 `OPENCLAW_BIN` 指向自定义可执行文件/本地 checkout

## 开发

```bash
npm install       # 安装依赖
npm run dev       # 启动开发模式（Electron + Vite HMR）
npm run typecheck # 类型检查
npm run build     # 编译主/预加载/渲染进程
npm run package   # 打包安装包（electron-builder）
```

## 目录结构

```
src/
├─ main/           # 主进程
│  ├─ index.ts             # 应用入口、窗口
│  ├─ openclaw-cli.ts      # 解析 openclaw 命令 + 一次性子命令执行
│  ├─ openclaw-manager.ts  # 常驻网关进程生命周期
│  ├─ config-writer.ts     # 写本地 OpenClaw 配置（batch-json，对齐云雾格式）
│  ├─ yunwu-client.ts      # 云雾令牌校验（/v1/models）
│  ├─ store.ts             # 激活配置本地持久化
│  └─ ipc.ts               # IPC 处理器
├─ preload/         # contextBridge 安全桥（window.api）
├─ renderer/        # 自绘 UI（React）
│  └─ src/pages/    # Activate（激活）/ Workspace（工作台）
└─ shared/          # 主/渲染共享类型
```

## 当前进度（MVP 骨架）

- [x] 工程骨架、构建配置
- [x] 主进程:OpenClaw 进程管理 / 配置写入 / 云雾令牌校验 / 持久化
- [x] 激活流程（粘贴云雾令牌 → 校验 → 写配置）
- [x] 自绘工作台 UI（网关启停、工作目录、连接信息、聊天面板骨架）
- [ ] 聊天 ↔ 本地 OpenClaw 网关（ws://127.0.0.1:18789）协议对接 ← 下一里程碑
- [ ] 内置 Node + OpenClaw 打包（免用户手动安装）
- [ ] 云雾账号登录 + `/api/desktop/activate`（替代手动粘贴令牌）
- [ ] 安全硬化（网关鉴权、CSP、代码签名/自动更新）
```
