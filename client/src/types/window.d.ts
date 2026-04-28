import type { AppApi } from '../lib/api-contract'

declare global {
  interface Window {
    api: AppApi
  }
}

export {}
