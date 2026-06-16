"""Unpacking: open suitcase nearly empty, towel on lid, stack beside."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import math
import lib_clay as C

C.reset()
top = C.platform(3.4, 2.8, 0.42, color="wood")

tan = C.clay((0.80, 0.64, 0.45, 1), 0.55)
grey = C.clay("steel", 0.5)

SW, SD, SH = 2.1, 1.55, 0.72
cxo = -0.45  # suitcase shifted left
C.box("case_bottom", (SW, SD, SH), (cxo, 0, top + SH / 2), tan, 0.14,
      bevel_seg=6)
C.box("trim_b", (SW + 0.04, SD + 0.04, 0.10), (cxo, 0, top + SH - 0.02),
      grey, 0.04)
# empty inner
C.box("lining", (SW - 0.24, SD - 0.24, 0.10), (cxo, 0, top + SH - 0.10),
      C.clay((0.86, 0.82, 0.74, 1), 0.7), 0.03)

ang = math.radians(70)
LH = 0.5
ly = SD / 2 + (LH / 2) * math.sin(ang)
lz = top + SH + (LH / 2) * math.cos(ang)
C.box("case_lid", (SW, 0.45, LH), (cxo, ly, lz + 0.32), tan, 0.14,
      rot=(-ang + math.radians(90), 0, 0), bevel_seg=6)
C.box("lid_inner", (SW - 0.25, 0.12, LH + 0.5),
      (cxo, ly - 0.18 * math.sin(ang) - 0.1, lz + 0.40),
      C.clay((0.86, 0.82, 0.74, 1), 0.7), 0.04,
      rot=(-ang + math.radians(90), 0, 0))
C.torus("handle", 0.28, 0.065, (cxo, -SD / 2 - 0.05, top + SH * 0.55), grey,
        rot=(0, math.radians(90), 0))

# blue towel hanging over lid top edge
blue = C.clay("blue_pale", 0.8)
tz = lz + 0.32 + LH * 0.45
C.box("towel_lid", (0.8, 0.55, 0.16), (cxo - 0.3, ly + 0.05, tz + 0.10),
      blue, 0.07, rot=(-ang + math.radians(90), 0, 0))

# folded stack beside (right): cream + blue
cream = C.clay((0.91, 0.87, 0.78, 1), 0.8)
C.box("stack1", (1.0, 0.85, 0.20), (1.15, -0.35, top + 0.12), cream, 0.08)
C.box("stack2", (0.95, 0.80, 0.18), (1.15, -0.35, top + 0.29), blue, 0.08)
C.box("stack3", (0.9, 0.75, 0.16), (1.15, -0.35, top + 0.44), cream, 0.07)

C.finish("unpacking", frame_target=(0, 0.2, 1.0), dist=10.5, azim=8, elev=26)
