"""Fan cleaning: dark ceiling fan, duster, cloth on blade."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import math
import lib_clay as C

C.reset()

dark = C.clay("grey_dark", 0.5)
steel = C.metal((0.6, 0.62, 0.66, 1), 0.4)

z0 = 2.0  # hub height

# ceiling mount + rod + hub
C.cyl("mount", 0.30, 0.22, (0, 0, z0 + 0.95), dark, 0.04)
C.cyl("rod", 0.07, 0.8, (0, 0, z0 + 0.5), steel, 0.01)
C.cyl("hub", 0.42, 0.35, (0, 0, z0), dark, 0.08)
C.cyl("hub_cap", 0.30, 0.16, (0, 0, z0 - 0.22), dark, 0.05)

# 3 blades, slight droop
for i in range(3):
    a = math.radians(i * 120 + 15)
    bx = 1.55 * math.cos(a)
    by = 1.55 * math.sin(a)
    C.box(f"blade{i}", (2.6, 0.55, 0.07), (bx, by, z0 - 0.05), dark, 0.04,
          rot=(0, math.radians(4), a))

# yellow cloth draped over one blade (i=0 → a=15°)
a0 = math.radians(15)
cx, cy = 1.9 * math.cos(a0), 1.9 * math.sin(a0)
cloth = C.clay("yellow_pale", 0.85)
C.box("cloth_top", (0.42, 0.62, 0.06), (cx, cy, z0 - 0.0), cloth, 0.03,
      rot=(0, math.radians(4), a0))
C.box("cloth_hang", (0.42, 0.07, 0.5), (cx - 0.28 * math.sin(a0),
      cy + 0.28 * math.cos(a0), z0 - 0.28), cloth, 0.03, rot=(0, 0, a0))

# duster: long tan handle + grey bristle head reaching a blade
hb = C.clay((0.85, 0.72, 0.52, 1), 0.6)
ha = math.radians(38)
C.cyl("duster_handle", 0.09, 2.6, (-0.7, -1.1, z0 - 1.35), hb, 0.02,
      rot=(ha, math.radians(18), 0))
head = C.clay("steel", 0.85)
C.sphere("duster_head", 0.30, (-1.25, -2.0, z0 - 2.35), head,
         scale=(1, 0.7, 1.3))

# dust puffs
puff = C.clay((0.99, 0.99, 1.0, 1), 0.3)
C.sphere("puff1", 0.12, (2.3, 0.9, z0 + 0.5), puff)
C.sphere("puff2", 0.08, (2.6, 1.1, z0 + 0.75), puff)

C.finish("fan-cleaning", frame_target=(0, 0, z0 - 0.7), dist=11.5,
         azim=10, elev=18)
