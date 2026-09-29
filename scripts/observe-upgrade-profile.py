#!/usr/bin/env python3
"""Stopped-profile raw migration observations only. Never launches an App or emits passed receipts."""
import argparse, hashlib, json, os, sqlite3, subprocess
from pathlib import Path
from datetime import datetime, timezone

TABLES = {
 'agents':['id','tool_type','archived','created'],
 'agent_installations':['id','agent_id','host_variant','profile_id','desired_state','consent_envelope_id'],
 'agent_consents':['id','installation_id','status','allowed_components_json'],
 'installation_components':['installation_id','component_key','desired_state','consent_envelope_id'],
 'nodes':['id','type','content','created','source_tool'],
 'node_versions':['id','node_id','version','content','changed_at'],
 'timeline_events':['id','type','subtype','title','detail','created'],
 'operation_log':['id','operation','created'],
 'links':['id','from_id','to_id','relation','strength','created'],
 'llm_usage_log':['id','model','connection_id','input_tokens','output_tokens','thinking_tokens','estimated_cost','created'],
 'model_connections':['id','provider_type','status','available_models','candidate_models','validation_fingerprint'],
 'agent_host_activity_evidence':['id','installation_id','activation_run_id','evidence_hash'],
 'managed_artifacts':['id','owner_namespace','owned_fragment_hash'],
 'artifact_consumers':['artifact_id','installation_id','state','desired_state','consent_envelope_id'],
 'llm_connection_auth_bindings':['connection_id','scope_state','scope_key','auth_epoch'],
 'llm_model_observations':['connection_id','scope_key','auth_epoch','model_id','last_outcome'],
 'cli_invocations':['id','connection_id','outcome','resolution'],
 'pending_digests':['id','status','ambiguous_invocation_id'],
}
def digest(raw): return hashlib.sha256(raw).hexdigest()
def canonical(value): return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()
def no_symlink(p):
 if p.is_symlink() or p.resolve()!=p.absolute(): raise ValueError('canonical non-symlink path required')
def main():
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('--workspace',required=True);p.add_argument('--phase',choices=['before','after','restored'],required=True)
 p.add_argument('--output',required=True);p.add_argument('--baseline');p.add_argument('--backup-dir')
 a=p.parse_args();w=Path(a.workspace).absolute();no_symlink(w)
 if w==Path.home() or w==Path('/'): raise ValueError('isolated workspace required')
 marker=w/'.tidemind-upgrade-profile'
 no_symlink(marker)
 if not marker.is_file() or marker.read_text()!='isolated-tidemind-upgrade-v1\n': raise ValueError('operator profile marker missing')
 d=w/'home/.tidemind/graph/brain.sqlite';c=w/'home/.tidemind/config.toml'
 no_symlink(d);no_symlink(c)
 for sidecar in [Path(str(d)+'-wal'),Path(str(d)+'-shm'),Path(str(d)+'-journal')]:
  if sidecar.exists() or sidecar.is_symlink():
   no_symlink(sidecar)
   if not sidecar.is_file():raise ValueError('SQLite sidecar must be a regular file')
 if not d.is_file(): raise ValueError('old/new signed App must have created the DB first')
 output=Path(a.output).absolute();no_symlink(output.parent)
 if output.exists(): raise ValueError('refuse overwrite of raw evidence')
 files=[str(x) for x in [d,Path(str(d)+'-wal'),Path(str(d)+'-shm')] if x.exists()]
 held=subprocess.run(['/usr/sbin/lsof','-t','--',*files],text=True,capture_output=True,timeout=10)
 if held.returncode not in (0,1) or held.stderr.strip(): raise RuntimeError('could not confirm stopped profile')
 if held.stdout.strip(): raise RuntimeError('profile is still open; stop its exact process tree before snapshot')
 baseline=json.loads(Path(a.baseline).read_text()) if a.baseline else None
 uri=d.as_uri()+'?mode=ro'
 if not Path(str(d)+'-wal').exists() and not Path(str(d)+'-journal').exists():uri+='&immutable=1'
 db=sqlite3.connect(uri,uri=True);db.execute('PRAGMA query_only=ON')
 try:
  integrity=db.execute('PRAGMA integrity_check').fetchone()[0]
  if integrity!='ok':raise RuntimeError('DB integrity failure')
  db.execute('BEGIN')
  names={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
  schema=dict(db.execute("SELECT key,value FROM metadata WHERE key='schema_version'")) if 'metadata' in names else {}
  tables={}
  for table,preferred in TABLES.items():
   if table not in names:tables[table]={'present':False};continue
   columns=[r[1] for r in db.execute('PRAGMA table_info('+table+')')]
   selected=(baseline['tables'].get(table,{}).get('columns') if baseline else None) or [v for v in preferred if v in columns]
   if not selected or any(col not in columns or col not in preferred for col in selected):raise ValueError('invalid/missing comparison columns for '+table)
   rows=list(db.execute('SELECT '+','.join(selected)+' FROM '+table))
   row_hashes=sorted(digest(canonical(row)) for row in rows)
   item={'present':True,'columns':selected,'rowCount':len(rows),'rowsSha256':digest(canonical(row_hashes)),'rowHashes':row_hashes}
   if table=='agents':item['identities']=[{'id':r[0]} for r in db.execute('SELECT id FROM agents ORDER BY id')]
   if table=='agent_installations':item['identities']=[dict(zip(['id','agentId','hostVariant','desiredState'],r)) for r in db.execute('SELECT id,agent_id,host_variant,desired_state FROM agent_installations ORDER BY id')]
   tables[table]=item
  backup=None
  if a.backup_dir:
   target=Path(a.backup_dir).absolute();no_symlink(target.parent);target.mkdir(mode=0o700)
   dest=sqlite3.connect(target/'brain.sqlite')
   try:db.backup(dest)
   finally:dest.close()
   os.chmod(target/'brain.sqlite',0o600)
   config=c.read_bytes() if c.exists() else None
   if config is not None:
    with (target/'config.toml').open('xb') as f:f.write(config)
    os.chmod(target/'config.toml',0o600)
   backup={'path':str(target),'databaseSha256':digest((target/'brain.sqlite').read_bytes()),'configurationPresent':config is not None,'configurationSha256':digest(config) if config is not None else None}
  observed={'kind':'upgrade_raw_observation','status':'not_an_acceptance_assertion','phase':a.phase,'workspace':str(w),'observedAt':datetime.now(timezone.utc).isoformat(),'schema':schema,'integrity':integrity,'configurationSha256':digest(c.read_bytes()) if c.exists() else None,'tables':tables,'backup':backup}
  if baseline:
   observed['comparison']={t:{'beforePresent':v.get('present'),'afterPresent':tables.get(t,{}).get('present'),'sameRows':v.get('rowsSha256')==tables.get(t,{}).get('rowsSha256'),'beforeRowsRetained':all(tables.get(t,{}).get('rowHashes',[]).count(x)>=v.get('rowHashes',[]).count(x) for x in set(v.get('rowHashes',[]))),'beforeCount':v.get('rowCount'),'afterCount':tables.get(t,{}).get('rowCount')} for t,v in baseline['tables'].items()}
  with output.open('x') as f:json.dump(observed,f,ensure_ascii=False,indent=2);f.write('\n')
  os.chmod(output,0o600)
  print(json.dumps({'status':'raw_observation_only','path':str(output)}))
 finally:db.close()
if __name__=='__main__':main()
