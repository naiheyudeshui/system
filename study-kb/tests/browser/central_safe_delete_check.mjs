// Reversible fixture-only authored data, real UI conflict/unbind/delete flow.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserDriver } from "./central_browser_driver.mjs";
const [url,artifacts]=process.argv.slice(2);assert.equal(new URL(url).hostname,"127.0.0.1");assert.notEqual(new URL(url).port,"8033");
const driver=await browserDriver(),{send,evaluate,waitFor,errors}=driver,checks=[];
const pane=id=>`.wb-plugin-instance[data-plugin-id="${id}"]`;
const review="study.review-table",tree="study.node-tree";
let table;
try {
  await send("Emulation.setDeviceMetricsOverride",{width:2400,height:1800,deviceScaleFactor:1,mobile:false});await send("Page.navigate",{url});
  await waitFor("document.querySelector('#load-state')?.hidden===true");
  const open=async id=>{await evaluate("document.querySelector('.app-launcher-button').click()");await waitFor(`!!document.querySelector('.wb-launcher-results button[data-application-id="${id}"][data-action="activate"]')`);await evaluate(`document.querySelector('.wb-launcher-results button[data-application-id="${id}"][data-action="activate"]').click()`);};
  const click=async(id,text)=>{const expr=`[...document.querySelectorAll('${pane(id)} button')].find(b=>b.textContent.trim().endsWith(${JSON.stringify(text)}))`;await waitFor(`!!(${expr})&&!(${expr}).disabled`);await evaluate(`(${expr}).click()`);};
  const fill=async(id,label,value)=>evaluate(`(()=>{const e=document.querySelector('${pane(id)} [aria-label="${label}"]');if(!e)throw new Error('Missing '+${JSON.stringify(label)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const modal=async text=>{await waitFor("!!document.querySelector('.wb-confirm-dialog[open]')");await evaluate(`(()=>{const b=[...document.querySelectorAll('.wb-confirm-dialog[open] button')].find(b=>b.textContent===${JSON.stringify(text)});if(!b)throw new Error('Missing dialog action');b.click()})()`);};
  const manager=async(id,label)=>{await open(id);await waitFor(`document.querySelector('${pane(id)} [aria-label="${label}"]')?.disabled===false`);await evaluate(`document.querySelector('${pane(id)} [aria-label="${label}"]').click()`);await click(id,"新增方案");await waitFor(`document.querySelector('${pane(id)} .wb-config-editor')?.dataset.ready==='true'`);};
  await manager(review,"方案设置");await fill(review,"方案名称","验收共享复习内容");await fill(review,"数据集名称","验收共享内容");await fill(review,"问题 · 第1行","验收根节点");await fill(review,"答案 · 第1行","仅限隔离库的测试内容");
  await click(review,"保存");await modal("确认保存");await waitFor(`document.querySelector('${pane(review)}')?.textContent.includes('已保存；')`);
  const created=await evaluate(`(async()=>{const id=document.querySelector('${pane(review)} [aria-label="管理已有方案"]').value;const p=await(await fetch('/api/plugin/configs?plugin_id=study.review-table&module_id=reviews')).json();return p.configs.find(c=>c.id===id)})()`);
  table=created.settings.dataSource.table;assert.match(table,/^wbp_study_review_table_验收共享内容_/);
  checks.push({scenario:"create-readable-owned-common-content-table-through-review-editor",pass:true});
  await manager(tree,"树方案设置");await fill(tree,"方案名称","验收共享树视图");await evaluate(`document.querySelector('${pane(tree)} [data-mode="existing"]').click()`);await waitFor(`document.querySelector('${pane(tree)} [aria-label="选择已有表或视图"]')?.options.length>1`);await fill(tree,"选择已有表或视图",table);await click(tree,"校验 / 预览");await waitFor(`document.querySelector('${pane(tree)} .wb-config-result')?.hidden===false`);await click(tree,"保存");await waitFor(`document.querySelector('${pane(tree)}')?.textContent.includes('已保存；')`);
  const reused=await evaluate(`(async()=>{const id=document.querySelector('${pane(tree)} [aria-label="管理已有方案"]').value;const p=await(await fetch('/api/plugin/configs?plugin_id=study.node-tree&module_id=trees')).json();const c=p.configs.find(c=>c.id===id);const t=await(await fetch('/api/study/tree?config_id='+c.id)).json();return{source:c.settings.dataSource.name,count:t.node_count};})()`);assert.equal(reused.source,table);assert.equal(reused.count,1);
  checks.push({scenario:"tree-and-review-use-one-authored-content-table",pass:true});
  await click(review,"删除基础表及全部数据");await waitFor("document.querySelector('.wb-confirm-dialog[open]')?.textContent.includes('基础表正在使用，无法删除')");
  assert.ok(await evaluate("document.querySelector('.wb-confirm-dialog[open]').textContent.includes('验收共享树视图')"));
  assert.equal((await(await fetch(`${url}/api/object?name=${encodeURIComponent(table)}&limit=1`)).json()).rows.length,1);
  const shot=await send("Page.captureScreenshot",{format:"png"});writeFileSync(join(artifacts,"central-delete-conflict.png"),Buffer.from(shot.data,"base64"));
  await modal("知道了");await evaluate("document.querySelectorAll('.wb-help-dialog[open]').forEach(d=>d.close())");
  checks.push({scenario:"delete-conflict-shows-specific-tree-consumer-and-preserves-row",pass:true});
  await click(tree,"删除");await modal("删除");await waitFor(`document.querySelector('${pane(tree)}')?.textContent.includes('方案已删除。')`);
  await click(review,"删除基础表及全部数据");await waitFor("document.querySelector('.wb-confirm-dialog[open]')?.textContent.includes('确认删除全部数据')");await modal("确认删除全部数据");await waitFor(`document.querySelector('${pane(review)}')?.textContent.includes('基础表及当前方案已删除。')`);
  const schema=await(await fetch(`${url}/api/schema`)).json();assert.ok(!schema.objects.some(o=>o.name===table));checks.push({scenario:"unbind-tree-plan-then-confirm-owner-table-deletion",pass:true});
  assert.deepEqual(errors,[]);
} finally {
  writeFileSync(join(artifacts,"central-safe-delete-ui.json"),JSON.stringify({checks,browserErrors:errors,table},null,2));await driver.close();
}
console.log(JSON.stringify({checks,browserErrors:errors,table},null,2));
