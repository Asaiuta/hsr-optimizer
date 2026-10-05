# AI 自动化接口

本分支提供结构化浏览器 API 和 MCP stdio 桥接，覆盖存档与扫描导入、库存查询和对比、配装模拟、CPU/GPU 搜索、方案管理、优化器内换装、批量分析和候选联合分配。计算复用网页现有引擎。

需要 Node.js 26+、npm 11+ 和 Microsoft Edge。MCP 使用独立临时浏览器，**不共享手动打开网页的存档**：先导入，结束前导出。所有换装操作只修改优化器，不操作游戏。

## 启动与接入

在仓库根目录执行：

```powershell
npm ci
npm run build
npm run preview -- --host 127.0.0.1 --port 4173
```

保持预览运行。网页地址为 <http://127.0.0.1:4173/hsr-optimizer/>。

仓库位于 `D:/AI/hsr-optimizer` 时，MCP 客户端可使用下列配置；其他位置需调整脚本绝对路径：

```json
{
  "mcpServers": {
    "hsr-optimizer": {
      "command": "node",
      "args": ["D:/AI/hsr-optimizer/scripts/automation-mcp.mts"],
      "env": {
        "HSR_AUTOMATION_URL": "http://127.0.0.1:4173/hsr-optimizer/",
        "HSR_BROWSER_CHANNEL": "msedge"
      }
    }
  }
}
```

客户端启动的 Node 必须为 26+；可将 `command` 改为其可执行文件绝对路径。两个环境变量默认就是上述值，浏览器通道也可设为已安装的 `chrome`。

Codex 使用 TOML 配置而非上面的 JSON。按 [官方 MCP 配置说明](https://developers.openai.com/codex/mcp/)，可在其 `config.toml` 中添加下列内容（此示例为当前 Windows 电脑的路径，已通过 `codex mcp list` 验证）：

```toml
[mcp_servers.hsr-optimizer]
command = 'F:\nvm4w\nodejs\node.exe'
args = ['D:\AI\hsr-optimizer\scripts\automation-mcp.mts']
startup_timeout_sec = 30
tool_timeout_sec = 180

[mcp_servers.hsr-optimizer.env]
HSR_AUTOMATION_URL = 'http://127.0.0.1:4173/hsr-optimizer/'
HSR_BROWSER_CHANNEL = 'msedge'
```

重新加载客户端后，确认出现 `hsr_start_scan` 等工具。180 秒工具超时为首次下载预留时间；扫描本身是异步任务，不占用一个长时间 MCP 调用。文档要求 Node 26+，但本机 nvm4w 的 v24.9.0 已实测可完成握手并列出全部 31 个工具；若后续版本出现兼容问题，再换用 Node 26+ 并同步更新此路径。

若通过 npm 启动，使用 `npm run --silent automation:mcp` 并指定仓库工作目录，避免 npm 横幅干扰 stdio。桥接不会启动预览服务器；网页须使用本分支构建。

## 实时查看 AI 操作（AI 动态面板）

MCP 桥接创建浏览器后会在 `127.0.0.1:4176` 启动一个轻量事件中继（SSE）。用浏览器打开网页，点击顶栏的机器人图标即可打开 AI 动态面板：

- 实时显示每个自动化命令的状态、耗时和参数/结果摘要；连续相同的轮询（如每秒一次的 `hsr_get_scanner`、`hsr_get_job`）合并为一行，展示次数和最新状态。
- 面板打开时才建立连接；面板关闭、会话结束或中继不可达时显示"未连接"，不影响 AI 会话本身。
- **把 AI 会话数据同步到本页**：拉取 AI 会话的当前存档快照，确认后替换本页存档。AI 导入的扫描数据由此可在手动打开的网页中直接查看，无需导出再导入文件。
- 页面内的输入/结果摘要截断到约 2000 字符；中继保留最近 200 条事件，面板重连时补发积压。
- 用户在面板里触发的快照导出不算 AI 操作，不会出现在动态中。

中继只监听 `127.0.0.1`，仅允许来自配置网址（127.0.0.1 与 localhost 两种写法）的跨域读取；`/snapshot` 返回 AI 会话的存档 JSON，不写入文件。相关环境变量：

| 变量                   | 默认 | 用途                                                                       |
| ---------------------- | ---- | -------------------------------------------------------------------------- |
| `HSR_MIRROR_PORT`      | 4176 | 中继端口；被占用时该会话跳过中继并在 stderr 记录，自动化不受影响             |
| `HSR_BROWSER_HEADLESS` | true | 设为 `false` 时自动化浏览器以有头窗口运行，可直接旁观优化器界面随操作变化    |

多个 MCP 会话同时运行时只有第一个会话占用中继端口，面板显示的是占用该端口的会话；其余会话的动态不可见。

## 本机扫描器

MCP 支持在游戏所在的 Windows x64 电脑上按需安装并启动 [Reliquary Archiver](https://github.com/IceDynamix/reliquary-archiver)。无需另装 Python 或 Npcap，也不需要将游戏文字改成英文。扫描器通过 Windows Packet Monitor 读取登录时的库存数据。

首次使用：

1. 启动本地预览并连接 MCP。若要保留此前的命名方案和角色设置，先导入原优化器存档。
2. 打开游戏，停在“点击进入”的登录界面；如果已经进入游戏，先返回该界面。
3. 调用 `hsr_start_scan`，例如 `{ "timeoutSeconds": 120 }`。首次调用会下载扫描器，随后 Windows 会显示管理员授权提示。授权只用于扫描器辅助进程，MCP 和浏览器不提升权限。
4. 每秒调用一次 `hsr_get_scanner`。`starting` 表示下载、等待授权或初始化；**等到 `running` 后再点击进入游戏**，该状态来自实际采集就绪日志。
5. 扫描完成后自动校验并导入。只有 `completed` 才表示扫描与导入都成功，之后即可查询库存或发起优化。
6. 完成配装后调用 `hsr_export_save_file` 保存优化器存档。

| MCP 工具              | 参数                                       | 用途                                                           |
| --------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| `hsr_install_scanner` | 无                                         | 提前下载并验证扫描器；已安装时只校验，不重复下载               |
| `hsr_start_scan`      | 可选 `timeoutSeconds`，30–600 秒，默认 120 | 按需安装，启动一次扫描并自动导入；立即返回任务信息             |
| `hsr_get_scanner`     | 无                                         | 查询最新任务、输出文件路径、错误及导入结果                     |
| `hsr_cancel_scan`     | 无                                         | 请求取消采集，退出后才标记 `cancelled`；导入已经开始时不能取消 |

扫描器固定为 `v0.19.0`，下载大小 12,294,144 字节，SHA-256 为 `4c687b0cc042d641fe3d2e513e3380544055f46ebb4092cc2a6dcb9072835c0a`。只从上游固定版本地址下载，启动前重新校验，不自动更新。遇到游戏更新导致不兼容时须升级并重新验证这个固定版本。

缓存位于 `%LOCALAPPDATA%/hsr-optimizer/scanner`，附带 MIT 许可证及来源信息；扫描原始 JSON 按任务单独保存在 `runs/<id>/scan.json`。Windows 打包应用可能重定向此目录，接口返回的是解析后的实际路径。缓存和账号数据不写入仓库，也不加入网页构建；历史扫描文件保留供恢复，可在任务结束后自行清理。

同一 MCP 会话只运行一次扫描；Windows 辅助进程也会互斥，防止本集成的多个会话同时采集。扫描期间可查询、导出库存，但拒绝新增优化任务和修改库存。若已有优化尚未结束，自动导入可能返回 `BUSY`，此时原始扫描文件仍保留，可稍后通过 `hsr_import_scan_file` 导入。

退出 MCP 或取消时会请求扫描器关闭，让其执行 Packet Monitor 清理；关闭信号不可用时等待原扫描超时，不强行终止并假装已清理。未确认清理完成会报告失败。取消和超时产生的部分数据不会自动导入；即使上游写出了 JSON，也必须有完整采集成功标志。`failed` 时查看 `error` 和 `outputPath`，原库存保持不变。

以上四项是本地 MCP 工具，不属于网页中的 27 个浏览器命令。浏览器本身不能启动 Windows 扫描器。

## 从扫描到保存配装

1. 调用 `hsr_import_scan_file` 导入扫描结果，或用 `hsr_import_save_file` 导入优化器存档。
2. 调用 `hsr_list_characters`、`hsr_list_relics`、`hsr_list_light_cones`、`hsr_get_resources` 查询当前数据。
3. 调用 `hsr_get_request` 检查继承的配置，用 `hsr_simulate_build` 或 `hsr_compare_builds` 比较方案。
4. 调用 `hsr_start_optimization`，再按需查询 `hsr_get_job`，建议每秒一次。
5. 完成后读取 `hsr_get_results`，用 `hsr_save_result` 保存候选。
6. 用 `hsr_check_builds` 检查要应用的方案，将返回的 `inventoryRevision` 传给 `hsr_equip_builds.expectedRevision`。
7. 用 `hsr_export_save_file` 写入一个尚不存在的文件，再结束 MCP 会话。

`import_save` 替换存档。`import_scan` 使用项目现有扫描合并逻辑：非空遗器列表作为本次库存，更新匹配遗器及扫描角色，保留现有角色配置和命名方案；空遗器列表沿用网页的“仅导入角色”行为。扫描后引用已删除遗器的旧方案仍可列出，`missingRelics` 会标明缺失项。

支持项目现有的 HSR-Scanner、Reliquary Archiver 和 Yas 文件版本；不自动升级旧扫描格式。解析不完整、未知角色/光锥或无效遗器会失败，不静默导入部分数据。角色和光锥的计算等级与网页扫描导入一致，使用 80 级。

文件最多 32 MiB；优化器存档最多 200 个角色、10,000 件遗器。扫描光锥最多 5,000 件、材料最多 10,000 条。导出拒绝覆盖已有文件。

## 浏览器 API

网页初始化后提供 `window.hsrAutomation`，版本为 `1`：

- `await api.describe()` 返回命令说明和输入 JSON Schema。
- `await api.call(name, input)` 返回 `{ ok: true, data }` 或 `{ ok: false, error: { code, message } }`。
- MCP 中大部分命令添加 `hsr_` 前缀，参数相同。响应文本为同样的 JSON 信封，失败时设置 `isError`。

以下代码可在已导入存档的网页控制台运行。角色需已设置匹配命途的光锥：

```javascript
const api = window.hsrAutomation
async function call(name, input = {}) {
  const reply = await api.call(name, input)
  if (!reply.ok) throw new Error(reply.error.code + ': ' + reply.error.message)
  return reply.data
}
const { characters } = await call('list_characters')
if (!characters.length) throw new Error('请先导入存档')
const characterId = characters[0].id
const settings = { resultSort: 'COMBO', resultsLimit: 10 }
console.log(await call('get_request', { characterId, settings }))
const { jobId } = await call('start_optimization', { characterId, settings })
let job = await call('get_job', { jobId })
while (job.status === 'running') {
  await new Promise((resolve) => setTimeout(resolve, 1000))
  job = await call('get_job', { jobId })
}
if (job.status !== 'completed') throw new Error(job.error ?? job.status)
console.log(await call('get_results', { jobId }))
```

## 查询与库存比较

| 命令                          | 主要参数                                     | 返回内容                                                                                   |
| ----------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `list_characters`             | 可选 `includeUnimported`                     | 角色 ID、名称、命途、元素、已配置光锥、当前装备、方案名称；可查询未导入角色的资料          |
| `list_relics`                 | 分页、可选 `equippedBy` / `part`             | 遗器主副词条、预测词条、套装、当前归属                                                     |
| `list_light_cones`            | 分页、可选 `path` / `ownedOnly`              | 默认游戏资料；`ownedOnly` 返回扫描所得的实际光锥实例                                       |
| `get_resources`               | 分页                                         | 扫描来源、星琼/古老梦华、材料数量，以及另列的抽卡规划配置                                  |
| `get_request`                 | `characterId`、可选 `buildName` / `settings` | 归一化后的完整配置                                                                         |
| `compare_inventory`           | 旧存档 `json`、分页                          | 当前相对旧存档的新增、删除、变化及总数，包含角色装备/星魂/光锥、遗器、扫描光锥、材料和货币 |
| `import_scan` / `import_save` | `json` 字符串                                | 导入后的数量                                                                               |
| `export_save`                 | 无                                           | JSON 存档字符串                                                                            |

通用分页默认 `offset: 0, limit: 20`，每页最多 100 条。库存差异按稳定 ID 比较，不推测两个不同 ID 是否代表同一件物品；派生评分和排序索引不参与比较。

扫描资源与实际光锥库存随本分支存档保存、重载。没有扫描数据时返回 `available: false`；未知货币为 `null`，不会当成零库存。抽卡规划中的数值可能由用户填写，不能视为真实资产。

MCP 将四个大文本命令替换为本地文件工具：

| MCP 工具                     | 参数                            |
| ---------------------------- | ------------------------------- |
| `hsr_import_save_file`       | `path`                          |
| `hsr_import_scan_file`       | `path`                          |
| `hsr_compare_inventory_file` | `path`、可选 `offset` / `limit` |
| `hsr_export_save_file`       | 尚不存在的 `path`               |

## 模拟与搜索配置

`simulate_build` 接受 `characterId`、可选 `settings`、`buildName`、`relicIds` 或 `virtualRelics`。默认使用当前六件装备；指定 `buildName` 时使用命名方案的装备和网页所保存的方案设置。显式 `settings` 优先。

`relicIds` 必须六件不同的已有遗器，每个位置一件。`virtualRelics` 则是六个假想遗器对象，字段为 `part`、`set`、`mainStat`、`substats: [{ stat, value }]`、可选 `grade` / `enhance`（默认 5 星、15 级）。主词条数值由游戏数据计算，副词条使用界面数值。两种输入不能同时提供；虚拟遗器不加入库存，也不能直接保存或装备。

`compare_builds` 接受一个 `baseline` 和最多 20 个 `candidates`，每项使用上述模拟参数且须为同一角色。返回属性与轮次结果，以及各数值的 `before`、`after`、`delta`、`percent`；基准为零时百分比为 `null`。这些是计算差异，不是自动生成的因果解释。

可以比较主词条/套装、光锥与叠影、星魂、队友、激活条件和技能序列，例如：

```javascript
await call('compare_builds', {
  baseline: { characterId, settings: { rotation: ['DEFAULT_SKILL'] } },
  candidates: [
    { characterId, settings: { rotation: ['DEFAULT_SKILL', 'DEFAULT_ULT'] } },
  ],
})
```

配置规则：

- 省略的设置继承角色已保存的配置，`resultsLimit` 例外，默认 10，上限 100。搜索仍遍历筛选后的空间，只限制保留数量。
- `statFilters` 使用界面单位：`minCr: 70` 为 70% 暴击率，`minSpd: 134` 为 134 速度；`null` 清除上下限。筛选作用于 `statDisplay: 'base' | 'combat'`。
- `resultSort` 使用 `COMBO`、`ATK`、`SPD` 等引擎键。`COMBO` 依赖当前轮次和战斗假设。
- `rotation` 为 1–12 个动作，枚举见 `describe()`。显式提供时替换旧序列，清除旧逐回合覆盖并关闭自动预处理；未提供时保留网页现有序列。
- `teammates` 为三个位置的完整数组；`null` 清空该位置，非空项需角色 ID，光锥可省略。
- `characterConditionals` / `lightConeConditionals` 更新默认激活值；未替换轮次时保留逐回合自定义。
- 主词条筛选空数组不限制该位置；`setFilters` 的三个空数组不限制套装。
- `mainStatUpscaleLevel` 在搜索和模拟中都使用网页的预测升级规则。
- 单配装模拟不要求通过搜索筛选。搜索中的装备、角色优先级与排除规则保持网页语义。

`start_optimization` 接受上述角色配置和 `engine: 'cpu' | 'gpu'`，默认 CPU。返回任务 ID，可通过 `get_job`、`get_results`、`cancel_job` 操作。仅保留最近一个单任务。完成状态在结果写入后发布；失败或取消不会作为完整最优结果返回。GPU 不可用时失败，不自动切换 CPU。

同分候选顺序可能不同。库存改变后结果标记 `stale`，可查看但不能直接保存。

## 保存与应用方案

| 命令           | 参数                                                              | 行为                                 |
| -------------- | ----------------------------------------------------------------- | ------------------------------------ |
| `save_result`  | `jobId`、零基 `index`、`name`                                     | 保存完成的搜索候选                   |
| `save_build`   | `characterId`、`name`、可选 `relicIds` / `settings` / `buildName` | 保存当前或指定的已有遗器方案         |
| `list_builds`  | `characterId`、分页                                               | 完整方案、缺失遗器、外部占用         |
| `delete_build` | `characterId`、`name`                                             | 删除命名方案，保留角色和遗器         |
| `check_builds` | `assignments`                                                     | 检查多角色分配，返回冲突和数据修订号 |
| `equip_builds` | `assignments`、`expectedRevision`、可选 `onConflict`              | 一次应用多角色装备                   |

每个 assignment 为 `{ characterId, name }` 或 `{ characterId, relicIds }`，最多 32 个角色，同一角色只出现一次。

同一遗器分给多个角色会被拒绝。遗器被计划外角色占用时，默认 `onConflict: 'reject'`；显式 `'transfer'` 会解除原角色该位置的装备。计划中的角色可以交换遗器。行为不受网页“交换/替换”偏好影响。

```javascript
const assignments = [{ characterId, name: 'AI candidate' }]
const plan = await call('check_builds', { assignments })
console.log(plan.conflicts)
if (!plan.conflicts.length) {
  await call('equip_builds', {
    assignments,
    expectedRevision: plan.inventoryRevision,
  })
}
```

修订号检查和全部校验在修改前完成；计划过期或冲突失败不会部分换装。保存方案拒绝同名覆盖，使用网页已有的方案格式和还原语义，不修改角色搜索默认设置。网页方案格式不包含全部敌人和筛选设置，复现特定实验时应同时保留其请求参数。换装只应用遗器，不修改星魂、光锥和队友。

方案可保留未配置光锥的队友。独立的角色评分基准要求队友光锥齐全；缺少时不计算该基准，避免忽略队友后给出误导评分。自动化配装模拟仍可使用该方案。

## 批量分析与联合分配

`start_batch` 接受 `requests` 数组和可选 `engine`。最多 32 个场景，总保留结果上限 1000，每场景最多 100。可多次使用同一角色，以比较不同光锥、队友、星魂或筛选设置。

批次按顺序复用同一工作线程池，不自动换装或预占遗器。运行时拒绝其他自动化搜索、模拟和写操作；用户从网页中断当前搜索会停止批次。库存改变也会停止后续搜索。

| 命令                | 参数                                                |
| ------------------- | --------------------------------------------------- |
| `get_batch`         | `batchId`                                           |
| `get_batch_results` | `batchId`、零基 `requestIndex`、分页                |
| `cancel_batch`      | `batchId`                                           |
| `save_batch_result` | `batchId`、`requestIndex`、零基结果 `index`、`name` |
| `allocate_batch`    | `batchId`、可选 `weights` / `maxNodes`              |

仅保留最近一个批次。中途失败或取消会保留已完成场景结果，并明确标记未启动场景；这些结果不代表整个批次完成。

联合分配要求批次成功完成、每个角色恰好一个场景、库存未变化。算法在保留候选中寻找无遗器冲突的组合，目标为：

`sum(weight[i] * selectedScore[i] / bestRetainedScore[i])`

默认各角色权重为 1，按各自最佳候选归一化，避免高数值角色自然压过其他角色。各角色评分须非负且最大值大于零。队友模型和战斗假设沿用各场景，不重新联动模拟所有角色的装备收益。

采用有界分支定界搜索，不预先生成候选笛卡尔积；默认工作上限 `maxNodes: 100000`，最大 1000000，冲突检查也计入工作预算。返回：

- `scope: 'retained_candidates'`：结论只适用于保留的候选。
- `searchComplete: true`：搜索穷尽或已由上界剪枝证明；非空方案为该候选范围内的最佳方案。
- `searchComplete: false`：达到工作上限，返回当前最佳可行方案（可能仍为 `null`）及 `upperBound`。
- `assignments: null` 且搜索已完成：当前候选中没有可行分配，不表示整个账号无解。

将非空结果的 `characterId` 和 `relicIds` 组成 assignments，再调用 `check_builds` / `equip_builds`。默认搜索仅保留前十名，遇到冲突可增加各场景的 `resultsLimit` 或调整筛选后重跑。

**这还不是覆盖全部遗器组合和动态队伍收益的全账号全局最优算法。**当前提供的是可验证、可应用的候选联合分配，输出明确区分候选范围和是否穷尽。

## 无浏览器 Node 实验入口

已支持从当前版本存档执行 `simulate_build` 和 `compare_builds`，不需要启动网页、Chromium 或 MCP。要求 Node.js 26+ 和已安装的项目依赖。在仓库目录运行：

```powershell
npm run automation:headless:build
node output/headless/automation-headless.mjs simulate_build save.json request.json
```

`save.json` 使用优化器导出的 JSON 存档，`request.json` 例如：

```json
{ "characterId": "1212b1" }
```

角色必须已导入并装备六件遗器；也可传入 `relicIds`、`virtualRelics`、`buildName` 和 `settings`，参数与网页 API 相同。比较请求示例：

```json
{
  "baseline": { "characterId": "1212b1" },
  "candidates": [
    { "characterId": "1212b1", "settings": { "mainStatUpscaleLevel": 15 } }
  ]
}
```

将命令改为 `compare_builds` 即可。标准输出为 `{ "ok": true, "data": ... }`；错误为 `{ "ok": false, "error": { "message": "..." } }` 且退出码为 1。标准错误输出运行时间和 RSS 内存指标，方便调用方分别收集。`executionMs` 不含模块加载时间，`processUptimeMs` 含进程启动时间；`rssBytes` 是采样时内存，不是峰值，也不能据此推断比浏览器快多少。

入口加载存档的行迹开关和命名方案，不修改输入文件，不返回网页的 `inventoryRevision`。单个输入文件上限 32 MiB。请使用当前版本导出的存档；此入口不执行网页完整的旧版存档迁移流程。

当前复用 TypeScript 计算代码，尚未实现 Rust 内核。CPU/GPU 遗器搜索、批量搜索、换装写入和扫描流程没有迁入这个入口，VCP 原生插件也尚未接入。部分共享代码仍依赖进程内的评分配置和 React/Zustand 模块，因此这还不是完全无状态的独立计算库；CLI 每次用新进程隔离配置。

提取前的网页与 Node 已对照 5 个角色、25 组模拟，完整输出在排除库存版本号后完全一致。自动化测试继续覆盖这些场景、行迹开关、命名方案和错误退出，并通过禁止访问浏览器全局对象验证 Node 路径。样本对照不代表覆盖全部角色与机制。

## 错误与验证

Node 入口的可复现性能测量见 [性能基线](./headless-performance.md)，运行 `npm run automation:benchmark` 可重新测量。

| 错误码                            | 处理方式                                   |
| --------------------------------- | ------------------------------------------ |
| `INVALID_INPUT`                   | 检查参数、ID、上下限、扫描版本或存档结构   |
| `NOT_FOUND`                       | 重新查询角色、遗器、方案或最新任务 ID      |
| `BUSY`                            | 等待或取消当前搜索/批次                    |
| `NOT_COMPLETED`                   | 检查对应任务或场景状态                     |
| `STALE_INVENTORY`                 | 重新搜索或重新检查换装计划                 |
| `ALREADY_EXISTS`                  | 换一个方案名称                             |
| `EQUIPMENT_CONFLICT`              | 检查重复分配或外部占用                     |
| `INVALID_RESULT`                  | 检查非有限数值或不适合归一化的评分         |
| `UNKNOWN_COMMAND`                 | 用 `describe()` 重新发现命令               |
| `INTERNAL_ERROR` / `BRIDGE_ERROR` | 查看消息，检查网页、文件、浏览器或存储环境 |

API 和 Schema 首次调用时才加载，不添加闲置轮询、套接字或工作线程。MCP 在发现工具/首次调用时创建浏览器，stdin EOF 和退出信号都会清理浏览器。CPU 批次使用常量空间游标，套装掩码每轮只打包一次，缓存缓冲区数量限制为工作线程数。库存版本按数组引用检查；库存差异只在显式请求时计算，返回有界页面。多角色换装按库存和分配数量线性处理，避免逐件重复重建完整索引。

验证命令：

```powershell
npm run lint
npx tsgo --noEmit -p tsconfig.json
npm run automation:typecheck
npm run automation:scanner:test
npm run vitest -- --maxWorkers=4
npm run build
npm run automation:test
git diff --check
```

浏览器测试使用独立端口 4174，须先构建。覆盖 CPU/GPU 对照、64 组合排名、预测升级、失败/取消、扫描持久化、虚拟模拟和轮次比较、方案还原、冲突转移、批量任务、联合分配应用、MCP 文件操作、惰性加载和 EOF 退出。联合分配另有随机小规模穷举对照。没有 WebGPU 适配器时 GPU 用例会明确跳过。
