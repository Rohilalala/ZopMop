"""Pre/post party: table with cupcake + cup, broom leaning, balloons."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import math
import lib_clay as C

C.reset()

# round table: white top, wood legs
white = C.clay((0.93, 0.92, 0.93, 1), 0.5)
wood = C.clay((0.85, 0.70, 0.48, 1), 0.55)
TZ = 1.5
C.cyl("table_top", 1.05, 0.18, (0, 0, TZ), white, 0.06)
for i in range(3):
    a = math.radians(i * 120 + 60)
    C.cyl(f"leg{i}", 0.09, TZ, (0.7 * math.cos(a), 0.7 * math.sin(a),
          TZ / 2 - 0.05), wood, 0.02, rot=(math.radians(-6) * math.sin(a),
          math.radians(6) * math.cos(a), 0))

tz = TZ + 0.09

# cupcake: wrapper + frosting dome + candle
wrap = C.clay("yellow_pale", 0.7)
pink = C.clay("pink", 0.55)
C.cone("wrapper", 0.20, 0.28, 0.30, (0.35, -0.25, tz + 0.15), wrap, 0.03)
C.sphere("frosting", 0.30, (0.35, -0.25, tz + 0.40), pink, scale=(1, 1, 0.8))
C.sphere("frosting2", 0.20, (0.35, -0.25, tz + 0.58), pink, scale=(1, 1, 0.8))
C.cyl("candle", 0.03, 0.22, (0.35, -0.25, tz + 0.78), C.clay("yellow", 0.5),
      0.0)

# cup
blue_grey = C.clay((0.78, 0.82, 0.88, 1), 0.5)
C.cyl("cup", 0.18, 0.42, (-0.45, -0.05, tz + 0.21), blue_grey, 0.04)

# broom leaning across table edge
handle = C.clay((0.86, 0.70, 0.44, 1), 0.55)
teal = C.clay((0.45, 0.60, 0.62, 1), 0.6)
ha = math.radians(32)
C.cyl("broom_handle", 0.075, 3.4, (-0.35, -0.65, 1.55), handle, 0.02,
      rot=(0, ha, math.radians(-20)))
C.cone("broom_head", 0.5, 0.16, 0.95, (-1.25, -0.32, 0.45), teal, 0.04,
       rot=(0, ha, math.radians(-20)))
C.cyl("broom_band", 0.18, 0.14, (-1.0, -0.41, 0.78), C.clay("steel", 0.5),
      0.02, rot=(0, ha, math.radians(-20)))

# balloons: pink, blue, yellow cluster top-right
for name, c, (bx, by, bz, r) in (
        ("bal_pink", "pink", (1.45, 0.5, 3.6, 0.5)),
        ("bal_blue", "blue_pale", (0.95, 0.3, 3.15, 0.38)),
        ("bal_yellow", "yellow_pale", (1.75, 0.25, 3.05, 0.40))):
    C.sphere(name, r, (bx, by, bz), C.clay(c, 0.45), scale=(1, 1, 1.15))
    C.cone(f"{name}_knot", 0.07, 0.02, 0.10, (bx, by, bz - r * 1.18),
           C.clay(c, 0.45), 0.0)

C.finish("pre-post-party", frame_target=(0.1, 0, 1.8), dist=12, azim=6,
         elev=14)
