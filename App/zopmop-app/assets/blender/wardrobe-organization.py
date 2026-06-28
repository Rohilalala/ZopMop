"""Wardrobe organization: cream shelf unit, folded towels, towel on top."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import math
import lib_clay as C

C.reset()

cream = C.clay((0.89, 0.84, 0.74, 1), 0.55)
W, D, H, t = 2.8, 1.4, 3.0, 0.22

C.box("back", (W, t, H), (0, D / 2 - t / 2, H / 2 + 0.15), cream, 0.08)
for sx in (-1, 1):
    C.box(f"side{sx}", (t, D, H), (sx * (W - t) / 2, 0, H / 2 + 0.15), cream,
          0.10)
C.box("top", (W, D, t), (0, 0, H + 0.15 - t / 2), cream, 0.10)
C.box("bottom", (W, D, t), (0, 0, 0.15 + t / 2), cream, 0.10)
C.box("shelf", (W - 2 * t, D - 0.1, 0.16), (0, 0.05, H * 0.52 + 0.15), cream,
      0.05)

# feet
for sx in (-0.95, 0.95):
    C.cyl(f"foot{sx}", 0.14, 0.16, (sx, -0.35, 0.08), cream, 0.03)

blue = C.clay("blue_pale", 0.8)
sage = C.clay("sage", 0.8)
white = C.clay((0.92, 0.91, 0.89, 1), 0.8)
grey = C.clay((0.80, 0.82, 0.85, 1), 0.8)

shelf_z = H * 0.52 + 0.15 + 0.08
bot_z = 0.15 + t

# upper shelf: blue + sage stack left
C.box("u1", (1.1, 0.95, 0.22), (-0.45, -0.05, shelf_z + 0.13), blue, 0.09)
C.box("u2", (1.05, 0.9, 0.20), (-0.45, -0.05, shelf_z + 0.33), sage, 0.09)

# lower shelf: two stacks
C.box("l1", (1.0, 0.95, 0.22), (-0.55, -0.05, bot_z + 0.13), white, 0.09)
C.box("l2", (0.95, 0.9, 0.20), (-0.55, -0.05, bot_z + 0.33), sage, 0.09)
C.box("l3", (1.0, 0.95, 0.24), (0.6, -0.05, bot_z + 0.14), blue, 0.09)
C.box("l4", (0.95, 0.9, 0.20), (0.6, -0.05, bot_z + 0.35), grey, 0.09)

# towel on top, right corner, slightly rotated
C.box("top_towel", (0.95, 0.8, 0.22), (0.65, -0.15, H + 0.15 + 0.11), blue,
      0.10, rot=(0, 0, math.radians(-12)))

C.finish("wardrobe-organization", frame_target=(0, 0, 1.6), dist=11.5,
         azim=16, elev=16)
