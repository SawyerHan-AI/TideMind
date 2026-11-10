/** Session-only commissioning mode; normal restart restores background work. */
export function isSyncBootstrapCheck(): boolean {
  return process.argv.includes('--sync-bootstrap-check');
}
