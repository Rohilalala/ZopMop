"""Packing: open suitcase on wood slab, folded clothes inside."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import math
import lib_clay as C

C.reset()
top = C.platform(3.2, 2.8, 0.42, color="wood")

tan = C.clay((0.80, 0.64, 0.45, 1), 0.55)
grey = C.clay("steel", 0.5)

# suitcase bottom shell
SW, SD, SH = 2.4, 1.7, 0.75
C.box("case_bottom", (SW, SD, SH), (0, 0, top + SH / 2), tan, 0.14,
      bevel_seg=6)
# grey trim around top edge of bottom shell
C.box("trim_b", (SW + 0.04, SD + 0.04, 0.10), (0, 0, top + SH - 0.02), grey,
      0.04)
# inner lining
C.box("lining", (SW - 0.2, SD - 0.2, 0.08), (0, 0, top + SH - 0.02),
      C.clay((0.88, 0.84, 0.76, 1), 0.7), 0.02)

# open lid, hinged at back (+y), tilted back ~65° from vertical? original ~75 open
ang = math.radians(70)  # from vertical
LH = 0.55
ly = SD / 2 + (LH / 2) * math.sin(ang)
lz = top + SH + (LH / 2) * math.cos(ang)
C.box("case_lid", (SW, 0.5, LH), (0, ly, lz + 0.35), tan, 0.14,
      rot=(-ang + math.radians(90), 0, 0), bevel_seg=6)
# lid inner panel + zip pocket
C.box("lid_inner", (SW - 0.25, 0.12, LH + 0.55),
      (0, ly - 0.20 * math.sin(ang) - 0.1, lz + 0.42),
      C.clay((0.88, 0.84, 0.76, 1), 0.7), 0.04,
      rot=(-ang + math.radians(90), 0, 0))
C.box("zip", (SW - 0.5, 0.05, 0.08),
      (0, ly - 0.24 * math.sin(ang) - 0.12, lz + 0.45), grey, 0.02,
      rot=(-ang + math.radians(90), 0, 0))

# handle front
C.torus("handle", 0.30, 0.07, (0, -SD / 2 - 0.05, top + SH * 0.55), grey,
        rot=(0, math.radians(90), 0))

# folded clothes inside: blue stack + cream stack
blue = C.clay("blue_pale", 0.8)
cream = C.clay((0.91, 0.87, 0.78, 1), 0.8)
C.box("shirt_b1", (0.95, 1.25, 0.22), (-0.55, 0, top + SH + 0.06), blue, 0.09)
C.box("shirt_b2", (0.88, 1.18, 0.20), (-0.55, 0, top + SH + 0.25), blue, 0.09)
C.box("shirt_c1", (0.95, 1.25, 0.22), (0.55, 0, top + SH + 0.06), cream, 0.09)
C.box("shirt_c2", (0.88, 1.18, 0.20), (0.55, 0, top + SH + 0.22), cream, 0.09)
# collar hints
C.box("collar", (0.5, 0.4, 0.07), (0.55, -0.35, top + SH + 0.36), cream, 0.03,
      rot=(0, 0, math.radians(4)))

C.finish("packing", frame_target=(0, 0.2, 1.1), dist=10.5, azim=8, elev=26)
