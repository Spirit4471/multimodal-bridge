# dsh-multimodal-bridge 发布收尾手册（v0.1.1）

npm 包已发布（`dsh-multimodal-bridge@0.1.1`，安装路径已验证）。剩下四步曝光操作：

---

## ① 提交并推送仓库

```powershell
cd C:\WorkSpace\multimodal-bridge
git status                      # 先看一遍：不应有 dsh-plugin/generated/* 的测试图（已 ignore）
git add dsh-plugin .github README.md adapters/qwen_dashscope.py
git commit -m "feat: add dsh-multimodal-bridge plugin bundle (v0.1.1) for DeepSeek Harness

- qwen_vision / qwen_generate tools with model fallback chain and size defaults
- DSH credential-store + user .env secret layering (no keys in config)
- UI image result cards via durable attachments (attachGeneratedImages)
- CI: typecheck + npm pack dry-run on push
- fix: native DashScope vision requests must wrap messages in input.messages"
git push
```

推送后 CI（`.github/workflows/dsh-plugin-ci.yml`）会自动跑 tsc + 打包校验，绿了即为二次确认。

## ② 仓库加 `dsh-plugin` topic

GitHub → `Spirit4471/multimodal-bridge` → 右上角 ⚙️ Settings → 左侧 **Topics** →
添加 `dsh-plugin`（保存）。有 `gh` CLI 且已登录的话可代跑：

```powershell
gh repo edit Spirit4471/multimodal-bridge --add-topic dsh-plugin
```

## ③ 登记 awesome-deepseek-harness

向 https://github.com/0xsline/awesome-deepseek-harness 提 PR/issue，在插件类目下加一条
（格式随该仓库现有条目微调）：

```markdown
- [dsh-multimodal-bridge](https://github.com/Spirit4471/multimodal-bridge) — DeepSeek
  Harness plugin bundle: `qwen_vision` (Qwen-VL image understanding) and
  `qwen_generate` (Qwen-Image text-to-image) tools for text-only models, with
  per-workspace model fallback, credential-store integration, and UI image cards.
```

PR 标题建议：`Add dsh-multimodal-bridge plugin`
PR 正文建议：

```
Adds the dsh-multimodal-bridge plugin bundle (npm: dsh-multimodal-bridge@0.1.1,
repo: Spirit4471/multimodal-bridge/dsh-plugin).

- qwen_vision / qwen_generate as model-facing tools in DeepSeek Harness
- Qwen gateway auto-fallback chain + per-model default sizes
- DSH credential store + user .env secret layering; no keys in config
- Best-effort UI image cards (attachGeneratedImages), never in model requests
- Verified: tsc clean, dsh profile load, live vision + generation
```

## ④ Discord / Discussions 公告稿（可直接粘贴）

**标题**：`[Plugin] dsh-multimodal-bridge — 给纯文本模型的视觉与出图能力`

```markdown
发布了一个 DeepSeek Harness 插件 bundle：**dsh-multimodal-bridge**
（npm: `dsh-multimodal-bridge@0.1.1` | repo: Spirit4471/multimodal-bridge/dsh-plugin）。

一句话：**纯文本模型 + 桥 = 看图 + 出图。**

- `qwen_vision(image_path, prompt)` — Qwen-VL 图片理解 / OCR / 结构分析
- `qwen_generate(prompt, size, n, negative_prompt)` — Qwen-Image 文生图，PNG 落盘
- 百炼工作空间网关 + DashScope 原生双协议自动识别
- 模型 fallback 链：工作空间网关路由表 ≠ 免费额度，网关侧错误自动换可用模型
- 尺寸随模型族自适应（qwen-image 1328² / wanx 1024²）
- 密钥安全分层：DSH 凭据存储（~/.dsh/.credentials.yaml）+ 用户级 .env，配置零秘密
- attachGeneratedImages：生成图以持久附件进结果卡片（纯 UI，不进模型请求）

安装：
```sh
dsh plugin --profile <name> add dsh-multimodal-bridge
```

文档（含全套排障经验）在 dsh-plugin/README.md。欢迎试用反馈！
```

英文版：

```markdown
Shipped **dsh-multimodal-bridge** (npm: `dsh-multimodal-bridge@0.1.1`,
repo: Spirit4471/multimodal-bridge/dsh-plugin) — a DeepSeek Harness plugin bundle
that gives text-only models eyes and a paintbrush.

- `qwen_vision(image_path, prompt)` — Qwen-VL image understanding / OCR
- `qwen_generate(prompt, ...)` — Qwen-Image text-to-image with PNG output
- Auto protocol detection (百炼 OpenAI-compatible gateway / DashScope native)
- Model fallback chain (workspace gateways route only a subset of models)
- Per-model default sizes, DSH credential-store integration, UI image result cards

Install: `dsh plugin --profile <name> add dsh-multimodal-bridge`
```

---

## 检查清单

- [ ] ① git 推送成功，CI 绿灯
- [ ] ② 仓库 topics 里有 `dsh-plugin`
- [ ] ③ awesome-deepseek-harness PR/issue 已开
- [ ] ④ Discord / GitHub Discussions 已发
