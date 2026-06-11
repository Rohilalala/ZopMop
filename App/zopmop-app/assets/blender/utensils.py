"""Utensils: stacked plates, cup with spoon+fork, yellow sponge."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import math
import lib_clay as C

C.reset()
top = C.platform(3.2, 3.0, 0.40)

white = C.clay((0.95, 0.94, 0.92, 1), 0.4)

# stack of 3 plates, slight offsets
for i, (px, py) in enumerate(((-0.3, -0.1), (-0.25, -0.15), (-0.35, -0.05))):
    z = top + 0.12 + i * 0.20
    C.cyl(f"plate{i}", 0.85, 0.10, (px, py, z), white, 0.04)
    C.cyl(f"plate_rim{i}", 0.70, 0.06, (px, py, z + 0.07), white, 0.03)

# cup holder with spoon + fork behind right
C.cyl("cup", 0.30, 0.75, (0.85, 0.55, top + 0.38), white, 0.06)
steel = C.metal((0.74, 0.76, 0.80, 1), 0.3)
# spoon
C.cyl("spoon_stem", 0.035, 0.85, (0.75, 0.55, top + 0.95), steel, 0.0,
      rot=(0, math.radians(-8), 0))
C.sphere("spoon_head", 0.11, (0.68, 0.55, top + 1.38), steel,
         scale=(1, 0.7, 1.3))
# fork
C.cyl("fork_stem", 0.035, 0.85, (1.0, 0.5, top + 0.95), steel, 0.0,
      rot=(0, math.radians(8), 0))
C.box("fork_head", (0.16, 0.05, 0.30), (1.07, 0.5, top + 1.40), steel, 0.01)
for i in range(3):
    C.cyl(f"tine{i}", 0.015, 0.16, (1.02 + i * 0.05, 0.5, top + 1.58), steel,
          0.0)

# yellow sponge leaning on plate stack, front right
sponge = C.clay("yellow", 0.8)
C.box("sponge", (0.70, 0.45, 0.38), (0.55, -0.55, top + 0.34), sponge, 0.10,
      rot=(0, math.radians(-18), math.radians(-12)), bevel_seg=6)
# suds drips
suds = C.clay((0.80, 0.90, 0.94, 1), 0.4)
C.sphere("sud1", 0.07, (0.2, -0.95, top + 0.05), suds, scale=(1.3, 1, 0.35))
C.sphere("sud2", 0.05, (0.95, -0.85, top + 0.05), suds, scale=(1.3, 1, 0.35))

C.finish("utensils", frame_target=(0, 0, 0.75), dist=9.5, azim=10, elev=26)
