import bpy,sys,os,json,mathutils
argv=sys.argv[sys.argv.index("--")+1:]
src,outdir,ratio=argv[0],argv[1],float(argv[2])
name=os.path.splitext(os.path.basename(src))[0].replace('.web','')
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
ms=[o for o in bpy.context.scene.objects if o.type=='MESH']
# join everything
bpy.ops.object.select_all(action='DESELECT')
for o in ms: o.select_set(True)
bpy.context.view_layer.objects.active=ms[0]
bpy.ops.object.join()
obj=bpy.context.view_layer.objects.active
bpy.ops.object.transform_apply(location=True,rotation=True,scale=True)
# decimate
m=obj.modifiers.new("d","DECIMATE"); m.ratio=ratio
bpy.ops.object.modifier_apply(modifier=m.name)
# strip to one plain material (matches existing air3d renderer: per-instance colour)
obj.data.materials.clear()
mat=bpy.data.materials.new("hull"); mat.use_nodes=True
bsdf=mat.node_tree.nodes.get("Principled BSDF")
bsdf.inputs["Base Color"].default_value=(0.85,0.87,0.9,1)
bsdf.inputs["Roughness"].default_value=0.45
obj.data.materials.append(mat)
obj.data.calc_loop_triangles(); tris=len(obj.data.loop_triangles)
mn=[1e9]*3;mx=[-1e9]*3
for c in obj.bound_box:
    v=obj.matrix_world@mathutils.Vector(c)
    for i in range(3): mn[i]=min(mn[i],v[i]);mx[i]=max(mx[i],v[i])
os.makedirs(outdir,exist_ok=True)
p=os.path.join(outdir,name+".single.glb")
bpy.ops.export_scene.gltf(filepath=p,export_format='GLB',export_materials='EXPORT',
  export_texcoords=False,export_normals=True,export_draco_mesh_compression_enable=False)
print("JOIN "+json.dumps({"name":name,"tris":tris,"kb":round(os.path.getsize(p)/1024),
 "dims":[round(mx[i]-mn[i],2) for i in range(3)],"ratio":ratio}))
