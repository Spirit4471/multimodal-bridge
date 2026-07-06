# multimodal-bridge

Claude Code MCP Server — 为 Claude Code 提供**视觉理解** (Qwen-VL) 和**图像生成** (通义万相) 能力。

## 功能

| 工具 | 能力 | 底层模型 |
|------|------|----------|
| `qwen_vision` | 本地图片理解（描述、OCR、分析） | Qwen-VL-Max / Qwen3-VL |
| `qwen_generate` | 文生图（中文/英文 prompt） | 通义万相 Wanx2.1 |

## 安装

```bash
pip install -r requirements.txt
```

### 前置条件

- Python 3.10+
- 阿里云百炼 API Key（[免费注册](https://bailian.console.aliyun.com)，新用户 90 天免费额度）

## Claude Code 集成

在 `~/.claude/settings.json`（全局）或 `<project>/.claude/settings.json`（项目级）中添加：

```json
{
  "mcpServers": {
    "multimodal-bridge": {
      "command": "python",
      "args": ["<path-to-repo>/server.py"],
      "env": {
        "QWEN_DASHSCOPE_API_KEY": "sk-xxxxxxxx"
      }
    }
  }
}
```

## 配置

所有配置通过环境变量控制：

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| `QWEN_DASHSCOPE_API_KEY` | 百炼 API Key（VISION/GENERATE 均回退到此） | — |
| `VISION_BACKEND` | 视觉理解后端 | `qwen_dashscope` |
| `VISION_MODEL` | 视觉模型 | `qwen-vl-max` |
| `VISION_API_KEY` | 视觉专用 Key（可选） | `QWEN_DASHSCOPE_API_KEY` |
| `GENERATE_BACKEND` | 图像生成后端 | `qwen_dashscope` |
| `GENERATE_MODEL` | 生成模型 | `wanx2.1-t2i-turbo` |
| `GENERATE_API_KEY` | 生成专用 Key（可选） | `QWEN_DASHSCOPE_API_KEY` |
| `QWEN_API_BASE` | 自定义 API 端点 | `https://dashscope.aliyuncs.com` |
| `OUTPUT_DIR` | 图片保存目录 | `./generated/` |

## 支持的模型

### Vision
- `qwen-vl-max` — 最强精度
- `qwen-vl-plus` — 均衡
- `qwen3-vl-flash` — 性价比首选
- `qwen3-vl-plus` — 新一代

### Generate
- `wanx2.1-t2i-turbo` — 性价比首选 (¥0.14/张)
- `wan2.2-t2i-plus` — 高质量
- `qwen-image-2.0` — 新一代
- `qwen-image-max` — 最强

## 架构

```
server.py          # MCP Server 入口，注册工具 + 路由
config.py          # 环境变量 → 配置映射
adapters/
├── __init__.py    # 适配器接口约定
└── qwen_dashscope.py  # Qwen DashScope 适配器（Vision + Generate）
```

适配器模式支持扩展其他后端（只需在 `adapters/` 下新增 `.py` 并实现 `vision()` / `generate()` 即可）。

## License

MIT
