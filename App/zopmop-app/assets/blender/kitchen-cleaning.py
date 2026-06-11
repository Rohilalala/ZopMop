"""Kitchen cleaning: counter slab, stove burners, spray bottle on cloth."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import math
import lib_clay as C

C.reset()

# two-tier counter: beige base + white top
C.box("base", (3.6, 2.6, 0.5), (0, 0, 0.25), C.clay("cream", 0.6), 0.12,
      bevel_seg=6)
top = 0.5 + 0.36
C.box("counter", (3.7, 2.7, 0.36), (0, 0, 0.5 + 0.18),
      C.clay((0.90, 0.90, 0.92, 1), 0.5), 0.12, bevel_seg=6)

# stove panel left with two burners
C.box("stove", (1.7, 1.5, 0.10), (-0.85, 0.25, top + 0.05),
      C.clay((0.96, 0.96, 0.97, 1), 0.45), 0.04)
burner = C.clay("grey", 0.5)
ring = C.metal((0.62, 0.64, 0.68, 1), 0.4)
for i, (bx, by) in enumerate(((-1.2, -0.1), (-0.55, 0.55))):
    C.cyl(f"ring{i}", 0.34, 0.07, (bx, by, top + 0.12), ring, 0.02)
    C.cyl(f"burner{i}", 0.26, 0.09, (bx, by, top + 0.14), burner, 0.02)

# folded cream cloth right + mint spray bottle standing on it
cloth = C.clay("yellow_pale", 0.85)
C.box("cloth1", (1.15, 0.95, 0.12), (0.95, -0.35, top + 0.06), cloth, 0.05)
C.box("cloth2", (1.05, 0.85, 0.11), (0.95, -0.35, top + 0.165), cloth, 0.05)

mint = C.clay("mint", 0.45)
bz = top + 0.22
C.cone("bottle", 0.30, 0.22, 0.95, (0.95, -0.35, bz + 0.48), mint, 0.05)
C.cyl("bottle_neck", 0.11, 0.22, (0.95, -0.35, bz + 1.03), mint, 0.02)
white = C.clay((0.95, 0.95, 0.96, 1), 0.4)
C.box("trigger_head", (0.2, 0.45, 0.2), (0.95, -0.42, bz + 1.20), white, 0.05)
C.box("nozzle", (0.09, 0.15, 0.11), (0.95, -0.68, bz + 1.20), white, 0.03)
C.box("trigger", (0.07, 0.09, 0.26), (0.95, -0.60, bz + 1.03), white, 0.02,
      rot=(math.radians(12), 0, 0))

C.finish("kitchen-cleaning", frame_target=(0, 0, 0.95), dist=10, azim=12,
         elev=26)
