"""Window cleaning: 4-pane window, teal squeegee, mint cloth."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import math
import lib_clay as C

C.reset()
top = C.platform(3.6, 2.4, 0.42)

grey = C.clay("steel", 0.45)
W, H, t = 2.6, 2.3, 0.20

wz = top  # window base
wy = 0.45

# frame: 2 vertical + 2 horizontal members + cross bars
for sx in (-1, 1):
    C.box(f"frame_v{sx}", (t, 0.22, H), (sx * (W - t) / 2, wy, wz + H / 2),
          grey, 0.05)
C.box("frame_top", (W, 0.22, t), (0, wy, wz + H - t / 2), grey, 0.05)
C.box("frame_bot", (W, 0.22, t), (0, wy, wz + t / 2), grey, 0.05)
C.box("cross_v", (0.12, 0.18, H - 2 * t), (0, wy, wz + H / 2), grey, 0.03)
C.box("cross_h", (W - 2 * t, 0.18, 0.12), (0, wy, wz + H / 2), grey, 0.03)

# glass panes
glass = C.clay((0.85, 0.93, 0.93, 1), 0.15)
C.box("glass", (W - 0.15, 0.08, H - 0.15), (0, wy + 0.02, wz + H / 2), glass,
      0.02)
# wipe streak
streak = C.clay((0.95, 0.99, 0.99, 1), 0.1)
C.box("streak", (0.14, 0.03, 1.4), (-0.45, wy - 0.03, wz + H / 2), streak,
      0.01, rot=(0, math.radians(-30), 0))

# squeegee leaning on window: teal handle + head with rubber strip
teal = C.clay("teal", 0.5)
mint = C.clay("mint", 0.55)
ra = math.radians(-35)
C.box("sq_head", (0.95, 0.16, 0.20), (0.55, 0.1, wz + 1.05), teal, 0.05,
      rot=(math.radians(-18), 0, math.radians(12)))
C.box("sq_rubber", (0.98, 0.08, 0.10), (0.55, 0.05, wz + 1.16), mint, 0.02,
      rot=(math.radians(-18), 0, math.radians(12)))
C.cyl("sq_handle", 0.085, 1.0, (0.75, -0.25, wz + 0.55), teal, 0.02,
      rot=(math.radians(28), ra, 0))

# folded mint cloth front-left
C.box("cloth1", (0.95, 0.7, 0.16), (-0.85, -0.55, top + 0.10), mint, 0.07)
C.box("cloth2", (0.88, 0.64, 0.15), (-0.85, -0.55, top + 0.24), mint, 0.07)

C.finish("window-cleaning", frame_target=(0, 0, 1.25), dist=10.5, azim=8,
         elev=18)
