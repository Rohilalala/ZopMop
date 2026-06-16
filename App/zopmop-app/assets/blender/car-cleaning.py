"""Car cleaning: blue car, yellow sponge with foam, mint spray bottle."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import math
import lib_clay as C

C.reset()
top = C.platform(3.8, 3.0, 0.42)

blue = C.clay((0.49, 0.62, 0.78, 1), 0.45)
blue_d = C.clay((0.38, 0.50, 0.66, 1), 0.45)

# car body angled across the slab
rotz = math.radians(18)
C.box("car_body", (2.7, 1.25, 0.62), (-0.25, 0.25, top + 0.55), blue, 0.22,
      rot=(0, 0, rotz), bevel_seg=7)
C.box("car_cabin", (1.5, 1.1, 0.62), (-0.45, 0.28, top + 1.05), blue_d, 0.24,
      rot=(0, 0, rotz), bevel_seg=7)

# wheels
tire = C.clay("charcoal", 0.6)
hub = C.clay("steel", 0.4)
# wheels: local coords along body axis, lateral sides poke past body
ca, sa = math.cos(rotz), math.sin(rotz)
for i, lx in enumerate((-0.92, 0.92)):
    for side in (-0.70, 0.70):
        x = lx * ca - side * sa - 0.25
        y = lx * sa + side * ca + 0.25
        C.cyl(f"tire{i}{side}", 0.30, 0.16, (x, y, top + 0.30), tire, 0.05,
              rot=(math.radians(90), 0, rotz))
        C.cyl(f"hub{i}{side}", 0.15, 0.18, (x, y, top + 0.30), hub, 0.02,
              rot=(math.radians(90), 0, rotz))

# headlight on front face (local -1.35, -0.45)
hx = -1.35 * ca - (-0.45) * sa - 0.25
hy = -1.35 * sa + (-0.45) * ca + 0.25
C.sphere("headlight", 0.12, (hx, hy, top + 0.62), C.clay("yellow_pale", 0.3))

# yellow sponge with foam (front right, against car)
sponge = C.clay("yellow", 0.8)
C.box("sponge", (0.75, 0.5, 0.42), (0.85, -0.85, top + 0.30), sponge, 0.12,
      rot=(0, 0, math.radians(-12)), bevel_seg=6)
foam = C.clay((0.99, 0.99, 1.0, 1), 0.3)
C.sphere("foam1", 0.20, (0.45, -0.65, top + 0.55), foam)
C.sphere("foam2", 0.14, (0.62, -0.45, top + 0.72), foam)
C.sphere("foam3", 0.11, (0.30, -0.45, top + 0.78), foam)
C.sphere("foam4", 0.09, (0.50, -0.30, top + 0.92), foam)

# mint spray bottle (right)
mint = C.clay("mint", 0.45)
C.cone("bottle", 0.28, 0.22, 0.85, (1.55, -0.35, top + 0.43), mint, 0.05)
C.cyl("bottle_neck", 0.11, 0.2, (1.55, -0.35, top + 0.94), mint, 0.02)
C.box("trigger_head", (0.2, 0.42, 0.2), (1.55, -0.42, top + 1.10), mint, 0.05)
C.box("nozzle", (0.09, 0.15, 0.11), (1.55, -0.66, top + 1.10), mint, 0.03)

C.finish("car-cleaning", frame_target=(0, 0, 0.85), dist=10.5, azim=8, elev=22)
