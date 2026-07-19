"""
统一配置 — 从环境变量读取后端选择。

环境变量一览:
  VISION_BACKEND        — 视觉理解后端: qwen_dashscope (默认)
  VISION_API_KEY         — 视觉 API Key
  VISION_MODEL           — 视觉模型名 (可选，有默认值)

  GENERATE_BACKEND       — 图像生成后端: qwen_dashscope (默认)
  GENERATE_API_KEY       — 生成 API Key
  GENERATE_MODEL         — 生成模型名 (可选，有默认值)

  QWEN_DASHSCOPE_API_KEY — Qwen 统一 Key (VISION/GENERATE 未设时回退使用)
  QWEN_API_BASE          — 自定义 API 端点 (百炼工作空间用，默认 dashscope.aliyuncs.com)
"""

import os

# ── Qwen 通用设置 ──────────────────────────────────────────
QWEN_API_BASE = os.getenv("QWEN_API_BASE", "https://dashscope.aliyuncs.com")
QWEN_API_KEY = os.getenv("QWEN_DASHSCOPE_API_KEY", "")

# ── 视觉理解后端 ──────────────────────────────────────────
VISION_BACKEND = os.getenv("VISION_BACKEND", "qwen_dashscope")
VISION_API_KEY = os.getenv("VISION_API_KEY") or QWEN_API_KEY
VISION_MODEL = os.getenv("VISION_MODEL", "qwen-vl-max")

# ── 图像生成后端 ──────────────────────────────────────────
GENERATE_BACKEND = os.getenv("GENERATE_BACKEND", "qwen_dashscope")
GENERATE_API_KEY = os.getenv("GENERATE_API_KEY") or QWEN_API_KEY
GENERATE_MODEL = os.getenv("GENERATE_MODEL", "wanx2.1-t2i-turbo")

# ── 图片下载目录 (可选，默认为本包下的 generated/) ─────
# 不能用 os.getcwd()：stdio MCP 服务器的 cwd 取决于宿主从哪启动，落点不可预测。
OUTPUT_DIR = os.getenv("OUTPUT_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "generated"))
