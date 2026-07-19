"""
Qwen DashScope 适配器 — Vision (Qwen-VL) + Generate (Qwen-Image)

支持两种 API 模式:
  1. DashScope 原生 API (默认 dashscope.aliyuncs.com)
     Vision:  POST /api/v1/services/aigc/multimodal-generation/generation
     Generate: POST /api/v1/services/aigc/text2image/image-synthesis
  2. 百炼 OpenAI 兼容 API (百炼工作空间)
     Vision:  POST /compatible-mode/v1/chat/completions
     Generate: POST /compatible-mode/v1/images/generations (如果支持)

自动检测: 若 QWEN_API_BASE 不含 "compatible-mode"，使用原生 DashScope API；
          若含 "compatible-mode" 或以 "maas.aliyuncs.com" 结尾，使用 OpenAI 兼容格式。

文档:
  DashScope:  https://help.aliyun.com/zh/model-studio/developer-reference/qwen-vl-api
  百炼兼容:  https://help.aliyun.com/zh/model-studio/developer-reference/compatible-mode
"""

import base64
import json
import time
from pathlib import Path

import httpx

from config import QWEN_API_BASE

def _use_openai_compat() -> bool:
    """检测是否应使用 OpenAI 兼容 API 格式"""
    return "compatible-mode" in QWEN_API_BASE or "maas.aliyuncs.com" in QWEN_API_BASE

# 端点
_BASE = QWEN_API_BASE.rstrip("/")

if _use_openai_compat():
    # 百炼 OpenAI 兼容端点: https://xxx.maas.aliyuncs.com/compatible-mode/v1
    _VISION_EP = f"{_BASE}/chat/completions"
    _GENERATE_EP = f"{_BASE}/images/generations"
    _GENERATE_RESULT_EP = f"{QWEN_API_BASE.rstrip('/v1').rsplit('/', 2)[0]}/tasks"  # 回退到 base domain
else:
    # DashScope 原生端点 (base 如 https://dashscope.aliyuncs.com)
    _VISION_EP = f"{_BASE}/api/v1/services/aigc/multimodal-generation/generation"
    _GENERATE_EP = f"{_BASE}/api/v1/services/aigc/text2image/image-synthesis"
    _GENERATE_RESULT_EP = f"{_BASE}/api/v1/tasks"

# 支持的模型列表（均来自百炼定价表，新用户 90 天免费额度）
_VISION_MODELS = {
    "qwen-vl-max",       # ¥1.6/M in, ¥4/M out, 100万Token免费
    "qwen-vl-plus",      # ¥0.8/M in, ¥2/M out, 100万Token免费
    "qwen3-vl-flash",    # ¥0.15/M in, ¥1.5/M out, 100万Token免费 (性价比首选)
    "qwen3-vl-plus",     # ¥1/M in, ¥10/M out, 100万Token免费
}

_GENERATE_MODELS = {
    "wanx2.1-t2i-turbo",  # ¥0.14/张, 500张免费 (性价比首选)
    "wan2.2-t2i-plus",    # ¥0.20/张, 100张免费
    "qwen-image-2.0",     # ¥0.20/张, 100张免费
    "qwen-image-max",     # ¥0.50/张, 100张免费
}


def _image_to_base64(image_path: str) -> str:
    """将本地图片编码为 base64 data URI (JPEG/PNG/WebP)"""
    path = Path(image_path)
    if not path.exists():
        raise FileNotFoundError(f"图片不存在: {image_path}")

    suffix = path.suffix.lower()
    mime_map = {".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                ".png": "image/png", ".webp": "image/webp", ".bmp": "image/bmp",
                ".gif": "image/gif"}
    mime = mime_map.get(suffix, "image/jpeg")

    data = path.read_bytes()
    b64 = base64.b64encode(data).decode("ascii")
    return f"data:{mime};base64,{b64}"


async def vision(image_path: str, prompt: str,
                 model: str = "qwen-vl-max",
                 api_key: str = "") -> str:
    """
    调用 Qwen-VL 进行图片理解，返回模型描述文本。
    自动检测 API 格式: DashScope 原生 或 百炼 OpenAI 兼容。

    参数:
      image_path: 本地图片路径 (PNG/JPEG/WebP/GIF)
      prompt:     对图片的提问
      model:      qwen-vl-max (默认) / qwen-vl-plus / qwen3-vl-flash / qwen3-vl-plus
      api_key:    DashScope / 百炼 API Key

    返回:
      模型生成的文本回答
    """
    if not api_key:
        raise ValueError("缺少 API Key (设置 VISION_API_KEY 或 QWEN_DASHSCOPE_API_KEY)")

    if model not in _VISION_MODELS:
        raise ValueError(f"不支持的视觉模型: {model}，可选: {_VISION_MODELS}")

    data_uri = _image_to_base64(image_path)

    if _use_openai_compat():
        # OpenAI 兼容格式
        body = {
            "model": model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": data_uri}},
                        {"type": "text", "text": prompt},
                    ],
                }
            ],
            "max_tokens": 1000,
        }
    else:
        # DashScope 原生格式
        body = {
            "model": model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"image": data_uri},
                        {"text": prompt},
                    ],
                }
            ],
        }

    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(
            _VISION_EP,
            json=body,
            headers={"Authorization": f"Bearer {api_key}",
                     "Content-Type": "application/json"},
        )
        resp.raise_for_status()
        result = resp.json()

    # 解析响应
    try:
        if _use_openai_compat():
            # OpenAI 格式: {"choices": [{"message": {"content": "..."}}]}
            return result["choices"][0]["message"]["content"]
        else:
            # DashScope 格式: {"output": {"choices": [{"message": {"content": [...]}}]}}
            content = result["output"]["choices"][0]["message"]["content"]
            if isinstance(content, list):
                texts = [p["text"] for p in content if "text" in p]
                return "\n".join(texts)
            return content
    except (KeyError, IndexError):
        return json.dumps(result, ensure_ascii=False, indent=2)


async def generate(prompt: str, size: str = "1024*1024",
                   model: str = "wan2.1-t2i-turbo",
                   api_key: str = "",
                   n: int = 1,
                   negative_prompt: str = "",
                   output_dir: str = "") -> dict:
    """
    调用通义万相生成图像。

    参数:
      prompt:          正向提示词 (中文/英文均可，中文理解好)
      size:            图像尺寸 "1024*1024" / "720*1280" / "1280*720"
      model:           wan2.1-t2i-turbo (默认)
      api_key:         DashScope API Key
      n:              生成数量 (1-4)
      negative_prompt: 反向提示词 (可选)
      output_dir:      图片保存目录 (可选)

    返回:
      {"success": bool, "images": [本地路径...], "error": str | None}
    """
    if not api_key:
        raise ValueError("缺少 DashScope API Key (设置 GENERATE_API_KEY 或 QWEN_DASHSCOPE_API_KEY)")

    if model not in _GENERATE_MODELS:
        raise ValueError(f"不支持的生成模型: {model}，可选: {_GENERATE_MODELS}")

    # 1. 提交生成任务
    body = {
        "model": model,
        "input": {"prompt": prompt},
        "parameters": {
            "size": size,
            "n": min(n, 4),
        },
    }
    if negative_prompt:
        body["parameters"]["negative_prompt"] = negative_prompt

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            _GENERATE_EP,
            json=body,
            headers={"Authorization": f"Bearer {api_key}",
                     "Content-Type": "application/json",
                     "X-DashScope-Async": "enable"},
        )
        resp.raise_for_status()
        submit_result = resp.json()

    task_id = submit_result.get("output", {}).get("task_id")
    if not task_id:
        return {"success": False, "images": [], "error": f"提交任务失败: {json.dumps(submit_result, ensure_ascii=False)}"}

    # 2. 轮询任务结果 (最多等 2 分钟)
    poll_url = f"{_GENERATE_RESULT_EP}/{task_id}"
    max_wait, interval = 120, 2
    elapsed = 0

    async with httpx.AsyncClient(timeout=30) as client:
        while elapsed < max_wait:
            time.sleep(interval)
            elapsed += interval

            resp = await client.get(
                poll_url,
                headers={"Authorization": f"Bearer {api_key}"},
            )
            resp.raise_for_status()
            result = resp.json()

            status = result.get("output", {}).get("task_status")
            if status == "SUCCEEDED":
                break
            if status == "FAILED":
                return {"success": False, "images": [],
                        "error": result.get("output", {}).get("message", "未知错误")}
        else:
            return {"success": False, "images": [], "error": f"生成超时 (task_id={task_id})"}

    # 3. 下载图片到本地
    results = result["output"].get("results", [])
    saved_paths = []
    import os as _os  # lazy import (we need it)

    dest_dir = output_dir or Path(__file__).parent.parent / "generated"
    Path(dest_dir).mkdir(parents=True, exist_ok=True)

    async with httpx.AsyncClient(timeout=60) as client:
        for i, img_result in enumerate(results):
            url = img_result.get("url")
            if not url:
                continue
            resp = await client.get(url)
            resp.raise_for_status()

            ext = ".png"  # 通义万相默认返回 PNG
            fname = f"qwen_{task_id[:8]}_{i}{ext}"
            fpath = Path(dest_dir) / fname
            fpath.write_bytes(resp.content)
            saved_paths.append(str(fpath))

    return {
        "success": True,
        "images": saved_paths,
        "error": None,
    }
