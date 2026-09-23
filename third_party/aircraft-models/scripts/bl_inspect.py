import bpy,sys,json,os
argv=sys.argv[sys.argv.index("--")+1:]
bpy.ops.wm.open_mainfile(filepath=argv[0])
print("IMGPATHS "+json.dumps([(i.name,i.filepath,i.has_data) for i in bpy.data.images if i.name!='Render Result']))
names=[o.name for o in bpy.context.scene.objects if o.type=='MESH']
print("OBJS "+json.dumps(names[:60]))
print("NOBJ "+str(len(names)))
