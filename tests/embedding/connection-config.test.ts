import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ensureSchema } from '../../src/db/schema.js';
import { createConnection } from '../../src/db/connections.js';
import { captureEmbeddingConnection, embeddingConnectionCurrent } from '../../src/embedding/connection-config.js';
import type { AppConfig } from '../../src/types.js';
const base={embedding:{provider:'gemini',model:'gemini-embedding-001',dimensions:3},gemini:{api_key:'synthetic-legacy'},vertex:{project_id:'old',region:'us-central1'},ollama:{url:'http://localhost:11434'}} as unknown as AppConfig;
describe('selected embedding connection',()=>{
 it('uses selected credentials without rewriting legacy config and detects later edits',()=>{
  const db=new Database(':memory:');try{
   ensureSchema(db);const connection=createConnection(db,{name:'Synthetic',provider_type:'gemini',credentials:{api_key:'synthetic-selected'}});
   const config=structuredClone(base);config.embedding.connection=connection.id;
   const captured=captureEmbeddingConnection(db,config);
   expect(captured.config.gemini.api_key).toBe('synthetic-selected');expect(config.gemini.api_key).toBe('synthetic-legacy');
   expect(embeddingConnectionCurrent(db,connection.id,captured.binding)).toBe(true);
   db.prepare('UPDATE model_connections SET credentials=? WHERE id=?').run(JSON.stringify({api_key:'synthetic-new'}),connection.id);
   expect(embeddingConnectionCurrent(db,connection.id,captured.binding)).toBe(false);
  }finally{db.close();}
 });
 it('does not fall back to another credential when the selected connection is missing or archived',()=>{
  const db=new Database(':memory:');try{
   ensureSchema(db);const config=structuredClone(base);config.embedding.connection='mc_12345678';
   expect(()=>captureEmbeddingConnection(db,config)).toThrow('unavailable');
   const connection=createConnection(db,{name:'Synthetic',provider_type:'gemini',credentials:{api_key:'synthetic-selected'}});
   config.embedding.connection=connection.id;db.prepare('UPDATE model_connections SET archived=1 WHERE id=?').run(connection.id);
   expect(()=>captureEmbeddingConnection(db,config)).toThrow('unavailable');
  }finally{db.close();}
 });
});
