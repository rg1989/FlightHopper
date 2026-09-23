import bpy, sys, os, json
argv = sys.argv[sys.argv.index("--")+1:]
path = argv[0]
bpy.ops.wm.read_factory_settings(use_empty=True)
try:
    bpy.ops.import_scene.gltf(filepath=path)
except Exception as e:
    print(json.dumps({"file":os.path.basename(path),"error":str(e)})); sys.exit(0)
meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']
tris=0
for o in meshes:
    m=o.data
    m.calc_loop_triangles()
    tris+=len(m.loop_triangles)
mats={m.name for o in meshes for m in o.data.materials if m}
imgs={i.name:(i.size[0],i.size[1]) for i in bpy.data.images if i.name!='Render Result'}
# bbox in world space
import mathutils
mn=[1e9]*3; mx=[-1e9]*3
for o in meshes:
    for c in o.bound_box:
        w=o.matrix_world @ mathutils.Vector(c)
        for i in range(3):
            mn[i]=min(mn[i],w[i]); mx[i]=max(mx[i],w[i])
dim=[round(mx[i]-mn[i],2) for i in range(3)]
print("PROBE "+json.dumps({"file":os.path.basename(path),"objects":len(meshes),"tris":tris,
  "materials":sorted(mats),"images":imgs,"dims_xyz_m":dim}))
