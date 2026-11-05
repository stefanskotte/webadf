import json,collections,sys
d=json.load(open(sys.argv[1]))
print('unconnected',len(d.get('unconnected_items',[])))
v=d['violations']; print(collections.Counter(x['severity']+':'+x['type'] for x in v))
show=set(sys.argv[2].split(',')) if len(sys.argv)>2 else set()
for x in v:
    if x['type'] in show: print(x['type'],[i['description'][:58] for i in x['items']])
