# multimodal-bridge

**多模态 MCP 桥** — 给纯文本 LLM 补上视觉理解与图像生成能力，或给多模态模型补上它没有的图像生成能力。

## v2.0：双轨工作流

Harness engineering 的第一原则：**让模型用它原生的能力干活，桥只补模型真正缺的那一块**。

| 能力 | 主线：Kimi Code + K3 | 备选线：Claude Code + DeepSeek |
|------|----------------------|-------------------------------|
| **Coding harness** | Kimi Code CLI | Claude Code |
| **LLM 推理** | K3（1M 上下文，thinking） | DeepSeek V4 Pro（按量计费，便宜一个数量级） |
| **视觉理解** | K3 原生（image_in / video_in） | 经 bridge → Qwen-VL（百炼免费额度） |
| **图像生成** | 经 bridge → Qwen-Image（百炼免费额度） | 经 bridge → Qwen-Image（同左） |

- **主线**适合日常重度使用：K3 自带高性能推理与视觉，一手多模态信息，没有中间模型转述的损失；bridge 只在需要出图时登场。
- **备选线**适合成本敏感场景：DeepSeek 按 token 计费极便宜，但它没有视觉，`qwen_vision` 是它看图的唯一途径。

v1 的工作流（Claude Code + DeepSeek + 全功能桥）即现在的备选线，并未废弃——两条线路成本结构不同，按用量选用。

## 工作流架构

```
主线 (Kimi Code + K3):
┌───────────────┐     ┌────────────────┐     ┌───────────────────┐
│ Kimi Code CLI │────▶│  K3 (1M ctx)   │────▶│ 代码 + 读图(原生)  │
└──────┬────────┘     └────────────────┘     └───────────────────┘
       │ 需要出图? ──▶ multimodal-bridge ──▶ Qwen-Image

备选线 (Claude Code + DeepSeek):
┌──────────────┐     ┌─────────────────┐     ┌──────────────────┐
│  Claude Code │────▶│ DeepSeek V4 Pro │────▶│ 代码生成 (纯文本) │
└──────┬───────┘     └─────────────────┘     └──────────────────┘
       │ 遇到图片? ──▶ multimodal-bridge ──▶ Qwen-VL / Qwen-Image
```

## 安装

```bash
git clone https://github.com/Spirit4471/multimodal-bridge.git
cd multimodal-bridge
pip install -r requirements.txt
```

前置条件：
- Python 3.10+
- [百炼 API Key](https://bailian.console.aliyun.com)（新用户 90 天免费，100万 Token + 500张图）

## 配置

在项目根目录的 `.mcp.json` 中声明（Claude Code / Kimi Code 等宿主均会读取）：

```json
{
  "mcpServers": {
    "multimodal-bridge": {
      "command": "python",
      "args": ["C:/WorkSpace/multimodal-bridge/server.py"],
      "env": {
        "QWEN_DASHSCOPE_API_KEY": "sk-xxxxxxxx"
      }
    }
  }
}
```

### 按 harness 挂载工具

- **Kimi Code + K3**：只需要图像生成。可加 `"enabledTools": ["qwen_generate"]` 只暴露生成工具（Kimi Code 支持该字段）。
- **Claude Code + DeepSeek**：视觉与生成都需要，两个工具全开。

> 宿主不支持 `enabledTools` 也无妨——两个工具都挂着，模型会按描述自行选用。

### Claude Code + DeepSeek 的 settings.json（备选线）

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
    "ANTHROPIC_MODEL": "deepseek-v4-pro"
  },
  "enabledMcpjsonServers": ["multimodal-bridge"]
}
```

核心技巧：`ANTHROPIC_BASE_URL` 指向 DeepSeek 的 Anthropic 兼容端点，Claude Code 的 tool use/agent/memory 全套功能照样跑，但每个 token 便宜 10 倍。

## MCP 工具

| 工具 | 功能 | 模型 | 哪条线路用 |
|------|------|------|-----------|
| `qwen_vision(image_path, prompt)` | 图片理解、OCR、分析 | Qwen-VL 系列 (qwen-vl-max / qwen3-vl-flash) | 备选线（K3 主线用原生视觉） |
| `qwen_generate(prompt, size)` | 文生图 | Qwen-Image 系列 (qwen-image-2.0 / qwen-image-2.0-pro / wan2.7-image) | 两条线路 |

## 环境变量

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| `QWEN_DASHSCOPE_API_KEY` | 百炼 Key | — |
| `VISION_MODEL` | 视觉模型 | `qwen-vl-max` |
| `GENERATE_MODEL` | 生成模型 | `qwen-image-2.0` |
| `QWEN_API_BASE` | 自定义端点（百炼工作空间填网关地址） | `https://dashscope.aliyuncs.com` |
| `OUTPUT_DIR` | 生成图片保存目录 | 包目录下的 `generated/` |

## 费用对比（备选线）

| | Anthropic 官方 | 备选线 | 省多少 |
|---|---|---|---|
| LLM (1M tokens) | ~$15 (Sonnet) | ~$0.48 (DeepSeek v4) | **97%** ↓ |
| Vision (100张图) | ~$3-5 | ¥0 (百炼免费) | **100%** ↓ (前90天) |
| 图像生成 (100张) | ~$4-8 (DALL·E) | ¥0 (百炼免费) | **100%** ↓ (前90天) |

## 扩展

适配器模式 — 在 `adapters/` 下新增 `.py`，实现 `vision()` / `generate()` 即可接入其他多模态后端：

```
server.py
config.py
adapters/
├── __init__.py          # 接口约定
└── qwen_dashscope.py    # 当前适配器
```

## License

[MIT](LICENSE) © 2026 Spirit4471
