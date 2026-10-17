#!/usr/bin/env python3
# 生成应用图标 PNG(纯标准库):青色渐变圆角方块 + 白色放大镜
import zlib, struct, math, os

S = 1024   # 画布尺寸
SS = 2     # 每像素子采样倍数(抗锯齿)

def lerp(a, b, t): return a + (b - a) * t

def hex2rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

TOP = hex2rgb('#0ea5b7')   # 顶部青色
BOT = hex2rgb('#0b3a52')   # 底部深蓝
WHITE = (255, 255, 255)

MARGIN = 32
RADIUS = 229

CX, CY = 440, 420          # 放大镜圆心
R = 200                    # 镜片半径
STROKE = 46                # 圆环线宽
HX, HY = CX + R * 0.72, CY + R * 0.72   # 手柄起点(45°方向)
HL = 210                   # 手柄长度
HW = 58                    # 手柄线宽

def in_rounded_rect(x, y):
    w = S - 2 * MARGIN
    qx = abs(x - S / 2) - (w / 2 - RADIUS)
    qy = abs(y - S / 2) - (w / 2 - RADIUS)
    return math.hypot(max(qx, 0), max(qy, 0)) <= RADIUS - 0.5

def circle_ring(x, y):
    return abs(math.hypot(x - CX, y - CY) - R) <= STROKE / 2

def circle_inside(x, y):
    return math.hypot(x - CX, y - CY) <= R - STROKE / 2

def seg_dist(x, y, x0, y0, x1, y1):
    vx, vy = x1 - x0, y1 - y0
    wx, wy = x - x0, y - y0
    c1 = vx * wx + vy * wy
    if c1 <= 0: return math.hypot(x - x0, y - y0)
    c2 = vx * vx + vy * vy
    if c2 <= c1: return math.hypot(x - x1, y - y1)
    t = c1 / c2
    return math.hypot(x - (x0 + t * vx), y - (y0 + t * vy))

def in_handle(x, y):
    hx1, hy1 = HX + HL * 0.7071, HY + HL * 0.7071
    return seg_dist(x, y, HX, HY, hx1, hy1) <= HW / 2

def in_bar(x, y, cy_, half_len, th):
    return abs(y - cy_) <= th / 2 and abs(x - CX) <= half_len

def sample(x, y):
    """返回该点 RGBA"""
    if not in_rounded_rect(x, y):
        return (0, 0, 0, 0)
    t = y / S
    cr, cg, cb = lerp(TOP[0], BOT[0], t), lerp(TOP[1], BOT[1], t), lerp(TOP[2], BOT[2], t)
    if circle_inside(x, y):  # 镜片内淡淡的白色
        f = 0.10
        cr, cg, cb = lerp(cr, WHITE[0], f), lerp(cg, WHITE[1], f), lerp(cb, WHITE[2], f)
    if circle_ring(x, y) or in_handle(x, y):
        cr, cg, cb = WHITE
    elif (in_bar(x, y, CY - 55, 92, 30) or in_bar(x, y, CY, 116, 30) or in_bar(x, y, CY + 55, 92, 30)) and circle_inside(x, y):
        cr, cg, cb = WHITE  # 镜片里的三条"数据"横线
    return (int(cr), int(cg), int(cb), 255)

rows = []
for py in range(S):
    row = bytearray([0])  # PNG filter type 0
    for px in range(S):
        r = g = b = a = 0
        for sy in range(SS):
            for sx in range(SS):
                sr, sg, sb, sa = sample(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS)
                r += sr; g += sg; b += sb; a += sa
        n = SS * SS
        row += bytes((r // n, g // n, b // n, a // n))
    rows.append(bytes(row))
raw = b''.join(rows)

def chunk(tag, data):
    c = struct.pack('>I', len(data)) + tag + data
    return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

png = b'\x89PNG\r\n\x1a\n'
png += chunk(b'IHDR', struct.pack('>IIBBBBB', S, S, 8, 6, 0, 0, 0))
png += chunk(b'IDAT', zlib.compress(raw, 9))
png += chunk(b'IEND', b'')

os.makedirs('build', exist_ok=True)
with open('build/icon.png', 'wb') as f:
    f.write(png)
print('build/icon.png written,', len(png), 'bytes')
