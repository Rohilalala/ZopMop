"""Balcony: white slab, grey railing back, potted plant, brush + dustpan."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import math
import lib_clay as C

C.reset()
top = C.platform(3.6, 3.2, 0.42)

# raised step under railing
step = C.box("step", (3.2, 0.9, 0.36), (0, 1.0, top + 0.18),
             C.clay("offwhite", 0.6), 0.10)

# railing
rail = C.clay("grey", 0.5)
n = 8
for i in range(n):
    x = -1.3 + i * (2.6 / (n - 1))
    C.cyl(f"bar{i}", 0.055, 1.1, (x, 1.0, top + 0.36 + 0.55), rail, 0.01)
C.box("toprail", (3.0, 0.16, 0.14), (0, 1.0, top + 0.36 + 1.12), rail, 0.05)
C.box("botrail", (3.0, 0.12, 0.10), (0, 1.0, top + 0.36 + 0.08), rail, 0.04)

# terracotta pot + plant (right back corner, on step)
potz = top + 0.36
pot = C.clay("terracotta", 0.6)
C.cone("pot", 0.34, 0.44, 0.62, (1.25, 0.55, potz + 0.31), pot, 0.04)
C.cyl("pot_rim", 0.47, 0.14, (1.25, 0.55, potz + 0.58), pot, 0.04)
soil = C.clay("brown", 0.8)
C.cyl("soil", 0.40, 0.06, (1.25, 0.55, potz + 0.63), soil, 0.01)
# plant: stem + leaves
green = C.clay("green", 0.5)
gdark = C.clay("green_dark", 0.5)
C.cyl("stem", 0.035, 0.7, (1.25, 0.55, potz + 0.95), gdark, 0.0)
for i in range(7):
    ang = math.radians(i * 51.4)
    r = 0.34 if i < 5 else 0.18
    lz = 1.12 + (0.16 if i % 2 else 0) + (0.3 if i >= 5 else 0)
    lx = 1.25 + r * math.cos(ang)
    ly = 0.55 + r * math.sin(ang)
    C.sphere(f"leaf{i}", 0.30, (lx, ly, potz + lz),
             green if i % 2 == 0 else gdark, scale=(1.0, 0.5, 0.25),
             rot=(0, math.radians(-28), ang))

# brush, front-left: wooden block + bristles
wood = C.clay("wood", 0.55)
C.box("brush_block", (0.85, 0.30, 0.16),
      (-0.85, -0.65, top + 0.20), wood, 0.05,
      rot=(0, 0, math.radians(20)))
bristle = C.clay("yellow_pale", 0.85)
C.box("bristles", (0.80, 0.26, 0.16),
      (-0.85, -0.65, top + 0.08), bristle, 0.04,
      rot=(0, 0, math.radians(20)))

# dustpan, front-right: mint scoop + handle
mint = C.clay("teal", 0.5)
C.box("pan", (0.95, 0.75, 0.14), (0.65, -0.75, top + 0.09), mint, 0.06,
      rot=(0, math.radians(-6), math.radians(-15)))
C.box("pan_back", (0.95, 0.16, 0.30), (0.75, -0.43, top + 0.22), mint, 0.05,
      rot=(0, 0, math.radians(-15)))
C.cyl("pan_handle", 0.07, 0.85, (0.95, -0.16, top + 0.44), mint, 0.02,
      rot=(math.radians(-55), 0, math.radians(20)))

C.finish("balcony", frame_target=(0, 0, 1.1), dist=10.5, azim=12, elev=24)
