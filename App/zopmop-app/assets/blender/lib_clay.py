"""Shared helpers for ZopMop clay-style service icons.

Style: soft 3D clay, pastel colors, rounded white platform slab,
3/4 hero view, soft studio lighting, transparent background.

Run any icon script headless:
  /Applications/Blender.app/Contents/MacOS/Blender -b -P <icon>.py
Each icon script imports this module, builds the scene, then calls
finish(name) which renders renders/<name>.png and saves <name>.blend.
"""
import bpy
import math
import os

ASSETS_DIR = os.path.dirname(os.path.abspath(__file__))
RENDER_DIR = os.path.join(ASSETS_DIR, "renders")

# ---------------------------------------------------------------- palette
PALETTE = {
    "white":      (0.93, 0.93, 0.94, 1.0),
    "offwhite":   (0.88, 0.87, 0.85, 1.0),
    "cream":      (0.92, 0.88, 0.78, 1.0),
    "beige":      (0.85, 0.76, 0.62, 1.0),
    "wood":       (0.80, 0.62, 0.42, 1.0),
    "wood_dark":  (0.55, 0.38, 0.24, 1.0),
    "brown":      (0.30, 0.18, 0.12, 1.0),
    "terracotta": (0.76, 0.43, 0.28, 1.0),
    "mint":       (0.69, 0.86, 0.78, 1.0),
    "teal":       (0.45, 0.76, 0.68, 1.0),
    "sage":       (0.72, 0.80, 0.66, 1.0),
    "green":      (0.45, 0.70, 0.38, 1.0),
    "green_dark": (0.30, 0.52, 0.28, 1.0),
    "blue":       (0.55, 0.68, 0.82, 1.0),
    "blue_pale":  (0.66, 0.79, 0.94, 1.0),
    "steel":      (0.60, 0.64, 0.69, 1.0),
    "grey":       (0.45, 0.47, 0.50, 1.0),
    "grey_dark":  (0.22, 0.23, 0.25, 1.0),
    "charcoal":   (0.12, 0.12, 0.13, 1.0),
    "yellow":     (0.95, 0.80, 0.35, 1.0),
    "yellow_pale":(0.94, 0.88, 0.66, 1.0),
    "pink":       (0.94, 0.71, 0.74, 1.0),
    "orange":     (0.90, 0.55, 0.25, 1.0),
}


def col(name):
    return PALETTE[name] if isinstance(name, str) else name


# ---------------------------------------------------------------- scene
def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scn = bpy.context.scene
    scn.render.engine = "CYCLES"
    scn.cycles.samples = 96
    scn.cycles.use_denoising = True
    scn.render.film_transparent = True
    scn.render.resolution_x = 1024
    scn.render.resolution_y = 1024
    # AgX desaturates pastels; Standard clips whites. PBR Neutral keeps both.
    try:
        scn.view_settings.view_transform = "Khronos PBR Neutral"
    except TypeError:
        scn.view_settings.view_transform = "Standard"
    scn.view_settings.look = "None"
    # GPU if available
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "METAL"
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
        scn.cycles.device = "GPU"
    except Exception:
        scn.cycles.device = "CPU"
    # soft white world so clay picks up gentle ambient
    world = bpy.data.worlds.new("World")
    scn.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (1.0, 1.0, 1.0, 1.0)
    bg.inputs[1].default_value = 0.35


# ---------------------------------------------------------------- materials
_mats = {}


def clay(color, rough=0.55, name=None):
    """Soft clay Principled material. color = palette key or RGBA."""
    key = (str(color), rough)
    if key in _mats:
        return _mats[key]
    m = bpy.data.materials.new(name or f"clay_{key}")
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = col(color)
    bsdf.inputs["Roughness"].default_value = rough
    _mats[key] = m
    return m


def glassy(color=(0.85, 0.92, 0.95, 1.0), name="glassy"):
    """Frosted translucent material for glass/windows/bottles."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = col(color)
    bsdf.inputs["Roughness"].default_value = 0.15
    bsdf.inputs["Transmission Weight"].default_value = 0.85
    bsdf.inputs["IOR"].default_value = 1.2
    return m


def metal(color=(0.75, 0.77, 0.80, 1.0), rough=0.35, name="metal"):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = col(color)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = 0.9
    return m


# ---------------------------------------------------------------- primitives
def _finish_obj(obj, mat, bevel_w, bevel_seg=5, shade_smooth=True):
    if bevel_w and bevel_w > 0:
        b = obj.modifiers.new("Bevel", "BEVEL")
        b.width = bevel_w
        b.segments = bevel_seg
        b.limit_method = "ANGLE"
        b.angle_limit = math.radians(40)
    if mat is not None:
        obj.data.materials.append(mat)
    if shade_smooth:
        for p in obj.data.polygons:
            p.use_smooth = True
        try:
            obj.data.use_auto_smooth = True
            obj.data.auto_smooth_angle = math.radians(50)
        except AttributeError:
            # Blender 4.1+ removed auto_smooth; use smooth-by-angle modifier
            try:
                bpy.ops.object.shade_smooth_by_angle(angle=math.radians(50))
            except Exception:
                pass
    return obj


def box(name, size, loc, mat, bevel_w=0.05, rot=(0, 0, 0), bevel_seg=5):
    """size = full (x,y,z) dimensions."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    o.scale = (size[0], size[1], size[2])
    bpy.ops.object.transform_apply(scale=True)
    return _finish_obj(o, mat, bevel_w, bevel_seg)


def cyl(name, radius, depth, loc, mat, bevel_w=0.03, rot=(0, 0, 0),
        verts=48, bevel_seg=4):
    bpy.ops.mesh.primitive_cylinder_add(
        radius=radius, depth=depth, location=loc, rotation=rot,
        vertices=verts)
    o = bpy.context.active_object
    o.name = name
    return _finish_obj(o, mat, bevel_w, bevel_seg)


def cone(name, r1, r2, depth, loc, mat, bevel_w=0.02, rot=(0, 0, 0),
         verts=48):
    bpy.ops.mesh.primitive_cone_add(
        radius1=r1, radius2=r2, depth=depth, location=loc, rotation=rot,
        vertices=verts)
    o = bpy.context.active_object
    o.name = name
    return _finish_obj(o, mat, bevel_w)


def sphere(name, radius, loc, mat, scale=(1, 1, 1), rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_uv_sphere_add(
        radius=radius, location=loc, segments=48, ring_count=24,
        rotation=rot)
    o = bpy.context.active_object
    o.name = name
    o.scale = scale
    bpy.ops.object.transform_apply(scale=True)
    return _finish_obj(o, mat, 0)


def torus(name, major, minor, loc, mat, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(
        major_radius=major, minor_radius=minor, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    return _finish_obj(o, mat, 0)


def platform(size_x=3.4, size_y=3.4, height=0.42, color="white",
             bevel_w=0.16, z=0.0):
    """Rounded slab the icon props sit on. Top face is at returned z."""
    o = box("platform", (size_x, size_y, height),
            (0, 0, z + height / 2), clay(color, 0.6), bevel_w, bevel_seg=7)
    return z + height


# ---------------------------------------------------------------- rig
def rig(target=(0, 0, 0.8), dist=9.5, azim=18, elev=26, lens=80):
    """Camera 3/4 hero view + 3-point soft studio lighting."""
    # target empty
    bpy.ops.object.empty_add(location=target)
    tgt = bpy.context.active_object
    tgt.name = "cam_target"

    az = math.radians(azim)
    el = math.radians(elev)
    cx = target[0] + dist * math.cos(el) * math.sin(az)
    cy = target[1] - dist * math.cos(el) * math.cos(az)
    cz = target[2] + dist * math.sin(el)
    bpy.ops.object.camera_add(location=(cx, cy, cz))
    cam = bpy.context.active_object
    cam.data.lens = lens
    tc = cam.constraints.new("TRACK_TO")
    tc.target = tgt
    bpy.context.scene.camera = cam

    def area(name, loc, energy, size, rot):
        bpy.ops.object.light_add(type="AREA", location=loc, rotation=rot)
        L = bpy.context.active_object
        L.name = name
        L.data.energy = energy
        L.data.size = size
        return L

    # key: upper front-left
    area("key", (-4.5, -5.5, 7.5), 600, 6,
         (math.radians(50), 0, math.radians(-35)))
    # fill: front-right, weaker
    area("fill", (5.5, -4.5, 4.5), 240, 6,
         (math.radians(60), 0, math.radians(45)))
    # rim/top
    area("rim", (0, 5.0, 7.0), 260, 5,
         (math.radians(-45), 0, 0))


# ---------------------------------------------------------------- output
def finish(name, frame_target=(0, 0, 0.9), dist=9.5, azim=18, elev=26,
           lens=80):
    rig(frame_target, dist, azim, elev, lens)
    os.makedirs(RENDER_DIR, exist_ok=True)
    scn = bpy.context.scene
    scn.render.filepath = os.path.join(RENDER_DIR, f"{name}.png")
    bpy.ops.render.render(write_still=True)
    bpy.ops.wm.save_as_mainfile(
        filepath=os.path.join(ASSETS_DIR, f"{name}.blend"))
    print(f"DONE {name}")
