import { cliErrorChain } from '../../../src/llm/cli/failure-diagnostics.js';
it('retains nested error metadata, bounds cycles and omits child command/output', () => {
 const inner = Object.assign(new Error('database is locked'), {code:'SQLITE_BUSY'});
 const outer = new Error('Command failed: codex --secret value\nprivate response', {cause:inner});
 inner.cause=outer;
 expect(cliErrorChain(outer)).toEqual([
  {name:'Error',message:'Command failed (command/output omitted)'},
  {name:'Error',message:'database is locked',code:'SQLITE_BUSY'},
 ]);
});
it('redacts credential forms and URLs without serializing arbitrary properties', () => {
 const e=Object.assign(new Error('Bearer secret api_key=abc sk-secret https://host/?token=value'),{stdout:'private answer',prompt:'private prompt'});
 const text=JSON.stringify(cliErrorChain(e));
 expect(text).not.toContain('secret');expect(text).not.toContain('abc');expect(text).not.toContain('private');expect(text).not.toContain('host');
});

it('omits parser input snippets from native SyntaxError messages', () => {
 expect(cliErrorChain(new SyntaxError('Unexpected token in private model answer'))[0].message).not.toContain('private model answer');
});
