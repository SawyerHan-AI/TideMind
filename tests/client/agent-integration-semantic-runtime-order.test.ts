import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron',()=>({app:{getPath:()=>'/tmp/synthetic-runtime-order',getVersion:()=> 'fixture',getAppPath:()=>'/tmp/Fixture.app',isPackaged:false},Notification:class{static isSupported(){return false} show(){}}}))
import { ProductionAgentIntegrationRuntime } from '../../client/electron/agent-integration/production-service.js'

describe('semantic readback maintenance scheduling',()=>{
  afterEach(()=>vi.useRealTimers())

  it.each([[true,false],[false,true],[true,true]])('aggregates exact=%s semantic=%s retry after recovery with autoRestore off',async(exact,semantic)=>{
    vi.useFakeTimers()
    const order:string[]=[]
    const dependencies={
      observeOnly:false,autoRestore:false,
      renewCodexContinuity:async()=>{order.push('exact');return exact},
      renewCodexMcpSemanticReadbacks:async()=>{order.push('semantic');return semantic},
      coordinator:{recoverNonTerminalRuns:async()=>{order.push('recovery')}},
    } as unknown as ConstructorParameters<typeof ProductionAgentIntegrationRuntime>[0]
    const runtime=new ProductionAgentIntegrationRuntime(dependencies)
    const scan=vi.fn(async()=>{order.push('scan')})
    runtime.configureScheduler(scan,60_000)
    try {
      await runtime.markScanCompleted()
      expect(order).toEqual(['exact','recovery','semantic'])
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(scan).toHaveBeenCalledTimes(1)
      expect(order).toEqual(['exact','recovery','semantic','scan','exact','recovery','semantic'])
      runtime.stop()
      expect(vi.getTimerCount()).toBe(0)
    } finally {runtime.stop()}
  })

  it.each(['stop','new-scan'] as const)('does not run semantic readback after %s during recovery',async boundary=>{
    let entered!:()=>void,release!:()=>void
    const started=new Promise<void>(resolve=>{entered=resolve})
    const semantic=vi.fn(async()=>false)
    const dependencies={observeOnly:false,autoRestore:false,
      coordinator:{recoverNonTerminalRuns:async()=>{entered();await new Promise<void>(resolve=>{release=resolve})}},
      renewCodexMcpSemanticReadbacks:semantic,
    } as unknown as ConstructorParameters<typeof ProductionAgentIntegrationRuntime>[0]
    const runtime=new ProductionAgentIntegrationRuntime(dependencies)
    try {
      const maintenance=runtime.markScanCompleted()
      await started
      if(boundary==='stop')runtime.stop();else runtime.markScanStarted()
      release()
      await maintenance
      expect(semantic).not.toHaveBeenCalled()
      expect(runtime.canPublishReadback()).toBe(false)
    } finally {runtime.stop()}
  })
})
