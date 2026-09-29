#!/usr/bin/env python3
"""Insert labelled non-activity corpus into a stopped isolated OLD App database; never grants authority."""
import argparse, hashlib, json, os, sqlite3, subprocess
from pathlib import Path
from datetime import datetime, timezone
PROTECTED=['agents','agent_installations','agent_consents','installation_components','managed_artifacts','artifact_consumers','reconcile_runs','agent_host_activity_evidence','model_connections','llm_connection_auth_bindings','llm_model_observations','cli_invocations','pending_digests']
def hash_value(value):return hashlib.sha256(json.dumps(value,sort_keys=True,default=str).encode()).hexdigest()
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--workspace',required=True);p.add_argument('--output',required=True);p.add_argument('--agent-id');a=p.parse_args()
 w=Path(a.workspace).absolute();output=Path(a.output).absolute()
 marker=w/'.tidemind-upgrade-profile'
 if marker.is_symlink() or not marker.is_file() or marker.resolve()!=marker:raise ValueError('profile marker must be a canonical regular file')
 if w.resolve()!=w or w==Path.home() or marker.read_text()!='isolated-tidemind-upgrade-v1\n':raise ValueError('isolated old-profile marker required')
 if output.exists() or output.parent.resolve()!=output.parent:raise ValueError('corpus observation must be new')
 dbpath=w/'home/.tidemind/graph/brain.sqlite'
 if dbpath.is_symlink() or not dbpath.is_file() or dbpath.resolve()!=dbpath:raise ValueError('old App must create a regular profile database first')
 for sidecar in [Path(str(dbpath)+'-wal'),Path(str(dbpath)+'-shm'),Path(str(dbpath)+'-journal')]:
  if sidecar.exists() or sidecar.is_symlink():
   if sidecar.is_symlink() or not sidecar.is_file() or sidecar.resolve()!=sidecar:raise ValueError('SQLite sidecar must be canonical and regular')
 files=[str(p) for p in [dbpath,Path(str(dbpath)+'-wal'),Path(str(dbpath)+'-shm')] if p.exists()]
 check=subprocess.run(['/usr/sbin/lsof','-t','--',*files],capture_output=True,text=True,timeout=10)
 if check.returncode not in (0,1) or check.stdout.strip() or check.stderr.strip():raise RuntimeError('old profile must be stopped before corpus preparation')
 db=sqlite3.connect(dbpath.as_uri()+'?mode=rw',uri=True)
 try:
  tables={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
  version=int(db.execute("SELECT value FROM metadata WHERE key='schema_version'").fetchone()[0])
  if version<1 or version>=35:raise ValueError('corpus preparation is limited to the actual old schema, never the candidate DB')
  if a.agent_id and not db.execute('SELECT id FROM agents WHERE id=? AND archived=0',(a.agent_id,)).fetchone():raise ValueError('Agent ID must be actually created by the old App')
  protected=lambda:{t:hash_value(db.execute('SELECT * FROM '+t+' ORDER BY rowid').fetchall()) for t in PROTECTED if t in tables}
  before=protected();timestamp=datetime.now(timezone.utc).isoformat();node_id='synthetic_upgrade_'+hashlib.sha256((str(w)+(a.agent_id or '')).encode()).hexdigest()[:24]
  def insert(table,values):
   columns={r[1] for r in db.execute('PRAGMA table_info('+table+')')};pairs=[(k,v) for k,v in values.items() if k in columns]
   return db.execute('INSERT INTO '+table+' ('+','.join(k for k,v in pairs)+') VALUES ('+','.join('?' for _ in pairs)+')',tuple(v for k,v in pairs))
  db.execute('BEGIN IMMEDIATE')
  # Archived synthetic memory cannot enter ordinary active-node metabolism.
  insert('nodes',{'id':node_id,'type':'fact','content':'synthetic_migration_corpus: deterministic archived data, not a real user memory or model result','tags':'["synthetic_migration_corpus"]','archived':1,'source_tool':a.agent_id or 'synthetic_migration_corpus','created':timestamp,'updated':timestamp})
  usage=insert('llm_usage_log',{'model':'synthetic_migration_corpus_not_a_model','operation':'synthetic_migration_corpus','input_tokens':11,'output_tokens':7,'thinking_tokens':3,'estimated_cost':0.0123,'provider_type':'synthetic_migration_corpus','source_type':'synthetic_migration_corpus','billing_mode':'synthetic_migration_corpus','estimated_cost_kind':'synthetic_migration_corpus','created':timestamp}).lastrowid
  if int(db.execute("SELECT value FROM metadata WHERE key='schema_version'").fetchone()[0])!=version:raise RuntimeError('corpus cannot change schema version')
  if protected()!=before:raise RuntimeError('corpus attempted to alter identity, authorization, activity, or invocation state')
  db.commit()
  result={'kind':'synthetic_migration_corpus','isRealCall':False,'isRealCharge':False,'isHostActivityEvidence':False,'oldSchemaVersion':version,'actualOldAgentId':a.agent_id,'nodeId':node_id,'usageRowId':usage,'statisticalTestValues':{'input_tokens':11,'output_tokens':7,'thinking_tokens':3,'estimated_cost':0.0123},'protectedTablesUnchanged':True,'status':'test_input_only_not_acceptance_assertion'}
  with output.open('x') as file:json.dump(result,file,indent=2);file.write('\n')
  os.chmod(output,0o600)
 finally:
  if db.in_transaction:db.rollback()
  db.close()
if __name__=='__main__':main()
