import type { Api } from '../shared/api'

declare global {
  interface Window {
    api: Api
    appCtl: {
      confirmClose(): Promise<void>
      toggleDevTools(): Promise<void>
      pathForFile(f: File): string
    }
  }
}
export {}
