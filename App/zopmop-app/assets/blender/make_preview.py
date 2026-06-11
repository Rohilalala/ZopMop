"""Composite a transparent render over light (#FAF8F2) and dark (#0D0D0F)
app backgrounds, side by side. Usage:
  Blender -b -P make_preview.py -- <icon-name>
Writes renders/<icon-name>_preview.png
"""
import bpy
import numpy as np
import sys, os

name = sys.argv[sys.argv.index("--") + 1]
here = os.path.dirname(os.path.abspath(__file__))
src = os.path.join(here, "renders", f"{name}.png")

img = bpy.data.images.load(src)
w, h = img.size
px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)

def over(bg_hex):
    bg = np.array([int(bg_hex[i:i + 2], 16) / 255 for i in (1, 3, 5)],
                  dtype=np.float32)
    # render is saved with straight alpha in sRGB-ish space after view xform
    a = px[..., 3:4]
    rgb = px[..., :3] * a + bg * (1 - a)
    out = np.concatenate([rgb, np.ones_like(a)], axis=-1)
    return out

light = over("#FAF8F2")
dark = over("#0A0E1A")
combo = np.concatenate([light, dark], axis=1)  # side by side

out_img = bpy.data.images.new("preview", width=w * 2, height=h, alpha=False)
out_img.pixels = combo.ravel().tolist()
out_img.filepath_raw = os.path.join(here, "renders", f"{name}_preview.png")
out_img.file_format = "PNG"
out_img.save()
print(f"PREVIEW {name}")
