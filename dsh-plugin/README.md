# dsh-multimodal-bridge

**DeepSeek Harness plugin bundle** — 给纯文本模型补上视觉理解与图像生成能力。

把 [multimodal-bridge](../README.md) 的 MCP 能力带进 DeepSeek Harness（`dsh`）：
本包是一个 Cordis 插件 bundle，注册两个模型可见工具：

| 工具 | 功能 | 后端模型 |
|------|------|----------|
| `qwen_vision(image_path, prompt)` | 图片理解、OCR、结构分析 | Qwen-VL 系列（`qwen-vl-max` / `qwen-vl-plus` / `qwen3-vl-flash` …） |
| `qwen_generate(prompt, image_path?, size?, n?, negative_prompt?)` | 文生图；传 `image_path` 时做**图生图**（编辑/风格转换），保存为本地 PNG | Qwen-Image 系列（`qwen-image-2.0` / `wan2.7-image` …） |
| `qwen_video(prompt, image_path?, size?)` | **文生视频**；传 `image_path` 时做**图生视频**（首帧动画），原生异步接口，MP4 落盘，几分钟出片 | t2v: wanx2.1-t2v-turbo / wan2.6-t2v / wan2.7-t2v；i2v: wanx2.1-i2v-turbo / wan2.6-i2v / wan2.7-i2v |
| `qwen_chat(prompt, system?)` | **LLM 咨询**：第二意见、质疑性审查/反驳、验证、复杂推理辅助 | qwen3.7-max / qwen-max / glm-5.2 / MiniMax-M2.5 … |
| `qwen_tts(text, voice?)` | **语音合成**：文本转语音，WAV 落盘 | qwen-tts（`input.text` 形状已验证）|

适用场景与 [multimodal-bridge 的"备选线"](../README.md)相同：DeepSeek 等纯文本模型没有视觉，
`qwen_vision` 是它看图的唯一途径；`qwen_generate` 为任何模型补上出图能力；
`qwen_chat` 让主模型在面对复杂/高不确定性问题时获得**另一模型族的第二意见与反驳**
（Fusion 架构：Qwen 系多模态 + LLM 能力融合给 DeepSeek v4）。

## 安装

以下命令默认在**仓库根目录** `multimodal-bridge/` 下执行（若已 `cd dsh-plugin`，
则把 `./dsh-plugin` 换成 `.`）：

```sh
# 从 npm（发布后）
dsh plugin --profile <name> add dsh-multimodal-bridge

# 从本仓库 checkout（在仓库根目录执行）
dsh plugin --profile <name> add ./dsh-plugin

# 或直接从 GitHub（会自动执行 prepare 构建；pnpm 首次会要求 allowBuilds 授权）
dsh plugin --profile <name> add github:Spirit4471/multimodal-bridge#<commit-sha>
```

`dsh plugin add` 会把包追加到 profile 的 `dsh.profile.bundles`，其
`cordis.patch.yml` 作为一层配置插入 `multimodal-bridge` 行。

验证层已生效（不启动服务）：

```sh
dsh --profile <name> --dump-config    # 应看到 "# == dsh-multimodal-bridge" 注释块
dsh --profile <name>                  # 启动后即可让模型调用两个工具
```

### 免 profile 快速验证（开发用）

不想建 profile 时，用 overlay 直挂本地构建产物（先 `npm run build`，
把 `overlay.example.yml` 里的路径改成你的 checkout 位置——**Windows 必须用
`file:///C:/...` URL 形式**，`C:/...` 会被 Loader 当成 `c:` 协议拒绝），
在仓库根目录执行：

```sh
dsh web --patch ./dsh-plugin/overlay.example.yml --port 3081
```

## 配置与密钥安全

**核心原则：配置只放"引用"，密钥放在每个用户自己的凭据层里。** bundle 自带的
patch 不含任何秘密（`apiKey: ''`），因此可以直接共享、同步、提交。每个使用者
只需输入自己的两样东西：**Key** 和**归属空间网关**。

### 推荐流程（每个用户一次设置，无需改任何 patch）

1. **归属空间网关（非机密）** → 追加到 `~/.dsh/.env`（用户级环境层，dsh 启动时自动加载）：
   ```ini
   QWEN_API_BASE=https://ws-xxxx.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
   ```
   （用 DashScope 官方端点则不需要这行，默认就是 `https://dashscope.aliyuncs.com`。）

2. **API Key（机密）** → 写入 DSH 官方凭据存储 `~/.dsh/.credentials.yaml`
   （首次创建即为 0600 权限，永不进环境变量、不进配置树）：
   ```yaml
   QWEN_DASHSCOPE_API_KEY: sk-ws-xxxxxxxx
   ```
   视觉/生成分开管理时用 `VISION_API_KEY`、`GENERATE_API_KEY`（未设时回退上面的共享键）。

3. 单次临时覆盖（最高优先级，仅当次进程生效）：
   ```powershell
   $env:QWEN_DASHSCOPE_API_KEY = 'sk-...'   # 或 VISION_API_KEY / GENERATE_API_KEY
   ```

插件每次调用时按 **config `apiKey` → DSH 凭据存储（环境 > `.credentials.yaml` > `.env`）→ 裸环境变量** 的顺序解析，轮换密钥只需改凭据文件，下一轮调用即生效，无需重启。

> ⚠️ 不建议把 key 写进 `cordis.patch.yml`（`apiKey` 字段是给受限部署用的最后一招）：
> patch 文件是普通配置，可能被分享或同步，密钥进去就等于泄露。

### 其他字段

bundle patch 自带默认值；需要改默认值时在 profile 的 `cordis.patch.yml` 里按行 id 覆盖
（注意：patch 替换整行 `config`，需重述保留字段）：

```yaml
- id: multimodal-bridge
  config:
    apiKey: ''                    # 建议留空，走上面的凭据层
    apiBase: ''                   # 留空 = 用环境变量 QWEN_API_BASE，未设则官方端点；填了会覆盖环境变量
    visionModel: qwen-vl-max
    visionFallbackModels: [qwen-vl-plus, qwen3-vl-plus, qwen3-vl-flash]
    generateModel: qwen-image-2.0
    generateFallbackModels:
      - wan2.7-image
      - qwen-image-2.0
      - wan2.7-image-pro
      - wan2.1-t2i-turbo
    videoModel: wanx2.1-t2v-turbo
    videoFallbackModels: [wanx2.1-t2v-plus, wan2.6-t2v, wan2.7-t2v]
    chatModel: qwen3.7-max
    chatFallbackModels: [qwen-max, glm-5.2, MiniMax-M2.5]
    attachGeneratedImages: false   # true = 生成图注册为附件并展示在结果卡片（纯 UI，不进模型请求）
    outputDir: generated
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `apiKey` | `''` | 显式密钥（**不建议用于密钥**）；留空则按上面的凭据优先级解析 |
| `apiBase` | `''` | **留空 = 环境变量 `QWEN_API_BASE` 优先，未设则官方 `dashscope.aliyuncs.com`**；显式填 URL 会覆盖环境变量。兼容网关（URL 含 `compatible-mode` / `maas.aliyuncs.com`）自动走 OpenAI 兼容协议 |
| `visionModel` | `qwen-vl-max` | 视觉模型 |
| `visionFallbackModels` | `[qwen-vl-plus, qwen3-vl-plus, qwen3-vl-flash]` | 视觉备用链（模型级拒绝自动切换）|
| `generateModel` | `qwen-image-2.0` | 首选文生图模型 |
| `generateFallbackModels` | `[wan2.7-image, qwen-image-2.0, wan2.7-image-pro, wan2.1-t2i-turbo]` | 主模型遇网关侧路由错误时按序尝试的备用链；每个模型自动使用各自的官方默认尺寸 |
| `videoModel` | `wanx2.1-t2v-turbo` | 首选文生视频模型（原生异步接口）|
| `videoFallbackModels` | `[wanx2.1-t2v-plus, wan2.6-t2v, wan2.7-t2v]` | 视频备用链；模型级拒绝（AccessDenied / 不存在 / 额度）自动跳过换下一个 |
| `videoI2vModel` | `wanx2.1-i2v-turbo` | 图生视频首选模型（`qwen_video` 收到 `image_path` 时使用）|
| `videoI2vFallbackModels` | `[wanx2.1-i2v-plus, wan2.6-i2v, wan2.7-i2v]` | 图生视频备用链 |
| `chatModel` | `qwen3.7-max` | `qwen_chat` 咨询的首选 LLM |
| `chatFallbackModels` | `[qwen-max, glm-5.2, MiniMax-M2.5]` | 咨询备用链（模型级拒绝自动切换）|
| `ttsModel` | `qwen-tts` | `qwen_tts` 首选语音合成模型（`input.text` 形状已验证可用）|
| `ttsFallbackModels` | `[]` | 语音备用链（`qwen3-tts-flash` 需 voice 参数且对文本格式挑剔，暂未纳入默认链）|
| `attachGeneratedImages` | `false` | 生成成功后把 PNG 注册为持久附件（`ctx.attachments.saveImage`）并把引用放进 canonical 输出的 `attachments` 数组，`presentResult` 据此返回带图片的结果卡片——**纯 UI 通道**：图片块只进卡片，绝不进模型请求（text-only 适配器会以 `UNSUPPORTED_CONTENT` 拒绝）。尽力而为，失败不影响生成结果 |
| `outputDir` | `generated` | 生成文件（图/视频）保存目录；相对路径基于会话工作区（启动目录）解析 |

## 行为与限制

- **大图自动降采样**：超过 ~10 MB 或最长边 1568 px 的图片会用 `sharp`
  压成 JPEG。`sharp` **不随包安装**（避免 pnpm 构建脚本审批拖垮默认安装）；
  遇到超限图片且未装 sharp 时，报错会提示 `dsh plugin --profile <name> add sharp`
  （装完在 profile 目录跑一次 `pnpm approve-builds` 审批其构建脚本）。
- **两种 API 协议**：URL 含 `compatible-mode` 或以 `maas.aliyuncs.com` 结尾
  时走百炼 OpenAI 兼容格式（视觉与生成都挂 `chat/completions`），否则走
  DashScope 原生格式（生成是"提交任务 + 轮询"的异步流程，最长等 2 分钟）。
- **图生图（image-to-image，双通道）**：`qwen_generate` 传 `image_path` 时先在
  当前网关的 chat 通道尝试（部分工作空间支持）；被拒（多数工作空间对图像模型只
  暴露文生图，报 `content length invalid` / `Either 'text' or 'image'` 等误导性
  错误）后**自动回退到 DashScope 原生 `multimodal-generation` 编辑接口**——实测
  工作空间 key 在官方端点可用且支持文字引导编辑（2026-08 探测结论）。原生通道
  不接受 `parameters`，输出尺寸为模型默认（qwen-image-2.0 编辑输出 1024×1024）。
  输入图会压缩到 1024px JPEG（sharp 可用时）以满足内容长度限制。
- **尺寸默认值随模型族变化**：qwen-image 模型默认 `1328*1328`，wanx 模型默认
  `1024*1024`；显式传 `size` 时以传入值为准（可选值见工具 schema）。
- **生成自动路由（fallback）**：免费额度 ≠ 网关路由表——工作空间网关只挂载部分
  模型。主模型遇网关侧错误（`url error`、空响应、`model not enabled` 等）时按
  `generateFallbackModels` 顺序自动换模型重试；401（密钥认证失败）不转移，
  模型级 403（AccessDenied/额度）会转移。
- **文生视频（`qwen_video`）**：走 DashScope 原生 `video-synthesis` 异步接口
  （提交任务 → 轮询 ≤10 分钟 → 下载 MP4），工作空间 key 已验证可用（2026-08-16：
  `wanx2.1-t2v-turbo` / `wan2.6-t2v` / `wan2.7-t2v` 接受任务）。视频模型在网关
  聊天通道不可路由，故不走网关；模型级拒绝按 `videoFallbackModels` 换下一个模型。
- **模型路由原则**：插件**不枚举/探测你的模型**——"有哪些模型、哪些有额度"以
  百炼控制台的免费额度清单为准，你只需把可用模型名填进对应 fallback 配置；
  插件负责按序尝试与失败转移。
- **聊天框内联展示（可选）**：DSH 当前的模型适配器只输出文本，且 DeepSeek 适配器
  遇图片内容块会直接拒绝请求（`UNSUPPORTED_CONTENT`）——所以图片**不能注入对话**。
  开启 `attachGeneratedImages` 后，插件把生成图注册为持久附件，图片块只出现在
  **工具结果卡片**（`presentResult` 的 generic 卡内容，纯 UI 投影，不进模型请求），
  模型本身仍只拿到文件路径文本，并可调 `qwen_vision` 自查图片。Web 端是否渲染
  卡片内的图片块取决于其 UI 适配器实现。
- **`qwen_vision` 是只读并发安全工具**（可与其他工具调用并行）；
  `qwen_generate` 写文件，保持互斥执行。
- 取消：两工具都转发 `exec.signal`，取消会中止在途 HTTP 请求。
- 模型侧错误信息是面向模型的纯文本；`qwen_generate` 的 API 失败返回
  `{ success: false, error }` 而不是抛错，配置类错误（缺 key、`n` 越界）才抛出。

## Fusion 使用模式（架构落地）

本插件的定位：**DeepSeek v4 的感知与对抗中枢**。原则与推荐工作流：

### 决策不分权，感知与生产分权

v4 是唯一控制平面（计划/编排/纠错/判断）；Qwen 家族是能力平面（看/画/动/咨询）。
**不要让 Qwen 替 v4 做决策**——只让它产出信息：结构化读数、生成物、第二意见。

### 感知：传感器读数式查询

- 视觉结果以**结构化文本**过桥（表格/CSV/JSON），不是原图；
- **两级取景**：先整体描述，再针对关键区域/属性聚焦提问；
- **关键事实三角验证**：换问法（或换模型）二次查询交叉确认。

### 对抗审议流水线（qwen_chat 的正确姿势）

```
v4 提出结论
  → 跨族顾问红队审查（system: "你是严厉的审稿人，找出漏洞"）
  → 顾问指出漏洞 → v4 综合、修正或反驳
  → 分歧大 → 第三方模型仲裁（qwq-plus 推理型）
  → 多模型一致 + v4 一致 → 高置信度
```

跨模型族是关键：GLM / MiniMax / Kimi 与 DeepSeek / Qwen 训练分布不同，一致才有
信号价值；同族模型互相附和是噪声。

### 任务画像路由预设（覆盖配置即可切换）

| 预设 | chatModel 链建议 |
|---|---|
| 通用 | `qwen3.7-max → qwen-max → glm-5.2` |
| 代码审查 | `kimi-k2.7-code → qwen3-coder-plus` |
| 逻辑/数学验证 | `qwq-plus → qwen-math-plus` |
| 多样性投票 | `glm-5.2 → MiniMax-M2.5 → kimi-k2.5` |

### 预算感知

免费额度有限（图像/视频是次数制）：flash 系模型做初筛，贵模型只处理 v4 判定
"值得"的请求；v4 自己能推理的绝不过桥。

## 排障

- **`Qwen API error 401: ... invalid_api_key`**：key 与端点不匹配或已过期。
  - 百炼工作空间网关的 key（`sk-ws-...`）**只能**配 `https://ws-xxxx...maas.aliyuncs.com/compatible-mode/v1` 网关地址；
  - DashScope 官方 key（`sk-...`）配默认的 `https://dashscope.aliyuncs.com`。
  按 [配置与密钥安全](#配置与密钥安全) 的优先级检查实际生效的是哪一层的值（启动环境 > `~/.dsh/.credentials.yaml` > `~/.dsh/.env`），或到百炼控制台重新生成 key。
- **大图报"sharp not installed"**：按提示安装：
  `dsh plugin --profile <name> add sharp`，然后在 profile 目录
  （`$DSH_HOME/profiles/<name>`）执行 `pnpm approve-builds` 勾选 sharp 审批其
  构建脚本；或换一张 ≤10MB、长边 ≤1568px 的图。
- **`Qwen API error 400: ... url error, please check url!`**：百炼兼容网关下
  `qwen-image-2.0` 用 `1024*1024` 尺寸会触发这个误导性报错（网关内部路由问题）。
  用官方默认尺寸 `1328*1328`（插件对 qwen-image 模型族已自动采用），或换 `wan2.7-image`
  等 wanx 模型（1024*1024 正常）。不同模型族支持的尺寸不同：wanx 支持
  `1024*1024` / `720*1280` / `1280*720`；qwen-image 支持 `1328*1328` / `1536*1536` 等。
- **生成报 `Qwen image API returned no images`**：模型名在该网关没有图像路由
  （如 `qwen-image-max`），响应里没有图片；换网关实际开通的图像模型（如 `qwen-image-2.0`、`wan2.7-image`）。
- **在 GUI/插件里报 `url error` 但 smoke 脚本正常**：patch/overlay 配置里的
  `apiBase` 显式值会**覆盖**环境变量——把它留空（`apiBase: ''`）才会使用
  `~/.dsh/.env` 里的 `QWEN_API_BASE`。工作空间 key（`sk-ws-...`）必须走工作空间
  网关（同步通道）；走官方原生端点会因工作空间的结果存储链路问题在生成时报
  `url error`（视觉不受影响）。
- **`dsh plugin add` 后版本停在旧版 / 报 `minimumReleaseAge` 相关错误**：
  pnpm 11 起对"刚发布"的版本有约 24 小时的最小发布期保护（supply-chain 安全机制），
  新版本发布后 `add` 可能自动回退旧版；显式 `@<新版本>` 也会在 lockfile 校验步
  报 `MINIMUM_RELEASE_AGE_VIOLATION`。两个解法：① 等发布期窗口过去（约一天）；
  ② 在该 profile 的 `pnpm-workspace.yaml`（`$DSH_HOME/profiles/<name>/`）里加
  `minimumReleaseAge: 0` 关闭门槛后重试。若同时出现 `IGNORED_BUILDS`，
  把同文件里 `allowBuilds` 的对应占位符改为 `true`（或跑 `pnpm approve-builds`）。
- **视频报 `403 AccessDenied` / `Model not exist`**：该模型对当前 key 未开通或
  不在路由表。插件会自动跳到 `videoFallbackModels` 的下一个模型；若整条链都失败，
  到百炼控制台核对免费额度清单里该模型的实际 Code（注意 `wanx2.1-*` 与
  `wan2.1-*` 是不同的名字），再把可用名字填进配置。
- **图生图报 `content parameter's length invalid` / `Either 'text' or 'image'`**：
  这是工作空间网关对图像模型的编辑请求的误导性拒绝（与真实长度无关）。插件已
  自动回退原生编辑接口；若仍失败，检查 `generateModel` 是否被残留环境变量覆盖
  （`GENERATE_MODEL` 只影响 smoke 脚本，插件配置看 `generateModel` 字段），
  或确认模型名在原生端点可用（`qwen-image-2.0` / `qwen-image-edit` 已验证）。
- **`dsh --dump-config` 看不到本层**：确认 `dsh plugin add` 成功后 `dsh.profile.bundles` 里有 `dsh-multimodal-bridge`，且包名拼写一致。

## 开发

```sh
cd dsh-plugin
npm install
npm run build    # tsc → lib/
```

`prepare` 脚本保证从 git 直接安装时也会自动构建（无 monorepo 上下文依赖）。

### 免 Harness 冒烟测试

不用启动 dsh 也能验证 Qwen 客户端（需要设置 `QWEN_DASHSCOPE_API_KEY`
环境变量，百炼网关可再加 `QWEN_API_BASE`）：

```sh
node scripts/smoke.mjs path/to/image.png "描述这张图片"
node scripts/smoke.mjs gen "一只赛博朋克风格的机械猫" 1024*1024 1
```

## 发布与贡献（生态路线）

DeepSeek Harness 目前不接受外部 PR（见其 CONTRIBUTING），插件走生态路线：

1. **发布到 npm**（`files` 已限定 `lib` + `cordis.patch.yml` + `scripts/smoke.mjs`）：
   ```sh
   cd dsh-plugin
   npm run build
   npm pack --dry-run        # 复核包内容：只应有 lib/**、cordis.patch.yml、scripts/smoke.mjs
   npm login                 # 首次
   npm publish
   ```
2. **发布后冒烟**：`dsh plugin --profile demo add dsh-multimodal-bridge` +
   `dsh --profile demo --dump-config` 应能看到本层。
3. **给仓库加 `dsh-plugin` topic**：GitHub 仓库 Settings → Topics →
   `dsh-plugin`，方便社区发现。
4. **README / 博客介绍**：说明"纯文本模型 + 桥 = 视觉/出图能力"的用法，
   就像本仓库 README 的双轨工作流图。
5. **社区**：登记 [awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness)，
   并在 DeepSeek Harness 的 GitHub Discussions / Discord 分享。

### 检查清单

- [ ] `package.json` 含 `dsh.bundle.patch`，指向随包发布的 `cordis.patch.yml`
- [ ] 包内行 `name` 引用包名本身（`dsh-multimodal-bridge`），Node 从 profile 的 `node_modules` 解析
- [ ] peerDependencies 声明 `@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-tools`
- [ ] `npm pack --dry-run` 确认只打包 `lib/**`、`cordis.patch.yml` 与 `scripts/smoke.mjs`
- [ ] `dsh plugin add` 后 `--dump-config` 可见本层，启动后工具可被调用
- [ ] 仓库根 `.github/workflows/dsh-plugin-ci.yml` 已随仓库启用 CI（自动 tsc 类型检查 + 打包校验）

## License

[MIT](../LICENSE)
