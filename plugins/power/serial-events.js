// Adapted from legacy blu-serial-lane.js: pure monotonic/clock-segment anchor mapping.
	function lowerBound(arr, v) {
		let lo = 0
		let hi = arr.length
		while (lo < hi) {
			const mid = (lo + hi) >>> 1
			if (arr[mid] < v) lo = mid + 1
			else hi = mid
		}
		return lo
	}

	/** 有序数组里第一个 > v 的下标 */
	function upperBound(arr, v) {
		let lo = 0
		let hi = arr.length
		while (lo < hi) {
			const mid = (lo + hi) >>> 1
			if (arr[mid] <= v) lo = mid + 1
			else hi = mid
		}
		return lo
	}

	/** [t0, t1] 闭区间落在有序 ts 里的 [lo, hi) */
	function visibleSlice(ts, t0, t1) {
		if (!(t1 >= t0)) return [0, 0]
		return [lowerBound(ts, t0), upperBound(ts, t1)]
	}

	/**
	 * 样点下标 ↔ 时间锚点。只做记录，不影响采样数据。
	 * note(li, tMs)：每个成功入库的样点调用一次（li 严格递增，tMs 为 performance.now 时间轴，单调）。
	 * 每 intervalMs 记一个锚点；相邻样点间隔超过 gapMs（停采后续采、USB 卡顿）时把断点两侧都记下，
	 * 避免线性插值把间隙摊到前一段样点上。映射以单调的 performance 时间轴为准(perfToLi / liToPerf)；
	 * 每个锚点另记当时的墙钟偏移 Date.now() - performance.now()，偏移突变超过 jumpMs(系统时钟回拨/跳变)时
	 * 开一个新映射段，墙钟换算(wallToPerf / wallToLi / liToWall)按段查找，不把墙钟钳成单调。
	 * 插值直接在锚点数组上二分，末样点(未必是锚点)单独处理，不复制数组：每帧对每条可见日志都要调一次。
	 */
	function createAnchorTrack(opts) {
		opts = opts || {}
		const intervalMs = opts.intervalMs > 0 ? opts.intervalMs : 200
		const gapMs = opts.gapMs > 0 ? opts.gapMs : 20
		const jumpMs = opts.jumpMs > 0 ? opts.jumpMs : 500
		const wallOffset = typeof opts.wallOffset === 'function'
			? opts.wallOffset
			: function () { return Date.now() - performance.now() }
		let lis = []
		let ts = []
		let offs = []
		// 各映射段起点在锚点数组里的下标
		let segs = []
		let lastLi = -1
		let lastT = 0
		let lastOff = 0
		let lastAnchorT = -Infinity

		function pushAnchor(li, t, off) {
			const n = lis.length
			if (n && lis[n - 1] === li) {
				ts[n - 1] = t
				offs[n - 1] = off
				return
			}
			if (!n || Math.abs(off - offs[n - 1]) > jumpMs) segs.push(n)
			lis.push(li)
			ts.push(t)
			offs.push(off)
		}

		function note(li, tMs) {
			if (lastLi >= 0 && tMs - lastT > gapMs) {
				pushAnchor(lastLi, lastT, lastOff)
				lastOff = wallOffset()
				pushAnchor(li, tMs, lastOff)
				lastAnchorT = tMs
			} else if (tMs - lastAnchorT >= intervalMs) {
				lastOff = wallOffset()
				pushAnchor(li, tMs, lastOff)
				lastAnchorT = tMs
			}
			lastLi = li
			lastT = tMs
		}

		function reset() {
			lis = []
			ts = []
			offs = []
			segs = []
			lastLi = -1
			lastT = 0
			lastOff = 0
			lastAnchorT = -Infinity
		}

		function has() {
			return lastLi >= 0 && lis.length > 0
		}

		function range() {
			if (!has()) return null
			return { li0: lis[0], li1: lastLi, t0: ts[0], t1: lastT, wall0: ts[0] + offs[0], wall1: lastT + lastOff }
		}

		/** 有效点数：锚点 + 末样点虚拟锚点(末样点不是锚点时) */
		function count() {
			const n = lis.length
			return n && lis[n - 1] !== lastLi ? n + 1 : n
		}

		/** xs/ys 为锚点数组，xTail/yTail 为末样点；x 超出已采集范围返回 null */
		function interp(xs, xTail, ys, yTail, x) {
			const real = xs.length
			const n = count()
			if (!n) return null
			const xEnd = n > real ? xTail : xs[real - 1]
			if (!(x >= xs[0] && x <= xEnd)) return null
			if (n === 1) return ys[0]
			let k = n > real && x >= xs[real - 1] ? real - 1 : upperBound(xs, x) - 1
			if (k >= n - 1) k = n - 2
			if (k < 0) k = 0
			const x0 = xs[k]
			const y0 = ys[k]
			const x1 = k + 1 < real ? xs[k + 1] : xTail
			const y1 = k + 1 < real ? ys[k + 1] : yTail
			const dx = x1 - x0
			if (!(dx > 0)) return y1
			return y0 + (y1 - y0) * (x - x0) / dx
		}

		/** performance 时间 → 小数样点下标；超出已采集范围返回 null */
		function perfToLi(t) {
			if (!has()) return null
			return interp(ts, lastT, lis, lastLi, t)
		}

		/** 样点下标 → performance 时间；超出范围返回 null */
		function liToPerf(li) {
			if (!has()) return null
			return interp(lis, lastLi, ts, lastT, li)
		}

		/**
		 * 墙钟毫秒 → performance 时间。按段查：时钟回拨后新旧两段的墙钟区间可能重叠，取最新一段
		 * (实时日志行有 performance 时间戳就不走这里，见界面部分的 stamps)。落在所有段外时按最新偏移换算。
		 */
		function wallToPerf(ms) {
			if (!has()) return ms - wallOffset()
			for (let s = segs.length - 1; s >= 0; s--) {
				const i0 = segs[s]
				const last = s === segs.length - 1
				const i1 = last ? lis.length - 1 : segs[s + 1] - 1
				const wLo = ts[i0] + offs[i0]
				const wHi = last ? lastT + lastOff : ts[i1] + offs[i1]
				if (ms < wLo || ms > wHi) continue
				// 段内偏移只有毫秒级漂移：先按段首偏移估 t，再取该处锚点的偏移
				const est = ms - offs[i0]
				let k = upperBound(ts, est) - 1
				if (k < i0) k = i0
				if (k > i1) k = i1
				return ms - offs[k]
			}
			return ms - lastOff
		}

		/** 墙钟毫秒 → 小数样点下标；超出已采集范围返回 null */
		function wallToLi(ms) {
			if (!has()) return null
			return perfToLi(wallToPerf(ms))
		}

		/** 样点下标 → 墙钟毫秒(按该样点所在段的偏移)；超出范围返回 null */
		function liToWall(li) {
			const t = liToPerf(li)
			if (t == null) return null
			let k = upperBound(lis, li) - 1
			if (k < 0) k = 0
			return t + offs[k]
		}

		return {
			pruneBefore(li) { const drop = Math.max(0, lowerBound(lis, li) - 1); if (!drop) return; lis.splice(0, drop); ts.splice(0, drop); offs.splice(0, drop); segs = [0]; for (let i = 1; i < offs.length; i++) if (Math.abs(offs[i] - offs[i - 1]) > jumpMs) segs.push(i) },
			note: note, reset: reset, has: has, range: range,
			perfToLi: perfToLi, liToPerf: liToPerf, wallToPerf: wallToPerf,
			wallToLi: wallToLi, liToWall: liToWall,
			anchorCount: function () { return lis.length },
			segmentCount: function () { return segs.length },
		}
	}

	/**
	 * 密集合并：xs 升序像素位置。与上一帧间距不超过 gapPx 的并进同一块，块宽超过 maxSpanPx 就另起一块，
	 * 连续密集流不会糊成一整条，计数也有地方写。返回 [{ x0, x1, n, i0, i1 }]，i0..i1 为 xs 的闭区间下标。
	 */
	function mergeMarks(xs, gapPx, maxSpanPx) {
		const span = maxSpanPx > 0 ? maxSpanPx : Infinity
		const out = []
		let cur = null
		for (let i = 0; i < xs.length; i++) {
			const x = xs[i]
			if (cur && x - cur.x1 <= gapPx && x - cur.x0 <= span) {
				cur.x1 = x
				cur.n++
				cur.i1 = i
			} else {
				cur = { x0: x, x1: x, n: 1, i0: i, i1: i }
				out.push(cur)
			}
		}
		return out
	}

	/** data-sid → 道键：单路全进 'S'；双路 B 进 'B'，其余（A、SYS）进 'A' */
export { createAnchorTrack, mergeMarks }
