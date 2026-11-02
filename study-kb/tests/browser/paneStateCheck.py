"""Real browser pane lifecycle checks with in-memory APIs; never uses study data."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[3]

class Sources(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, '.mjs':'text/javascript'}
    def translate_path(self, path):
        parsed = urlparse(path).path
        if parsed.startswith('/3dworkbench/'):
            return str(ROOT/'3dStudio/3dworkbench/web'/parsed[len('/3dworkbench/'):])
        return super().translate_path(path)
    def log_message(self, *_):
        pass

PAGE = '''<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/study-kb/web/styles.css">
<link rel="stylesheet" href="/3dworkbench/workbench.css">
<link rel="stylesheet" href="/3dworkbench/pluginWorkspace.css">
<header class="topbar"><div class="topbar-primary"><div class="toolbar"><button id="refresh">Refresh</button></div></div></header>
<main id="workbench" style="position:absolute;top:90px;left:0;width:1400px;height:680px"></main>'''

FIXTURE = r'''async () => {
 const {createPluginWorkspace}=await import('/3dworkbench/pluginWorkspace.mjs');
 const {renderNodeTreePanel}=await import('/study-kb/web/studyTreeWorkspace.mjs');
 const {renderReviewTablePanel}=await import('/study-kb/web/studySqlReview.mjs');
 const leaf=(id)=>({kind:'leaf',id:'leaf-'+id,pluginId:id,instanceId:id+'#test'});
 let layout={schema:'workbench.layout.bsp/v1',revision:1,tree:{kind:'split',id:'split',orientation:'vertical',ratio:.5,first:leaf('study.node-tree'),second:leaf('study.review-table')}};
 const f={reads:[],writes:[],layoutPosts:0};window.fixture=f;
 const tree={roots:[{id:'root',title:'Root',data:{content_md:'Retained node detail'},children:[]}],rows:[{node_id:'root',title:'Root',content_md:'Retained node detail'}],columns:['node_id','title','content_md'],detail_fields:[{column:'content_md',format:'markdown'}],validation:{kind:'tree',root_count:1,max_depth:1,warnings:[]},scopes:[]};
 const api=async path=>{if(path==='/api/plugin/layout')return structuredClone(layout);f.reads.push(path);if(path.includes('/configs?'))return {configs:[],definition:{}};if(path.includes('/review/session/'))return {session_id:'in-memory',config:{view:'test'},completed:0,total:2,position:0,card:{front:'Retained question',back:'Retained answer'}};return tree;};
 const postApi=async(path,payload)=>{if(path==='/api/plugin/layout'){f.layoutPosts++;layout={...payload,revision:payload.revision+1};return structuredClone(layout);}f.writes.push(path);return {};};
 localStorage.setItem('study.review.session.v1',JSON.stringify('in-memory'));
 f.host=createPluginWorkspace({api,postApi,container:document.querySelector('#workbench'),topbar:document.querySelector('.topbar'),renderers:{'study.node-tree':renderNodeTreePanel,'study.review-table':renderReviewTablePanel}});
 const plugins=await Promise.all(['study.node-tree','study.review-table'].map(async id=>(await fetch('/study-kb/plugins/'+id+'/plugin.json')).json()));
 await f.host.update(plugins);
 return true;
}'''

def run(output):
    output.mkdir(parents=True,exist_ok=False)
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(Sources,directory=str(ROOT)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    scenarios=[]
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(channel='msedge',headless=True)
            try:
                for touch in (False,True):
                    context=browser.new_context(viewport={'width':1440,'height':850},has_touch=touch,is_mobile=touch)
                    page=context.new_page();errors=[]
                    page.on('pageerror',lambda error:errors.append(str(error)))
                    page.goto(f'http://127.0.0.1:{server.server_port}/');page.set_content(PAGE)
                    page.evaluate(FIXTURE)
                    tree=page.locator('[data-plugin-id="study.node-tree"].wb-bsp-leaf')
                    review=page.locator('[data-plugin-id="study.review-table"].wb-bsp-leaf')
                    tree.get_by_role('button',name='预览并筛选',exact=True).click()
                    tree.get_by_role('button',name='打开树图',exact=True).click()
                    tree.locator('.wb-tree-graph-node').focus();page.keyboard.press('Space')
                    page.locator('.wb-tree-radial-item[aria-label="节点详情"]').focus();page.keyboard.press('Enter')
                    review.get_by_role('button',name='继续上次复习',exact=True).click()
                    review.get_by_role('button',name='显示答案',exact=True).click()
                    page.evaluate('''()=>{fixture.detail=document.querySelector('.wb-tree-detail');fixture.card=document.querySelector('.study-learning-card');fixture.readCount=fixture.reads.length;}''')
                    for width in [650,1400,850,393,1400]:
                        page.evaluate('w=>document.querySelector("#workbench").style.width=w+"px"',width)
                        page.wait_for_timeout(120)
                        assert page.evaluate('''()=>fixture.detail===document.querySelector('.wb-tree-detail')&&!fixture.detail.hidden&&fixture.card===document.querySelector('.study-learning-card')&&!fixture.card.hidden&&!fixture.card.querySelector('.study-review-ratings').hidden&&fixture.readCount===fixture.reads.length''')
                        scenarios.append({'touch':touch,'width':width,'treeDetailAndRevealedCardRetained':True})
                    handle=tree.locator('.wb-bsp-move-handle');box=handle.bounding_box();pane=tree.bounding_box()
                    content=tree.locator('.wb-plugin-instance').bounding_box()
                    assert abs(box['x']+box['width']/2-pane['x']-pane['width']/2)<1
                    assert abs(content['y']-box['y']-12)<1
                    assert abs(box['width']-80)<1 and abs(box['height']-24)<1
                    start={'x':box['x']+box['width']/2,'y':box['y']+box['height']/2}
                    cdp=context.new_cdp_session(page)
                    if touch:
                        cdp.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{**start,'id':1}]})
                    else:
                        page.mouse.move(**start);page.mouse.down()
                    assert tree.evaluate("el=>el.classList.contains('is-move-pressed')&&getComputedStyle(el,'::after').content!=='none'")
                    page.screenshot(path=str(output/f'{"touch" if touch else "mouse"}-pressed.png'))
                    if touch:cdp.send('Input.dispatchTouchEvent',{'type':'touchCancel','touchPoints':[]})
                    else:page.mouse.up()
                    page.wait_for_timeout(100)
                    assert not tree.evaluate("el=>el.classList.contains('is-move-pressed')")
                    scenarios.append({'touch':touch,'centeredHandleReservedSpaceAndPressFeedback':True})
                    if touch:
                        cdp.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{**start,'id':1}]});page.wait_for_timeout(400)
                    else:
                        page.mouse.move(**start);page.mouse.down();page.mouse.move(start['x']+10,start['y']+12,steps=3)
                    target=review.bounding_box();point={'x':target['x']+target['width']-4,'y':target['y']+target['height']/2}
                    if touch:cdp.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{**point,'id':1}]})
                    else:page.mouse.move(**point,steps=12)
                    marker=page.locator('.wb-bsp-result-preview');marker.wait_for(state='visible');page.wait_for_timeout(200)
                    if touch:cdp.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
                    else:page.mouse.up()
                    page.wait_for_function('fixture.layoutPosts===1')
                    assert page.evaluate('''()=>fixture.detail===document.querySelector('.wb-tree-detail')&&!fixture.detail.hidden&&fixture.card===document.querySelector('.study-learning-card')&&!fixture.card.hidden&&fixture.reads.length===fixture.readCount''')
                    assert page.locator('.is-move-pressed').count()==0
                    assert not errors,errors
                    assert page.evaluate("fixture.writes.every(path=>path.includes('/unit-lease/'))")
                    scenarios.append({'touch':touch,'nativeDragRetainsBothPluginPages':True})
                    page.screenshot(path=str(output/f'{"touch" if touch else "mouse"}-final.png'))
                    page.evaluate('fixture.host.dispose()');context.close()
            finally:browser.close()
    finally:server.shutdown();server.server_close()
    report={'passed':True,'scenarios':scenarios}
    (output/'verification.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'passed':True,'scenarioCount':len(scenarios),'report':str(output/'verification.json')}))

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True)
    run(parser.parse_args().output)
