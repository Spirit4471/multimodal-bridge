"""
适配器工厂 — 根据后端名称加载对应的适配器。

每个适配器暴露两个异步函数:
  - vision(image_path: str, prompt: str, model: str, api_key: str) -> str
  - generate(prompt: str, size: str, model: str, api_key: str) -> dict

返回格式:
  vision   → 纯文本描述字符串
  generate → {"success": bool, "images": [...], "error": str | None}
"""
