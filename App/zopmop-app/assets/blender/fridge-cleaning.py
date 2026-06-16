"""Fridge cleaning: white two-door fridge, top door open, yellow cloth."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import math
import lib_clay as C

C.reset()

white = C.clay((0.93, 0.93, 0.95, 1), 0.45)
inner = C.clay((0.82, 0.83, 0.86, 1), 0.6)

W, D = 1.8, 1.5
split = 2.1  # z where freezer (top) starts
H = 3.4

# main cabinet
C.box("cabinet", (W, D, H), (0, 0, H / 2), white, 0.10, bevel_seg=6)

# bottom door (front = -Y), slightly proud
C.box("door_bottom", (W * 0.98, 0.16, split - 0.12),
      (0, -D / 2 - 0.06, (split - 0.06) / 2), white, 0.08)
C.cyl("handle_b", 0.055, 0.9, (-0.7, -D / 2 - 0.2, split * 0.55), white, 0.01)

# top compartment cavity: dark inset + shelves
C.box("cavity", (W * 0.8, 0.3, H - split - 0.3),
      (0, -D / 2 + 0.12, (H + split) / 2), inner, 0.04)
for i, sz in enumerate((split + 0.45, split + 0.85)):
    C.box(f"shelf{i}", (W * 0.78, 0.34, 0.06), (0, -D / 2 + 0.12, sz),
          C.clay((0.9, 0.9, 0.92, 1), 0.5), 0.02)

# top door, open swung on right hinge ~70°
ang = math.radians(65)
dw = W * 0.98
hx = W / 2  # hinge at right edge, front face
cx = hx - (dw / 2) * math.cos(ang)
cy = -D / 2 - (dw / 2) * math.sin(ang)
C.box("door_top", (dw, 0.16, H - split - 0.16),
      (cx, cy, (H + split) / 2), white, 0.08, rot=(0, 0, -ang))
# handle on open door outer face
C.cyl("handle_t", 0.05, 0.7,
      (hx - dw * 0.85 * math.cos(ang) - 0.12 * math.sin(ang),
       -D / 2 - dw * 0.85 * math.sin(ang) + 0.12 * math.cos(ang),
       (H + split) / 2), white, 0.01)

# yellow cloth over bottom door top edge
cloth = C.clay("yellow_pale", 0.85)
C.box("cloth_top", (0.6, 0.5, 0.07), (-0.25, -D / 2 - 0.05, split - 0.02),
      cloth, 0.03)
C.box("cloth_hang", (0.6, 0.07, 0.55), (-0.25, -D / 2 - 0.18, split - 0.32),
      cloth, 0.03)

# feet
foot = C.clay("grey", 0.6)
for x in (-0.7, 0.7):
    for y in (-0.55, 0.55):
        C.cyl(f"foot{x}{y}", 0.10, 0.14, (x, y, 0.05), foot, 0.02)

C.finish("fridge-cleaning", frame_target=(0, 0, 1.8), dist=12.5,
         azim=22, elev=14)
