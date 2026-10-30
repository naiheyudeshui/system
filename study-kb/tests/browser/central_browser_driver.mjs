import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function browserDriver() {
  const executable = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
  const profile = mkdtempSync(join(tmpdir(), "central-bindings-")), port = 9700 + Math.floor(Math.random() * 100);
  const child = spawn(executable, [`--remote-debugging-port=${port}`, "--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  let endpoint;
  for (let i=0;i<60;i++) { try { endpoint=(await(await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;break; } catch { await sleep(100); } }
  const socket = new WebSocket(endpoint); await new Promise(r=>socket.addEventListener("open",r,{once:true}));
  let sessionId, id=0; const pending=new Map(),errors=[];
  const send=(method,params={})=>new Promise((resolve,reject)=>{const key=++id,timer=setTimeout(()=>reject(new Error(method+" timeout")),30000);pending.set(key,value=>{clearTimeout(timer);value.error?reject(new Error(value.error.message)):resolve(value.result);});socket.send(JSON.stringify({id:key,method,params,...(sessionId&&!method.startsWith("Target.")?{sessionId}:{})}));});
  socket.addEventListener("message",({data})=>{const value=JSON.parse(data);if(value.id){pending.get(value.id)?.(value);pending.delete(value.id);}if(value.method==="Runtime.exceptionThrown")errors.push(value.params.exceptionDetails.exception?.description||value.params.exceptionDetails.text);if(value.method==="Page.javascriptDialogOpening")send("Page.handleJavaScriptDialog",{accept:true});});
  const target=await send("Target.createTarget",{url:"about:blank"});({sessionId}=await send("Target.attachToTarget",{targetId:target.targetId,flatten:true}));
  await send("Runtime.enable");await send("Page.enable");
  const evaluate=async expression=>{const value=await send("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true});if(value.exceptionDetails)throw new Error(value.exceptionDetails.exception?.description||value.exceptionDetails.text);return value.result.value;};
  const waitFor=async expression=>{for(let i=0;i<200;i++){if(await evaluate(expression).catch(()=>false))return;await sleep(100);}throw new Error("Timed out: "+expression+"\n"+await evaluate("document.body.innerText.slice(-3000)"));};
  return {send,evaluate,waitFor,errors,async close(){socket.close();child.kill();await sleep(300);try{rmSync(profile,{recursive:true,force:true});}catch{}}};
}
