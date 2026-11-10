import { createHash } from 'node:crypto';
/** Private transport scope, never part of a portable embedding profile. */
export function cloudEndpointIdentity(value = 'https://cloud.tidemind.ai'): { url: string; id: string } {
  const endpoint = new URL(value);
  if (!['https:','http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Invalid cloud service endpoint');
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') || '/';
  const url = endpoint.toString().replace(/\/$/, '');
  return { url, id: createHash('sha256').update(url).digest('hex') };
}
