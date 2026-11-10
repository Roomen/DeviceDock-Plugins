import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mockHost } from './helpers.js'
import { activate as power } from '../plugins/power/index.js'
import { activate as firmware } from '../plugins/firmware/index.js'
import { activate as wireless } from '../plugins/wireless/index.js'
import { activate as bridge } from '../plugins/bridge/index.js'
// Minimal mount-scoped DOM contract. No global document/window is installed.
class Element extends EventTarget {
 constructor(tag, doc) { super(); this.tag = tag; this.ownerDocument = doc; this.children = []; this.value = ''; this.files = [] }
 append(el) { this.children.push(el); el.parent = this }
 remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this) }
 replaceChildren() { this.children = [] }
 setAttribute() {}
 getContext() { return null }
}
export function documentMock() { const doc = { createElement: tag => new Element(tag, doc) }; return doc }
test('all four plugins activate/deactivate repeatedly against SDK mock with no globals/resources left', async () => {
 const host = mockHost(), doc = documentMock(); host.mount = doc.createElement('main')
 const registered = new Map(), preflight = new Set()
 host.registerTransport = provider => { assert.equal(registered.has(provider.id), false); registered.set(provider.id, provider); return () => registered.delete(provider.id) }
 host.prepareDeactivate = check => { preflight.add(check); return () => preflight.delete(check) }
 for (let i = 0; i < 3; i++) {
  const cleanups = [power(host), firmware(host), wireless(host), bridge(host)]
  assert.equal(host.services.size, 3); assert.equal(host.resourcesMap.size, 1)
  for (const check of preflight) await check()
  for (const cleanup of cleanups.reverse()) await cleanup()
  assert.equal(host.services.size, 0); assert.equal(host.resourcesMap.size, 0); assert.equal(host.mount.children.length, 0); assert.equal(preflight.size, 0); assert.equal(registered.size, 0)
 }
})
