/**
 * Copy for the market section.
 *
 * Its own namespace rather than a few more keys on the account dictionary: the
 * two surfaces are registered independently, and a namespace is the unit the
 * kernel's locale registry hands out.
 */

/** Simplified Chinese dictionary; the key set every other locale is checked against. */
export const zh = {
  'nav': '市场',
  'title': '市场',
  'intro': '这里的专家与专家团安装后成为本机的 Agent 预设，新建会话时可以选用。安装、默认与删除都由「Agent 预设」页管理。',

  'searchPlaceholder': '搜索专家、职业或标签',
  'kindAll': '全部',
  'kindAgent': '专家',
  'kindTeam': '专家团',
  'categoryAll': '全部分类',

  'empty': '没有符合条件的条目',
  'emptyCatalog': '市场目录暂时是空的',
  'failedSignedOut': '登录后才能读取市场目录',
  'failedHttp': '目录读取失败（HTTP {status}）',
  'failedRefused': '目录读取被拒绝：{message}',
  'failedTransport': '连不上市场目录：{message}',
  'retry': '重试',
  'stale': '显示的是上次取到的目录',

  'installed': '已安装',
  'install': '安装',
  'installing': '安装中…',
  'summon': '召唤',
  // One word for both halves of a summon (fetching the expert the first time,
  // and opening the session), because to the person waiting they are one wait.
  'preparing': '准备中…',
  'detailPrompts': '可以这样问它',
  'unavailableNoArtifact': '该条目还没有适配当前内核（{kernelApi}）的版本',
  'unavailableBadId': '该条目的标识不能作为预设目录名',
  'notAuthorable': '当前部署没有可写的预设目录，无法安装',
  'brokenInstalled': '已安装，但内核报告加载失败',
  'teamBadge': '专家团',
  'downloads': '{count} 次安装',

  'detailClose': '关闭',
  'detailTags': '标签',
  'detailVersion': '版本',
  'detailKind': '类型',
  'detailCategory': '分类',
  'detailTarget': '安装位置',

  'confirmTitle': '安装到本机？',
  'confirmBody': '将写入下面这个目录，成为一个可选的 Agent 预设。它以你的权限在本机运行，使用时可以调用其组装里声明的工具。',
  'confirmBodySummon': '这位专家会先装到下面这个目录，成为一个 Agent 预设，然后直接开一条新会话给你。它以你的权限在本机运行，使用时可以调用其组装里声明的工具。只有第一次召唤要过这一步。',
  'confirmCancel': '取消',
  'confirmInstall': '安装',
  'confirmSummon': '召唤',
  'installedTitle': '已安装',
  'installedBody': '「{name}」已装到 {path}。新建会话时在预设里选它即可；管理与删除在「Agent 预设」页。',
  'installedDone': '好',

  'refusedTitle': '没有安装',
  'refused-not-authorable': '当前部署没有可写的预设目录。',
  'refused-invalid-id': '该条目的标识不能作为预设目录名。',
  'refused-already-installed': '同名预设已经存在，安装不会覆盖它。',
  'refused-download-failed': '制品下载失败。',
  'refused-digest-mismatch': '制品摘要与目录声明的不一致，已丢弃。',
  'refused-bad-archive': '制品内容不被接受，已丢弃。',
  'refused-broken-after-install': '装好后内核没能加载它，已回滚。',
  'refused-unsupported-format': '这个客户端还不认得该制品的格式，升级后再试。',
  'refused-no-base-preset': '内核的预设名录里没有可作基准的 standard，无法组装专家。',
  installedSkillsPartial: '随包技能只装上 {installed}/{total}：缺的那几个这位专家的人设里还会提到，遇到时它会说自己有、实际调不动。重装一次即可补齐。',
  'refused-no-download-url': '控制台没有签出下载链接。',
  'refused-catalog-stale': '目录里这条已经过期，刷新后再装。',
} satisfies Record<string, string>

/** Key union of this section's copy. */
export type MarketKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'nav': 'Market',
  'title': 'Market',
  'intro': 'Experts and teams installed here become local agent presets you can pick when starting a session. Defaults and removal live on the Agent presets page.',

  'searchPlaceholder': 'Search experts, professions, tags',
  'kindAll': 'All',
  'kindAgent': 'Experts',
  'kindTeam': 'Teams',
  'categoryAll': 'All categories',

  'empty': 'Nothing matches those filters',
  'emptyCatalog': 'The catalog is empty for now',
  'failedSignedOut': 'Sign in to read the market catalog',
  'failedHttp': 'Could not read the catalog (HTTP {status})',
  'failedRefused': 'The catalog read was refused: {message}',
  'failedTransport': 'Could not reach the catalog: {message}',
  'retry': 'Retry',
  'stale': 'Showing the catalog from the last successful read',

  'installed': 'Installed',
  'install': 'Install',
  'installing': 'Installing…',
  'summon': 'Summon',
  'preparing': 'Preparing…',
  'detailPrompts': 'Ask it something like',
  'unavailableNoArtifact': 'No build for this kernel ({kernelApi}) yet',
  'unavailableBadId': 'This item’s id cannot be a preset directory name',
  'notAuthorable': 'This deployment has no writable preset directory',
  'brokenInstalled': 'Installed, but the kernel reports it fails to load',
  'teamBadge': 'Team',
  'downloads': '{count} installs',

  'detailClose': 'Close',
  'detailTags': 'Tags',
  'detailVersion': 'Version',
  'detailKind': 'Kind',
  'detailCategory': 'Category',
  'detailTarget': 'Installs to',

  'confirmTitle': 'Install on this machine?',
  'confirmBody': 'This writes the directory below and adds one selectable agent preset. It runs locally with your permissions and may use the tools its composition declares.',
  'confirmBodySummon': 'This expert is written to the directory below as an agent preset, and a new session opens on it right away. It runs locally with your permissions and may use the tools its composition declares. Only the first summon asks.',
  'confirmCancel': 'Cancel',
  'confirmInstall': 'Install',
  'confirmSummon': 'Summon',
  'installedTitle': 'Installed',
  'installedBody': '“{name}” is now at {path}. Pick it as a preset when starting a session; manage or remove it on the Agent presets page.',
  'installedDone': 'Done',

  'refusedTitle': 'Not installed',
  'refused-not-authorable': 'This deployment has no writable preset directory.',
  'refused-invalid-id': 'This item’s id cannot be a preset directory name.',
  'refused-already-installed': 'A preset with that id already exists; installing never overwrites it.',
  'refused-download-failed': 'The artifact could not be downloaded.',
  'refused-digest-mismatch': 'The artifact digest did not match the catalog; it was discarded.',
  'refused-bad-archive': 'The artifact contents were refused and discarded.',
  'refused-broken-after-install': 'The kernel could not load it after installing, so it was rolled back.',
  'refused-unsupported-format': 'This client has no unpacker for that artifact format yet; try again after updating.',
  'refused-no-base-preset': 'The roster supplies no `standard` preset to compose an expert from.',
  installedSkillsPartial: 'Only {installed} of {total} bundled skills were installed. This expert’s persona still advertises the missing ones, so it will claim skills it cannot invoke. Installing again fills the gap.',
  'refused-no-download-url': 'The console signed no download link for this artifact.',
  'refused-catalog-stale': 'This row is no longer current; refresh the catalog and install again.',
} satisfies Record<MarketKey, string>
