// Adapt sink-based device driver to SDK streams. Close waits for real I/O drain.
export function createStreamPort(driver) {
 let generation = 0, opening = null, closing = null, chain = Promise.resolve(), controller = null, state = 'closed'
 const port = {
  readable: null, writable: null,
  getInfo: () => driver.getInfo?.() || {},
  get state() { return state },
  async open(options) {
   if (state !== 'closed') throw Error('Port busy')
   state = 'opening'; const token = ++generation
   port.readable = new ReadableStream({ start(c) { controller = c } }, { highWaterMark: 65536, size: b => b.length })
   const fail = e => { if (token !== generation) return; ++generation; state = 'lost'; try { controller.error(e) } catch {} }
   opening = (async () => {
    try {
     await driver.open(options, {
      data(bytes) { if (token !== generation) return; if (controller.desiredSize < -65536) { fail(Error('Receive overflow')); return }; controller.enqueue(bytes.slice()) },
      lost: fail, error: fail,
     })
     if (token !== generation) throw Error('Open cancelled')
     const makeWritable = () => new WritableStream({ write(bytes) {
      const copy = bytes.slice()
      const job = chain.then(async () => { if (token !== generation) throw Error('Stale connection'); await driver.write(copy); if (token !== generation) throw Error('Connection lost during write') })
      chain = job.catch(() => {}); return job.catch(error => { if (token === generation && state === 'open') port.writable = makeWritable(); throw error })
     } })
     port.writable = makeWritable(); state = 'open'
    } catch (e) { if (state !== 'closing') { state = 'cleanup-needed'; try { controller.error(e) } catch {} }; await driver.close(); if (state !== 'closing') { state = 'closed'; port.readable = port.writable = null }; throw e }
   })()
   return opening
  },
  async close() {
   if (closing) return closing
   if (state === 'closed') return
   state = 'closing'; ++generation
   closing = (async () => {
    try { await opening?.catch(() => {}); await chain; await driver.close(); try { controller?.close() } catch {}; port.readable = port.writable = null; state = 'closed' }
    catch (e) { state = 'cleanup-needed'; throw e }
    finally { closing = null }
   })()
   return closing
  },
 }
 return port
}
