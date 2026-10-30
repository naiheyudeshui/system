// Actual installed-plugin controls over the disposable imported-main fixture.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserDriver, sleep } from "./central_browser_driver.mjs";
const [url,artifacts]=process.argv.slice(2);
assert.equal(new URL(url).hostname,"127.0.0.1");assert.notEqual(new URL(url).port,"8033");
const driver=await browserDriver(),{send,evaluate,waitFor,errors}=driver,checks=[];
const pane=id=>`.wb-plugin-instance[data-plugin-id="${id}"]`;
try {
  await send("Emulation.setDeviceMetricsOverride",{width:2400,height:1800,deviceScaleFactor:1,mobile:false});
  await send("Page.navigate",{url});
  await waitFor("document.querySelector('#load-state')?.hidden===true");
  const open=async id=>{
    await evaluate("document.querySelector('.app-launcher-button').click()");
    await waitFor(`!!document.querySelector('.wb-launcher-results button[data-application-id="${id}"][data-action="activate"]')`);
    await evaluate(`document.querySelector('.wb-launcher-results button[data-application-id="${id}"][data-action="activate"]').click()`);
    await waitFor(`!!document.querySelector('${pane(id)} .wb-plugin-content')`);
  };
  const click=async(id,text)=>{await waitFor(`(()=>{const p=document.querySelector('${pane(id)}'),b=[...p.querySelectorAll('button')].find(b=>b.textContent.trim().endsWith(${JSON.stringify(text)}));return b&&!b.disabled})()`);return evaluate(`(()=>{const p=document.querySelector('${pane(id)}'),b=[...p.querySelectorAll('button')].find(b=>b.textContent.trim().endsWith(${JSON.stringify(text)}));b.click()})()`);};
  const input=async(id,label,value)=>evaluate(`(()=>{const e=document.querySelector('${pane(id)} [aria-label="${label}"]');if(!e)throw new Error('Missing '+${JSON.stringify(label)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const bind=async(id,settingLabel,name,source)=>{
    await open(id);await waitFor(`document.querySelector('${pane(id)} [aria-label="${settingLabel}"]')?.disabled===false`);
    await evaluate(`document.querySelector('${pane(id)} [aria-label="${settingLabel}"]').click()`);await click(id,"新增方案");
    await waitFor(`!!document.querySelector('${pane(id)} [aria-label="方案名称"]')`);
    await waitFor(`document.querySelector('${pane(id)} .wb-config-editor')?.dataset.ready==='true'`);
    await input(id,"方案名称",name);
    await evaluate(`document.querySelector('${pane(id)} [data-mode="existing"]').click()`);
    await waitFor(`document.querySelector('${pane(id)} [aria-label="选择已有表或视图"]')?.options.length>1`);
    await input(id,"选择已有表或视图",source);
    if(id==="study.review-table") {
      await input(id,"映射卡片 ID","card_id");await input(id,"映射问题","front");await input(id,"映射答案","back");
      await input(id,"映射章节 ID（可选）","node_id");
    }
    await click(id,"校验 / 预览");
    await waitFor(`document.querySelector('${pane(id)} .wb-config-result')?.hidden===false`);
    await click(id,"保存");
    await waitFor(`document.querySelector('${pane(id)}')?.textContent.includes('已保存；')`);
    checks.push({scenario:"bind-existing-source-through-plugin-editor",pluginId:id,source,pass:true});
  };
  await bind("study.node-tree","树方案设置","验收：main 统一知识树","study_knowledge_item");
  await bind("study.review-table","方案设置","验收：main 已有复习卡","v_study_node_cards");
  await open("study.metrics");await waitFor(`document.querySelector('${pane('study.metrics')}')?.textContent.includes('活跃卡片')`);
  checks.push({scenario:"installed-metrics-read-imported-data",pass:true});
  await open("official.sqlite-triggers");
  await waitFor(`!!document.querySelector('${pane('official.sqlite-triggers')} [aria-label="管理触发器"]')`);
  const triggerExists=await evaluate(`document.querySelector('${pane('official.sqlite-triggers')}')?.textContent.includes('central_acceptance_imported')`);
  if(!triggerExists){
  await evaluate(`document.querySelector('${pane('official.sqlite-triggers')} [aria-label="管理触发器"]').click()`);
  await click("official.sqlite-triggers","+ 新建触发器");await waitFor("!!document.querySelector('.trigger-dialog[open]')");
  await evaluate("document.querySelector('.trigger-dialog[open] textarea[name=sql]').value='CREATE TRIGGER central_acceptance_imported AFTER UPDATE ON study_knowledge_item BEGIN SELECT NEW.id; END';document.querySelector('.trigger-dialog[open] [data-preview]').click()");
  await waitFor("document.querySelector('.trigger-dialog[open] [data-apply]')?.disabled===false");
  await evaluate("document.querySelector('.trigger-dialog[open] [data-apply]').click()");
  await waitFor(`document.querySelector('${pane('official.sqlite-triggers')}')?.textContent.includes('central_acceptance_imported')`);
  }
  checks.push({scenario:"installed-sql-trigger-binds-imported-table",pass:true});
  await open("study.table-grid");await open("official.table-print");await open("study.table-catalog");
  await waitFor(`!!document.querySelector('${pane('study.table-catalog')} [data-item-id="study_knowledge_item"]')`);
  await evaluate(`document.querySelector('${pane('study.table-catalog')} [data-item-id="study_knowledge_item"]').click()`);
  await waitFor(`document.querySelector('${pane('study.table-grid')}')?.textContent.includes('study_knowledge_item')`);
  await waitFor(`document.querySelector('${pane('official.table-print')}')?.textContent.includes('study_knowledge_item')`);
  checks.push({scenario:"catalog-click-binds-grid-and-print-to-imported-table",pass:true});
  await sleep(150);
  const shot=await send("Page.captureScreenshot",{format:"png"});writeFileSync(join(artifacts,"central-existing-bindings.png"),Buffer.from(shot.data,"base64"));
  assert.deepEqual(errors,[]);
} finally {
  const shot=await send("Page.captureScreenshot",{format:"png"}).catch(()=>null);if(shot)writeFileSync(join(artifacts,"central-existing-bindings-last.png"),Buffer.from(shot.data,"base64"));
  writeFileSync(join(artifacts,"central-existing-bindings-ui.json"),JSON.stringify({checks,browserErrors:errors},null,2));await driver.close();
}
console.log(JSON.stringify({checks,browserErrors:errors},null,2));
