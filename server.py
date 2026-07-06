#!/usr/bin/env python3
"""
multimodal-bridge MCP Server
============================

为 Claude Code 提供视觉理解 (Vision) 和图像生成 (Generate) 能力。

注册到 ~/.claude/settings.json (全局) 或 <project>/.claude/settings.json (项目级):
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

MCP 工具:
  qwen_vision(image_path, prompt)  → 图片理解
  qwen_generate(prompt, size)      → 文生图
"""

import asyncio
import importlib
import json
from pathlib import Path

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent, ImageContent

import config

# ── MCP Server 实例 ──────────────────────────────────────
server = Server("multimodal-bridge")


# ── 适配器懒加载 ─────────────────────────────────────────
def _load_adapter(backend: str):
    """动态加载适配器模块。"""
    try:
        return importlib.import_module(f"adapters.{backend}")
    except ImportError as e:
        raise RuntimeError(
            f"无法加载后端适配器 '{backend}'。"
            f"请检查 adapters/{backend}.py 是否存在。"
            f"当前支持: qwen_dashscope"
        )


# ── 工具注册 ─────────────────────────────────────────────
@server.list_tools()
async def handle_list_tools() -> list[Tool]:
    return [
        Tool(
            name="qwen_vision",
            description=(
                "对本地图片进行视觉理解。传入图片路径和问题，返回模型对图片的分析描述。\n"
                "适用场景: 理解图片内容、提取文字、分析结构、判断正确性等。\n"
                "参数:\n"
                "  image_path: 本地图片的绝对路径 (支持 PNG/JPEG/WebP/BMP)\n"
                "  prompt: 提问内容，如 '描述这张图片' / '接线是否正确？' / '提取图中文字'"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "image_path": {
                        "type": "string",
                        "description": "本地图片的绝对路径，如 C:/photos/circuit.jpg",
                    },
                    "prompt": {
                        "type": "string",
                        "description": "对图片的提问，如 '描述这张图片的内容' / '这个接线是否正确？'",
                    },
                },
                "required": ["image_path", "prompt"],
            },
        ),
        Tool(
            name="qwen_generate",
            description=(
                "调用图像生成模型创建图片。支持中文/英文提示词。\n"
                "适用场景: 生成概念图、插图、设计稿、参考图等。\n"
                "参数:\n"
                "  prompt: 图像描述 (中文效果更好)\n"
                "  size: 图像尺寸，可选 '1024*1024' (默认) / '720*1280' / '1280*720'\n"
                "  n: 生成数量 1-4 (默认 1)\n"
                "  negative_prompt: 不想出现的内容 (可选)"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "prompt": {
                        "type": "string",
                        "description": "描述想要生成的图像内容，如 '赛博朋克风格的机械手臂，霓虹灯背景'",
                    },
                    "size": {
                        "type": "string",
                        "description": "图像尺寸: 1024*1024 / 720*1280 / 1280*720",
                        "default": "1024*1024",
                    },
                    "n": {
                        "type": "integer",
                        "description": "生成数量 1-4",
                        "default": 1,
                    },
                    "negative_prompt": {
                        "type": "string",
                        "description": "负面提示词 (不想出现的内容)",
                        "default": "",
                    },
                },
                "required": ["prompt"],
            },
        ),
    ]


@server.call_tool()
async def handle_call_tool(name: str, arguments: dict) -> list[TextContent]:
    if name == "qwen_vision":
        return await _handle_vision(arguments)
    elif name == "qwen_generate":
        return await _handle_generate(arguments)
    else:
        return [TextContent(type="text", text=f"未知工具: {name}")]


# ── Vision 处理 ──────────────────────────────────────────
async def _handle_vision(args: dict) -> list[TextContent]:
    image_path = args.get("image_path", "")
    prompt = args.get("prompt", "")

    if not image_path or not prompt:
        return [TextContent(
            type="text",
            text="[错误] 缺少必要参数: image_path 和 prompt 均为必填",
        )]

    adapter = _load_adapter(config.VISION_BACKEND)

    try:
        result = await adapter.vision(
            image_path=image_path,
            prompt=prompt,
            model=config.VISION_MODEL,
            api_key=config.VISION_API_KEY,
        )
        return [TextContent(type="text", text=result)]
    except FileNotFoundError as e:
        return [TextContent(type="text", text=f"[文件不存在] {e}")]
    except ValueError as e:
        return [TextContent(type="text", text=f"[配置错误] {e}")]
    except Exception as e:
        return [TextContent(type="text", text=f"[视觉理解失败] {type(e).__name__}: {e}")]


# ── Generate 处理 ────────────────────────────────────────
async def _handle_generate(args: dict) -> list[TextContent]:
    prompt = args.get("prompt", "")
    size = args.get("size", "1024*1024")
    n_val = args.get("n", 1)
    negative_prompt = args.get("negative_prompt", "")

    if not prompt:
        return [TextContent(type="text", text="[错误] 缺少必要参数: prompt")]

    adapter = _load_adapter(config.GENERATE_BACKEND)

    try:
        result = await adapter.generate(
            prompt=prompt,
            size=size,
            model=config.GENERATE_MODEL,
            api_key=config.GENERATE_API_KEY,
            n=n_val,
            negative_prompt=negative_prompt,
            output_dir=config.OUTPUT_DIR,
        )
        return [TextContent(
            type="text",
            text=json.dumps(result, ensure_ascii=False, indent=2),
        )]
    except ValueError as e:
        return [TextContent(
            type="text",
            text=json.dumps({"success": False, "images": [], "error": str(e)}, ensure_ascii=False),
        )]
    except Exception as e:
        return [TextContent(
            type="text",
            text=json.dumps({"success": False, "images": [], "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False),
        )]


# ── 入口 ─────────────────────────────────────────────────
async def main():
    async with stdio_server() as (reader, writer):
        await server.run(reader, writer, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
