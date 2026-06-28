"""Bathroom cleaning: toilet, sink+faucet, spray bottle, brush, towels."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import math
import lib_clay as C

C.reset()
top = C.platform(3.6, 3.2, 0.42)

white = C.clay((0.96, 0.96, 0.97, 1), 0.35)

# toilet (center back): base + bowl + seat + tank + flush button
C.cyl("t_base", 0.40, 0.55, (0.1, 0.45, top + 0.28), white, 0.08)
C.sphere("t_bowl", 0.60, (0.1, 0.45, top + 0.70), white, scale=(1, 1.1, 0.55))
C.cyl("t_seat", 0.58, 0.14, (0.1, 0.45, top + 1.00), white, 0.06)
C.box("t_tank", (0.95, 0.36, 0.95), (0.1, 1.05, top + 1.05), white, 0.10)
C.cyl("t_btn", 0.11, 0.07, (0.1, 1.05, top + 1.55), white, 0.02)

# sink (left): basin box + faucet
C.box("sink", (1.05, 1.0, 0.78), (-1.15, 0.15, top + 0.39), white, 0.10)
inner = C.clay((0.85, 0.87, 0.89, 1), 0.4)
C.box("sink_inner", (0.8, 0.75, 0.1), (-1.15, 0.15, top + 0.76), inner, 0.05)
fauc = white
C.cyl("fauc_post", 0.09, 0.55, (-1.15, 0.62, top + 1.0), fauc, 0.02)
C.cyl("fauc_arm", 0.075, 0.5, (-1.15, 0.42, top + 1.26), fauc, 0.02,
      rot=(math.radians(90), 0, 0))
C.cyl("fauc_tip", 0.06, 0.16, (-1.15, 0.2, top + 1.2), fauc, 0.01)

# spray bottle (right front): teal
teal = C.clay("teal", 0.45)
mintl = C.clay("mint", 0.45)
C.cone("bottle", 0.30, 0.24, 0.85, (1.25, -0.45, top + 0.43), teal, 0.05)
C.cyl("bottle_neck", 0.12, 0.22, (1.25, -0.45, top + 0.95), teal, 0.02)
C.box("trigger_head", (0.22, 0.45, 0.22), (1.25, -0.52, top + 1.12), mintl, 0.05)
C.box("nozzle", (0.10, 0.16, 0.12), (1.25, -0.78, top + 1.12), mintl, 0.03)
C.box("trigger", (0.08, 0.10, 0.30), (1.25, -0.70, top + 0.94), mintl, 0.02,
      rot=(math.radians(15), 0, 0))

# scrub brush (front left): blue handle + white bristles
blue = C.clay("blue", 0.5)
C.box("brush_handle", (0.70, 0.26, 0.18), (-0.7, -0.95, top + 0.32), blue, 0.08,
      rot=(0, 0, math.radians(15)))
brist = C.clay((0.95, 0.94, 0.90, 1), 0.85)
C.box("brush_bristles", (0.72, 0.30, 0.18), (-0.7, -0.95, top + 0.14), brist, 0.05,
      rot=(0, 0, math.radians(15)))

# folded towels (front center-right)
tow = C.clay("mint", 0.8)
C.box("towel1", (0.95, 0.7, 0.16), (0.45, -1.0, top + 0.10), tow, 0.07)
C.box("towel2", (0.88, 0.64, 0.15), (0.45, -1.0, top + 0.245), tow, 0.07)

C.finish("bathroom-cleaning", frame_target=(0, 0, 0.95), dist=10.5,
         azim=10, elev=24)
