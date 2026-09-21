/** Quote one literal argument for a POSIX shell command stored in host config. */
export function shellArgument(value: string): string {
  if (value.includes('\0')) throw new Error('shell_argument_contains_nul')
  return `'${value.replace(/'/gu, `'"'"'`)}'`
}
