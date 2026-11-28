#!/usr/bin/env python3
"""生成 Pi Agent Desktop 的应用图标。

图标不依赖任何字体：π 由矩形与梯形拼出，因此任何机器上重跑结果一致。
设计约束来自 macOS 图标栅格：画布 1024、内容区 824（四周各留 100）、圆角半径 185。
主色取 renderer 的 --pi-accent (#0066cc)。

用法（在仓库根目录）：
    python3 apps/desktop/assets/make-icon.py

产物：
    assets/icon.png   1024x1024 透明底 PNG（Linux / 预览用）
    assets/icon.icns  macOS 图标包（electron-builder mac.icon）
    assets/icon.ico   Windows 图标（electron-builder win.icon）
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

CANVAS = 1024
SS = 4  # 超采样倍数：先在 4096 上绘制再降采样，边缘才干净
SIZE = CANVAS * SS

MARGIN = 100 * SS
RADIUS = 185 * SS

# 渐变两端：上浅下深，比单色更有体积感
TOP = (20, 126, 232)
BOTTOM = (0, 70, 145)

ASSETS = Path(__file__).resolve().parent


def lerp(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))  # type: ignore[return-value]


def vertical_gradient() -> Image.Image:
    """逐行取色，先画 64 行再双三次放大，避免渐变出现色阶。"""
    strip = Image.new("RGB", (1, 64))
    for i in range(64):
        strip.putpixel((0, i), lerp(TOP, BOTTOM, i / 63))
    return strip.resize((SIZE, SIZE), Image.Resampling.BICUBIC)


def radial_highlight() -> Image.Image:
    """顶部柔光：从图标上方 28% 处散开的白色低透明度光，降采样后自然过渡。"""
    small = 64
    img = Image.new("L", (small, small), 0)
    cx, cy, radius = 0.5, 0.28, 0.72
    for y in range(small):
        for x in range(small):
            dx = (x / (small - 1)) - cx
            dy = (y / (small - 1)) - cy
            d = (dx * dx + dy * dy) ** 0.5 / radius
            if d < 1:
                img.putpixel((x, y), round((1 - d) ** 2 * 42))
    return img.resize((SIZE, SIZE), Image.Resampling.BICUBIC)


def rounded_mask() -> Image.Image:
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [MARGIN, MARGIN, SIZE - MARGIN, SIZE - MARGIN], radius=RADIUS, fill=255
    )
    return mask


def glyph_mask() -> Image.Image:
    """π：一根圆头横杠 + 两条向外微撇的腿，腿顶伸进横杠里保证无缝。"""
    k = SS
    mask = Image.new("L", (SIZE, SIZE), 0)
    draw = ImageDraw.Draw(mask)

    draw.rounded_rectangle(
        [300 * k, 322 * k, 724 * k, 397 * k], radius=37 * k, fill=255
    )
    for top_l, top_r, bottom_l, bottom_r in (
        (355, 435, 318, 398),  # 左腿
        (589, 669, 626, 706),  # 右腿
    ):
        draw.polygon(
            [
                (top_l * k, 360 * k),
                (top_r * k, 360 * k),
                (bottom_r * k, 702 * k),
                (bottom_l * k, 702 * k),
            ],
            fill=255,
        )
    return mask


def build_base() -> Image.Image:
    base = vertical_gradient()
    base = Image.composite(Image.new("RGB", (SIZE, SIZE), (255, 255, 255)), base, radial_highlight())
    icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    icon.paste(base, (0, 0), rounded_mask())
    icon.paste(Image.new("RGBA", (SIZE, SIZE), (255, 255, 255, 255)), (0, 0), glyph_mask())
    return icon.resize((CANVAS, CANVAS), Image.Resampling.LANCZOS)


def write_icns(master: Image.Image, target: Path) -> None:
    # iconutil 只接受固定命名；用 sips 逐档缩放，避免 PIL 缩小尺寸的锐度问题
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        png = Path(tmp) / "master.png"
        master.save(png)
        for size in (16, 32, 128, 256, 512):
            for scale in (1, 2):
                name = f"icon_{size}x{size}{'@2x' if scale == 2 else ''}.png"
                subprocess.run(
                    ["sips", "-z", str(size * scale), str(size * scale), str(png), "--out", str(iconset / name)],
                    check=True,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(target)], check=True)


def main() -> int:
    master = build_base()
    png = ASSETS / "icon.png"
    master.save(png)

    if sys.platform == "darwin":
        write_icns(master, ASSETS / "icon.icns")
    else:
        print("跳过 icon.icns：需要 macOS 的 iconutil")

    # Windows 的多尺寸 ico 由 PIL 直接输出
    master.save(ASSETS / "icon.ico", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])

    for name in ("icon.png", "icon.icns", "icon.ico"):
        path = ASSETS / name
        if path.exists():
            print(f"{name}: {path.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())