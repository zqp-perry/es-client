#!/usr/bin/env python3
# 把多个 PNG 打包成 ICO(PNG 条目格式,Vista+ 均支持)
import struct, sys, os

def pack(out_path, png_paths):
    blobs = [open(p, 'rb').read() for p in png_paths]
    n = len(blobs)
    header = struct.pack('<HHH', 0, 1, n)
    offset = 6 + 16 * n
    entries = b''
    for b in blobs:
        w = struct.unpack('>I', b[16:20])[0]  # PNG IHDR width
        s = w if w < 256 else 0               # 256 用 0 表示
        entries += struct.pack('<BBBBHHII', s, s, 0, 0, 1, 32, len(b), offset)
        offset += len(b)
    with open(out_path, 'wb') as f:
        f.write(header + entries + b''.join(blobs))
    print('已生成', out_path)

if __name__ == '__main__':
    pack(sys.argv[1], sys.argv[2:])
