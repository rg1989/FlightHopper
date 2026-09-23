import bpy,sys,os,json,mathutils
argv=sys.argv[sys.argv.index("--")+1:]
src,outdir,ratio=argv[0],argv[1],float(argv[2])
name=os.path.splitext(os.path.basename(src))[0]
bpy.ops.wm.open_mainfile(filepath=src)
for w in bpy.data.window_managers[0].windows:
    if w.scene.objects: bpy.context.window.scene=w.scene; break
try:
    if bpy.context.object and bpy.context.object.mode!='OBJECT': bpy.ops.object.mode_set(mode='OBJECT')
except Exception: pass
ms=[o for o in bpy.context.scene.objects if o.type=='MESH']
if ms and not bpy.context.view_layer.objects.active:
    bpy.context.view_layer.objects.active=ms[0]
if not ms:
    print("JOIN "+json.dumps({"name":name,"error":"no mesh"})); sys.exit(0)
bpy.ops.object.select_all(action='DESELECT')
for o in ms: o.select_set(True)
bpy.context.view_layer.objects.active=ms[0]
bpy.ops.object.join()
obj=bpy.context.view_layer.objects.active
bpy.ops.object.transform_apply(location=True,rotation=True,scale=True)
m=obj.modifiers.new("d","DECIMATE"); m.ratio=ratio
bpy.ops.object.modifier_apply(modifier=m.name)
obj.data.materials.clear()
mat=bpy.data.materials.new("hull"); mat.use_nodes=True
mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value=(0.85,0.87,0.9,1)
obj.data.calc_loop_triangles(); tris=len(obj.data.loop_triangles)
obj.data.materials.append(mat)
mn=[1e9]*3;mx=[-1e9]*3
for c in obj.bound_box:
    v=obj.matrix_world@mathutils.Vector(c)
    for i in range(3): mn[i]=min(mn[i],v[i]);mx[i]=max(mx[i],v[i])
os.makedirs(outdir,exist_ok=True)
p=os.path.join(outdir,name+".single.glb")
bpy.ops.export_scene.gltf(filepath=p,export_format='GLB',export_texcoords=False,
  export_draco_mesh_compression_enable=False)
print("JOIN "+json.dumps({"name":name,"tris":tris,"kb":round(os.path.getsize(p)/1024),
 "dims":[round(mx[i]-mn[i],2) for i in range(3)]}))
