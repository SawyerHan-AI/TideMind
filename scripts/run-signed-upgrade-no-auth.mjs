#!/usr/bin/env node
/** Actual historical GUI -> immutable candidate GUI -> matched restore. Never emits passed receipts. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { parse as parseToml } from 'smol-toml'
import { assertCodexUpgradeIdentity, codexUpgradeConfigurationScope } from './codex-upgrade-baseline.mjs'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runOperator, parseOperatorArgs, assertNoAuthSchedulerGuard, currentCandidateVersion } from './run-signed-host-no-auth.mjs'
import { loadHistoricalUpgradeApps, inspectHistoricalUpgradeApp } from './historical-upgrade-apps.mjs'
import { inspectPhysicalTideMindCandidateApp, hashPhysicalAppBundle } from './tidemind-candidate-app-identity.mjs'
import { loadHostNoAuthSamples } from './prepare-host-no-auth-samples.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const catalogs = ['claude-desktop-legacy', 'codex-desktop', 'claude-cowork-local']
const within = (base, target) => target.startsWith(base + path.sep)
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function check(value, message) { if (!value) throw new Error(message) }
function canonicalDirectory(directory) {
  const absolute = path.resolve(directory)
  check(fs.realpathSync(absolute) === absolute && fs.lstatSync(absolute).isDirectory(), 'noncanonical directory')
  return absolute
}
function readJson(file) { check(fs.realpathSync(file) === path.resolve(file) && fs.lstatSync(file).isFile(), 'noncanonical input JSON'); return JSON.parse(fs.readFileSync(file, 'utf8')) }
export function parseUpgradeArgs(args) {
  const out = {}, allowed = new Set(['candidate-app','candidate-bundle-sha256','source-commit','capture-nonce','historical-inputs','host-samples','workspace','output-dir','catalog-id'])
  for (let i=0;i<args.length;i+=2) { const key=args[i]?.replace(/^--/,'');check(args[i]?.startsWith('--')&&allowed.has(key)&&!out[key]&&args[i+1]&&!args[i+1].startsWith('--'),'invalid upgrade argument');out[key]=args[i+1] }
  check(Object.keys(out).length===allowed.size && catalogs.includes(out['catalog-id']),'upgrade requires every binding and a reviewed Desktop target')
  check(/^[a-f0-9]{40}$/.test(out['source-commit'])&&/^[a-f0-9]{64}$/.test(out['candidate-bundle-sha256'])&&/^[a-f0-9]{64}$/.test(out['capture-nonce']),'invalid upgrade source/candidate/capture binding')
  return out
}
function snapshot(workspace, phase, output, baseline, backup) {
  const args=['scripts/observe-upgrade-profile.py','--workspace',workspace,'--phase',phase,'--output',output]
  if(baseline)args.push('--baseline',baseline)
  if(backup)args.push('--backup-dir',backup)
  execFileSync('/usr/bin/python3',args,{cwd:root,encoding:'utf8',timeout:120000,stdio:['ignore','pipe','pipe']})
  return readJson(output)
}
export function assertUpgradeStopped(workspace, knownProcessIds = []) {
  workspace = canonicalDirectory(workspace)
  for (const pid of knownProcessIds) {
    check(Number.isSafeInteger(pid) && pid > 1, 'invalid known upgrade process PID')
    try { process.kill(pid, 0) } catch (error) {
      if (error.code === 'ESRCH') continue
      throw new Error('cannot confirm known upgrade process stopped: ' + pid)
    }
    throw new Error('known host/helper/restart process is still running: ' + pid)
  }
  const marker=path.join(workspace,'.tidemind-upgrade-profile')
  check(fs.realpathSync(marker)===marker&&fs.lstatSync(marker).isFile()&&!fs.lstatSync(marker).isSymbolicLink(),'profile marker must be canonical and regular')
  for(const suffix of ['', '-wal', '-shm', '-journal']){
    const file=path.join(workspace,'home/.tidemind/graph/brain.sqlite')+suffix
    let stat;try{stat=fs.lstatSync(file)}catch(error){if(error.code==='ENOENT')continue;throw error}
    check(stat.isFile()&&!stat.isSymbolicLink()&&fs.realpathSync(file)===file,'SQLite file/sidecar must be canonical and regular')
  }
  check(!fs.existsSync(path.join(workspace,'.signed-host-operator.lock')),'signed App operator is still active')
  const db=path.join(workspace,'home/.tidemind/graph/brain.sqlite')
  const files=[db,db+'-wal',db+'-shm'].filter(file=>fs.existsSync(file))
  const result=spawnSync('/usr/sbin/lsof',['-t','--',...files],{encoding:'utf8',timeout:10000})
  check(!result.error&&[0,1].includes(result.status)&&!result.stderr.trim()&&!result.stdout.trim(),'profile must be fully stopped before restore')
}
export function restoreUpgradeProfile(workspace, before, output, knownProcessIds = []) {
  workspace=canonicalDirectory(workspace);output=canonicalDirectory(output);assertUpgradeStopped(workspace, knownProcessIds)
  check(fs.readFileSync(path.join(workspace,'.tidemind-upgrade-profile'),'utf8')==='isolated-tidemind-upgrade-v1\n','isolated upgrade marker missing')
  const home=canonicalDirectory(path.join(workspace,'home')),data=canonicalDirectory(path.join(home,'.tidemind')),graph=canonicalDirectory(path.join(data,'graph'))
  const backup=canonicalDirectory(before.backup.path),backupDb=path.join(backup,'brain.sqlite')
  check(within(output,backup)&&fs.realpathSync(backupDb)===backupDb&&hash(fs.readFileSync(backupDb))===before.backup.databaseSha256,'restore backup identity differs')
  const config=path.join(data,'config.toml'),backupConfig=path.join(backup,'config.toml')
  if(fs.existsSync(config))check(fs.realpathSync(config)===config&&fs.lstatSync(config).isFile(),'live config is not regular')
  if(before.backup.configurationPresent)check(fs.realpathSync(backupConfig)===backupConfig&&hash(fs.readFileSync(backupConfig))===before.backup.configurationSha256,'restore configuration identity differs')
  const staged=path.join(data,'.upgrade-restore-'+crypto.randomUUID());fs.mkdirSync(staged,{mode:0o700})
  fs.copyFileSync(backupDb,path.join(staged,'brain.sqlite'),fs.constants.COPYFILE_EXCL)
  if(before.backup.configurationPresent)fs.copyFileSync(backupConfig,path.join(staged,'config.toml'),fs.constants.COPYFILE_EXCL)
  check(hash(fs.readFileSync(path.join(staged,'brain.sqlite')))===before.backup.databaseSha256,'staged restore DB changed')
  if(before.backup.configurationPresent)check(hash(fs.readFileSync(path.join(staged,'config.toml')))===before.backup.configurationSha256,'staged restore config changed')
  const retired=path.join(data,'.upgrade-retained-'+crypto.randomUUID());fs.mkdirSync(retired,{mode:0o700})
  // Preserve the entire post-upgrade graph/WAL state. Never delete to restore.
  fs.renameSync(graph,path.join(retired,'graph'));fs.mkdirSync(graph,{mode:0o700});fs.renameSync(path.join(staged,'brain.sqlite'),path.join(graph,'brain.sqlite'))
  if(fs.existsSync(config)){check(fs.realpathSync(config)===config&&fs.lstatSync(config).isFile(),'live config is not regular');fs.renameSync(config,path.join(retired,'config.toml'))}
  if(before.backup.configurationPresent)fs.renameSync(path.join(staged,'config.toml'),config)
  fs.rmdirSync(staged)
  return {retainedPostUpgradeState:retired,hostConfigurationRestored:false,reason:'external host configuration is never blindly restored with the DB'}
}
export function compareUpgradeObservations(before, after, agentId, catalogId) {
  const agents=after.tables.agents?.identities??[],installations=after.tables.agent_installations?.identities??[]
  const tableChecks=Object.fromEntries(['nodes','node_versions','timeline_events','links','llm_usage_log'].map(table=>[table,after.comparison?.[table]??{beforePresent:false}]))
  const oldAgents=before.tables.agents?.identities??[],oldInstallations=(before.tables.agent_installations?.identities??[]).filter(row=>row.agentId===agentId)
  const inAgents=oldAgents.some(row=>row.id===agentId)
  const preserved=(inAgents||oldInstallations.length>0)&&(!inAgents||agents.some(row=>row.id===agentId))
    &&oldInstallations.every(old=>installations.some(row=>row.id===old.id&&row.agentId===old.agentId&&row.hostVariant===old.hostVariant))
  return {agentIdPreserved:agentId?Boolean(preserved):null,
    installation:agentId?installations.find(row=>row.hostVariant===catalogId&&row.agentId===agentId)??null:null,
    tableChecks,nonzeroSyntheticUsageHistoryExercised:(before.tables.llm_usage_log?.rowCount??0)>0,statisticsInputOrigin:'synthetic_migration_corpus',realBillingHistoryClaimed:false,
    limitations:['raw comparisons are not independent acceptance assertions','synthetic statistics do not represent real model calls or charges','login and real calls are not executed']}
}
export function targetConfigurationBindings(profile, files, expectedAgentId, catalogId) {
  const home=canonicalDirectory(path.join(profile,'home'))
  check(Array.isArray(files)&&files.length>0,'baseline has no physical configuration paths')
  const primary=catalogId==='codex-desktop'?[path.join(home,'.codex/config.toml')]:catalogId==='claude-desktop-legacy'?[path.join(home,'Library/Application Support/Claude/claude_desktop_config.json')]:files.filter(file=>/\.(plugin|zip)$/.test(file))
  check(primary.length>0,'baseline has no recognized primary MCP configuration')
  const observations=[]
  for(const file of primary){
    const absolute=path.resolve(file);check(within(home,absolute)&&fs.realpathSync(absolute)===absolute&&fs.lstatSync(absolute).isFile(),'configuration path escaped isolated HOME')
    let text
    if(/\.(plugin|zip)$/.test(absolute)){
      const code="import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); names=[i for i in z.infolist() if i.filename=='.mcp.json']; assert len(names)==1 and names[0].file_size<=1048576; f=z.open(names[0]); b=f.read(1048577); assert len(b)<=1048576; print(b.decode('utf8'))"
      text=execFileSync('/usr/bin/python3',['-I','-S','-c',code,absolute],{encoding:'utf8',maxBuffer:2*1024*1024})
    }else{check(fs.statSync(absolute).size<=2*1024*1024,'configuration too large');text=fs.readFileSync(absolute,'utf8')}
    let data
    try{data=/\.toml$/.test(absolute)?parseToml(text):JSON.parse(text)}catch{continue}
    const containers=[data.mcpServers,data.mcp_servers,data.mcp,data].filter(value=>value&&typeof value==='object'&&!Array.isArray(value))
    const bindings=[]
    for(const container of containers)for(const [name,value]of Object.entries(container))if(/^(tidemind|externabrain)([-_]|$)/i.test(name)&&value&&typeof value==='object'){
      const id=value.env?.EB_AGENT_ID??value.environment?.EB_AGENT_ID
      if(typeof id==='string')bindings.push({selector:name,agentId:id})
    }
    if(bindings.length)observations.push({path:absolute,sha256:hash(fs.readFileSync(absolute)),bindings})
  }
  check(observations.length>0&&observations.every(item=>item.bindings.every(binding=>binding.agentId===expectedAgentId)),'target configuration does not bind the original Agent ID')
  return observations
}
async function appRun(options, app, version, workspace, output, mode, expectedBundle) {
  return runOperator(parseOperatorArgs(['--candidate-app',app,'--candidate-bundle-sha256',expectedBundle,'--source-commit',options['source-commit'],
    '--capture-nonce',options['capture-nonce'],'--workspace',workspace,'--output-dir',output,'--app-version',version,'--catalog-id',options['catalog-id'],'--mode',mode]))
}
/** Existing prepared profiles only: no prime/create/connect and no host installation. */
export async function runPreparedCodexUpgrade(options, { fromAppVersion, profile, originalAgentId }) {
  check(process.platform === 'darwin' && process.arch === 'arm64', 'native macOS ARM64 required')
  check(options['catalog-id'] === 'codex-desktop', 'prepared database path is Codex-only')
  check(/^[a-f0-9]{40}$/.test(options['source-commit'] ?? '') && /^[a-f0-9]{64}$/.test(options['capture-nonce'] ?? ''), 'invalid prepared source/capture binding')
  profile = canonicalDirectory(profile)
  assertUpgradeStopped(profile)
  assertNoAuthSchedulerGuard(path.join(profile, 'home'))
  const output = path.resolve(options['output-dir'])
  check(!fs.existsSync(output) && fs.realpathSync(path.dirname(output)) === path.dirname(output), 'new canonical output required')
  const history = readJson(options['historical-inputs'])
  const old = history.records?.find(item => item.version === fromAppVersion)
  check(old && loadHistoricalUpgradeApps().some(item => item.version === fromAppVersion), 'unreviewed historical input')
  const identity = inspectHistoricalUpgradeApp(old.app, old.version)
  check(identity.bundleSha256 === old.identity.bundleSha256, 'historical App differs from bound input')
  const candidate = inspectPhysicalTideMindCandidateApp(options['candidate-app'], currentCandidateVersion, options['source-commit'], 'arm64')
  check(candidate.bundleSha256 === options['candidate-bundle-sha256'], 'candidate differs from frozen binding')
  fs.mkdirSync(output, { mode: 0o700 })
  const report = { kind:'upgrade_raw_observation_batch', status:'running', fromAppVersion, toAppVersion:currentCandidateVersion,
    workspace:profile, originalAgentId, sourceCommit:options['source-commit'], candidateBundleSha256:candidate.bundleSha256,
    realHostInvocationVerified:false, acceptanceStatus:'not_evaluated' }
  const save = () => fs.writeFileSync(path.join(output,'upgrade-observations.json'), JSON.stringify(report,null,2)+'\n')
  save()
  try {
    const input = snapshot(profile,'before',path.join(output,'prepared-input.json'))
    const inputRows = (input.tables.agent_installations?.identities ?? []).filter(row => row.agentId === originalAgentId)
    assertCodexUpgradeIdentity(input,input,originalAgentId,inputRows[0]?.id ?? null)
    report.migrationScope = codexUpgradeConfigurationScope(input,originalAgentId)
    report.oldConfigurationObservation = input.codexConfiguration
    const nodeRowCount = input.tables.nodes?.rowCount, usageRowCount = input.tables.llm_usage_log?.rowCount
    check(input.tables.nodes?.present && Number.isSafeInteger(nodeRowCount) && nodeRowCount > 0
      && input.tables.llm_usage_log?.present && Number.isSafeInteger(usageRowCount) && usageRowCount > 0,
    'existing profile must contain already prepared history and usage before opening an App')
    report.preparedInput = { nodeRowCount, usageRowCount, sourceSchemaVersion: input.schema.schema_version,
      observedAt: input.observedAt, seededByThisRun: false }
    await appRun(options,old.app,old.version,profile,path.join(output,'old-corpus-readback'),'historical-upgrade-snapshot',identity.bundleSha256)
    const beforePath=path.join(output,'before.json')
    const before=snapshot(profile,'before',beforePath,null,path.join(output,'backup'))
    check(codexUpgradeConfigurationScope(before,originalAgentId)===report.migrationScope,'old App changed baseline coverage')
    report.oldConfigurationBindings=report.migrationScope==='configured_host'
      ? targetConfigurationBindings(profile,before.codexConfiguration.files.filter(file=>file.state==='regular').map(file=>path.join(profile,'home',file.path)),originalAgentId,'codex-desktop') : []
    await appRun(options,options['candidate-app'],currentCandidateVersion,profile,path.join(output,'new-migration'),'upgrade-observe',candidate.bundleSha256)
    const after=snapshot(profile,'after',path.join(output,'after.json'),beforePath,path.join(output,'after-backup'))
    const installed=(after.tables.agent_installations?.identities??[]).filter(row=>row.agentId===originalAgentId&&row.hostVariant==='codex-desktop')
    report.installationId=installed[0]?.id??null
    assertCodexUpgradeIdentity(before,after,originalAgentId,report.installationId)
    if(report.migrationScope==='configured_host')check(report.installationId!==null,'configured upgrade did not retain an Installation')
    report.comparison=compareUpgradeObservations(before,after,originalAgentId,'codex-desktop')
    for(const table of ['agents','nodes','node_versions','operation_log','timeline_events','links','llm_usage_log']) if(before.tables[table]?.present)check(after.comparison?.[table]?.beforeRowsRetained===true,`prior ${table} rows were not preserved`)
    check(after.schema.schema_version==='45'&&after.schema.schema_lineage==='stable-0.2.94','candidate schema/lineage mismatch')
    check(report.comparison.nonzeroSyntheticUsageHistoryExercised,'nonzero statistics not exercised')
    if(report.migrationScope==='configured_host')report.newConfigurationBindings=targetConfigurationBindings(profile,report.oldConfigurationBindings.map(item=>item.path),originalAgentId,'codex-desktop')
    let refused=false
    try{restoreUpgradeProfile(profile,{...before,backup:{...before.backup,databaseSha256:'0'.repeat(64)}},output)}catch{refused=true}
    check(refused,'altered recovery binding accepted')
    report.restore=restoreUpgradeProfile(profile,before,output)
    await appRun(options,old.app,old.version,profile,path.join(output,'old-restored'),'historical-upgrade-snapshot',identity.bundleSha256)
    const restored=snapshot(profile,'restored',path.join(output,'restored.json'),beforePath)
    const restoredRows=(restored.tables.agent_installations?.identities??[]).filter(row=>row.agentId===originalAgentId&&row.hostVariant==='codex-desktop')
    assertCodexUpgradeIdentity(before,restored,originalAgentId,restoredRows[0]?.id??null)
    check(restored.schema.schema_version===before.schema.schema_version,'restore schema mismatch')
    for(const table of ['agents','nodes','node_versions','operation_log','timeline_events','links','llm_usage_log']) if(before.tables[table]?.present)check(restored.comparison?.[table]?.beforeRowsRetained===true,`restored ${table} changed`)
    report.status='database_identity_history_statistics_and_restore_observed'
  } catch(error) { report.status='failed';report.error=error.message;save();throw error }
  save();return report
}
export async function runSignedUpgradeBatch(options) {
  check(process.platform==='darwin'&&process.arch==='arm64','signed upgrade operator requires native macOS ARM64')
  const workspace=canonicalDirectory(options.workspace),output=path.resolve(options['output-dir'])
  check(!fs.existsSync(output)&&fs.realpathSync(path.dirname(output))===path.dirname(output),'upgrade output must be new under a canonical parent')
  fs.mkdirSync(output,{mode:0o700})
  const history=readJson(options['historical-inputs']),samples=readJson(options['host-samples']),recipe=loadHistoricalUpgradeApps()
  check(history.status==='prepared_not_upgrade_acceptance'&&history.appsExecuted===false&&JSON.stringify(history.records.map(r=>r.version))===JSON.stringify(recipe.map(r=>r.version)),'historical prepared input scope invalid')
  const sample=samples.targets?.find(t=>t.catalogId===options['catalog-id'])
  const approved=loadHostNoAuthSamples().find(s=>s.catalogIds.includes(options['catalog-id']))
  check(sample&&approved&&sample.distributionId===approved.receipt.distributionId&&fs.realpathSync(sample.appPath)===sample.appPath&&within(path.join(samples.workspace,'home/Applications'),sample.appPath),'host sample path/scope invalid')
  const candidate=inspectPhysicalTideMindCandidateApp(options['candidate-app'],currentCandidateVersion,options['source-commit'],'arm64')
  check(candidate.bundleSha256===options['candidate-bundle-sha256'],'upgrade candidate does not match frozen binding')
  const report={schemaVersion:1,kind:'signed_app_upgrade_raw_observations',acceptanceStatus:'not_evaluated',sourceCommit:options['source-commit'],candidate,captureNonce:options['capture-nonce'],catalogId:options['catalog-id'],paths:[],omitted:['login','real_model_calls','passed_receipts']}
  const save=()=>fs.writeFileSync(path.join(output,'upgrade-observations.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600})
  save()
  for(const old of history.records){
    const caseOutput=path.join(output,old.version);fs.mkdirSync(caseOutput,{mode:0o700})
    const profile=path.join(workspace,options['catalog-id']+'-'+old.version);fs.mkdirSync(profile,{mode:0o700})
    const apps=path.join(profile,'home/Applications');fs.mkdirSync(apps,{recursive:true,mode:0o700})
    const hostApp=path.join(apps,approved.appName),expectedHostBytes=hashPhysicalAppBundle(sample.appPath)
    try {
      // macOS cp(1): -c uses clonefile with copyfile fallback; -RpP preserves
      // permissions/attributes and symbolic links, never follows framework links.
      execFileSync('/bin/cp',['-cRpP',sample.appPath,hostApp],{stdio:['ignore','pipe','pipe'],timeout:120000})
    } catch(error) { throw new Error('host sample clone/copy failed (check available disk space): '+error.message) }
    check(hashPhysicalAppBundle(hostApp)===expectedHostBytes,'copied host App bytes/links/modes changed')
    execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',hostApp],{stdio:['ignore','pipe','pipe'],timeout:120000})
    const record={fromAppVersion:old.version,toAppVersion:currentCandidateVersion,workspace:profile,status:'running'};report.paths.push(record);save()
    try{
      const identity=inspectHistoricalUpgradeApp(old.app,old.version)
      await appRun(options,old.app,old.version,profile,path.join(caseOutput,'old-prime'),'historical-upgrade-prime',identity.bundleSha256)
      assertNoAuthSchedulerGuard(path.join(profile,'home'))
      await appRun(options,old.app,old.version,profile,path.join(caseOutput,'old-baseline'),'historical-upgrade-baseline',identity.bundleSha256)
      const baselineRaw=readJson(path.join(caseOutput,'old-baseline/observations.json'))
      const unsupported=baselineRaw.observations.find(o=>o.step==='unsupported_historical_capability')
      const created=baselineRaw.observations.find(o=>o.step==='historical_baseline_identity')?.value??baselineRaw.observations.find(o=>o.step==='historical_agent_created')?.value
      check(unsupported||created?.agentId||created?.id,'old signed App did not return a real baseline identity')
      record.historicalCapability=unsupported?'unsupported_historical_capability':'baseline_created_by_old_signed_app'
      record.originalAgentId=created?.agentId??created?.id??null
      record.configurationPaths=created?.configurationPaths??[]
      if(!unsupported)record.oldConfigurationBindings=targetConfigurationBindings(profile,record.configurationPaths,record.originalAgentId,options['catalog-id'])
      const corpusPath=path.join(caseOutput,'synthetic-corpus.json')
      const corpusArgs=['scripts/seed-upgrade-corpus.py','--workspace',profile,'--output',corpusPath]
      if(record.originalAgentId)corpusArgs.push('--agent-id',record.originalAgentId)
      assertNoAuthSchedulerGuard(path.join(profile,'home'))
      execFileSync('/usr/bin/python3',corpusArgs,{cwd:root,encoding:'utf8',timeout:120000,stdio:['ignore','pipe','pipe']})
      record.syntheticCorpus=readJson(corpusPath)
      // The actual historical App must read its nonzero test corpus before upgrade.
      await appRun(options,old.app,old.version,profile,path.join(caseOutput,'old-corpus-readback'),'historical-upgrade-snapshot',identity.bundleSha256)
      const beforePath=path.join(caseOutput,'before.json'),before=snapshot(profile,'before',beforePath,null,path.join(caseOutput,'before-backup'))
      // These fresh profiles never launch the external host App or a restart service.
      // Existing-host workflows must pass their known PIDs to assertUpgradeStopped.
      assertUpgradeStopped(profile)
      record.switchBarrier = { scope: 'isolated_gui_only', externalHostStarted: false, restartServiceStarted: false }
      // Capture automatic migration before any explicit new consent/lifecycle operation.
      await appRun(options,options['candidate-app'],currentCandidateVersion,profile,path.join(caseOutput,'new-migration'),'upgrade-observe',candidate.bundleSha256)
      const after=snapshot(profile,'after',path.join(caseOutput,'after.json'),beforePath,path.join(caseOutput,'after-backup'))
      record.comparison=compareUpgradeObservations(before,after,record.originalAgentId,options['catalog-id'])
      if(unsupported){const targets=(after.tables.agent_installations?.identities??[]).filter(row=>row.hostVariant===options['catalog-id']);record.unsupportedTargetObservation={targetRows:targets,automaticManagedIntentObserved:targets.some(row=>row.desiredState==='managed')};check(!record.unsupportedTargetObservation.automaticManagedIntentObserved,'historically unsupported target was automatically enabled')}
      for(const table of ['nodes','node_versions','timeline_events','links','llm_usage_log'])if(before.tables[table]?.present)check(after.tables[table]?.present&&after.comparison?.[table]?.beforeRowsRetained===true,`prior ${table} rows were not preserved`)
      check(record.comparison.nonzeroSyntheticUsageHistoryExercised,'synthetic nonzero statistics corpus was not present')
      if(!unsupported){
        check(record.comparison.agentIdPreserved,'original Agent ID lost')
        await appRun(options,options['candidate-app'],currentCandidateVersion,profile,path.join(caseOutput,'new-target-observation'),'lifecycle',candidate.bundleSha256)
        const targetAfter=snapshot(profile,'after',path.join(caseOutput,'after-target-observation.json'),beforePath)
        record.targetComparison=compareUpgradeObservations(before,targetAfter,record.originalAgentId,options['catalog-id'])
        check(record.targetComparison.installation,'target production installation did not retain the old Agent ID')
        record.newConfigurationBindings=targetConfigurationBindings(profile,record.configurationPaths,record.originalAgentId,options['catalog-id'])
      }
      // Demonstrate the manual rollback guard refuses an altered recovery point.
      const falseBinding={...before,backup:{...before.backup,databaseSha256:'0'.repeat(64)}}
      let refused=false
      try{restoreUpgradeProfile(profile,falseBinding,caseOutput)}catch(error){refused=true;record.alteredRestoreBindingRejected={message:error.message}}
      check(refused,'rollback accepted a mismatched backup digest')
      record.restore=restoreUpgradeProfile(profile,before,caseOutput)
      await appRun(options,old.app,old.version,profile,path.join(caseOutput,'old-restored'),'historical-upgrade-snapshot',identity.bundleSha256)
      const restored=snapshot(profile,'restored',path.join(caseOutput,'restored.json'),beforePath)
      record.restoredComparison=compareUpgradeObservations(before,restored,record.originalAgentId,options['catalog-id'])
      for(const table of ['nodes','node_versions','timeline_events','links','llm_usage_log'])if(before.tables[table]?.present)check(restored.tables[table]?.present&&restored.comparison?.[table]?.beforeRowsRetained===true,`restored ${table} rows differ from recovery point`)
      if(record.originalAgentId)check(record.restoredComparison.agentIdPreserved,'restored old App lost Agent ID')
      record.status=unsupported?'unsupported_historical_capability_observed':'actual_gui_migration_and_restore_observed'
    }catch(error){record.status='failed';record.error=error.message;save();throw error}
    save()
  }
  return {outputDirectory:output,rawObservations:path.join(output,'upgrade-observations.json'),acceptanceStatus:'not_evaluated'}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){try{console.log(JSON.stringify(await runSignedUpgradeBatch(parseUpgradeArgs(process.argv.slice(2)))))}catch(error){console.error(error.message);process.exitCode=1}}
