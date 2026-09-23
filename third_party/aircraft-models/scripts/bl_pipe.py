import bpy,sys,os,json,mathutils
argv=sys.argv[sys.argv.index("--")+1:]
src,outdir=argv
name=os.path.splitext(os.path.basename(src))[0]
bpy.ops.wm.read_factory_settings(use_empty=True)
try: bpy.ops.import_scene.gltf(filepath=src)
except Exception as e:
    print("PIPE "+json.dumps({"name":name,"error":str(e)[:120]})); sys.exit(0)
def st():
    ms=[o for o in bpy.context.scene.objects if o.type=='MESH']; t=0
    for o in ms: o.data.calc_loop_triangles(); t+=len(o.data.loop_triangles)
    return len(ms),t
n0,t0=st()
imgs={i.name:(i.size[0],i.size[1]) for i in bpy.data.images if i.name!='Render Result'}
mn=[1e9]*3;mx=[-1e9]*3
for o in bpy.context.scene.objects:
    if o.type!='MESH': continue
    for c in o.bound_box:
        v=o.matrix_world@mathutils.Vector(c)
        for i in range(3): mn[i]=min(mn[i],v[i]);mx[i]=max(mx[i],v[i])
dims=[round(mx[i]-mn[i],2) for i in range(3)]
for o in [o for o in bpy.context.scene.objects if o.type=='MESH']:
    bpy.context.view_layer.objects.active=o
    m=o.modifiers.new("d","DECIMATE"); m.ratio=0.15
    try: bpy.ops.object.modifier_apply(modifier=m.name)
    except Exception: pass
for i in bpy.data.images:
    if i.size[0]>512 and i.size[1]>512: i.scale(512,512)
n1,t1=st()
os.makedirs(outdir,exist_ok=True)
p=os.path.join(outdir,name+".web.glb")
bpy.ops.export_scene.gltf(filepath=p,export_format='GLB',export_image_format='WEBP',export_image_quality=70,
                          export_draco_mesh_compression_enable=True,export_draco_mesh_compression_level=7)
print("PIPE "+json.dumps({"name":name,"objs":n0,"tris":t0,"tris_lod":t1,"imgs":imgs,"dims":dims,
  "src_kb":round(os.path.getsize(src)/1024),"web_kb":round(os.path.getsize(p)/1024)}))
