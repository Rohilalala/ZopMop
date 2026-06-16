"""Sweeping & Mopping — ZopMop v3 locked design language (see lib_studio).

Hero: flat-head mop, light wood handle, navy microfiber head (fabric folds
+ seam). Support: soft-bristle broom crossing behind (ferrule, bristle
clumps with splay), slate-blue bucket with rim/handle/water line.
Detail: folded teal cloth on opposite corner, 2 subtle bubbles.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import math
import bpy
import lib_clay as C
import lib_studio as S

S.reset()
top = S.slab(2.6)

wood = S.wood_mat()
navy = S.mat("navy", 0.7, rough_var=0.08, noise_scale=18, bump=0.12)
navy_deep = S.mat("navy-deep", 0.45, bump=0.02)
slate = S.mat("slate", 0.55, bump=0.03)
slate_blue = S.mat("slate-blue", 0.35, rough_var=0.06, bump=0.02)
teal = S.mat("teal", 0.65, rough_var=0.08, noise_scale=16, bump=0.10)
steel = S.mat("steel", 0.3, bump=0.01, metallic=0.85)
water = S.mat("water", 0.08, rough_var=0.02, bump=0.0)


def parent_to(objs, name, pivot):
    bpy.ops.object.empty_add(location=pivot)
    e = bpy.context.active_object
    e.name = name
    for o in objs:
        o.parent = e
        o.matrix_parent_inverse = e.matrix_world.inverted()
    return e


# ================================================= HERO: flat-head mop
mx, my = -0.35, -0.38
parts = []
# fabric head: subsurf + displaced folds
head = C.box("mop_head", (1.2, 0.4, 0.34), (mx, my, top + 0.17), navy,
             bevel_w=0.09, bevel_seg=4)
S.subsurf(head, 2)
S.displace(head, strength=0.06, size=0.35)
parts.append(head)
# seam line across the top
seam = C.box("mop_seam", (1.16, 0.04, 0.03), (mx, my, top + 0.36),
             navy_deep, bevel_w=0.01, bevel_seg=2)
parts.append(seam)
# collar where head meets pole
parts.append(C.cyl("mop_collar", 0.075, 0.16, (mx, my, top + 0.44),
                   navy_deep, 0.02))
# joint knuckle
parts.append(C.sphere("mop_joint", 0.065, (mx, my, top + 0.54), navy_deep))
# wood handle
PL = 1.65
parts.append(C.cyl("mop_pole", 0.048, PL, (mx, my, top + 0.54 + PL / 2),
                   wood, 0.012))
# end cap
parts.append(C.cyl("mop_cap", 0.058, 0.10,
                   (mx, my, top + 0.54 + PL + 0.04), navy_deep, 0.015))
mop = parent_to(parts, "mop", (mx, my, top))
mop.rotation_euler = (math.radians(-3), math.radians(10), 0)

# ================================================= SUPPORT: broom behind
bx, by = 0.12, 0.52
parts = []
# bristle clumps: ring + center, splayed at tips
for i in range(8):
    a = math.radians(i * 45)
    cxp = bx + 0.175 * math.cos(a)
    cyp = by + 0.175 * math.sin(a)
    cl = C.cone(f"clump{i}", 0.075, 0.05, 0.80, (cxp, cyp, top + 0.40),
                slate, 0.012,
                rot=(-math.radians(9) * math.sin(a),
                     math.radians(9) * math.cos(a), 0))
    parts.append(cl)
parts.append(C.cone("clump_c", 0.085, 0.06, 0.80, (bx, by, top + 0.42),
                    slate, 0.012))
# ferrule
parts.append(C.cyl("ferrule", 0.165, 0.24, (bx, by, top + 0.92), steel,
                   0.02))
parts.append(C.cyl("ferrule_band", 0.172, 0.05, (bx, by, top + 0.86), steel,
                   0.01))
# wood handle
BL = 1.8
parts.append(C.cyl("broom_pole", 0.044, BL, (bx, by, top + 1.04 + BL / 2),
                   wood, 0.012))
parts.append(C.cyl("broom_cap", 0.052, 0.09,
                   (bx, by, top + 1.04 + BL + 0.035), navy_deep, 0.012))
broom = parent_to(parts, "broom", (bx, by, top))
broom.rotation_euler = (math.radians(6), math.radians(-18), 0)

# ================================================= SUPPORT: bucket
ux, uy = 0.95, 0.30
BH = 0.82
C.cone("bucket", 0.46, 0.57, BH, (ux, uy, top + BH / 2), slate_blue, 0.02)
C.cone("bucket_in", 0.42, 0.535, BH - 0.06, (ux, uy, top + BH / 2 + 0.045),
       slate_blue, 0.01)
C.torus("bucket_lip", 0.575, 0.035, (ux, uy, top + BH), slate_blue)
# water line inside
C.cyl("water", 0.50, 0.025, (ux, uy, top + BH - 0.16), water, 0.0)
# wire handle: pivots at two diametrically opposite rim lugs, arc over center
ha = math.radians(110)  # diameter faces the 20° camera head-on
hp0 = (ux + 0.545 * math.cos(ha), uy + 0.545 * math.sin(ha), top + BH - 0.05)
hp1 = (ux - 0.545 * math.cos(ha), uy - 0.545 * math.sin(ha), top + BH - 0.05)
S.arc("bucket_handle", hp0, hp1, 0.50, 0.021, steel)
for i, hp in enumerate((hp0, hp1)):
    C.sphere(f"handle_lug{i}", 0.048, hp, slate_blue)

# ================================================= DETAIL: teal cloth
cx, cy = 0.42, -0.78
c1 = C.box("cloth1", (0.85, 0.64, 0.15), (cx, cy, top + 0.075), teal,
           bevel_w=0.05, bevel_seg=4, rot=(0, 0, math.radians(18)))
S.subsurf(c1, 2)
S.displace(c1, strength=0.03, size=0.25)
c2 = C.box("cloth2", (0.74, 0.55, 0.13), (cx + 0.03, cy - 0.02, top + 0.18),
           teal, bevel_w=0.045, bevel_seg=4, rot=(0, 0, math.radians(12)))
S.subsurf(c2, 2)
S.displace(c2, strength=0.028, size=0.22)

# ================================================= micro: bubbles
bub = S.mat("#DCE8F0", 0.12, rough_var=0.02, bump=0.0)
C.sphere("bub1", 0.055, (-0.95, -0.25, top + 0.42), bub)
C.sphere("bub2", 0.035, (-1.08, -0.12, top + 0.58), bub)

S.finish("mopping-and-sweeping", target_z=1.02, dist=8.2)
