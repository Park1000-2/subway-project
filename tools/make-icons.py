#!/usr/bin/env python3
"""앱 아이콘 생성 — 어두운 안내판 바탕에 좌석 옆모습.
   python3 tools/make-icons.py
"""
from PIL import Image, ImageDraw
import os

BG = (13, 22, 32)         # --board
SEAT = (122, 174, 248)    # 밝은 파랑 — 어두운 바탕에서 또렷하게
LEG = (42, 90, 152)       # 다리는 한 단계 어둡게 (형태를 눌러 줌)
S = 1024                  # 원본 크기

def glyph():
    """좌석 옆모습을 투명 레이어에 그리고, 실제 차지한 영역만 잘라 돌려줍니다."""
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    r = d.rounded_rectangle
    r([290, 190, 440, 650], radius=62, fill=SEAT)    # 등받이
    r([290, 610, 790, 760], radius=62, fill=SEAT)    # 방석
    r([300, 740, 410, 880], radius=46, fill=LEG)     # 뒷다리
    r([670, 740, 780, 880], radius=46, fill=LEG)     # 앞다리
    return im.crop(im.getbbox())

GLYPH = glyph()

def icon(size, fill_ratio):
    """fill_ratio: 아이콘 한 변 대비 그림이 차지하는 비율.
       마스크형(maskable)은 바깥이 잘릴 수 있어 작게 잡습니다."""
    im = Image.new('RGB', (S, S), BG)
    w, h = GLYPH.size
    scale = (S * fill_ratio) / max(w, h)
    g = GLYPH.resize((round(w * scale), round(h * scale)), Image.LANCZOS)
    im.paste(g, ((S - g.width) // 2, (S - g.height) // 2), g)   # 정확히 중앙
    return im.resize((size, size), Image.LANCZOS)

os.makedirs('icons', exist_ok=True)
for name, size, ratio in [
    ('icon-192.png', 192, 0.62), ('icon-512.png', 512, 0.62),
    ('icon-maskable-512.png', 512, 0.44),   # 마스크 안전 영역(가운데 80%) 안쪽
    ('apple-touch-icon.png', 180, 0.60), ('favicon-64.png', 64, 0.70),
]:
    icon(size, ratio).save(f'icons/{name}')
    print(f'  icons/{name}')
