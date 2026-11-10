export function ui(host, title) {
 const doc = host.mount.ownerDocument
 const root = doc.createElement('section'); host.mount.append(root)
 const make = (tag, text, parent = root) => { const el = doc.createElement(tag); if (text != null) el.textContent = text; parent.append(el); return el }
 make('h2', title)
 const status = make('output', 'Ready')
 status.setAttribute('aria-live', 'polite')
 const report = error => { status.textContent = error?.message || String(error) }
 const run = async fn => { try { return await fn() } catch (e) { report(e) } }
 const button = (text, fn, parent) => { const b = make('button', text, parent); b.type = 'button'; b.addEventListener('click', () => run(fn), { signal: host.signal }); return b }
 const input = (label, value = '', type = 'text') => { const wrap = make('label', label + ' '); const el = make('input', null, wrap); el.type = type; el.value = value; return el }
 const select = (label, entries) => { const wrap = make('label', label + ' '); const el = make('select', null, wrap); for (const [value, text] of entries) { const option = make('option', text, el); option.value = value } return el }
 const download = (data, name, type = 'application/octet-stream') => { const url = URL.createObjectURL(new Blob([data], { type })); const a = make('a', 'Save ' + name); a.href = url; a.download = name; a.click(); a.remove(); URL.revokeObjectURL(url) }
 return { root, make, button, input, select, status, report, run, download, dispose: () => root.remove() }
}
