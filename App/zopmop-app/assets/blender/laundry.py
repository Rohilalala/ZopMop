"""Laundry: white washing machine, folded blue towel on top, soap bubbles."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import math
import lib_clay as C

C.reset()

white = C.clay("white", 0.5)
body_w = 2.2

# machine body
C.box("body", (body_w, body_w * 0.95, 2.8), (0, 0, 1.4), white, 0.12, bevel_seg=6)

# feet
foot = C.clay("grey", 0.6)
for x in (-0.85, 0.85):
    for y in (-0.8, 0.8):
        C.cyl(f"foot_{x}_{y}", 0.16, 0.18, (x, y, 0.05), foot, 0.02)

# front door: rim + glass, front face is -Y
rim = C.metal((0.72, 0.74, 0.78, 1), 0.4)
C.torus("door_rim", 0.62, 0.14, (0, -body_w * 0.475, 1.15), rim,
        rot=(math.radians(90), 0, 0))
glass = C.glassy((0.62, 0.74, 0.84, 1))
C.cyl("door_glass", 0.52, 0.08, (0, -body_w * 0.475, 1.15), glass, 0.02,
      rot=(math.radians(90), 0, 0))

# control panel strip
panel = C.clay((0.97, 0.97, 0.98, 1), 0.45)
C.box("panel", (body_w * 0.9, 0.1, 0.34), (0, -body_w * 0.45, 2.52), panel, 0.04)
C.cyl("knob", 0.12, 0.08, (0.6, -body_w * 0.49, 2.52), C.clay("grey", 0.5), 0.02,
      rot=(math.radians(90), 0, 0))
# dots
dot = C.clay("grey_dark", 0.5)
for i in range(3):
    C.cyl(f"dot{i}", 0.035, 0.06, (-0.55 + i * 0.18, -body_w * 0.49, 2.52),
          dot, 0.0, rot=(math.radians(90), 0, 0))

# folded towel on top
towel = C.clay("blue_pale", 0.8)
C.box("towel1", (1.5, 1.05, 0.22), (0, 0.1, 2.94), towel, 0.10, bevel_seg=6)
C.box("towel2", (1.42, 0.98, 0.2), (0, 0.1, 3.13), towel, 0.09, bevel_seg=6)

# bubbles
bub = C.clay((0.99, 0.99, 1.0, 1), 0.25)
C.sphere("bub1", 0.16, (-0.5, -0.6, 3.6), bub)
C.sphere("bub2", 0.10, (-0.75, -0.5, 3.95), bub)
C.sphere("bub3", 0.07, (-0.35, -0.5, 4.1), bub)

C.finish("laundry", frame_target=(0, 0, 1.7), dist=11, azim=20, elev=18)
