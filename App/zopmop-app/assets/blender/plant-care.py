"""Plant care: potted plant, glass mister, sage watering can."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import math
import lib_clay as C

C.reset()
top = C.platform(3.4, 3.0, 0.40)

# terracotta pot + saucer, center
pot = C.clay("terracotta", 0.6)
C.cyl("saucer", 0.62, 0.10, (0, 0.15, top + 0.05), pot, 0.03)
C.cone("pot", 0.42, 0.56, 0.80, (0, 0.15, top + 0.50), pot, 0.05)
C.cyl("pot_rim", 0.60, 0.16, (0, 0.15, top + 0.86), pot, 0.05)
C.cyl("soil", 0.52, 0.06, (0, 0.15, top + 0.92), C.clay("brown", 0.8), 0.01)

# plant
green = C.clay("green", 0.5)
gdark = C.clay("green_dark", 0.5)
C.cyl("stem", 0.04, 0.9, (0, 0.15, top + 1.35), gdark, 0.0)
for i in range(8):
    ang = math.radians(i * 45 + 10)
    r = 0.42 if i < 6 else 0.20
    lz = 1.35 + (0.22 if i % 2 else 0) + (0.42 if i >= 6 else 0)
    lx = r * math.cos(ang)
    ly = 0.15 + r * math.sin(ang)
    C.sphere(f"leaf{i}", 0.34, (lx, ly, top + lz),
             green if i % 2 == 0 else gdark, scale=(1.0, 0.5, 0.25),
             rot=(0, math.radians(-30), ang))

# glass mister bottle, left: glassy body + sage pump
glass = C.glassy((0.80, 0.90, 0.94, 1))
sage = C.clay("sage", 0.5)
C.cyl("mister_body", 0.28, 0.75, (-1.15, -0.55, top + 0.38), glass, 0.06)
C.cyl("mister_neck", 0.10, 0.18, (-1.15, -0.55, top + 0.84), sage, 0.02)
C.sphere("mister_pump", 0.14, (-1.15, -0.55, top + 1.0), sage)
C.cyl("mister_nozzle", 0.05, 0.16, (-1.15, -0.68, top + 1.0), sage, 0.01,
      rot=(math.radians(90), 0, 0))

# watering can, right: sage body + spout + top handle
C.cyl("can_body", 0.50, 0.95, (1.15, 0.05, top + 0.48), sage, 0.10)
C.cyl("can_neck", 0.26, 0.18, (1.15, 0.05, top + 1.02), sage, 0.04)
# spout angled out to front-left
C.cyl("spout", 0.09, 0.95, (0.62, -0.35, top + 0.75), sage, 0.02,
      rot=(math.radians(35), math.radians(-50), 0))
C.cyl("spout_head", 0.16, 0.10, (0.30, -0.60, top + 1.05), sage, 0.03,
      rot=(math.radians(35), math.radians(-50), 0))
# arc handle on top
C.torus("can_handle", 0.34, 0.07, (1.35, 0.05, top + 1.12), sage,
        rot=(0, math.radians(90), 0))

C.finish("plant-care", frame_target=(0, 0, 1.05), dist=10.5, azim=8, elev=24)
