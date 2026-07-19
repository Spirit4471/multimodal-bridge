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

import asyncio
import base64
import json
import re
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
    # 该模式下视觉理解与图像生成都走 chat/completions
    _VISION_EP = f"{_BASE}/chat/completions"
    _GENERATE_EP = f"{_BASE}/chat/completions"
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


# 单图上限：超过才压缩。VL API 对请求体体积和像素尺寸都有限制。
_MAX_IMAGE_EDGE = 1568
_MAX_IMAGE_BYTES = 10 * 1024 * 1024


def _image_to_base64(image_path: str) -> str:
    """将本地图片编码为 base64 data URI；超限图片自动缩小/压缩为 JPEG。"""
    path = Path(image_path)
    if not path.exists():
        raise FileNotFoundError(f"图片不存在: {image_path}")

    suffix = path.suffix.lower()
    mime_map = {".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                ".png": "image/png", ".webp": "image/webp", ".bmp": "image/bmp",
                ".gif": "image/gif"}
    mime = mime_map.get(suffix, "image/jpeg")

    data = path.read_bytes()
    try:
        from PIL import Image
        import io

        with Image.open(path) as img:
            width, height = img.size
            if len(data) <= _MAX_IMAGE_BYTES and max(width, height) <= _MAX_IMAGE_EDGE:
                b64 = base64.b64encode(data).decode("ascii")
                return f"data:{mime};base64,{b64}"

            # 透明通道合成到白底，避免转 JPEG 后变黑
            if img.mode in ("RGBA", "LA", "P"):
                rgba = img.convert("RGBA")
                background = Image.new("RGB", rgba.size, (255, 255, 255))
                background.paste(rgba, mask=rgba.split()[-1])
                img = background
            elif img.mode != "RGB":
                img = img.convert("RGB")

            img.thumbnail((_MAX_IMAGE_EDGE, _MAX_IMAGE_EDGE))
            encoded = b""
            for quality in (85, 70, 50):
                buf = io.BytesIO()
                img.save(buf, format="JPEG", quality=quality)
                encoded = buf.getvalue()
                if len(encoded) <= _MAX_IMAGE_BYTES:
                    break
        return f"data:image/jpeg;base64,{base64.b64encode(encoded).decode('ascii')}"
    except (ImportError, OSError):
        # 无 Pillow 或图片无法解析时原样编码，交由 API 侧报错
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
            "max_tokens": 4096,
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


async def _generate_via_openai_compat(prompt: str, size: str, model: str,
                                      api_key: str, n: int,
                                      negative_prompt: str) -> tuple[list[tuple[str, str]], str]:
    """百炼 OpenAI 兼容模式: 图像生成走 chat/completions, 同步返回。

    实测该网关不提供 /images/generations；图像模型 (qwen-image 等) 挂在
    chat/completions 下——请求为 OpenAI chat 格式 (content 为 list)，
    size / n / negative_prompt 通过 DashScope 风格的 parameters 传入；
    响应为 DashScope 原生风格:
      output.choices[0].message.content = [{"image": url}, ...]
    解析时同时兼容标准 OpenAI images (data[].url/b64_json) 与
    chat 文本中内嵌图片 URL 的响应形状。

    返回 ([(kind, value)], stem): kind 为 "url" 或 "b64", stem 用于文件命名。
    """
    body = {
        "model": model,
        "messages": [{"role": "user", "content": [{"type": "text", "text": prompt}]}],
        "parameters": {"size": size, "n": min(n, 4)},
        "stream": False,
    }
    if negative_prompt:
        body["parameters"]["negative_prompt"] = negative_prompt

    async with httpx.AsyncClient(timeout=180) as client:
        resp = await client.post(
            _GENERATE_EP,
            json=body,
            headers={"Authorization": f"Bearer {api_key}",
                     "Content-Type": "application/json"},
        )
        resp.raise_for_status()
        result = resp.json()

    items: list[tuple[str, str]] = []

    # DashScope 原生风格: output.choices[].message.content = [{"image": url}, ...]
    for choice in result.get("output", {}).get("choices", []):
        content = choice.get("message", {}).get("content")
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("image"):
                    items.append(("url", part["image"]))

    # 标准 OpenAI images 风格: data[].url / data[].b64_json
    if not items:
        for entry in result.get("data", []):
            if entry.get("url"):
                items.append(("url", entry["url"]))
            elif entry.get("b64_json"):
                items.append(("b64", entry["b64_json"]))

    # 标准 OpenAI chat 风格: choices[].message.content 文本内嵌图片 URL
    if not items:
        for choice in result.get("choices", []):
            content = choice.get("message", {}).get("content")
            if isinstance(content, str):
                for url in re.findall(r"https?://\S+", content):
                    items.append(("url", url.rstrip(").]\"'")))

    if not items:
        raise RuntimeError(f"生成接口未返回图片: {json.dumps(result, ensure_ascii=False)}")
    return items, str(int(time.time()))


async def _generate_via_dashscope(prompt: str, size: str, model: str,
                                  api_key: str, n: int,
                                  negative_prompt: str) -> tuple[list[tuple[str, str]], str]:
    """DashScope 原生模式: 异步任务, 提交后轮询拿图片 URL。"""
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

    # 1. 提交生成任务
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
        raise RuntimeError(f"提交任务失败: {json.dumps(submit_result, ensure_ascii=False)}")

    # 2. 轮询任务结果 (最多等 2 分钟)
    poll_url = f"{_GENERATE_RESULT_EP}/{task_id}"
    max_wait, interval = 120, 2
    elapsed = 0

    async with httpx.AsyncClient(timeout=30) as client:
        while elapsed < max_wait:
            await asyncio.sleep(interval)
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
                raise RuntimeError(result.get("output", {}).get("message", "未知错误"))
        else:
            raise RuntimeError(f"生成超时 (task_id={task_id})")

    items = [("url", r["url"]) for r in result["output"].get("results", []) if r.get("url")]
    if not items:
        raise RuntimeError(f"任务成功但未返回图片 (task_id={task_id})")
    return items, task_id[:8]


async def _save_images(items: list[tuple[str, str]], dest_dir, stem: str) -> list[str]:
    """把 ("url"|"b64", 内容) 列表保存为本地 PNG, 返回文件路径列表。"""
    Path(dest_dir).mkdir(parents=True, exist_ok=True)
    saved_paths = []
    async with httpx.AsyncClient(timeout=60) as client:
        for i, (kind, value) in enumerate(items):
            if kind == "b64":
                content = base64.b64decode(value)
            else:
                resp = await client.get(value)
                resp.raise_for_status()
                content = resp.content
            # 通义万相默认返回 PNG
            fpath = Path(dest_dir) / f"qwen_{stem}_{i}.png"
            fpath.write_bytes(content)
            saved_paths.append(str(fpath))
    return saved_paths


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
      model:           wanx2.1-t2i-turbo (默认)
      api_key:         DashScope API Key
      n:              生成数量 (1-4)
      negative_prompt: 反向提示词 (可选)
      output_dir:      图片保存目录 (可选)

    返回:
      {"success": bool, "images": [本地路径...], "error": str | None}

    失败时抛出异常 (ValueError / RuntimeError / httpx 异常)。
    """
    if not api_key:
        raise ValueError("缺少 DashScope API Key (设置 GENERATE_API_KEY 或 QWEN_DASHSCOPE_API_KEY)")

    if model not in _GENERATE_MODELS:
        raise ValueError(f"不支持的生成模型: {model}，可选: {_GENERATE_MODELS}")

    if _use_openai_compat():
        items, stem = await _generate_via_openai_compat(prompt, size, model, api_key, n, negative_prompt)
    else:
        items, stem = await _generate_via_dashscope(prompt, size, model, api_key, n, negative_prompt)

    dest_dir = output_dir or Path(__file__).parent.parent / "generated"
    saved_paths = await _save_images(items, dest_dir, stem)

    return {
        "success": True,
        "images": saved_paths,
        "error": None,
    }
