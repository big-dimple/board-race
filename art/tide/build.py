"""Rebuild the editable Tide head and game GLB with Blender 4.x.

Run: blender --background --python art/tide/build.py
Coordinates below use the game's meters, +Y up, +Z face forward.
"""
import math
from pathlib import Path
import sys

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
# The system Pillow installs alongside Blender on the authoring host.
sys.path.append('/usr/lib/python3/dist-packages')
from PIL import Image, ImageDraw, ImageFilter

OUT = ROOT / 'src/assets/models'
OUT.mkdir(parents=True, exist_ok=True)
SOURCE = Path(__file__).resolve().parent
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
for block in list(bpy.data.materials):
    bpy.data.materials.remove(block)


def xyz(p):
    return (p[0], -p[2], p[1])


def smooth(a, b, x):
    t = max(0, min(1, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def gauss(x, y, cx, cy, sx, sy):
    return math.exp(-((x - cx) / sx) ** 2 - ((y - cy) / sy) ** 2)


def uv(p):
    return ((p[0] + .14) / .28, (p[1] + .025) / .30)


# Reproject individual painted features, removing the portrait's perspective
# between the eyes. Skin and nose lighting are supplied by the game shader.
portrait = Image.open(ROOT / 'src/assets/drivers/tide.webp').convert('RGB')
atlas = Image.new('RGB', (1024, 1024), (244, 207, 174))


def feature(box, center, size):
    patch = portrait.crop(box).resize((int(size[0] / .28 * 1024), int(size[1] / .30 * 1024)), Image.Resampling.LANCZOS)
    mask = Image.new('L', patch.size)
    draw = ImageDraw.Draw(mask)
    w, h = patch.size
    draw.ellipse((w * .03, h * .08, w * .97, h * .92), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(max(2, h * .10)))
    u, v = uv((center[0], center[1], 0))
    atlas.paste(patch, (int(u * 1024 - w / 2), int((1 - v) * 1024 - h / 2)), mask)


feature((307, 261, 405, 305), (-.051, .126), (.075, .033))
feature((425, 275, 493, 310), (.051, .126), (.071, .033))
feature((317, 235, 413, 267), (-.051, .160), (.076, .020))
feature((435, 249, 489, 278), (.051, .158), (.066, .020))
feature((391, 382, 450, 423), (0, .040), (.054, .027))
atlas.save(SOURCE / 'tide-face.png')
texture = bpy.data.images.load(str(SOURCE / 'tide-face.png'))
texture.pack()


def material(name, color, image=None):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*color, 1)
    shader.inputs['Roughness'].default_value = .8
    if image:
        node = mat.node_tree.nodes.new('ShaderNodeTexImage')
        node.image = image
        mat.node_tree.links.new(node.outputs['Color'], shader.inputs['Base Color'])
    else:
        node = mat.node_tree.nodes.new('ShaderNodeVertexColor')
        node.layer_name = 'Color'
        mat.node_tree.links.new(node.outputs['Color'], shader.inputs['Base Color'])
    return mat


skin_mat = material('TideSkin', (1, 1, 1), texture)
hair_mat = material('TideHair', (1, 1, 1))


def mesh(name, vertices, faces, mat, colors=None, weights=None):
    data = bpy.data.meshes.new(name)
    data.from_pydata([xyz(p) for p in vertices], [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    for poly in data.polygons:
        poly.use_smooth = True
    if colors:
        attr = data.color_attributes.new(name='Color', type='FLOAT_COLOR', domain='POINT')
        for i, c in enumerate(colors):
            attr.data[i].color = (*c, 1)
    else:
        layer = data.uv_layers.new(name='UVMap')
        for loop in data.loops:
            p = vertices[loop.vertex_index]
            layer.data[loop.index].uv = uv(p) if p[2] > .035 else (.015, .015)
    if weights:
        for i, entries in enumerate(weights):
            for name, weight in entries:
                group = obj.vertex_groups.get(name) or obj.vertex_groups.new(name=name)
                group.add([i], weight, 'REPLACE')
    return obj


# Ring loft with a sculpted facial surface: cheek planes, sockets, nose and lips.
profile = [
    (-.010, .025, .028, .019), (.008, .046, .044, .021),
    (.035, .068, .063, .016), (.064, .089, .081, .009),
    (.090, .103, .094, .005), (.120, .104, .100, .003),
    (.153, .106, .103, .001), (.187, .102, .100, -.002),
    (.216, .087, .083, -.005), (.242, .054, .052, -.007),
    (.257, .001, .001, -.007),
]


def head_ring(y):
    for a, b in zip(profile, profile[1:]):
        if y <= b[0]:
            t = smooth(a[0], b[0], y)
            return tuple(a[k] + (b[k] - a[k]) * t for k in (1, 2, 3))
    return profile[-1][1:]


verts, faces = [], []
ROWS, SIDES = 33, 48
for row in range(ROWS):
    y = -.010 + .267 * row / (ROWS - 1)
    rx, rz, cz = head_ring(y)
    for col in range(SIDES):
        theta = 2 * math.pi * col / SIDES
        x = rx * math.sin(theta)
        front = max(0, math.cos(theta)) ** 8
        z = cz + rz * math.cos(theta)
        z += front * (
            .026 * gauss(x, y, 0, .112, .013, .043)
            + .036 * gauss(x, y, 0, .083, .015, .014)
            + .009 * gauss(abs(x), y, .020, .077, .009, .009)
            - .010 * gauss(abs(x), y, .051, .127, .030, .014)
            + .007 * gauss(abs(x), y, .057, .091, .034, .019)
            + .007 * gauss(x, y, 0, .041, .034, .015))
        verts.append((x, y, z))
for row in range(ROWS - 1):
    for col in range(SIDES):
        a = row * SIDES + col
        b = row * SIDES + (col + 1) % SIDES
        faces.append((a, b, b + SIDES, a + SIDES))
faces.append(tuple(reversed(range(SIDES))))
head = mesh('tide-head', verts, faces, skin_mat)

# A tapered neck closes the gap above the existing suit collar.
nv, nf = [], []
for y, radius in [(-.072, .045), (-.018, .040), (.030, .038)]:
    for i in range(24):
        a = i * math.pi * 2 / 24
        nv.append((radius * math.sin(a), y, .007 + radius * math.cos(a)))
for row in range(2):
    for i in range(24):
        a = row * 24 + i
        b = row * 24 + (i + 1) % 24
        nf.append((a, b, b + 24, a + 24))
neck = mesh('tide-neck', nv, nf, skin_mat)
for loop in neck.data.loops:
    neck.data.uv_layers.active.data[loop.index].uv = (.015, .015)
bpy.ops.object.select_all(action='DESELECT')
head.select_set(True)
neck.select_set(True)
bpy.context.view_layer.objects.active = head
bpy.ops.object.join()

# A cap and swept, overlapping locks share one mesh and material.
hv, hf, hc, hw = [], [], [], []
BASE = (.11, .165, .29)
LIGHT = (.22, .34, .49)
CYAN = (.16, .83, .90)


def hair_vertex(p, t, across, group, fixed=False):
    shade = .35 + .65 * max(0, math.sin(across * math.pi)) ** 3
    c = [BASE[k] + (LIGHT[k] - BASE[k]) * shade for k in range(3)]
    accent = smooth(.70, .98, t) if group != 'fringe' else 0
    c = [c[k] * (1 - accent) + CYAN[k] * accent for k in range(3)]
    hv.append(p)
    hc.append(c)
    if fixed:
        hw.append([('hair-root', 1)])
    else:
        root_weight = 1 - smooth(.03, .32, t)
        tip_weight = smooth(.35, .85, t) * (1 - root_weight)
        hw.append([('hair-root', root_weight), (group + '-a', 1 - root_weight - tip_weight), (group + '-b', tip_weight)])


# Crown stops above the eyebrows, with side/back locks extending below it.
for row in range(9):
    for col in range(57):
        theta = 2 * math.pi * col / 56
        front = max(0, math.cos(theta)) ** 4
        phi = .025 + (1.43 - .58 * front) * row / 8
        hair_vertex((.122 * math.sin(phi) * math.sin(theta), .153 + .119 * math.cos(phi), -.012 + .125 * math.sin(phi) * math.cos(theta)), 0, col / 56, 'back', True)
for row in range(8):
    for col in range(56):
        a = row * 57 + col
        hf.append((a, a + 1, a + 58, a + 57))


def lock(theta0, theta1, bottom, group, phase=0):
    start = len(hv)
    rows, cols = 8, 5
    for row in range(rows):
        t = row / (rows - 1)
        for col in range(cols):
            u = col / (cols - 1)
            theta = theta0 + (theta1 - theta0) * u + .08 * math.sin(t * math.pi)
            y = .207 * (1 - t) + (bottom + .012 * math.sin(u * math.pi + phase)) * t
            radius = .106 + .036 * math.sin(t * math.pi * .83) - .009 * t * t
            radius += .002 * math.sin(u * math.pi)
            p = (radius * math.sin(theta), y, -.017 + radius * math.cos(theta))
            hair_vertex(p, t, u, group)
    for row in range(rows - 1):
        for col in range(cols - 1):
            a = start + row * cols + col
            hf.append((a, a + cols, a + cols + 1, a + 1))


for i in range(12):
    a = .66 + i * (2 * math.pi - 1.32) / 12
    b = a + (2 * math.pi - 1.32) / 12 + .025
    middle = (a + b) / 2
    group = 'left' if middle < 2.15 else 'right' if middle > 4.13 else 'back'
    lock(a, b, -.044 if group != 'back' else -.027, group, i * .7)

# Side-swept fringe: broad curved locks start at the part and sweep to the temple.
for i in range(3):
    start = len(hv)
    for row in range(9):
        t = row / 8
        for col in range(5):
            u = col / 4
            x = .049 - .164 * t + .038 * (u - .5) + .013 * i
            y = .254 - .108 * t + .014 * math.sin(t * math.pi) - .010 * i + .035 * (u - .5)
            z = .026 + .104 * math.sin(t * math.pi * .72) + .002 * i
            hair_vertex((x, y, z), t, u, 'fringe')
    for row in range(8):
        for col in range(4):
            a = start + row * 5 + col
            hf.append((a, a + 1, a + 6, a + 5))

hair = mesh('tide-hair', hv, hf, hair_mat, hc, hw)
# Give open ribbons actual thickness without retaining a live modifier in GLB.
bpy.context.view_layer.objects.active = hair
solid = hair.modifiers.new('Lock thickness', 'SOLIDIFY')
solid.thickness = .002
bpy.ops.object.modifier_apply(modifier=solid.name)

armature = bpy.data.armatures.new('TideHairRig')
rig = bpy.data.objects.new('TideHairRig', armature)
bpy.context.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig
rig.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
root_bone = armature.edit_bones.new('hair-root')
root_bone.head = xyz((0, .20, -.015))
root_bone.tail = xyz((0, .23, -.015))
anchors = {'left': (.113, .173, .013), 'right': (-.113, .173, .013), 'back': (0, .174, -.135), 'fringe': (-.025, .218, .105)}
for name, p in anchors.items():
    parent = root_bone
    for i, suffix in enumerate(('a', 'b', 'tip')):
        bone = armature.edit_bones.new(name + '-' + suffix)
        bone.head = xyz((p[0], p[1] - i * .088, p[2]))
        bone.tail = xyz((p[0], p[1] - (i + 1) * .088, p[2]))
        bone.parent = parent
        parent = bone
bpy.ops.object.mode_set(mode='OBJECT')
hair.parent = rig
mod = hair.modifiers.new('Hair skin', 'ARMATURE')
mod.object = rig

for obj in (head, hair):
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    obj.select_set(False)

head['assetVersion'] = 'tide-head-v1'
hair['hairStyle'] = 'bob'
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE / 'tide.blend'))
bpy.ops.export_scene.gltf(filepath=str(OUT / 'tide.glb'), export_format='GLB', export_animations=False, export_yup=True)
triangles = sum(len(p.vertices) - 2 for obj in (head, hair) for p in obj.data.polygons)
print('TIDE_ASSET triangles=%d glb_bytes=%d' % (triangles, (OUT / 'tide.glb').stat().st_size))
assert triangles <= 8000, triangles
