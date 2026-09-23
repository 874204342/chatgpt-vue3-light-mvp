import base64
import os
from typing import Any
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel

APP_DIR = Path(__file__).resolve().parent
PADDLEX_CACHE_DIR = APP_DIR / ".paddlex-cache"
PADDLEX_CACHE_DIR.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("PADDLE_PDX_CACHE_HOME", str(PADDLEX_CACHE_DIR))
# Windows CPU 环境下，部分 Paddle/PIR + oneDNN 组合会触发
# `ConvertPirAttribute2RuntimeAttribute` 异常，这里先关闭对应优化分支。
os.environ.setdefault("FLAGS_enable_pir_api", "0")
os.environ.setdefault("FLAGS_use_mkldnn", "0")

from paddleocr import PaddleOCR


class OcrRequest(BaseModel):
    file_name: str = ""
    file_content: str = ""
    mime_type: str = ""


app = FastAPI(title="local-ocr-service")


def create_ocr_engine() -> PaddleOCR:
    # Keep a single OCR instance in memory so repeated requests stay responsive.
    # Newer PaddleOCR versions prefer `use_textline_orientation`, while older
    # versions still rely on `use_angle_cls`.
    try:
        return PaddleOCR(
            use_textline_orientation=True,
            lang="ch",
            enable_mkldnn=False,
        )
    except TypeError:
        return PaddleOCR(
            use_angle_cls=True,
            lang="ch",
        )


ocr_engine = create_ocr_engine()


def decode_image(file_content: str) -> np.ndarray:
    binary = base64.b64decode(file_content)
    np_array = np.frombuffer(binary, dtype=np.uint8)
    image = cv2.imdecode(np_array, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Failed to decode image content")
    return image


def flatten_ocr_result(raw_result: Any) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = []
    result_groups = raw_result if isinstance(raw_result, list) else [raw_result]

    for group in result_groups:
        if isinstance(group, dict):
            text_list = group.get("rec_texts") or []
            score_list = group.get("rec_scores") or []
            poly_list = group.get("rec_polys") or group.get("dt_polys") or []
            for index, text in enumerate(text_list):
                normalized_text = str(text).strip()
                if not normalized_text:
                    continue
                score = float(score_list[index]) if index < len(score_list) else 0.0
                box = poly_list[index] if index < len(poly_list) else []
                lines.append(
                    {
                        "text": normalized_text,
                        "score": score,
                        "box": box,
                    }
                )
            continue

        if isinstance(group, list):
            for item in group:
                if not isinstance(item, list) or len(item) < 2:
                    continue
                box = item[0] if isinstance(item[0], list) else []
                text_info = item[1] if isinstance(item[1], (list, tuple)) else ("", 0)
                text = str(text_info[0]).strip()
                score = float(text_info[1]) if len(text_info) > 1 else 0.0
                if not text:
                    continue
                lines.append(
                    {
                        "text": text,
                        "score": score,
                        "box": box,
                    }
                )

    return lines


@app.get("/health")
def health():
    return {"code": 200, "message": "ok"}


@app.post("/ocr")
def ocr(request: OcrRequest):
    if not request.file_content.strip():
        return {"code": 400, "message": "Missing image content"}

    try:
        image = decode_image(request.file_content)
        try:
            result = ocr_engine.ocr(image, cls=True)
        except TypeError:
            result = ocr_engine.ocr(image)
        lines = flatten_ocr_result(result)
        raw_text = "\n".join(item["text"] for item in lines)
        avg_score = round(
            sum(float(item["score"]) for item in lines) / len(lines),
            4,
        ) if lines else 0

        return {
            "code": 200,
            "message": "ok",
            "data": {
                "rawText": raw_text,
                "lines": lines,
                "avgScore": avg_score,
                "imageWidth": int(image.shape[1]),
                "imageHeight": int(image.shape[0]),
            },
        }
    except Exception as error:  # noqa: BLE001
        return {
            "code": 500,
            "message": f"OCR failed: {error}",
        }
