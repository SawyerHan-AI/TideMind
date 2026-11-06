import { runDiagnosticSupervisor } from './agent-diagnostic-runner.js';
void runDiagnosticSupervisor().catch(() => {
  process.stderr.write('agent_diagnostic:supervisor_failed\n');
  process.exitCode = 1;
});
