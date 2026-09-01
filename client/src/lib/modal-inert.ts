export interface InertRoot {
  inert: boolean
}

interface InertLeaseState {
  count: number
  original: boolean
}

const leases = new WeakMap<InertRoot, InertLeaseState>()

/**
 * Makes the application root inert for a portal modal. Leases are reference
 * counted so closing one of several mounted modals cannot re-enable the page
 * underneath the remaining modal.
 */
export function acquireModalInert(root: InertRoot | null): () => void {
  if (!root) return () => {}
  const current = leases.get(root)
  if (current) current.count += 1
  else leases.set(root, { count: 1, original: root.inert })
  root.inert = true

  let released = false
  return () => {
    if (released) return
    released = true
    const lease = leases.get(root)
    if (!lease) return
    lease.count -= 1
    if (lease.count > 0) return
    root.inert = lease.original
    leases.delete(root)
  }
}
