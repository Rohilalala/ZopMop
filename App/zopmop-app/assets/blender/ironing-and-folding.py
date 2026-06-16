"""Ironing & folding: wood slab, folded blue cloth, white iron, steam."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import math
import lib_clay as C

C.reset()
top = C.platform(2.9, 2.6, 0.40, color="wood")

# folded blue cloth stack
cloth = C.clay("blue_pale", 0.8)
C.box("cloth1", (2.0, 1.7, 0.30), (0, 0, top + 0.18), cloth, 0.13, bevel_seg=6)
C.box("cloth2", (1.85, 1.55, 0.26), (0.05, 0, top + 0.44), cloth, 0.12,
      bevel_seg=6)

base_z = top + 0.57

# iron on top: soleplate + body + handle
white = C.clay((0.95, 0.95, 0.96, 1), 0.4)
steel = C.metal((0.7, 0.72, 0.75, 1), 0.3)
rotz = math.radians(-25)
# soleplate: scaled sphere half gives rounded-pointy shape
C.sphere("soleplate", 0.62, (0, 0, base_z + 0.08), steel,
         scale=(1.5, 0.75, 0.25), rot=(0, 0, rotz))
C.sphere("iron_body", 0.58, (0.08, 0, base_z + 0.28), white,
         scale=(1.35, 0.68, 0.55), rot=(0, 0, rotz))
# handle arch: torus half sunk in body
C.torus("handle", 0.38, 0.10, (0.08, 0, base_z + 0.62), white,
        rot=(math.radians(90), 0, rotz))
# dial
C.sphere("dial", 0.12, (0.08 + 0.1 * math.cos(rotz), 0.1 * math.sin(rotz),
         base_z + 0.55), C.clay("teal", 0.4))

# steam puffs at the nose (nose points +x rotated)
puff = C.clay((0.99, 0.99, 1.0, 1), 0.3)
nx = -1.1 * math.cos(rotz)
ny = -1.1 * math.sin(rotz)
C.sphere("puff1", 0.16, (nx, ny, base_z + 0.7), puff)
C.sphere("puff2", 0.11, (nx - 0.15, ny, base_z + 0.95), puff)
C.sphere("puff3", 0.08, (nx + 0.05, ny, base_z + 1.12), puff)

C.finish("ironing-and-folding", frame_target=(0, 0, 0.85), dist=9.5,
         azim=14, elev=24)
