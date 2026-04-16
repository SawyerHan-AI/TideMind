export function now(): string {
  return new Date().toISOString();
}

export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function hoursAgo(isoString: string): number {
  return (Date.now() - new Date(isoString).getTime()) / (1000 * 60 * 60);
}

export function daysAgo(isoString: string): number {
  return hoursAgo(isoString) / 24;
}
