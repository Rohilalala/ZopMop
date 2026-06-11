"""ZopMop icon design language v3 — LOCKED. See user spec in ICON_PROMPTS.md.

Palette: pale ice-grey stone slab, deep petrol/navy (#1E3A5F family),
soft slate grey, natural light wood, ONE muted teal (#2E8B8B) accent.
No warm/earthy object tones (warm light fill is allowed).

Camera: elev 32, azim 45, 70mm. Cycles 256 denoised, AgX + contrast lift,
transparent film, 1024x1024.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy
import math
import lib_clay as C

ASSETS_DIR = C.ASSETS_DIR
RENDER_DIR = C.RENDER_DIR

HEX = {
    "stone":      "#E7E9EC",   # pale ice-grey slab
    "navy":       "#1E3A5F",
    "navy-deep":  "#16294A",
    "slate":      "#6B7686",
    "slate-blue": "#46586E",
    "wood":       "#D4B68C",   # light oak
    "wood-deep":  "#B89868",
    "teal":       "#2E8B8B",
    "steel":      "#9AA4AE",
    "water":      "#2C4A66",
}


def _lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hexc(h):
    h = HEX.get(h, h).lstrip("#")
    return tuple(_lin(int(h[i:i + 2], 16) / 255) for i in (0, 2, 4)) + (1.0,)


# ---------------------------------------------------------------- scene
def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scn = bpy.context.scene
    scn.render.engine = "CYCLES"
    scn.cycles.samples = 256
    scn.cycles.use_denoising = True
    scn.render.film_transparent = True
    scn.render.resolution_x = 1024
    scn.render.resolution_y = 1024
    scn.view_settings.view_transform = "AgX"
    try:
        scn.view_settings.look = "AgX - Punchy"
    except TypeError:
        scn.view_settings.look = "Punchy"
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "METAL"
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
        scn.cycles.device = "GPU"
    except Exception:
        scn.cycles.device = "CPU"
    world = bpy.data.worlds.new("World")
    scn.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.85, 0.90, 1.0, 1.0)  # cool ambient
    bg.inputs[1].default_value = 0.5


# ---------------------------------------------------------------- materials
def mat(token, rough=0.5, rough_var=0.10, noise_scale=7.0, bump=0.04,
        metallic=0.0, name=None):
    """Principled with subtle procedural roughness variation + bump."""
    m = bpy.data.materials.new(name or f"st_{token}_{rough}")
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = hexc(token)
    bsdf.inputs["Metallic"].default_value = metallic

    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = noise_scale
    noise.inputs["Detail"].default_value = 4.0

    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.inputs["From Min"].default_value = 0.0
    mr.inputs["From Max"].default_value = 1.0
    mr.inputs["To Min"].default_value = max(0.02, rough - rough_var)
    mr.inputs["To Max"].default_value = min(0.98, rough + rough_var)
    nt.links.new(noise.outputs["Fac"], mr.inputs["Value"])
    nt.links.new(mr.outputs["Result"], bsdf.inputs["Roughness"])

    if bump > 0:
        bp = nt.nodes.new("ShaderNodeBump")
        bp.inputs["Strength"].default_value = bump
        nt.links.new(noise.outputs["Fac"], bp.inputs["Height"])
        nt.links.new(bp.outputs["Normal"], bsdf.inputs["Normal"])
    return m


def wood_mat(rough=0.5):
    """Light oak with faint stretched grain."""
    m = bpy.data.materials.new("st_wood")
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = rough

    tc = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (1.0, 1.0, 14.0)  # stretch along z
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 3.0
    noise.inputs["Detail"].default_value = 6.0
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.inputs["Factor"].default_value = 0.5
    mix.inputs[6].default_value = hexc("wood")
    mix.inputs[7].default_value = hexc("wood-deep")
    nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
    nt.links.new(mp.outputs["Vector"], noise.inputs["Vector"])
    nt.links.new(noise.outputs["Fac"], mix.inputs["Factor"])
    nt.links.new(mix.outputs[2], bsdf.inputs["Base Color"])

    bp = nt.nodes.new("ShaderNodeBump")
    bp.inputs["Strength"].default_value = 0.03
    nt.links.new(noise.outputs["Fac"], bp.inputs["Height"])
    nt.links.new(bp.outputs["Normal"], bsdf.inputs["Normal"])
    return m


def stone_mat():
    """Smooth pale stone with barely-visible fine speckle."""
    m = bpy.data.materials.new("st_stone")
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = 0.3

    vor = nt.nodes.new("ShaderNodeTexVoronoi")
    vor.inputs["Scale"].default_value = 220.0
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.inputs[6].default_value = hexc("stone")
    mix.inputs[7].default_value = hexc("#C9CDD3")
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.inputs["From Min"].default_value = 0.0
    mr.inputs["From Max"].default_value = 1.0
    mr.inputs["To Min"].default_value = 0.0
    mr.inputs["To Max"].default_value = 0.12   # speckle barely visible
    nt.links.new(vor.outputs["Distance"], mr.inputs["Value"])
    nt.links.new(mr.outputs["Result"], mix.inputs["Factor"])
    nt.links.new(mix.outputs[2], bsdf.inputs["Base Color"])
    return m


# ---------------------------------------------------------------- helpers
def subsurf(obj, levels=2):
    s = obj.modifiers.new("Subsurf", "SUBSURF")
    s.levels = levels
    s.render_levels = levels
    return obj


def displace(obj, strength=0.04, size=0.6):
    tex = bpy.data.textures.new(f"disp_{obj.name}", type="CLOUDS")
    tex.noise_scale = size
    d = obj.modifiers.new("Displace", "DISPLACE")
    d.texture = tex
    d.strength = strength
    return obj


def slab(size=3.0, height=0.12):
    """Thin rounded pale-stone slab. Returns top z."""
    o = C.box("slab", (size, size, height), (0, 0, height / 2), None,
              bevel_w=0.045, bevel_seg=4)
    o.data.materials.append(stone_mat())
    return height


def arc(name, p0, p1, bulge, r, material, res=24):
    """Rounded handle arc from p0 to p1 bulging up by `bulge` (curve+bevel)."""
    cu = bpy.data.curves.new(name, type="CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = r
    cu.bevel_resolution = 6
    cu.resolution_u = res
    cu.use_fill_caps = True
    sp = cu.splines.new("BEZIER")
    sp.bezier_points.add(1)
    mid = [(a + b) / 2 for a, b in zip(p0, p1)]
    mid[2] += bulge
    b0, b1 = sp.bezier_points
    b0.co = p0
    b1.co = p1
    b0.handle_right = (p0[0] + (mid[0] - p0[0]) * 0.8,
                       p0[1] + (mid[1] - p0[1]) * 0.8, mid[2])
    b0.handle_left = p0
    b1.handle_left = (p1[0] + (mid[0] - p1[0]) * 0.8,
                      p1[1] + (mid[1] - p1[1]) * 0.8, mid[2])
    b1.handle_right = p1
    obj = bpy.data.objects.new(name, cu)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(material)
    return obj


# ---------------------------------------------------------------- rig + out
def rig(target=(0, 0, 0.7), dist=9.0, lens=70):
    bpy.ops.object.empty_add(location=target)
    tgt = bpy.context.active_object
    tgt.name = "cam_target"
    az, el = math.radians(20), math.radians(22)
    cx = target[0] + dist * math.cos(el) * math.sin(az)
    cy = target[1] - dist * math.cos(el) * math.cos(az)
    cz = target[2] + dist * math.sin(el)
    bpy.ops.object.camera_add(location=(cx, cy, cz))
    cam = bpy.context.active_object
    cam.data.lens = lens
    tc = cam.constraints.new("TRACK_TO")
    tc.target = tgt
    bpy.context.scene.camera = cam

    def area(name, loc, energy, size, rot, color=(1, 1, 1)):
        bpy.ops.object.light_add(type="AREA", location=loc, rotation=rot)
        L = bpy.context.active_object
        L.name = name
        L.data.energy = energy
        L.data.size = size
        L.data.color = color
        return L

    # key: large soft, upper-left, slightly cool
    area("key", (-5.0, -4.0, 7.5), 2400, 7,
         (math.radians(48), 0, math.radians(-40)), (0.92, 0.96, 1.0))
    # fill: gentle warm, from the right, low
    area("fill", (5.5, -3.0, 3.5), 480, 5,
         (math.radians(65), 0, math.radians(55)), (1.0, 0.92, 0.82))
    # rim: behind/above to separate silhouettes
    area("rim", (1.5, 5.5, 6.5), 1400, 4,
         (math.radians(-45), 0, math.radians(12)), (0.95, 0.97, 1.0))


def finish(name, target_z=0.75, dist=9.0, lens=70):
    rig((0, 0, target_z), dist, lens)
    os.makedirs(RENDER_DIR, exist_ok=True)
    scn = bpy.context.scene
    scn.render.filepath = os.path.join(RENDER_DIR, f"{name}.png")
    bpy.ops.render.render(write_still=True)
    bpy.ops.wm.save_as_mainfile(
        filepath=os.path.join(ASSETS_DIR, f"{name}.blend"))
    print(f"DONE {name}")
