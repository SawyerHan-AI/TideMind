import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseOperatorArgs, isolatedOperatorEnv, validateNoAuthPlan, fileObservations, reviewedNoAuthCommand, validateIsolatedProfilePaths, validateLegacySnippet, historicalDesktopRecipe, createHistoricalCodexManagedBaseline, assertNoAuthSchedulerGuard } from '../../scripts/run-signed-host-no-auth.mjs'
const args = ['--candidate-app','/task/Tide Mind.app','--candidate-bundle-sha256','a'.repeat(64),'--source-commit','b'.repeat(40),'--workspace','/task/profile','--capture-nonce','test-operator-nonce','--output-dir','/task/raw','--catalog-id','codex-desktop']
test('candidate binding is mandatory, duplicate and unknown args rejected', () => { assert.equal(parseOperatorArgs(args).mode,'lifecycle'); assert.throws(()=>parseOperatorArgs(args.slice(0,-1))); assert.throws(()=>parseOperatorArgs([...args,'--source-commit','c'.repeat(40)])); assert.throws(()=>parseOperatorArgs([...args,'--eval','code'])) })
test('old-candidate self check cannot execute lifecycle', () => { assert.throws(()=>parseOperatorArgs([...args,'--capture-purpose','operator_self_check_old_candidate'])); assert.equal(parseOperatorArgs([...args,'--mode','snapshot-only','--capture-purpose','operator_self_check_old_candidate'])['capture-purpose'],'operator_self_check_old_candidate') })
test('subprocess environment drops auth, provider, audit and runtime injection', () => { const env=isolatedOperatorEnv('/task',{GH_TOKEN:'secret',GITHUB_TOKEN:'secret',ANTHROPIC_API_KEY:'secret',CODEX_HOME:'/daily',NODE_OPTIONS:'--require evil',TIDEMIND_UI_AUDIT:'1',PATH:'/evil',LANG:'en_US.UTF-8'}); assert.equal(env.HOME,'/task/home'); assert.equal(env.LANG,'en_US.UTF-8'); assert.equal(Object.values(env).includes('secret'),false); for(const key of ['GH_TOKEN','GITHUB_TOKEN','ANTHROPIC_API_KEY','CODEX_HOME','NODE_OPTIONS','TIDEMIND_UI_AUDIT']) assert.equal(env[key],undefined) })
const fixture = fn => { const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'signed-operator-test-')));try{fn(home)}finally{fs.rmSync(home,{recursive:true,force:true})} }
const plan = target => ({planHash:'a'.repeat(64),installations:[{targets:[{targetLabel:'~/config.json',scope:'user',risk:'low',action:'create',commandCategory:'file_write',...target}]}]})
test('file-only plan retains exact scoped path',()=>fixture(home=>assert.deepEqual(validateNoAuthPlan(plan({}),home),[path.join(home,'config.json')])) )
test('absolute, traversal and escaped symbolic targets rejected',()=>fixture(home=>{assert.throws(()=>validateNoAuthPlan(plan({targetLabel:'<absolute>/config.json'}),home));assert.throws(()=>validateNoAuthPlan(plan({targetLabel:'~/../config.json'}),home));fs.symlinkSync(os.tmpdir(),path.join(home,'link'));assert.throws(()=>validateNoAuthPlan(plan({targetLabel:'~/link/config.json'}),home))}))
test('unreviewed runtime command cannot enter apply through preview',()=>fixture(home=>{assert.throws(()=>validateNoAuthPlan(plan({commandCategory:'host_cli'}),home));assert.throws(()=>validateNoAuthPlan(plan({commands:[{commandCategory:'plugin_install'}]}),home));assert.throws(()=>validateNoAuthPlan(plan({action:'invoke'}),home))}))
test('configuration observations contain hashes, never file contents',()=>fixture(home=>{const p=path.join(home,'config.json');fs.writeFileSync(p,'private-value');const result=fileObservations([p,path.join(home,'absent')],home);assert.equal(result[0].sha256.length,64);assert.equal(JSON.stringify(result).includes('private-value'),false);assert.equal(result[1].kind,'absent')}))

test('reviewed local plugin commands do not admit remote install, auth or generation', () => {
  assert.equal(reviewedNoAuthCommand({commandCategory:'host_cli',args:['plugin','marketplace','add','~/.tidemind/plugins/market','--scope','user']}),true)
  assert.equal(reviewedNoAuthCommand({commandCategory:'plugin_install',args:['extensions','install','~/.tidemind/staging','--consent','--skip-settings']}),true)
  for (const args of [['extensions','install','https://evil','--consent','--skip-settings'],['plugin','install','other@market','--scope','user','--yes'],['auth','login'],['-p','run model'],['extensions','install','~/../daily','--consent','--skip-settings']]) assert.equal(reviewedNoAuthCommand({commandCategory:'plugin_install',args}),false)
})

test('configuration readback rejects switched ancestor outside HOME',()=>fixture(home=>{const outside=fs.mkdtempSync(path.join(os.tmpdir(),'operator-outside-'));try{fs.writeFileSync(path.join(outside,'config'),'secret');fs.symlinkSync(outside,path.join(home,'link'));assert.throws(()=>fileObservations([path.join(home,'link/config')],home));}finally{fs.rmSync(outside,{recursive:true,force:true})}}))

test('historical read-only mode never admits new candidate or lifecycle downgrade',()=>{assert.throws(()=>parseOperatorArgs([...args,'--mode','historical-upgrade-snapshot','--app-version','0.2.94']));assert.equal(parseOperatorArgs([...args,'--mode','historical-upgrade-snapshot','--app-version','0.2.89']).mode,'historical-upgrade-snapshot');assert.throws(()=>parseOperatorArgs([...args,'--app-version','0.2.89']))})

test('existing isolated marker cannot authorize symlinked configuration or WAL',()=>fixture(home=>{fs.mkdirSync(path.join(home,'.tidemind'));fs.mkdirSync(path.join(home,'.tidemind/graph'));fs.symlinkSync('/tmp',path.join(home,'.tidemind/graph/brain.sqlite-wal'));assert.throws(()=>validateIsolatedProfilePaths(home))}))

test('canonical TOML cannot redirect database outside isolated profile',()=>fixture(home=>{fs.mkdirSync(path.join(home,'.tidemind'));const config=path.join(home,'.tidemind/config.toml');for(const value of ['/Users/daily/.tidemind','~/.tidemind','../daily']){fs.writeFileSync(config,`[general]\ndata_dir = ${JSON.stringify(value)}\n`);assert.throws(()=>validateIsolatedProfilePaths(home))}fs.writeFileSync(config,`[general]\ndata_dir = ${JSON.stringify(path.join(home,'.tidemind'))}\n`);validateIsolatedProfilePaths(home)}))

test('historical baseline cannot create records for other targets or new versions',()=>{assert.equal(parseOperatorArgs([...args,'--mode','historical-upgrade-baseline','--app-version','0.2.89']).mode,'historical-upgrade-baseline');assert.throws(()=>parseOperatorArgs([...args.map(value=>value==='codex-desktop'?'other-target':value),'--mode','historical-upgrade-baseline','--app-version','0.2.89']));const legacy=args.map(value=>value==='codex-desktop'?'claude-desktop-legacy':value);assert.equal(parseOperatorArgs([...legacy,'--mode','historical-upgrade-baseline','--app-version','0.2.89']).mode,'historical-upgrade-baseline')})
test('historical snippet requires exact real Agent and bounded paths',()=>fixture(home=>{const executable=path.join(home,'node'),script=path.join(home,'mcp.js');fs.writeFileSync(executable,'x');fs.writeFileSync(script,'x');const snippet={mcpServers:{tidemind:{command:executable,args:[script],env:{EB_AGENT_ID:'eb_real'}}}};validateLegacySnippet(snippet,'eb_real',home,'/signed/App.app');assert.throws(()=>validateLegacySnippet(snippet,'eb_other',home,'/signed/App.app'));assert.throws(()=>validateLegacySnippet({...snippet,extra:'x'},'eb_real',home,'/signed/App.app'))}))

test('historical Desktop recipes preserve old Cowork absence instead of alias fabrication',()=>{for(const version of ['0.2.89','0.2.90','0.2.91','0.2.92','0.2.93']){assert.equal(historicalDesktopRecipe(version,'codex-desktop'),version==='0.2.89'?'codex-legacy':'codex-managed');assert.equal(historicalDesktopRecipe(version,'claude-desktop-legacy'),'desktop-legacy');assert.equal(historicalDesktopRecipe(version,'claude-cowork-local'),['0.2.92','0.2.93'].includes(version)?'cowork-guided':'unsupported-cowork')}assert.throws(()=>historicalDesktopRecipe('0.2.94','claude-cowork-local'));assert.throws(()=>historicalDesktopRecipe('0.2.89','cowork'))})

test('upgrade observation is read-only mode restricted to new candidate Desktop targets',()=>{assert.equal(parseOperatorArgs([...args,'--mode','upgrade-observe']).mode,'upgrade-observe');assert.throws(()=>parseOperatorArgs([...args,'--mode','upgrade-observe','--app-version','0.2.92']));assert.throws(()=>parseOperatorArgs([...args.map(value=>value==='codex-desktop'?'other-target':value),'--mode','upgrade-observe']))})

test('existing corpus requires persisted scheduler pause and cloud-off flags',()=>fixture(home=>{fs.mkdirSync(path.join(home,'.tidemind'));const file=path.join(home,'.tidemind/config.toml');fs.writeFileSync(file,'[cloud]\nenabled=false\nsync_enabled=false\nmetabolism_enabled=false\n');assert.throws(()=>assertNoAuthSchedulerGuard(home));fs.writeFileSync(file,'[cloud]\nenabled=false\nsync_enabled=false\nmetabolism_enabled=true\n');assertNoAuthSchedulerGuard(home);fs.writeFileSync(file,'[cloud]\nenabled=false\nsync_enabled=true\nmetabolism_enabled=true\n');assert.throws(()=>assertNoAuthSchedulerGuard(home))}))
test('priming uses only frozen historical App versions',()=>{assert.throws(()=>parseOperatorArgs([...args,'--mode','historical-upgrade-prime','--app-version','0.2.94']));assert.equal(parseOperatorArgs([...args,'--mode','historical-upgrade-prime','--app-version','0.2.89']).mode,'historical-upgrade-prime')})

for (const mode of ['success','wrong-root','duplicate-desktop','untrusted','unknown-command','wrong-task-target','slow-success','deadline','failed-result']) test('historical managed Desktop baseline '+mode,async()=>{
 const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'codex093-managed-')))
 try{
  fs.mkdirSync(path.join(home,'.codex'))
  const calls:string[]=[],records:any[]=[]
  const desktop={id:'desktop',hostVariant:'codex-desktop',manageable:true,sourceVerification:{state:mode==='untrusted'?'pending':'trusted'}}
  const installations=[{id:'cli',hostVariant:'codex-cli'},desktop,...(mode==='duplicate-desktop'?[{...desktop,id:'desktop2'}]:[])]
  let applied=false, elapsed=0, polls=0
  const invoke=async(method:string,...params:any[])=>{
   calls.push(method)
   if(method==='scan')return {snapshot:{fixtureMode:false,releasePolicy:{mode:'active'},installations}}
   if(method==='detail')return {installation:{...desktop,id:params[0],desiredState:applied?'managed':'unmanaged'},configRootLabel:mode==='wrong-root'?'~/.other-codex':'~/.codex',technical:{agentId:'native-created-agent',distributionId:'app:ChatGPT'}}
   if(method==='previewConnect'){assert.deepEqual(params[0],['desktop']);return {planHash:'a'.repeat(64),installations:[{installationId:'desktop',targets:[{scope:'user',risk:'low',targetLabel:'~/.codex/config.toml',action:mode==='unknown-command'?'invoke':'write',commandCategory:mode==='unknown-command'?'unknown':'file_write'}]}]}}
   if(method==='startApplyConnect'){assert.deepEqual(params[1],['desktop']);applied=true;return {id:'task',state:'running'}}
   if(method==='getApplyTask'){polls++;if(mode==='deadline'||(mode==='slow-success'&&polls<130))return {id:'task',state:'running',pendingInstallationIds:[],results:[{installationId:'desktop',status:'awaiting_verification'}]};return {id:'task',state:'completed',results:[{installationId:mode==='wrong-task-target'?'cli':'desktop',status:mode==='failed-result'?'failed':'awaiting_verification'}]}}
   throw new Error('unexpected API '+method)
  }
  const action=()=>createHistoricalCodexManagedBaseline(invoke,home,(kind:string,value:any)=>records.push({kind,value}),async(ms:number)=>{elapsed+=ms},()=>elapsed)
  if(mode==='slow-success'){await action();assert.equal(polls,130);assert.equal(elapsed,65000)}
  else if(mode==='deadline'){await assert.rejects(action);assert.equal(elapsed,600000);assert.equal(polls,1199);assert.equal(records.some(x=>x.kind==='historical_baseline_identity'),false)}
  else if(mode==='success'){await action();assert.deepEqual(calls,['scan','detail','previewConnect','startApplyConnect','getApplyTask','detail']);assert.equal(records.find(x=>x.kind==='historical_baseline_identity').value.agentId,'native-created-agent')}
  else {await assert.rejects(action);assert.equal(records.some(x=>x.kind==='historical_baseline_identity'),false);if(!['wrong-task-target','failed-result'].includes(mode))assert.equal(calls.includes('startApplyConnect'),false)}
 }finally{fs.rmSync(home,{recursive:true,force:true})}
})
