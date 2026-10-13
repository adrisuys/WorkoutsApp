/* ==========================================================================
   Charts — hand-rolled SVG. No dependencies, nothing to keep up to date.

   Two forms, both with a hover/focus layer and a table-view twin in the page:
     Charts.columns(el, spec)  stacked columns over time
     Charts.lines(el, spec)    cumulative lines, one per year

   Shared rules baked in here: bars cap at 24px with a 4px rounded data-end
   square at the baseline, a 2px surface gap separates touching fills, grid
   and axes are solid hairlines, markers carry a 2px surface ring, and text
   never wears a series colour.
   ========================================================================== */

(function (global) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const BAR_MAX = 24;
  const BAR_RADIUS = 4;
  const GAP = 2;
  // A sport with nothing to measure in the chart's unit — strength training on
  // a distance chart — still happened. It gets a sliver this tall instead of
  // vanishing. Fixed in pixels on purpose: it is a presence mark, not a value,
  // and it must never be mistaken for one or move the scale.
  const STUB_H = 3;

  function svg(tag, attrs) {
    const node = document.createElementNS(NS, tag);
    for (const key in attrs) {
      const value = attrs[key];
      if (value !== undefined && value !== null) node.setAttribute(key, value);
    }
    return node;
  }

  function tokens(ref) {
    const cs = getComputedStyle(ref);
    const read = (name) => cs.getPropertyValue(name).trim();
    return {
      surface: read('--surface-1'),
      grid: read('--grid'),
      axis: read('--axis'),
      muted: read('--text-muted'),
      secondary: read('--text-secondary'),
      primary: read('--text-primary'),
      wash: read('--hover-wash'),
      rule: read('--target-rule'),
    };
  }

  /* --- scales ------------------------------------------------------------ */

  function niceTicks(max, target, integer) {
    if (!(max > 0)) return [0, 1];
    const rough = max / target;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm = rough / mag;
    // Fine-grained so the top gridline sits close to the tallest bar rather
    // than leaving a third of the plot empty.
    const nice = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    // Things you count have no halves: over a handful of sessions a day the
    // fine-grained step lands on 0.8, and "0.8 sessions" is not a gridline.
    const step = integer
      ? Math.max(1, Math.round((nice.find((n) => norm <= n + 1e-9) || 10) * mag))
      : (nice.find((n) => norm <= n + 1e-9) || 10) * mag;
    const ticks = [];
    for (let v = 0; v < max - 1e-9; v += step) ticks.push(round(v));
    ticks.push(round(ticks.length ? ticks[ticks.length - 1] + step : step));
    return ticks;
  }

  const round = (v) => Math.round(v * 1e6) / 1e6;

  /* --- marks ------------------------------------------------------------- */

  // A column: rounded at the data-end, square where it meets the baseline.
  // Opt-in: a series may carry a `stubs` array alongside `values`, counting
  // what happened in a bucket the chart's unit cannot express. Series without
  // one behave exactly as before.
  function stubAt(series, i) {
    return (series.stubs && series.stubs[i]) || 0;
  }

  function columnPath(x, y, w, h, radius) {
    const r = Math.max(0, Math.min(radius, w / 2, h));
    if (r < 1) return `M${x},${y}h${w}v${h}h${-w}z`;
    return `M${x},${y + r}` +
      `a${r},${r} 0 0 1 ${r},${-r}` +
      `h${w - 2 * r}` +
      `a${r},${r} 0 0 1 ${r},${r}` +
      `v${h - r}h${-w}z`;
  }

  /* --- tooltip ----------------------------------------------------------- */

  // A mouse cursor is a 1px hotspot with nothing around it, so a tooltip placed
  // below-right of it reads fine. A fingertip is ~40px across and the hand
  // covers everything below and to the right of it — which is precisely where
  // that placement puts the tooltip. Touch therefore gets the opposite
  // treatment: centred, and lifted clear above the contact point.
  const TOUCH_GAP = 28;
  let pointerKind = 'mouse';
  const trackPointer = (e) => { pointerKind = e.pointerType || 'mouse'; };
  document.addEventListener('pointerdown', trackPointer, { passive: true, capture: true });
  document.addEventListener('pointermove', trackPointer, { passive: true, capture: true });

  const tip = {
    node: null,
    el() {
      if (!this.node) this.node = document.getElementById('tooltip');
      return this.node;
    },
    // rows: [{label, value, color, total, muted}] — labels are data, so
    // textContent only.
    show(head, rows, anchor) {
      const el = this.el();
      if (!el) return;
      el.textContent = '';

      const header = document.createElement('div');
      header.className = 'tt-head';
      header.textContent = head;
      el.appendChild(header);

      for (const row of rows) {
        const line = document.createElement('div');
        line.className = 'tt-row' + (row.total ? ' tt-total' : '') + (row.muted ? ' tt-muted' : '');
        if (row.color) {
          const key = document.createElement('span');
          key.className = 'key-line';
          key.style.background = row.color;
          line.appendChild(key);
        }
        const name = document.createElement('span');
        name.className = 'tt-name';
        name.textContent = row.label;
        line.appendChild(name);
        const value = document.createElement('span');
        value.className = 'tt-value';
        value.textContent = row.value;
        line.appendChild(value);
        el.appendChild(line);
      }

      el.hidden = false;
      this.place(anchor);
    },
    place(anchor) {
      const el = this.el();
      const box = el.getBoundingClientRect();
      const pad = 10;
      const clamp = (v, limit) => Math.min(Math.max(v, pad), Math.max(pad, limit - pad));

      if (pointerKind === 'touch' || pointerKind === 'pen') {
        const x = clamp(anchor.x - box.width / 2, window.innerWidth - box.width);
        // Above the finger. Near the top of the screen there is no room, so
        // drop below it instead — still clear of the fingertip either way.
        let y = anchor.y - box.height - TOUCH_GAP;
        if (y < pad) y = anchor.y + TOUCH_GAP;
        y = clamp(y, window.innerHeight - box.height);
        el.style.left = `${Math.round(x)}px`;
        el.style.top = `${Math.round(y)}px`;
        return;
      }

      let x = anchor.x + 14;
      let y = anchor.y + 14;
      if (x + box.width + pad > window.innerWidth) x = anchor.x - box.width - 14;
      if (x < pad) x = pad;
      if (y + box.height + pad > window.innerHeight) y = anchor.y - box.height - 14;
      if (y < pad) y = pad;
      el.style.left = `${Math.round(x)}px`;
      el.style.top = `${Math.round(y)}px`;
    },
    hide() {
      const el = this.el();
      if (el) el.hidden = true;
    },
  };

  /* --- dismissing --------------------------------------------------------- */

  // A chart keeps its highlight state — wash band, crosshair — in its closure,
  // so dismissing from outside needs a way back in. A redraw replaces the
  // entry, so no closure over detached nodes survives.
  function registerClear(container, fn) {
    const state = observed.get(container);
    if (state) state.clear = fn;
  }

  function dismiss() {
    document.querySelectorAll('.chart').forEach((el) => {
      const state = observed.get(el);
      if (state && state.clear) state.clear();
    });
    tip.hide();
  }

  // Touch has no equivalent of moving the cursor away. pointerleave only fires
  // if the finger happens to lift over the chart, and starting a scroll on one
  // makes the browser claim the gesture and fire pointercancel instead — so a
  // tooltip opened by brushing a chart mid-scroll had nothing left to close it.
  // .tooltip is pointer-events:none, so it could not even be tapped away.
  document.addEventListener('pointerdown', (e) => {
    if (!e.target || typeof e.target.closest !== 'function' || !e.target.closest('.chart')) dismiss();
  }, { capture: true, passive: true });
  // Scroll events do not bubble, but they still reach a capturing listener.
  // Mouse hover survives a wheel scroll on purpose: the cursor is still there.
  window.addEventListener('scroll', () => {
    if (pointerKind === 'touch' || pointerKind === 'pen') dismiss();
  }, { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) dismiss();
  });

  /* --- column chart ------------------------------------------------------ */

  function drawColumns(container, spec) {
    const t = tokens(container);
    const width = Math.max(240, container.clientWidth || 320);
    const compact = !!spec.compact;
    const height = spec.height || (compact ? 150 : 300);

    const stackTotals = spec.buckets.map((_, i) =>
      spec.series.reduce((sum, s) => sum + Math.max(0, s.values[i] || 0), 0)
    );
    // A target the bars have never reached still has to fit on the chart, or
    // the rule would sit above the plot and read as "no target at all".
    const max = Math.max(...stackTotals, spec.rule || 0, 0);
    const ticks = niceTicks(max, compact ? 2 : 4, spec.integerTicks);
    const yMax = ticks[ticks.length - 1];

    // Leave room for the widest y label so nothing is clipped.
    const yLabels = ticks.map((v) => spec.formatTick(v));
    const labelWidth = Math.max(...yLabels.map((s) => s.length)) * (compact ? 6 : 6.6);
    const m = {
      top: compact ? 10 : 14,
      right: 6,
      bottom: compact ? 20 : 26,
      left: Math.ceil(labelWidth) + 12,
    };
    const plotW = Math.max(20, width - m.left - m.right);
    const plotH = Math.max(40, height - m.top - m.bottom);

    const yScale = (v) => m.top + plotH - (yMax ? (v / yMax) * plotH : 0);
    const band = plotW / spec.buckets.length;
    const barW = Math.min(BAR_MAX, Math.max(1, band - GAP));

    const root = svg('svg', {
      viewBox: `0 0 ${width} ${height}`,
      width,
      height,
      role: 'img',
      tabindex: '0',
      'aria-label': spec.ariaLabel || '',
    });

    // Gridlines — solid hairlines, one step off the surface.
    for (const value of ticks) {
      const y = yScale(value);
      root.appendChild(svg('line', {
        x1: m.left, x2: m.left + plotW, y1: y, y2: y,
        stroke: value === 0 ? t.axis : t.grid, 'stroke-width': 1,
        'shape-rendering': 'crispEdges',
      }));
      const label = svg('text', {
        x: m.left - 7, y: y + 3.5,
        'text-anchor': 'end',
        fill: t.muted,
        'font-size': compact ? 10 : 11,
        style: 'font-variant-numeric: tabular-nums',
      });
      label.textContent = spec.formatTick(value);
      root.appendChild(label);
    }

    // Hover wash sits behind the columns so the mark stays on top.
    const washes = svg('g', {});
    root.appendChild(washes);

    const bars = svg('g', {});
    spec.buckets.forEach((_, i) => {
      const x = m.left + i * band + (band - barW) / 2;
      const measured = spec.series.filter((s) => (s.values[i] || 0) > 0);
      // Slivers ride on top of the measured stack rather than in series order,
      // so the part of the column drawn to scale is never broken by a mark
      // that has no scale.
      const present = spec.series.filter(
        (s) => !((s.values[i] || 0) > 0) && stubAt(s, i) > 0
      );

      let cum = 0;
      let top = m.top + plotH;              // pixel top of the column so far
      measured.forEach((s, si) => {
        const value = s.values[i];
        const yBottom = yScale(cum) - (cum > 0 ? GAP : 0);
        const yTop = yScale(cum + value);
        cum += value;
        const h = yBottom - yTop;
        if (h <= 0.4) return;
        const capped = si === measured.length - 1 && !present.length;
        bars.appendChild(svg('path', {
          d: columnPath(x, yTop, barW, h, capped ? BAR_RADIUS : 0),
          fill: s.color,
        }));
        top = yTop;
      });

      present.forEach((s, si) => {
        const yTop = top - (top < m.top + plotH ? GAP : 0) - STUB_H;
        bars.appendChild(svg('path', {
          d: columnPath(x, yTop, barW, STUB_H, si === present.length - 1 ? BAR_RADIUS : 0),
          fill: s.color,
        }));
        top = yTop;
      });
    });
    root.appendChild(bars);

    // Target rule — over the bars, because the question it answers is which
    // side of it each one lands on.
    //
    // Cased: the same dashes go down first in the surface colour and a little
    // thicker, so every dash carries a halo. Red over green is the classic
    // colour-vision confusion pair and this rule crosses the hiking bars, so
    // the casing lets it separate by *lightness* as well as hue — it stays a
    // line you can follow whether or not the red reads as red.
    if (spec.rule > 0) {
      const y = yScale(spec.rule);
      const dashes = {
        x1: m.left, x2: m.left + plotW, y1: y, y2: y,
        'stroke-dasharray': '4 3', 'stroke-linecap': 'butt',
      };
      root.appendChild(svg('line', {
        ...dashes, stroke: t.surface, 'stroke-width': 3.8, opacity: 0.9,
      }));
      root.appendChild(svg('line', {
        ...dashes, stroke: t.rule, 'stroke-width': 1.6,
      }));
    }

    // X labels, thinned from the right so the most recent one always shows.
    // `labelWidth` is how much room one label needs: short labels (weekdays)
    // can sit closer together than the dates this was sized for.
    const perLabel = spec.labelWidth || (compact ? 42 : 54);
    const step = Math.max(1, Math.ceil(spec.buckets.length / Math.max(1, Math.floor(plotW / perLabel))));
    for (let i = spec.buckets.length - 1; i >= 0; i -= step) {
      const marked = i === spec.emphasisIndex;
      const label = svg('text', {
        x: m.left + i * band + band / 2,
        y: height - (compact ? 6 : 9),
        'text-anchor': 'middle',
        fill: marked ? t.secondary : t.muted,
        'font-size': compact ? 10 : 11,
        'font-weight': marked ? 600 : 400,
      });
      label.textContent = spec.xLabels[i];
      root.appendChild(label);
    }

    // Hit layer: one full-height target per bucket, always wider than the bar.
    const hits = svg('g', {});
    let active = -1;

    const showAt = (i, point) => {
      if (i < 0 || i >= spec.buckets.length) return;
      active = i;
      washes.textContent = '';
      washes.appendChild(svg('rect', {
        x: m.left + i * band, y: m.top, width: band, height: plotH, fill: t.wash,
      }));
      const rows = spec.series
        .map((s) => {
          const value = s.values[i] || 0;
          if (value > 0) {
            return { label: s.label, value: spec.formatValue(value), color: s.color };
          }
          // A sliver says something happened; the tooltip is where it says
          // what, since the chart's own unit has no answer for it.
          const stub = stubAt(s, i);
          if (!stub) return null;
          return {
            label: s.label,
            value: spec.formatStub ? spec.formatStub(stub) : '—',
            color: s.color,
            muted: true,
          };
        })
        .filter(Boolean)
        .reverse();
      if (spec.series.length > 1) {
        rows.push({ label: 'Total', value: spec.formatValue(stackTotals[i]), total: true });
      }
      if (!rows.length) rows.push({ label: 'Nothing logged', value: '—' });
      tip.show(spec.xTooltips[i], rows, point);
    };

    const clear = () => {
      active = -1;
      washes.textContent = '';
      tip.hide();
    };

    spec.buckets.forEach((_, i) => {
      const hit = svg('rect', {
        x: m.left + i * band, y: m.top, width: band, height: plotH,
        fill: 'transparent',
      });
      hit.addEventListener('pointerenter', (e) => showAt(i, { x: e.clientX, y: e.clientY }));
      hit.addEventListener('pointermove', (e) => {
        if (active === i) tip.place({ x: e.clientX, y: e.clientY });
        else showAt(i, { x: e.clientX, y: e.clientY });
      });
      hits.appendChild(hit);
    });
    root.appendChild(hits);

    root.addEventListener('pointerleave', clear);
    root.addEventListener('pointercancel', clear);
    root.addEventListener('blur', clear);
    registerClear(container, clear);
    root.addEventListener('keydown', (e) => {
      const last = spec.buckets.length - 1;
      let next = active;
      if (e.key === 'ArrowRight') next = active < 0 ? 0 : Math.min(last, active + 1);
      else if (e.key === 'ArrowLeft') next = active < 0 ? last : Math.max(0, active - 1);
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = last;
      else if (e.key === 'Escape') { clear(); return; }
      else return;
      e.preventDefault();
      const box = root.getBoundingClientRect();
      const scale = box.width / width;
      showAt(next, {
        x: box.left + (m.left + next * band + band / 2) * scale,
        y: box.top + (m.top + plotH / 2) * scale,
      });
    });

    container.textContent = '';
    container.appendChild(root);
  }

  /* --- line chart -------------------------------------------------------- */

  function drawLines(container, spec) {
    const t = tokens(container);
    const width = Math.max(240, container.clientWidth || 320);
    const compact = !!spec.compact;
    const height = spec.height || (compact ? 170 : 300);

    const max = Math.max(0, ...spec.lines.flatMap((l) => l.points.map((p) => p.y)));
    const ticks = niceTicks(max, compact ? 2 : 4);
    const yMax = ticks[ticks.length - 1];
    const yLabels = ticks.map((v) => spec.formatTick(v));
    const labelWidth = Math.max(...yLabels.map((s) => s.length)) * (compact ? 6 : 6.6);

    const m = {
      top: compact ? 10 : 14,
      right: compact ? 30 : 40,   // room for the end label of the current line
      bottom: compact ? 20 : 26,
      left: Math.ceil(labelWidth) + 12,
    };
    const plotW = Math.max(20, width - m.left - m.right);
    const plotH = Math.max(40, height - m.top - m.bottom);

    const xScale = (v) => m.left + (v / spec.xMax) * plotW;
    const yScale = (v) => m.top + plotH - (yMax ? (v / yMax) * plotH : 0);

    const root = svg('svg', {
      viewBox: `0 0 ${width} ${height}`,
      width,
      height,
      role: 'img',
      tabindex: '0',
      'aria-label': spec.ariaLabel || '',
    });

    for (const value of ticks) {
      const y = yScale(value);
      root.appendChild(svg('line', {
        x1: m.left, x2: m.left + plotW, y1: y, y2: y,
        stroke: value === 0 ? t.axis : t.grid, 'stroke-width': 1,
        'shape-rendering': 'crispEdges',
      }));
      const label = svg('text', {
        x: m.left - 7, y: y + 3.5, 'text-anchor': 'end', fill: t.muted,
        'font-size': compact ? 10 : 11,
        style: 'font-variant-numeric: tabular-nums',
      });
      label.textContent = spec.formatTick(value);
      root.appendChild(label);
    }

    for (const tick of spec.xTicks) {
      const label = svg('text', {
        x: xScale(tick.x), y: height - (compact ? 6 : 9),
        'text-anchor': 'middle', fill: t.muted, 'font-size': compact ? 10 : 11,
      });
      label.textContent = tick.label;
      root.appendChild(label);
    }

    const crosshair = svg('line', {
      y1: m.top, y2: m.top + plotH, stroke: t.axis, 'stroke-width': 1,
      'shape-rendering': 'crispEdges', opacity: 0,
    });
    root.appendChild(crosshair);

    for (const line of spec.lines) {
      const d = line.points
        .map((p, i) => `${i ? 'L' : 'M'}${xScale(p.x).toFixed(1)},${yScale(p.y).toFixed(1)}`)
        .join('');
      root.appendChild(svg('path', {
        d, fill: 'none', stroke: line.color, 'stroke-width': 2,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round',
        opacity: line.emphasis === false ? 0.85 : 1,
      }));
    }

    // Direct-label only the line the reader is asking about — the current one.
    const lead = spec.lines.find((l) => l.emphasis);
    if (lead && lead.points.length) {
      const end = lead.points[lead.points.length - 1];
      const cx = xScale(end.x);
      const cy = yScale(end.y);
      root.appendChild(svg('circle', {
        cx, cy, r: 4, fill: lead.color, stroke: t.surface, 'stroke-width': 2,
      }));
      // A current-year line usually ends mid-plot, on top of the other years —
      // a surface-coloured stroke behind the glyphs keeps the label readable.
      const label = svg('text', {
        x: Math.min(cx + 8, width - 2), y: cy + 3.5,
        'text-anchor': cx + 8 + 28 > width ? 'end' : 'start',
        fill: t.muted, 'font-size': compact ? 10 : 11,
        stroke: t.surface, 'stroke-width': 3, 'paint-order': 'stroke fill',
        'stroke-linejoin': 'round',
        style: 'font-variant-numeric: tabular-nums',
      });
      label.textContent = lead.label;
      root.appendChild(label);
    }

    // Crosshair snaps to the X; the readout lists every line at that X.
    const hit = svg('rect', {
      x: m.left, y: m.top, width: plotW, height: plotH, fill: 'transparent',
    });
    let activeX = -1;

    const valueAt = (line, x) => {
      let value = 0;
      for (const p of line.points) {
        if (p.x > x) break;
        value = p.y;
      }
      return value;
    };

    const showAt = (x, point) => {
      activeX = Math.max(0, Math.min(spec.xMax, Math.round(x)));
      crosshair.setAttribute('x1', xScale(activeX));
      crosshair.setAttribute('x2', xScale(activeX));
      crosshair.setAttribute('opacity', 1);
      const rows = spec.lines
        .map((l) => ({ label: l.label, value: spec.formatValue(valueAt(l, activeX)), color: l.color }))
        .reverse();
      tip.show(spec.formatX(activeX), rows, point);
    };

    const clear = () => {
      activeX = -1;
      crosshair.setAttribute('opacity', 0);
      tip.hide();
    };

    const toDataX = (clientX) => {
      const box = root.getBoundingClientRect();
      const scale = width / box.width;
      return ((clientX - box.left) * scale - m.left) / plotW * spec.xMax;
    };

    hit.addEventListener('pointermove', (e) => showAt(toDataX(e.clientX), { x: e.clientX, y: e.clientY }));
    hit.addEventListener('pointerenter', (e) => showAt(toDataX(e.clientX), { x: e.clientX, y: e.clientY }));
    root.appendChild(hit);

    root.addEventListener('pointerleave', clear);
    root.addEventListener('pointercancel', clear);
    root.addEventListener('blur', clear);
    registerClear(container, clear);
    root.addEventListener('keydown', (e) => {
      const stride = Math.max(1, Math.round(spec.xMax / 24));
      let next = activeX;
      if (e.key === 'ArrowRight') next = activeX < 0 ? 0 : Math.min(spec.xMax, activeX + stride);
      else if (e.key === 'ArrowLeft') next = activeX < 0 ? spec.xMax : Math.max(0, activeX - stride);
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = spec.xMax;
      else if (e.key === 'Escape') { clear(); return; }
      else return;
      e.preventDefault();
      const box = root.getBoundingClientRect();
      const scale = box.width / width;
      showAt(next, {
        x: box.left + xScale(next) * scale,
        y: box.top + (m.top + plotH / 2) * scale,
      });
    });

    container.textContent = '';
    container.appendChild(root);
  }

  /* --- point chart (race progression) ------------------------------------ */

  // Nice steps for a *time* axis — seconds don't divide by ten.
  const TIME_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

  function timeTicks(min, max, target) {
    const span = Math.max(max - min, 0.1);
    const rough = span / target;
    const step = TIME_STEPS.find((s) => s >= rough) || TIME_STEPS[TIME_STEPS.length - 1];
    const first = Math.floor(min / step) * step;
    const ticks = [];
    for (let v = first; v <= max + step * 1e-9; v += step) ticks.push(round(v));
    // The axis must *cover* the data. Without this the slowest swim renders
    // above the top gridline and gets clipped out of the plot entirely.
    while (ticks[ticks.length - 1] < max) {
      ticks.push(round(ticks[ticks.length - 1] + step));
    }
    if (ticks.length < 2) ticks.push(round(ticks[0] + step));
    return ticks;
  }

  // A handful of results over time: the marks are the data, not the trend, so
  // dots lead and the connecting line is a faint aid. Y is elapsed time and is
  // NOT zero-based — a zero baseline would flatten every race into one band —
  // and it is not inverted either, because a silently flipped axis misleads.
  function drawPoints(container, spec) {
    const t = tokens(container);
    const width = Math.max(240, container.clientWidth || 320);
    const compact = !!spec.compact;
    const height = spec.height || (compact ? 170 : 260);

    const values = spec.points.map((p) => p.y);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    // Cover the data range only — headroom for the value labels comes from the
    // pixel margins, not from inflating the scale, which would squash the marks
    // into a narrow band in the middle of the plot.
    const ticks = hi - lo < 1e-9
      ? timeTicks(lo - 1, hi + 1, 2)
      : timeTicks(lo, hi, compact ? 3 : 4);
    const yLo = ticks[0];
    const yHi = ticks[ticks.length - 1];

    const yLabels = ticks.map((v) => spec.formatTick(v));
    const labelWidth = Math.max(...yLabels.map((s) => s.length)) * (compact ? 6 : 6.6);
    const m = {
      top: compact ? 25 : 29,          // headroom for the value labels
      right: 14,
      bottom: compact ? 20 : 26,
      left: Math.ceil(labelWidth) + 12,
    };
    const plotW = Math.max(20, width - m.left - m.right);
    const plotH = Math.max(40, height - m.top - m.bottom);

    const xSpan = Math.max(spec.xMax - spec.xMin, 1);
    // Inset so the first and last marks don't sit on the axis.
    const inset = Math.min(plotW * 0.12, 26);
    const xScale = (v) => m.left + inset + ((v - spec.xMin) / xSpan) * (plotW - inset * 2);
    const yScale = (v) => m.top + plotH - ((v - yLo) / (yHi - yLo)) * plotH;

    const root = svg('svg', {
      viewBox: `0 0 ${width} ${height}`,
      width,
      height,
      role: 'img',
      tabindex: '0',
      'aria-label': spec.ariaLabel || '',
    });

    for (const value of ticks) {
      const y = yScale(value);
      root.appendChild(svg('line', {
        x1: m.left, x2: m.left + plotW, y1: y, y2: y,
        stroke: t.grid, 'stroke-width': 1, 'shape-rendering': 'crispEdges',
      }));
      const label = svg('text', {
        x: m.left - 7, y: y + 3.5, 'text-anchor': 'end', fill: t.muted,
        'font-size': compact ? 10 : 11,
        style: 'font-variant-numeric: tabular-nums',
      });
      label.textContent = spec.formatTick(value);
      root.appendChild(label);
    }

    // Thin x labels from the right, so the most recent race always keeps its
    // label and nothing collides with a neighbour.
    const minGap = compact ? 44 : 56;
    const candidates = spec.xTicks
      .filter((tick) => tick.x >= spec.xMin && tick.x <= spec.xMax)
      .sort((a, b) => a.x - b.x);
    const keptTicks = [];
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const px = xScale(candidates[i].x);
      if (!keptTicks.length || keptTicks[keptTicks.length - 1].px - px >= minGap) {
        keptTicks.push({ ...candidates[i], px });
      }
    }
    for (const tick of keptTicks) {
      const label = svg('text', {
        x: tick.px, y: height - (compact ? 6 : 9),
        'text-anchor': 'middle', fill: t.muted, 'font-size': compact ? 10 : 11,
      });
      label.textContent = tick.label;
      root.appendChild(label);
    }

    const ordered = [...spec.points].sort((a, b) => a.x - b.x);

    root.appendChild(svg('path', {
      d: ordered.map((p, i) => `${i ? 'L' : 'M'}${xScale(p.x).toFixed(1)},${yScale(p.y).toFixed(1)}`).join(''),
      fill: 'none', stroke: spec.color, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round', opacity: 0.35,
    }));

    ordered.forEach((point) => {
      root.appendChild(svg('circle', {
        cx: xScale(point.x), cy: yScale(point.y), r: point.best ? 5.5 : 4,
        fill: spec.color, stroke: t.surface, 'stroke-width': 2,
      }));
      if (point.best) {   // second ring marks the best without adding a hue
        root.appendChild(svg('circle', {
          cx: xScale(point.x), cy: yScale(point.y), r: 8.5,
          fill: 'none', stroke: spec.color, 'stroke-width': 1.5, opacity: 0.55,
        }));
      }
    });

    // Value labels last, so their surface halo sits over the marks and the text
    // always wins. Offset clears the best-mark's outer ring (r 8.5).
    // Few enough marks that labelling each one helps rather than floods; marks
    // close together would collide, so flip the second one below its dot, and
    // if that still collides drop the label — the tooltip and the "Every race"
    // table keep the number reachable either way. The best is never dropped.
    const charWidth = compact ? 5.4 : 5.9;
    const placed = [];
    ordered.forEach((point) => {
      const cx = xScale(point.x);
      const cy = yScale(point.y);
      const halfWidth = (point.label.length * charWidth) / 2 + 4;
      let below = cy < m.top + 16;
      let y = below ? cy + 19 : cy - 15;

      const collides = () => placed.some((other) =>
        Math.abs(other.x - cx) < other.halfWidth + halfWidth
        && Math.abs(other.y - y) < 12
      );

      if (collides()) {
        below = !below;
        y = below ? cy + 19 : cy - 15;
        if (collides() && !point.best) return;   // give up rather than overlap
      }

      const label = svg('text', {
        x: Math.max(m.left + 2, Math.min(cx, width - 4)),
        y,
        'text-anchor': cx > width - 26 ? 'end' : cx < m.left + 24 ? 'start' : 'middle',
        fill: point.best ? t.secondary : t.muted,
        'font-size': compact ? 10 : 11,
        'font-weight': point.best ? 600 : 400,
        stroke: t.surface, 'stroke-width': 3, 'paint-order': 'stroke fill',
        'stroke-linejoin': 'round',
        style: 'font-variant-numeric: tabular-nums',
      });
      label.textContent = point.label;
      root.appendChild(label);
      placed.push({ x: cx, y, halfWidth });
    });

    // Nearest-point hover: a 4px dot is not a hit target.
    let active = -1;
    const showAt = (index, anchor) => {
      const point = ordered[index];
      if (!point) return;
      active = index;
      const rows = [{ label: spec.valueLabel || 'Time', value: point.label, color: spec.color }];
      if (point.best) rows.push({ label: 'Personal best', value: '★' });
      else if (point.gap) rows.push({ label: 'Behind best', value: point.gap, total: true });
      if (point.pace) rows.push({ label: 'Per 100 m', value: point.pace });
      tip.show(point.tooltip || point.date, rows, anchor);
    };
    const clear = () => { active = -1; tip.hide(); };

    const hit = svg('rect', {
      x: m.left, y: m.top, width: plotW, height: plotH, fill: 'transparent',
    });
    const nearest = (clientX, clientY) => {
      const box = root.getBoundingClientRect();
      const scale = width / box.width;
      const px = (clientX - box.left) * scale;
      const py = (clientY - box.top) * scale;
      let bestIndex = -1;
      let bestDistance = Infinity;
      ordered.forEach((point, i) => {
        const dx = xScale(point.x) - px;
        const dy = yScale(point.y) - py;
        const distance = dx * dx + dy * dy;
        if (distance < bestDistance) { bestDistance = distance; bestIndex = i; }
      });
      return bestIndex;
    };
    const onMove = (e) => showAt(nearest(e.clientX, e.clientY), { x: e.clientX, y: e.clientY });
    hit.addEventListener('pointermove', onMove);
    hit.addEventListener('pointerenter', onMove);
    root.appendChild(hit);

    root.addEventListener('pointerleave', clear);
    root.addEventListener('pointercancel', clear);
    root.addEventListener('blur', clear);
    registerClear(container, clear);
    root.addEventListener('keydown', (e) => {
      const last = ordered.length - 1;
      let next = active;
      if (e.key === 'ArrowRight') next = active < 0 ? 0 : Math.min(last, active + 1);
      else if (e.key === 'ArrowLeft') next = active < 0 ? last : Math.max(0, active - 1);
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = last;
      else if (e.key === 'Escape') { clear(); return; }
      else return;
      e.preventDefault();
      const box = root.getBoundingClientRect();
      const scale = box.width / width;
      showAt(next, {
        x: box.left + xScale(ordered[next].x) * scale,
        y: box.top + yScale(ordered[next].y) * scale,
      });
    });

    container.textContent = '';
    container.appendChild(root);
  }

  /* --- public API -------------------------------------------------------- */

  const observed = new WeakMap();
  let observer = null;

  function ensureObserver() {
    if (observer || typeof ResizeObserver === 'undefined') return;
    let frame = null;
    observer = new ResizeObserver((entries) => {
      const dirty = entries
        .map((entry) => entry.target)
        .filter((el) => {
          const state = observed.get(el);
          if (!state) return false;
          const w = el.clientWidth;
          if (Math.abs(w - state.width) < 8) return false;
          state.width = w;
          return true;
        });
      if (!dirty.length) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => dirty.forEach(redraw));
    });
  }

  const RENDERERS = { columns: drawColumns, lines: drawLines, points: drawPoints };

  function redraw(container) {
    const state = observed.get(container);
    if (!state || !state.spec) return;
    RENDERERS[state.kind](container, state.spec);
  }

  // ResizeObserver is the primary path, but it is suspended while the tab is
  // hidden — a phone rotated in the background comes back stale otherwise.
  let resizeTimer = null;
  const onViewportChange = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      document.querySelectorAll('.chart').forEach(redraw);
    }, 150);
  };
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('orientationchange', onViewportChange);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) onViewportChange();
  });

  function mount(kind, container, spec) {
    ensureObserver();
    let state = observed.get(container);
    if (!state) {
      state = { width: container.clientWidth };
      observed.set(container, state);
      if (observer) observer.observe(container);
    }
    state.kind = kind;
    state.spec = spec;
    state.width = container.clientWidth;
    RENDERERS[kind](container, spec);
  }

  global.Charts = {
    columns: (container, spec) => mount('columns', container, spec),
    lines: (container, spec) => mount('lines', container, spec),
    points: (container, spec) => mount('points', container, spec),
    redrawAll: () => {
      document.querySelectorAll('.chart').forEach((el) => redraw(el));
    },
    hideTooltip: dismiss,
  };
})(window);
