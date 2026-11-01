"""Exercise real desktop UI/IPC using an existing isolated tauri-driver session.
Usage: python3 scripts/smoke-desktop.py /tmp/session.json
The session must use a disposable LUPINO_DATA_DIR; this script imports test data.
"""
import base64,json,sys,time,urllib.request,urllib.error,os
from pathlib import Path
session=json.load(open(sys.argv[1]))['value']['sessionId']
base=os.environ.get('LUPINO_WEBDRIVER_URL','http://127.0.0.1:4444')+'/session/'+session

def call(path,data=None):
    request=urllib.request.Request(base+path,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json'})
    try:return json.load(urllib.request.urlopen(request,timeout=30))['value']
    except urllib.error.HTTPError as error:raise RuntimeError(error.read().decode()) from error

def js(script,args=None):return call('/execute/sync',{'script':script,'args':args or []})
def wait(script,timeout=15):
    start=time.monotonic()
    while time.monotonic()-start<timeout:
        result=js(script)
        if result:return result
        time.sleep(.1)
    raise AssertionError('Timed out: '+script)
def click(label):
    js("const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===arguments[0]||b.querySelector('span')?.textContent.trim()===arguments[0]);if(!b)throw Error('No button '+arguments[0]);b.click();",[label])
def fill(selector,value):
    js("const e=document.querySelector(arguments[0]);if(!e)throw Error('No input '+arguments[0]);e.value=arguments[1];e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));",[selector,value])

def screenshot(name):
    Path('artifacts').mkdir(exist_ok=True);Path('artifacts/'+name+'.png').write_bytes(base64.b64decode(call('/screenshot')))

wait("return !!document.querySelector('nav')")
click('Biblioteca');wait("return !!document.querySelector('.library-page')")
click('Agregar texto');wait("return !!document.querySelector('.modal textarea')")
fill('input[placeholder="Ej. Álgebra"]','Álgebra de prueba')
fill('input[placeholder="Mensaje sobre el parcial"]','Consigna de prueba')
fill('.modal textarea','El parcial de matrices es el 12/11/2026 a las 18:30. Incluir determinantes y bases.')
click('Guardar en biblioteca');wait("return !document.querySelector('.modal') && !!document.querySelector('.source-row')")
fill('input[aria-label="Buscar en el material"]','determinantes');click('Buscar');wait("return !!document.querySelector('.search-result')")
js("document.querySelector('.search-result').click()")
wait("return document.querySelector('.source-panel')?.textContent.includes('determinantes')")
screenshot('native-source')
js('document.querySelector(\'button[aria-label="Cerrar fuente"]\').click()')
click('Calendario');click('Mes');wait("return !!document.querySelector('.calendar-event')")
js("[...document.querySelectorAll('.calendar-event')].find(e=>e.textContent.includes('Álgebra de prueba')).click()")
wait("return !!document.querySelector('.modal')")
click('Corregir');wait("return !!document.querySelector('input[type=date]')")
fill('input[type=date]','2026-11-13');click('Guardar fecha')
wait("return !document.querySelector('.modal') && [...document.querySelectorAll('.calendar-event')].find(e=>e.textContent.includes('Álgebra de prueba'))?.parentElement.textContent.trim().startsWith('13')")
screenshot('native-calendar')
click('Nuevo chat');wait("return !!document.querySelector('.composer')")
fill('textarea[aria-label="Tu pregunta"]','¿Qué temas entran en el parcial?')
assert js('return document.querySelector(\'button[aria-label="Enviar pregunta"]\').disabled')
assert js('return document.querySelector(\'select[aria-label="Modelo de IA"]\').disabled')
click('Conectar');wait("return !!document.querySelector('.connections-page')")
screenshot('native-chat-disconnected')
print('PASS: native UI import → Rust/SQLite → search → source → date correction → explicit account/model gate.')
