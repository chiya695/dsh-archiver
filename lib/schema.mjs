/**
 * lib/schema.mjs —— 设置页的字段描述表（服务端唯一真相）
 * ============================================================================
 * 前端（client.js）不写死任何字段：它拉 /api/dsh-archiver?view=boot 拿到
 * `groups`，按 type 渲染控件，保存时把改动按点路径回传。
 *
 * 好处：以后加一个设置项只改这里，前端不用动，也就不必重新验证页面。
 *
 * 每个字段：
 *   key      点路径（同时是 config.json 里的位置）
 *   type     bool | number | text | password | textarea | select
 *   label    人话标题
 *   help     一行说明（为什么要这么设）
 *   options  select 用：[[value, label], ...]
 *   min/max/step   number 用
 *   unit     数字后面的单位（纯展示）
 *   placeholder
 *   rows     textarea 行数
 * ============================================================================
 */

export const GROUPS = [
  {
    id: 'mode',
    title: '模式与对象',
    desc: '归档什么、往哪儿放。自动与手动共用这一组。',
    fields: [
      { key: 'enabled', type: 'bool', label: '启用自动归档', help: '关掉后只有手动能触发；插件本身不受影响。' },
      { key: 'targets.skills', type: 'bool', label: '归档技能', help: '每个技能一个 zip（SKILL.md 所在目录整包）。' },
      { key: 'targets.plugins', type: 'bool', label: '归档插件', help: '每个已装插件一个 zip（不含 node_modules）。' },
      {
        key: 'dest',
        type: 'select',
        label: '默认落地位置',
        options: [['local', '只存本地'], ['webdav', '只传 WebDAV'], ['both', '本地 + WebDAV']],
        help: 'WebDAV 没配好时会自动退回"只存本地"。',
      },
      {
        key: 'zip.skipUnchanged',
        type: 'bool',
        label: '增量归档（跳过没变的东西）',
        help: '按"文件数 + 总字节 + 最新修改时间"判断源目录有没有变；没变就复用上次的 zip。只在「flat 布局 + 本地落地」时生效。',
      },
    ],
  },

  {
    id: 'auto',
    title: '自动模式',
    desc: '两条节拍可以同时开：DSH 启动时一次，加上每 N 小时 / 每天定时。',
    fields: [
      { key: 'auto.onStart', type: 'bool', label: 'DSH 启动后自动归档一次', help: '每次启动（含重启）都会跑一次。' },
      {
        key: 'auto.onStartDelayMs',
        type: 'number',
        label: '启动后延迟',
        unit: '毫秒',
        min: 0,
        max: 600000,
        step: 1000,
        help: '建议留 10000–30000，别跟启动读盘抢 IO。',
      },
      {
        key: 'auto.everyHours',
        type: 'number',
        label: '每隔几小时自动归档',
        unit: '小时',
        min: 0,
        max: 720,
        step: 1,
        help: '0 = 关闭这条节拍。',
      },
      {
        key: 'auto.dailyAt',
        type: 'text',
        label: '每天定时',
        placeholder: 'HH:MM，例如 03:30（留空 = 关闭）',
        help: '本地时间。当天跑过就不再跑；跨天重新计时。',
      },
      {
        key: 'auto.minGapMinutes',
        type: 'number',
        label: '最小间隔',
        unit: '分钟',
        min: 0,
        max: 10080,
        step: 5,
        help: '防抖：刚跑过（含手动）就不会在这么短时间内再自动跑。',
      },
    ],
  },

  {
    id: 'manual',
    title: '手动模式',
    desc: '面板「立即归档」、工具 dsh_archive_now、命令行都按这里的默认值走，单次还能临时改。',
    fields: [
      {
        key: 'manual.defaultTargets',
        type: 'select',
        label: '默认归档对象',
        options: [['all', '技能 + 插件'], ['skills', '只技能'], ['plugins', '只插件']],
      },
      { key: 'manual.dryRun', type: 'bool', label: '默认空跑（只扫描不写盘）', help: '想看"会打哪些包"又不想动文件时勾上。' },
      { key: 'manual.openAfterRun', type: 'bool', label: '跑完自动打开产物目录', help: '只对本地落地生效（Windows 资源管理器）。' },
    ],
  },

  {
    id: 'local',
    title: '本地落地',
    desc: 'zip 往哪儿写、怎么组织。',
    fields: [
      {
        key: 'local.root',
        type: 'text',
        label: '保存目录',
        placeholder: '例如 D:\\Backup\\dsh（留空 = $DSH_HOME/dsh-archiver/out）',
        help: '留空就用插件家目录下的 out/。',
      },
      {
        key: 'local.layout',
        type: 'select',
        label: '目录布局',
        options: [['flat', 'flat：固定文件名，直接覆盖（推荐）'], ['run', 'run：每次一个时间戳目录，没有"最新"副本']],
        help: 'flat 下"最新"永远在那几个固定文件名上；历史版本另存 history/ 里。',
      },
      {
        key: 'local.keepVersions',
        type: 'number',
        label: '保留历史版本数量',
        unit: '份',
        min: 0,
        max: 500,
        step: 1,
        help: '0 = 只留最新。设为 N 就额外保留最近 N 份快照：flat 落在 <保存目录>/history/<时间>/；run 布局下即保留最近 N 个目录（超出自动删最旧的）。每份约等于一轮全部 zip 的体积。',
      },
      {
        key: 'local.pluginImportDir',
        type: 'text',
        label: '插件导入目录',
        placeholder: '留空 = $DSH_HOME/dsh-archiver/imported-plugins',
        help: '导入插件包时解压到这里（不直接改 profile / pnpm 树），导入结果里会给出 link 命令。',
      },
    ],
  },

  {
    id: 'webdav',
    title: 'WebDAV',
    desc: '逐级 MKCOL 建目录后 PUT 上传；密码建议走环境变量，不写进配置文件。',
    fields: [
      { key: 'webdav.enabled', type: 'bool', label: '启用 WebDAV 上传' },
      { key: 'webdav.url', type: 'text', label: '服务地址', placeholder: 'https://dav.jianguoyun.com/dav/' },
      { key: 'webdav.username', type: 'text', label: '用户名', placeholder: '账号邮箱 / 用户名' },
      {
        key: 'webdav.password',
        type: 'password',
        label: '密码（不建议写在这里）',
        placeholder: '留空，改用下面的环境变量',
        help: '面板不回显已存密码（留空 = 不修改）。坚果云等要用「应用密码」，不是登录密码；要清空：config set webdav.password ""。',
      },
      {
        key: 'webdav.passwordEnv',
        type: 'text',
        label: '密码环境变量名',
        placeholder: 'DSH_ARCHIVER_WEBDAV_PASSWORD',
        help: '优先读这个环境变量；Password 字段留空即可。',
      },
      { key: 'webdav.root', type: 'text', label: '远端目录', placeholder: 'dsh-archiver' },
      {
        key: 'webdav.timeoutMs',
        type: 'number',
        label: '单请求超时',
        unit: '毫秒',
        min: 5000,
        max: 600000,
        step: 1000,
      },
    ],
  },

  {
    id: 'zip',
    title: '打包',
    desc: '压缩与排除规则。',
    fields: [
      {
        key: 'zip.level',
        type: 'number',
        label: '压缩级别',
        unit: '0–9',
        min: 0,
        max: 9,
        step: 1,
        help: '0 = 只存储（最快、最大）；6 是默认；9 最慢最省。',
      },
      {
        key: 'zip.maxFileMB',
        type: 'number',
        label: '单文件上限',
        unit: 'MB',
        min: 1,
        max: 4096,
        step: 1,
        help: '超了就跳过并记进 warnings，不会把整次归档拖死。',
      },
      {
        key: 'zip.exclude',
        type: 'textarea',
        label: '排除片段（一行一个）',
        rows: 6,
        help: '目录/文件名里含这些片段就不进包。默认挡掉 node_modules、.git 等。',
      },
    ],
  },

  {
    id: 'sources',
    title: '来源',
    desc: '除了 $DSH_HOME/skills、~/.agents/skills、插件自带 skills/ 之外，还要收哪些地方。',
    fields: [
      {
        key: 'sources.projectCwd',
        type: 'text',
        label: '项目根（可选）',
        placeholder: '例如 D:\\Projects\\my-project',
        help: '填了就会额外收 <项目>/.dsh/skills 与 <项目>/.agents/skills。',
      },
      {
        key: 'sources.extraSkillRoots',
        type: 'textarea',
        label: '额外技能根（一行一个）',
        rows: 4,
        help: '每个子目录一个技能（含 SKILL.md）。',
      },
      {
        key: 'sources.skillImportRoot',
        type: 'text',
        label: '技能导入目录',
        placeholder: '留空 = $DSH_HOME/skills',
        help: '导入技能包时解压到这里；DSH 的技能提供器会自动发现新目录，无需重启。',
      },
      {
        key: 'sources.includeBundledSkills',
        type: 'bool',
        label: '收 DSH 自带的技能',
        help: 'office-docx / office-pptx / office-xlsx 等。',
      },
      {
        key: 'sources.includeAgentsSkills',
        type: 'bool',
        label: '收 ~/.agents/skills',
        help: '跨 agent 的公共技能根。',
      },
      {
        key: 'sources.includeBuiltinPlugins',
        type: 'bool',
        label: '收 @deepseek-ai/* 基础包',
        help: '随 DSH 安装一起在，重装即得；开了会多出 200MB+ 源体积。',
      },
    ],
  },
]

/** 所有字段的点路径清单（保存时校验用） */
export function fieldKeys() {
  return GROUPS.flatMap((g) => g.fields.map((f) => f.key))
}

/** 面板需要的 schema（纯数据，可 JSON 化） */
export function panelSchema() {
  return {
    groups: GROUPS,
    keys: fieldKeys(),
  }
}
