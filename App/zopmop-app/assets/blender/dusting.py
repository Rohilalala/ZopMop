"""Dusting: wooden open shelf, folded cream towel, brush leaning."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import math
import lib_clay as C

C.reset()

wood = C.clay("wood", 0.55)
W, D, H, t = 3.0, 1.3, 2.6, 0.22  # shelf outer dims, panel thickness

# panels: back, sides, top, bottom, middle shelf
C.box("back", (W, t, H), (0, D / 2 - t / 2, H / 2), wood, 0.08)
for sx in (-1, 1):
    C.box(f"side{sx}", (t, D, H), (sx * (W - t) / 2, 0, H / 2), wood, 0.08)
C.box("top", (W, D, t), (0, 0, H - t / 2), wood, 0.08)
C.box("bottom", (W, D, t), (0, 0, t / 2), wood, 0.08)
C.box("shelf", (W - 2 * t, D - 0.1, 0.16), (0, 0.05, H * 0.55), wood, 0.05)

# folded towel on bottom shelf, left
tow = C.clay((0.93, 0.89, 0.78, 1), 0.8)
C.box("towel1", (1.0, 0.75, 0.18), (-0.75, -0.1, t + 0.11), tow, 0.08)
C.box("towel2", (0.92, 0.68, 0.16), (-0.75, -0.1, t + 0.27), tow, 0.07)

# brush leaning on right side: dark handle + bristle head
hb = C.clay("wood_dark", 0.5)
br = C.clay("yellow_pale", 0.85)
ang = math.radians(40)
C.cyl("brush_handle", 0.10, 1.5, (1.85, -0.45, 0.95), hb, 0.03,
      rot=(0, ang, math.radians(-15)))
C.box("brush_head", (0.42, 0.30, 0.55), (1.32, -0.30, 1.42), br, 0.06,
      rot=(0, ang, math.radians(-15)))

C.finish("dusting", frame_target=(0.2, 0, 1.25), dist=10.5, azim=14, elev=20)
