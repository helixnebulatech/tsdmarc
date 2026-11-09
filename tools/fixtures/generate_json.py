"""Differential corpus for pyJsonLoads(): Python json.loads() results or errors.

Run: .venv/bin/python -I tools/fixtures/generate_json.py
"""
import json, random
random.seed(7)
base=['{"organization-name":"x","date-range":{"start-datetime":"2024","end-datetime":"2025"},"policies":[{"a":[1,2.5,-3e2,true,false,null]}]}',
      '[1, "a\\u00e9\\ud83d\\ude00", {"k": "v\\n"}, [], {}]', '{"a": NaN, "b": [Infinity, -Infinity]}', ' \n\t{"x":"\\\\\\"/\\b\\f\\r\\t"} \r\n']
toks=list('{}[]:,"\\ -.0123456789eEaNIuntrfl\n\t')+['true','false','null','\\u12','\\ud800','\\udc00','"x"','NaN','Infinity','\x01','\ufeff','é']
cases=['','  ','x','{','[','"','{"a":1,}','[1,]','{"a" 1}','{} x','1.','.5','-','01','1e','1e5','-0','"\\ud800\\u0041"','"\\ud800\\udc00"']
for b in base:
    cases.append(b)
    for _ in range(300):
        s=list(b)
        for _ in range(random.randint(1,3)):
            op=random.random(); i=random.randrange(len(s)+1)
            if op<0.4 and s: del s[min(i,len(s)-1)]
            elif op<0.8: s.insert(i, random.choice(toks))
            else: s=s[:i]
        cases.append(''.join(s))
for _ in range(500):
    cases.append(''.join(random.choice(toks) for _ in range(random.randint(1,12))))
out=[]
def norm(v):
    return json.dumps(v, allow_nan=True, sort_keys=False, ensure_ascii=True)
for c in cases:
    try: out.append([c,'OK',norm(json.loads(c))])
    except json.JSONDecodeError as e: out.append([c,'ERR',str(e)])
    except Exception as e: out.append([c,'EXC',type(e).__name__+': '+str(e)])
import pathlib
target = pathlib.Path(__file__).resolve().parents[2] / 'packages/tsdmarc/src/internal/__fixtures__/py-json-loads.json'
target.write_text(json.dumps(out, ensure_ascii=True))
print(len(out))
