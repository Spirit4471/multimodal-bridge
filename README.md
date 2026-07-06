# multimodal-bridge

**省钱个人工作流** — Claude Code + DeepSeek API + Qwen 系列多模态模型。

## 动机

Claude Code 很强，但 Anthropic API 太贵。把能省的都省了：

| 能力 | 用谁 | 为什么 |
|------|------|--------|
| **Coding Agent** | Claude Code | 交互体验无可替代 |
| **LLM 推理** | DeepSeek API (`deepseek-v4-pro`) | 代码能力不输，价格砍一个数量级 |
| **视觉理解** | Qwen-VL 系列（百炼免费额度） | Claude Vision 太贵，Qwen 90 天免费 |
| **图像生成** | Qwen-Image 系列（百炼免费额度） | 偶尔需要，没必要付费用 DALL·E |

> 视觉理解和图像生成都是 **Qwen 系列模型**，统一走百炼 API，共享同一套免费额度体系。

`multimodal-bridge` 就是那个多模态 MCP 桥——Claude Code 本身只有纯文本推理，遇到图片/生成需求就通过这个 bridge 调 Qwen。

## 工作流架构

```
┌──────────────┐     ┌─────────────────┐     ┌──────────────────┐
│  Claude Code │────▶│  DeepSeek API   │────▶│  代码生成/重构    │
│  (前端/IDE)   │     │  (deepseek-v4)  │     │  (纯文本, 便宜)   │
└──────┬───────┘     └─────────────────┘     └──────────────────┘
       │
       │ 遇到图片? ──▶ multimodal-bridge (MCP)
       │                    │
       │              ┌─────┴─────┐
       │              │           │
       │         Qwen-VL    Qwen-Image
       │        (图片理解)   (图片生成)
       │              │           │
       │        百炼免费额度   百炼免费额度
       │        (90天新用户)   (90天新用户)
```

## 我的 settings.json

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
    "ANTHROPIC_MODEL": "deepseek-v4-pro"
  },
  "enabledMcpjsonServers": ["multimodal-bridge"]
}
```

`.claude/mcp.json`:
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

核心技巧：`ANTHROPIC_BASE_URL` 指向 DeepSeek 的 Anthropic 兼容端点，Claude Code 的 tool use/agent/memory 全套功能照样跑，但每个 token 便宜 10 倍。

## 安装

```bash
git clone https://github.com/Spirit4471/multimodal-bridge.git
cd multimodal-bridge
pip install -r requirements.txt
```

前置条件：
- Python 3.10+
- [百炼 API Key](https://bailian.console.aliyun.com)（新用户 90 天免费，100万 Token + 500张图）
- [DeepSeek API Key](https://platform.deepseek.com)（如果也要用 DeepSeek 后端）

## MCP 工具

| 工具 | 功能 | 模型 |
|------|------|------|
| `qwen_vision(image_path, prompt)` | 图片理解、OCR、分析 | Qwen-VL 系列 (qwen-vl-max / qwen3-vl-flash) |
| `qwen_generate(prompt, size)` | 文生图 | Qwen-Image 系列 (qwen-image-2.0 / wanx2.1-t2i-turbo) |

## 费用对比

| | Anthropic 官方 | 本工作流 | 省多少 |
|---|---|---|---|
| LLM (1M tokens) | ~$15 (Sonnet) | ~$0.48 (DeepSeek v4) | **97%** ↓ |
| Vision (100张图) | ~$3-5 | ¥0 (百炼免费) | **100%** ↓ (前90天) |
| 图像生成 (100张) | ~$4-8 (DALL·E) | ¥0 (百炼免费) | **100%** ↓ (前90天) |

## 配置

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| `QWEN_DASHSCOPE_API_KEY` | 百炼 Key | — |
| `VISION_MODEL` | 视觉模型 | `qwen-vl-max` |
| `GENERATE_MODEL` | 生成模型 | `wanx2.1-t2i-turbo` |
| `QWEN_API_BASE` | 自定义端点 | `dashscope.aliyuncs.com` |

## 扩展

适配器模式 — 在 `adapters/` 下新增 `.py`，实现 `vision()` / `generate()` 即可接入其他视觉后端：

```
server.py
config.py
adapters/
├── __init__.py          # 接口约定
└── qwen_dashscope.py    # 当前适配器
```

## License

MIT
