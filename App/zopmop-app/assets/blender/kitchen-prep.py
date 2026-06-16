"""Kitchen prep: cutting board, cucumber + slices, carrot, onion, knife."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import math
import lib_clay as C

C.reset()
top = C.platform(3.4, 3.0, 0.38)

# wooden cutting board with handle tab
wood = C.clay("wood", 0.55)
C.box("board", (2.6, 2.2, 0.18), (-0.1, 0, top + 0.09), wood, 0.09,
      rot=(0, 0, math.radians(8)), bevel_seg=6)
C.cyl("board_handle", 0.28, 0.16, (1.35, -0.45, top + 0.09), wood, 0.05)

bz = top + 0.18

# cucumber: dark green capsule + slices
cuc = C.clay((0.25, 0.45, 0.22, 1), 0.5)
cuc_in = C.clay((0.78, 0.88, 0.62, 1), 0.6)
C.cyl("cucumber", 0.26, 1.5, (-0.7, 0.55, bz + 0.26), cuc, 0.10,
      rot=(0, math.radians(90), math.radians(20)))
for i in range(3):
    C.cyl(f"slice{i}", 0.24, 0.09, (-0.55 + i * 0.42, -0.35 - i * 0.12,
          bz + 0.05), cuc_in, 0.02, rot=(math.radians(8) * i, 0, 0))
    C.torus(f"slice_skin{i}", 0.23, 0.035, (-0.55 + i * 0.42,
            -0.35 - i * 0.12, bz + 0.05 + 0.045), cuc)

# carrot: orange cone + green top
car = C.clay("orange", 0.55)
C.cone("carrot", 0.20, 0.04, 1.1, (0.85, 0.15, bz + 0.20), car, 0.05,
       rot=(0, math.radians(95), math.radians(-30)))
gr = C.clay("green_dark", 0.5)
for i in range(3):
    C.cyl(f"car_top{i}", 0.035, 0.4, (1.35, 0.42 + i * 0.06, bz + 0.22), gr,
          0.0, rot=(math.radians(60 + i * 25), math.radians(20), 0))

# onion: cream sphere + tip
oni = C.clay((0.93, 0.86, 0.66, 1), 0.5)
C.sphere("onion", 0.42, (0.15, 0.85, bz + 0.40), oni, scale=(1, 1, 1.05))
C.cone("onion_tip", 0.10, 0.01, 0.25, (0.15, 0.85, bz + 0.90), oni, 0.01)

# knife: steel blade + grey handle, diagonal
blade = C.metal((0.78, 0.80, 0.84, 1), 0.25)
rotk = math.radians(35)
C.box("blade", (1.25, 0.30, 0.05), (0.1, -0.15, bz + 0.10), blade, 0.02,
      rot=(0, 0, rotk))
C.box("knife_handle", (0.65, 0.16, 0.14),
      (0.1 + 0.95 * math.cos(rotk), -0.15 + 0.95 * math.sin(rotk),
       bz + 0.12), C.clay("grey", 0.5), 0.05, rot=(0, 0, rotk))

C.finish("kitchen-prep", frame_target=(0, 0, 0.6), dist=9.5, azim=10, elev=30)
