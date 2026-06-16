"""ZopMop icon design system v2 — see ICON_PROMPTS.md.

Brand palette (hex sRGB, converted to linear for Cycles), shared squircle
base tile, fixed camera + lighting. Reuses primitives from lib_clay.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy
import math
import lib_clay as C

TOKENS = {
    "tile":        "#D8DCE4",
    "surface":     "#ECE9E1",
    "indigo":      "#4F46E5",
    "indigo-soft": "#818CF8",
    "indigo-pale": "#C7D2FE",
    "amber":       "#F5A300",
    "amber-soft":  "#FFC042",
    "slate":       "#3F4756",
    "slate-soft":  "#8E99AB",
    "teal":        "#4FB3A5",
    "green":       "#5FA85F",
    "terracotta":  "#C96F4A",
    "wood":        "#C89A6B",
    "blue-soft":   "#7FA7D9",
}


def _lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hexc(h):
    h = h.lstrip("#")
    return tuple(_lin(int(h[i:i + 2], 16) / 255) for i in (0, 2, 4)) + (1.0,)


def mat(token, rough=0.55):
    """Clay material from a design token (or raw hex)."""
    h = TOKENS.get(token, token)
    return C.clay(hexc(h), rough, name=f"zop_{token}_{rough}")


def metal_mat(rough=0.35):
    return C.metal(hexc(TOKENS["slate-soft"]), rough)


def reset():
    C.reset()


def tile(size=2.9, height=0.34):
    """Family-signature squircle base tile. Returns top z."""
    # tall box + heavy bevel, then squash z → squircle puck
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0))
    o = bpy.context.active_object
    o.name = "tile"
    o.scale = (size, size, 1.4)
    bpy.ops.object.transform_apply(scale=True)
    b = o.modifiers.new("Bevel", "BEVEL")
    b.width = 0.52
    b.segments = 12
    bpy.ops.object.modifier_apply(modifier="Bevel")
    o.scale = (1, 1, height / 1.4)
    bpy.ops.object.transform_apply(scale=True)
    o.location = (0, 0, height / 2)
    o.data.materials.append(mat("tile", 0.6))
    for p in o.data.polygons:
        p.use_smooth = True
    return height


def sparkle(name, loc, s=0.22, rot=0.0, token="surface"):
    """4-point star sparkle — two crossed thin diamonds."""
    m = mat(token, 0.3)
    for i, (sx, sy) in enumerate(((s, s * 0.28), (s * 0.28, s))):
        bpy.ops.mesh.primitive_cube_add(size=1, location=loc,
                                        rotation=(0, 0, rot + math.radians(45)))
        o = bpy.context.active_object
        o.name = f"{name}_{i}"
        o.scale = (sx, sy, s * 0.18)
        bpy.ops.object.transform_apply(scale=True)
        b = o.modifiers.new("Bevel", "BEVEL")
        b.width = s * 0.1
        b.segments = 3
        o.data.materials.append(m)
        for p in o.data.polygons:
            p.use_smooth = True


def finish(name, target_z=0.9, dist=9.5, lens=80):
    """Fixed family camera: azim 18, elev 24."""
    C.finish(name, frame_target=(0, 0, target_z), dist=dist, azim=18,
             elev=24, lens=lens)
