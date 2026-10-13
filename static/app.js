/* ==========================================================================
   Dashboard wiring: filter state -> API -> charts, tiles and table views.
   ========================================================================== */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /* --- top bar height ---------------------------------------------------- */

  // The top bar is position: fixed (iOS 27 only keeps a fixed bar clear of its
  // blur band in the installed app), so it no longer reserves its own space.
  // --topbar-h is its full height; --topbar-rest-h is everything below its
  // padding-top. The CSS offsets the page by --topbar-pad-top + rest, so the
  // part iOS controls (safe-area inset) never waits on JS — only the part
  // that changes when the bar wraps does, and a content-box observer sees that.
  (function trackTopbarHeight() {
    const bar = document.querySelector('.topbar');
    if (!bar) return;
    const root = document.documentElement.style;
    const publish = () => {
      const padTop = parseFloat(getComputedStyle(bar).paddingTop) || 0;
      root.setProperty('--topbar-h', bar.offsetHeight + 'px');
      root.setProperty('--topbar-rest-h', (bar.offsetHeight - padTop) + 'px');
    };
    publish();
    if ('ResizeObserver' in window) new ResizeObserver(publish).observe(bar);
    // Belt and braces: keep --topbar-h current across rotation and resume.
    for (const type of ['resize', 'orientationchange', 'pageshow', 'load']) {
      window.addEventListener(type, publish);
    }
    document.addEventListener('visibilitychange', publish);
  })();

  /* --- periods ----------------------------------------------------------- */

  // Two questions, not six: "how did this year go" and "how has it all gone".
  // Which year is a separate control — a stepper, the same one the week and
  // the calendar use — so the first question can be asked of any year rather
  // than only the one we happen to be in.
  const PERIODS = [
    { key: 'year', label: 'Year', bucket: 'month', year: true },
    { key: 'all', label: 'All time', bucket: 'year', all: true },
  ];

  // What a filter saved by an older build turns into. The rest have no honest
  // equivalent here, so they fall through to the default rather than being
  // bent into one.
  const PERIOD_ALIASES = { ytd: 'year' };

  const BUCKETS = [
    { key: 'week', label: 'Week' },
    { key: 'month', label: 'Month' },
    { key: 'year', label: 'Year' },
  ];

  const METRICS = [
    { key: 'distance', label: 'Distance' },
    { key: 'time', label: 'Time' },
    { key: 'elevation', label: 'Climb' },
    { key: 'count', label: 'Sessions' },
  ];

  /* --- formatting -------------------------------------------------------- */

  const nf = (digits) => new Intl.NumberFormat('en-GB', {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });

  function num(value, digits = 0) {
    return nf(digits).format(value);
  }

  function compact(value) {
    const abs = Math.abs(value);
    if (abs >= 10000) {
      const k = value / 1000;
      return `${num(k, abs >= 100000 || Number.isInteger(k) ? 0 : 1)}k`;
    }
    if (abs >= 100 || abs === 0) return num(value, 0);
    if (abs >= 10) return num(value, value % 1 ? 1 : 0);
    return num(value, value % 1 ? 1 : 0);
  }

  // Distance is worth two decimals: a 3.85 km hike and a 3.50 km swim are
  // different sessions, and one digit hides the difference. Past 100 km the
  // tens of metres stop carrying any meaning, and the extra characters would
  // only push a four-figure total out of its tile. Two is also all there is —
  // the API rounds to two before it sends anything.
  const kmDigits = (value) => (Math.abs(value) >= 100 ? 0 : 2);

  function hoursHuman(value) {
    let h = Math.floor(value);
    let min = Math.round((value - h) * 60);
    if (min === 60) { h += 1; min = 0; }
    return `${num(h)}h ${String(min).padStart(2, '0')}`;
  }

  const METRIC_FMT = {
    distance: { unit: 'km', tick: compact, value: (v) => `${num(v, kmDigits(v))} km`, tile: (v) => num(v, kmDigits(v)) },
    time: { unit: 'h', tick: compact, value: hoursHuman, tile: (v) => num(v, v >= 100 ? 0 : 1) },
    elevation: { unit: 'm', tick: compact, value: (v) => `${num(v, 0)} m`, tile: (v) => num(v, 0) },
    count: { unit: '', tick: compact, value: (v) => `${num(v, 0)} ${v === 1 ? 'session' : 'sessions'}`, tile: (v) => num(v, 0) },
  };

  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

  const parseDay = (iso) => new Date(`${iso}T00:00:00`);

  function xLabel(iso, bucket) {
    const d = parseDay(iso);
    if (bucket === 'year') return String(d.getFullYear());
    if (bucket === 'month') return d.getMonth() === 0
      ? `${MONTHS_SHORT[0]} ${String(d.getFullYear()).slice(2)}`
      : MONTHS_SHORT[d.getMonth()];
    return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
  }

  function xTooltip(iso, bucket) {
    const d = parseDay(iso);
    if (bucket === 'year') return String(d.getFullYear());
    if (bucket === 'month') return `${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`;
    return `Week of ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
  }

  function dayOfYearLabel(doy) {
    if (doy <= 0) return '1 January';
    const d = new Date(2001, 0, 1);           // non-leap reference year
    d.setDate(Math.min(doy, 365));
    return `${d.getDate()} ${MONTHS_LONG[d.getMonth()]}`;
  }

  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  const sportColor = (key) => cssVar(`--sport-${key}`) || cssVar('--sport-other');

  /* --- state ------------------------------------------------------------- */

  const state = {
    // Where a browser that has never been here lands. Goals is optional, so
    // when there is no goals.json the switcher falls through to the first view
    // that does exist — This week, which is the same question one grain wider.
    view: 'goals',
    period: 'year',
    bucket: 'month',
    // Which year the Year period means. Not remembered between sessions, for
    // the same reason the week offset isn't: you open the app on the year you
    // are in, not the one you were reading about last time.
    year: new Date().getFullYear(),
    metric: 'distance',
    sports: null,        // Set of group keys, derived on load from `excluded`
    // What you've *unticked*, remembered rather than what you've left on — the
    // same model the week view uses. A group that appears later (a new sport,
    // or one split out of Other) is one you have never had an opinion about,
    // so it arrives counted instead of silently missing.
    excluded: new Set(),
    overview: null,
    lastSeries: null,
    races: null,
    goals: null,
    // This week keeps its own controls: which measure the days are drawn in,
    // which week is on screen, and which of that week's sports are counted.
    // The measure is kept apart from the training one so switching there
    // doesn't silently redraw a view you aren't looking at. The offset isn't
    // remembered between sessions — opening the app should land on the week
    // you're in, not the one you were reading about on Tuesday.
    week: {
      metric: 'distance',
      offset: 0,         // weeks back from the current one; 0 is this week
      sports: null,      // Set of the displayed week's ticked keys, null until loaded
      // What you've *unticked*, remembered rather than what you've left on: a
      // sport the week you step into happens to have is one you have never had
      // an opinion about, and it should arrive counted.
      excluded: new Set(),
      data: null,
      loaded: false,
    },
    // The workout log keeps its own filters: it answers "find that session",
    // not "how much did I do", so nothing is shared with the volume filters.
    // The log answers "find that session", and a search that can only see part
    // of the history is a worse search — so it has no period of its own: it is
    // always all time.
    log: {
      q: '',
      sports: null,
      excluded: new Set(),
      sort: 'date',
      direction: 'desc',
      shown: 0,          // rows currently on screen, so paging survives a re-sort
      loaded: false,
    },
    // The month grid above the log. Not remembered between sessions, for the
    // same reason the week isn't: you open the app on the month you're in.
    calendar: {
      month: null,       // 'YYYY-MM-01' of the month on screen, null until first drawn
    },
    // The map of every trace: always all time, so only which sports and where
    // you were looking are kept. Unticked sports are remembered, as elsewhere.
    map: {
      sports: null,
      excluded: new Set(),
      viewport: null,    // { lat, lng, zoom } — reopening lands where you left it
      data: null,
      loaded: false,
    },
    folds: {},           // card id -> open, once you've had an opinion about it
  };

  const LOG_PAGE = 50;

  const STORE_KEY = 'workouts.filters.v1';

  function saveState() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        view: state.view,
        period: state.period, bucket: state.bucket, metric: state.metric,
        excluded: [...state.excluded],
        week: { metric: state.week.metric },
        // The search text is deliberately not kept: reopening the app to a
        // filtered list you don't remember typing is a puzzle, not a feature.
        log: {
          sort: state.log.sort,
          direction: state.log.direction,
          excluded: [...state.log.excluded],
        },
        map: {
          excluded: [...state.map.excluded],
          viewport: state.map.viewport,
        },
        folds: state.folds,
      }));
    } catch (_) { /* private mode */ }
  }

  function restoreState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (VIEWS.some((v) => v.key === saved.view)) state.view = saved.view;
      const period = PERIOD_ALIASES[saved.period] || saved.period;
      if (PERIODS.some((p) => p.key === period)) state.period = period;
      if (BUCKETS.some((b) => b.key === saved.bucket)) state.bucket = saved.bucket;
      if (METRICS.some((m) => m.key === saved.metric)) state.metric = saved.metric;
      if (Array.isArray(saved.excluded)) state.excluded = new Set(saved.excluded);

      const week = saved.week || {};
      if (METRICS.some((m) => m.key === week.metric)) state.week.metric = week.metric;

      const log = saved.log || {};
      // Only the sortable columns count: matching against every column would
      // let a missing key match the ones that have no sort of their own.
      if (LOG_SORT_KEYS.includes(log.sort)) state.log.sort = log.sort;

      if (saved.folds && typeof saved.folds === 'object') {
        for (const [id, open] of Object.entries(saved.folds)) {
          if (id in FOLDS && typeof open === 'boolean') state.folds[id] = open;
        }
      }
      if (log.direction === 'asc' || log.direction === 'desc') state.log.direction = log.direction;
      if (Array.isArray(log.excluded)) state.log.excluded = new Set(log.excluded);

      const savedMap = saved.map || {};
      if (Array.isArray(savedMap.excluded)) state.map.excluded = new Set(savedMap.excluded);
      const vp = savedMap.viewport;
      if (vp && [vp.lat, vp.lng, vp.zoom].every(Number.isFinite)) state.map.viewport = vp;
    } catch (_) { /* ignore */ }
  }

  // The first year there is anything to show, and the last — the bounds the
  // stepper stops at. Before the overview lands they collapse to this year,
  // which is the only year we can be sure exists.
  const thisYear = () => new Date().getFullYear();

  function firstYear() {
    const first = state.overview && state.overview.first_date;
    return first ? parseDay(first).getFullYear() : thisYear();
  }

  function range(periodKey, year = state.year) {
    const preset = PERIODS.find((p) => p.key === periodKey) || PERIODS[0];
    const today = new Date();
    let start = new Date(today);
    let end = today;
    if (preset.all) {
      start = state.overview && state.overview.first_date
        ? parseDay(state.overview.first_date) : new Date(today.getFullYear() - 5, 0, 1);
    } else if (preset.year) {
      start = new Date(year, 0, 1);
      // A year that is over ends on its last day; the one we are in ends
      // today, so the part-period notes stay honest and the comparison is
      // against the same stretch of last year rather than all of it.
      if (year < today.getFullYear()) end = new Date(year, 11, 31);
    }
    return { start: iso(start), end: iso(end) };
  }

  /* --- controls ---------------------------------------------------------- */

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Icons are shape lists rather than markup so they go through the same DOM
  // building as everything else here. 16x16 box, currentColor, to match the
  // theme button in the topbar.
  function iconSvg(shapes) {
    const root = document.createElementNS(SVG_NS, 'svg');
    root.setAttribute('viewBox', '0 0 16 16');
    root.setAttribute('width', '16');
    root.setAttribute('height', '16');
    root.setAttribute('aria-hidden', 'true');
    for (const [tag, attrs] of shapes) {
      const node = document.createElementNS(SVG_NS, tag);
      for (const key in attrs) node.setAttribute(key, attrs[key]);
      root.appendChild(node);
    }
    return root;
  }

  function buildSegmented(container, items, name, current, onChange) {
    // A control whose markup isn't there is a shell that has come apart — an
    // old script against new HTML, which the service worker works hard to
    // prevent but a reload mid-deploy can still produce. Losing one control is
    // a far smaller failure than throwing here, which would take the rest of
    // boot with it: the view switcher and the first data load come after this,
    // so the page would be left with no tabs and empty cards.
    if (!container) {
      console.error(`buildSegmented: no container for "${name}" — stale shell?`);
      return;
    }
    container.textContent = '';
    for (const item of items) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = name;
      input.value = item.key;
      input.checked = item.key === current;
      input.addEventListener('change', () => onChange(item.key));
      label.appendChild(input);
      if (item.icon) {
        // The word stays in the DOM, just out of sight: it is what a screen
        // reader announces, and `title` is the hover tooltip for everyone else.
        label.title = item.label;
        label.appendChild(iconSvg(item.icon));
        const text = document.createElement('span');
        text.className = 'visually-hidden';
        text.textContent = item.label;
        label.appendChild(text);
        // Shown only in the phone tab bar, under the icon. Hidden from screen
        // readers, which already have the full word above.
        const caption = document.createElement('span');
        caption.className = 'tab-label';
        caption.setAttribute('aria-hidden', 'true');
        caption.textContent = item.short || item.label;
        label.appendChild(caption);
      } else {
        label.appendChild(document.createTextNode(item.label));
      }
      container.appendChild(label);
    }
  }

  // `selected` is the Set the chips drive — the training filter and the log
  // filter each own one, so unticking Ride in one view doesn't touch the other.
  // `excluded`, when given, is the opt-out set that outlives this render: the
  // ticked set is derived from it, so it has to be kept in step here.
  function buildSportChips(container, groups, selected, onChange, excluded) {
    container.textContent = '';
    for (const group of groups) {
      const label = document.createElement('label');
      label.className = 'chip';
      label.style.setProperty('--chip-color', sportColor(group.key));

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = group.key;
      input.checked = selected.has(group.key);
      input.addEventListener('change', () => {
        if (input.checked) selected.add(group.key);
        else selected.delete(group.key);
        if (!selected.size) {               // never leave the page blank
          selected.add(group.key);
          input.checked = true;
          return;
        }
        if (excluded) {
          if (input.checked) excluded.delete(group.key);
          else excluded.add(group.key);
        }
        saveState();
        onChange();
      });

      const swatch = document.createElement('span');
      swatch.className = 'swatch';

      label.appendChild(input);
      label.appendChild(swatch);
      label.appendChild(document.createTextNode(group.label));
      container.appendChild(label);
    }
  }

  // The stepper is only a control while Year is the period, and it only steps
  // as far as there is anything to show: back to the first year on file,
  // forward to the one we are in.
  function renderYearNav() {
    const on = state.period === 'year';
    $('f-year-filter').hidden = !on;
    if (!on) return;
    $('year-label').textContent = String(state.year);
    $('year-prev').disabled = state.year <= firstYear();
    $('year-next').disabled = state.year >= thisYear();
  }

  function stepYear(delta) {
    const year = Math.min(thisYear(), Math.max(firstYear(), state.year + delta));
    if (year === state.year) return;
    state.year = year;
    renderYearNav();
    refresh();
  }

  function buildControls() {
    buildSegmented($('f-period'), PERIODS, 'period', state.period, (key) => {
      state.period = key;
      const preset = PERIODS.find((p) => p.key === key);
      state.bucket = preset.bucket;           // presets carry a sensible grain
      // Coming back to Year lands on the year you are in, not the one you
      // stepped away from: the same rule the week stepper follows.
      if (preset.year) state.year = thisYear();
      buildSegmented($('f-bucket'), BUCKETS, 'bucket', state.bucket, onBucket);
      renderYearNav();
      saveState();
      refresh();
    });
    $('year-prev').addEventListener('click', () => stepYear(-1));
    $('year-next').addEventListener('click', () => stepYear(1));
    renderYearNav();
    buildSegmented($('f-bucket'), BUCKETS, 'bucket', state.bucket, onBucket);
    buildSegmented($('f-metric'), METRICS, 'metric', state.metric, (key) => {
      state.metric = key;
      saveState();
      refresh();
    });
  }

  function onBucket(key) {
    state.bucket = key;
    saveState();
    refresh();
  }

  /* --- rendering --------------------------------------------------------- */

  function deltaNode(current, previous, note = 'vs previous period') {
    const node = document.createElement('div');
    node.className = 'tile-delta';
    if (!previous) {
      node.textContent = current ? 'no comparable period' : '—';
      return node;
    }
    const pct = ((current - previous) / previous) * 100;
    const up = pct >= 0;
    node.classList.add(up ? 'up' : 'down');
    const dir = document.createElement('span');
    dir.className = 'dir';
    dir.textContent = `${up ? '↑' : '↓'} ${num(Math.abs(pct), Math.abs(pct) >= 10 ? 0 : 1)}%`;
    node.appendChild(dir);
    node.appendChild(document.createTextNode(note));
    return node;
  }

  const TILES = [
    { field: 'distance', label: 'Distance' },
    { field: 'time', label: 'Moving time' },
    { field: 'count', label: 'Sessions' },
    { field: 'elevation', label: 'Elevation gain' },
  ];

  // Label and big number; whatever goes underneath is the caller's business.
  function tileCard(labelText, field, value) {
    const card = document.createElement('div');
    card.className = 'tile';

    const label = document.createElement('div');
    label.className = 'tile-label';
    label.textContent = labelText;

    const valueNode = document.createElement('div');
    valueNode.className = 'tile-value';
    valueNode.textContent = METRIC_FMT[field].tile(value);
    if (METRIC_FMT[field].unit) {
      const unit = document.createElement('span');
      unit.className = 'unit';
      unit.textContent = METRIC_FMT[field].unit;
      valueNode.appendChild(unit);
    }

    card.appendChild(label);
    card.appendChild(valueNode);
    return card;
  }

  function renderTiles(totals) {
    const host = $('tiles');
    host.textContent = '';
    for (const tile of TILES) {
      const current = totals.total[tile.field] || 0;
      const previous = totals.previous_total[tile.field] || 0;
      const card = tileCard(tile.label, tile.field, current);
      card.appendChild(deltaNode(current, previous));
      host.appendChild(card);
    }
  }

  const RECORD_LABELS = {
    day: 'Best day', week: 'Best week', month: 'Best month', year: 'Best year',
  };

  function recordWhen(record) {
    if (record.bucket === 'day') return longDate(record.start);
    return xTooltip(record.start, record.bucket);
  }

  function renderRecords(data) {
    const host = $('records');
    const card = $('records-card');
    // An installed PWA can be running an older index.html than this script;
    // a card that isn't in the markup yet must not take the dashboard with it.
    if (!host || !card) return;
    host.textContent = '';
    const fmt = METRIC_FMT[state.metric];

    const found = data.records.filter((r) => r.value);
    card.hidden = !found.length;
    if (!found.length) return;

    $('records-title').textContent = `Peak ${data.label.toLowerCase()}`;
    $('records-sub').textContent =
      'The single day, week, month and year with the most '
      + `${data.label.toLowerCase()}, adding up the sports selected above. `
      + `Within ${data.start} to ${data.end}.`;

    for (const record of found) {
      const card = document.createElement('div');
      card.className = 'tile';

      const label = document.createElement('div');
      label.className = 'tile-label';
      label.textContent = RECORD_LABELS[record.bucket];

      const value = document.createElement('div');
      value.className = 'tile-value';
      value.textContent = fmt.tile(record.value);
      if (fmt.unit) {
        const unit = document.createElement('span');
        unit.className = 'unit';
        unit.textContent = fmt.unit;
        value.appendChild(unit);
      }

      const when = document.createElement('div');
      when.className = 'tile-when';
      const notes = [];
      if (state.metric !== 'count') {        // else the value already says it
        notes.push(`${record.sessions} session${record.sessions === 1 ? '' : 's'}`);
      }
      // Say so rather than quietly comparing a half month against full ones.
      if (!record.complete) notes.push('only partly in this period');

      // Each part its own element: adjacent text nodes would merge into one
      // flex item and lose the gap between them.
      const parts = [recordWhen(record), ...notes];
      parts.forEach((text, i) => {
        const span = document.createElement('span');
        if (i === 0) span.className = 'when';
        span.textContent = text;
        when.appendChild(span);
      });

      card.appendChild(label);
      card.appendChild(value);
      card.appendChild(when);
      host.appendChild(card);
    }
  }

  const AVERAGE_LABELS = {
    day: 'Per day', week: 'Per week', month: 'Per month', year: 'Per year',
  };

  const BUCKET_NOUNS = {
    day: ['day', 'days'], week: ['week', 'weeks'],
    month: ['month', 'months'], year: ['year', 'years'],
  };

  function renderAverages(data) {
    const host = $('averages');
    const card = $('averages-card');
    if (!host || !card) return;
    host.textContent = '';
    const fmt = METRIC_FMT[state.metric];

    const found = data.averages.filter((a) => a.value !== null && a.value !== undefined);
    card.hidden = !found.length;
    if (!found.length) return;

    $('averages-title').textContent = `Typical ${data.label.toLowerCase()}`;
    const partial = found.some((a) => a.partial);
    $('averages-sub').textContent =
      `${data.label} averaged over the days, weeks, months and years in the period. `
      + 'The big number counts quiet ones as zero — a fortnight off is part of your '
      + 'typical week, not an exception to it. Underneath it, the same total over only '
      + 'the periods you actually trained in.'
      + (partial ? ' A part-period at either end counts for the share of it the '
        + 'window covers, so the grains agree with each other.' : '');

    for (const average of found) {
      const card1 = document.createElement('div');
      card1.className = 'tile';

      const label = document.createElement('div');
      label.className = 'tile-label';
      label.textContent = AVERAGE_LABELS[average.bucket];

      const value = document.createElement('div');
      value.className = 'tile-value';
      value.textContent = fmt.tile(average.value);
      if (fmt.unit) {
        const unit = document.createElement('span');
        unit.className = 'unit';
        unit.textContent = fmt.unit;
        value.appendChild(unit);
      }

      // How many of those periods you actually did something in, and the same
      // total spread over only those. The two numbers answer "a typical week"
      // and "a typical week I trained" — the gap between them is what says
      // whether the average is a habit or a couple of big efforts.
      const noun = BUCKET_NOUNS[average.bucket][average.buckets === 1 ? 0 : 1];
      const when = document.createElement('div');
      when.className = 'tile-when';
      const count = document.createElement('span');
      count.className = 'when';
      count.textContent = `${num(average.active)} of ${num(average.buckets)} ${noun}`;
      when.appendChild(count);

      // Dropped when every period counted: the second figure would be the
      // first one again, and a number repeated is a number doubted.
      const split = average.active > 0 && average.active < average.buckets;
      const tail = document.createElement('span');
      tail.textContent = split ? 'with activity, averaging' : 'with activity';
      when.appendChild(tail);
      if (split) {
        const active = document.createElement('span');
        active.className = 'when';
        active.textContent = fmt.unit
          ? `${fmt.tile(average.active_value)} ${fmt.unit}`
          : fmt.value(average.active_value);
        when.appendChild(active);
      }

      card1.appendChild(label);
      card1.appendChild(value);
      card1.appendChild(when);
      host.appendChild(card1);
    }
  }

  function renderLegend(host, entries, kind) {
    host.textContent = '';
    for (const entry of entries) {
      const item = document.createElement('span');
      item.className = 'legend-item';
      const key = document.createElement('span');
      key.className = kind === 'line' ? 'key-line' : 'key';
      key.style.background = entry.color;
      item.appendChild(key);
      item.appendChild(document.createTextNode(entry.label));
      host.appendChild(item);
    }
  }

  function renderMainChart(data) {
    const fmt = METRIC_FMT[state.metric];
    const host = $('chart1');
    const series = data.series.map((s) => ({ ...s, color: sportColor(s.key) }));

    $('chart1-title').textContent = `${data.label} over time`;
    $('chart1-sub').textContent = `Per ${state.bucket}, stacked by sport${data.unit ? ` · ${data.unit}` : ''}.`;

    if (!series.length) {
      host.textContent = '';
      host.dataset.state = 'empty';
      $('chart1-legend').textContent = '';
      return;
    }
    delete host.dataset.state;
    renderLegend($('chart1-legend'), series.map((s) => ({ label: s.label, color: s.color })), 'rect');

    Charts.columns(host, {
      buckets: data.buckets,
      series,
      xLabels: data.buckets.map((b) => xLabel(b, data.bucket)),
      xTooltips: data.buckets.map((b) => xTooltip(b, data.bucket)),
      formatValue: fmt.value,
      formatTick: fmt.tick,
      integerTicks: state.metric === 'count',
      ariaLabel: `${data.label} per ${data.bucket} by sport, ${data.start} to ${data.end}. `
        + 'The same figures are listed in the Numbers table below.',
    });
  }

  function renderFacets(data) {
    const fmt = METRIC_FMT[state.metric];
    const host = $('chart2');
    host.textContent = '';

    const active = data.series.filter((s) => s.values.some((v) => v > 0));
    if (!active.length) {
      const empty = document.createElement('p');
      empty.className = 'card-sub';
      empty.textContent = 'No activity in this period.';
      host.appendChild(empty);
      return;
    }

    for (const s of active) {
      const color = sportColor(s.key);
      const total = s.values.reduce((a, b) => a + b, 0);

      const facet = document.createElement('div');
      facet.className = 'facet';

      const head = document.createElement('div');
      head.className = 'facet-head';
      const title = document.createElement('span');
      title.className = 'facet-title';
      const key = document.createElement('span');
      key.className = 'key';
      key.style.background = color;
      title.appendChild(key);
      title.appendChild(document.createTextNode(s.label));
      const totalNode = document.createElement('span');
      totalNode.className = 'facet-total';
      totalNode.textContent = fmt.value(total);
      head.appendChild(title);
      head.appendChild(totalNode);

      const chart = document.createElement('div');
      chart.className = 'chart';

      facet.appendChild(head);
      facet.appendChild(chart);
      host.appendChild(facet);

      Charts.columns(chart, {
        buckets: data.buckets,
        series: [{ key: s.key, label: s.label, color, values: s.values }],
        xLabels: data.buckets.map((b) => xLabel(b, data.bucket)),
        xTooltips: data.buckets.map((b) => xTooltip(b, data.bucket)),
        formatValue: fmt.value,
        formatTick: fmt.tick,
        integerTicks: state.metric === 'count',
        compact: true,
        ariaLabel: `${s.label}: ${data.label} per ${data.bucket}, total ${fmt.value(total)}.`,
      });
    }
  }

  function yearColors(count) {
    // Ordinal ramp: the newest year always takes the strongest step.
    const ramp = [1, 2, 3, 4, 5, 6].map((i) => cssVar(`--year-${i}`));
    return Array.from({ length: count }, (_, i) => ramp[ramp.length - count + i] || ramp[0]);
  }

  function renderCumulative(results) {
    const fmt = METRIC_FMT[state.metric];
    const host = $('chart3');
    const legend = $('chart3-legend');
    host.textContent = '';
    legend.textContent = '';

    const usable = results.filter((r) => r && r.years.length);
    if (!usable.length) {
      const empty = document.createElement('p');
      empty.className = 'card-sub';
      empty.textContent = 'Not enough history yet for a year-on-year view.';
      host.appendChild(empty);
      return;
    }

    const allYears = [...new Set(usable.flatMap((r) => r.years.map((y) => y.year)))].sort();
    const palette = yearColors(allYears.length);
    const colorOf = (year) => palette[allYears.indexOf(year)];

    renderLegend(legend, allYears.map((y) => ({ label: String(y), color: colorOf(y) })), 'line');

    const currentYear = new Date().getFullYear();
    const xTicks = [1, 60, 121, 182, 244, 305].map((doy, i) => ({
      x: doy, label: MONTHS_SHORT[i * 2],
    }));

    for (const result of usable) {
      const facet = document.createElement('div');
      facet.className = 'facet';

      const head = document.createElement('div');
      head.className = 'facet-head';
      const title = document.createElement('span');
      title.className = 'facet-title';
      const key = document.createElement('span');
      key.className = 'key';
      key.style.background = sportColor(result.group);
      title.appendChild(key);
      title.appendChild(document.createTextNode(result.group_label));
      head.appendChild(title);

      const chart = document.createElement('div');
      chart.className = 'chart';

      facet.appendChild(head);
      facet.appendChild(chart);
      host.appendChild(facet);

      Charts.lines(chart, {
        lines: result.years.map((y) => ({
          label: String(y.year),
          color: colorOf(y.year),
          emphasis: y.year === currentYear,
          points: y.points.map((p) => ({ x: p.doy, y: p.value })),
        })),
        xMax: 366,
        xTicks,
        formatValue: fmt.value,
        formatTick: fmt.tick,
        formatX: dayOfYearLabel,
        compact: true,
        ariaLabel: `${result.group_label}: cumulative ${result.label.toLowerCase()} by day of year, `
          + `one line per year from ${allYears[0]} to ${allYears[allYears.length - 1]}.`,
      });
    }
  }

  function cell(row, text, className) {
    const td = document.createElement(row.parentNode.tagName === 'THEAD' ? 'th' : 'td');
    td.textContent = text;
    if (className) td.className = className;
    row.appendChild(td);
    return td;
  }

  function renderTotalsTable(totals) {
    const table = $('totals-table');
    table.textContent = '';

    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    head.appendChild(headRow);
    table.appendChild(head);
    ['Sport', 'Sessions', 'Distance (km)', 'Time', 'Climb (m)'].forEach((label) => cell(headRow, label));

    const body = document.createElement('tbody');
    table.appendChild(body);
    for (const row of totals.rows) {
      const tr = document.createElement('tr');
      body.appendChild(tr);

      const nameCell = cell(tr, '');
      const wrap = document.createElement('span');
      wrap.className = 'name';
      const key = document.createElement('span');
      key.className = 'key';
      key.style.background = sportColor(row.key);
      wrap.appendChild(key);
      wrap.appendChild(document.createTextNode(row.label));
      nameCell.appendChild(wrap);

      cell(tr, num(row.current.count));
      cell(tr, num(row.current.distance, kmDigits(row.current.distance)));
      cell(tr, hoursHuman(row.current.time));
      cell(tr, num(row.current.elevation));
    }

    const foot = document.createElement('tfoot');
    const footRow = document.createElement('tr');
    foot.appendChild(footRow);
    table.appendChild(foot);
    cell(footRow, 'Total');
    cell(footRow, num(totals.total.count));
    cell(footRow, num(totals.total.distance, kmDigits(totals.total.distance)));
    cell(footRow, hoursHuman(totals.total.time));
    cell(footRow, num(totals.total.elevation));

    $('table-sub').textContent =
      `${totals.start} to ${totals.end} — compared against ${totals.previous_start} to ${totals.previous_end}.`;
  }

  function renderSeriesTable(data) {
    const table = $('series-table');
    table.textContent = '';
    const fmt = METRIC_FMT[state.metric];

    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    head.appendChild(headRow);
    table.appendChild(head);
    cell(headRow, state.bucket === 'week' ? 'Week of' : state.bucket === 'month' ? 'Month' : 'Year');
    data.series.forEach((s) => cell(headRow, s.label));
    if (data.series.length > 1) cell(headRow, 'Total');

    const body = document.createElement('tbody');
    table.appendChild(body);
    data.buckets.forEach((bucket, i) => {
      const tr = document.createElement('tr');
      body.appendChild(tr);
      cell(tr, xTooltip(bucket, data.bucket));
      let total = 0;
      data.series.forEach((s) => {
        total += s.values[i] || 0;
        cell(tr, fmt.value(s.values[i] || 0));
      });
      if (data.series.length > 1) cell(tr, fmt.value(total));
    });
  }

  /* --- goals ------------------------------------------------------------- */

  const PERIOD_NOUN = { week: 'week', month: 'month' };

  const goalRound = (v) => Math.round(v * 100) / 100;

  // How much of something, in the goal's own terms. Measured metrics carry
  // their unit; counts say what is being counted, because "1" on its own in a
  // sentence about sessions reads as a bare number.
  function goalAmount(goal, value) {
    const fmt = METRIC_FMT[goal.metric];
    return fmt.unit ? `${fmt.tile(value)} ${fmt.unit}` : fmt.value(value);
  }

  // The mark next to a goal's name. One sport gets its colour flat; a whole-
  // programme goal gets a miniature stack of the sports it is made of, in the
  // stacking order its chart uses — so the key is a small picture of the bar
  // rather than a hue borrowed from one of its parts. Equal bands: it says
  // "these, stacked", not "in these proportions", which change every week.
  function goalKeyBackground(series) {
    if (series.length === 1) return sportColor(series[0].key);
    const step = 100 / series.length;
    const stops = series.map((s, i) =>
      `${sportColor(s.key)} ${i * step}% ${(i + 1) * step}%`);
    return `linear-gradient(to top, ${stops.join(', ')})`;
  }

  // The same stack as a plain background, in the real proportions. The
  // segments below draw it properly; this is what shows if their rule never
  // arrives. A bar whose only colour lives in a stylesheet is a bar that can
  // render as bare track — which is exactly what a half-updated cache did.
  function stackGradient(parts, total) {
    if (parts.length === 1) return sportColor(parts[0].key);
    let at = 0;
    const stops = parts.map((part) => {
      const from = at;
      at += total ? (part.actual / total) * 100 : 100 / parts.length;
      return `${sportColor(part.key)} ${from}% ${at}%`;
    });
    return `linear-gradient(to right, ${stops.join(', ')})`;
  }

  // A target is a number you chose, so it is written the way you'd have
  // written it: "7 km", not the two decimals the measured side needs to tell a
  // 3.85 km hike from a 3.50 km swim.
  function goalTargetText(goal) {
    const fmt = METRIC_FMT[goal.metric];
    const amount = Number.isInteger(goal.target)
      ? num(goal.target, 0)
      : fmt.tile(goal.target);
    return `${amount} ${fmt.unit || (goal.target === 1 ? 'session' : 'sessions')}`;
  }

  // Counts arrive in lumps, not at a rate: a single session a week is either
  // done or not, and "0.43 sessions behind pace" on a Wednesday is noise
  // dressed as precision. Pace is for things you accumulate.
  const goalHasPace = (goal) => goal.metric !== 'count' || goal.target >= 2;

  function goalFigure(goal) {
    const fmt = METRIC_FMT[goal.metric];
    const node = document.createElement('span');
    node.className = 'goal-figure';

    const actual = document.createElement('strong');
    actual.textContent = fmt.tile(goal.actual);
    node.appendChild(actual);

    node.appendChild(document.createTextNode(
      `${fmt.unit ? ' / ' : ' of '}${goalTargetText(goal)}`
    ));
    return node;
  }

  // The sentence under the bar. Part-way through a period the comparison is
  // against pace rather than the whole target — 3 km of a 7 km week by
  // Wednesday is on schedule, not 43% of a failure — so only a period that is
  // actually over can be described as missed.
  function goalNote(goal, period) {
    const noun = PERIOD_NOUN[period.period];
    const left = period.total_days - period.elapsed_days;
    const daysLeft = left === 1 ? '1 day left' : `${left} days left`;

    let tone = '';
    let flag;
    let rest;

    if (goal.hit) {
      const over = goalRound(goal.actual - goal.target);
      tone = 'good';
      flag = 'Hit';
      rest = over > 0 ? ` — ${goalAmount(goal, over)} past the target.` : '.';
    } else if (!left) {
      tone = 'bad';
      flag = 'Missed';
      rest = ` by ${goalAmount(goal, goal.remaining)}.`;
    } else if (!goalHasPace(goal)) {
      flag = `${goalAmount(goal, goal.remaining)} to go`;
      rest = `, ${daysLeft}.`;
    } else {
      const behind = goalRound(goal.pace - goal.actual);
      if (behind > 0) {
        flag = `${goalAmount(goal, behind)} behind pace`;
      } else {
        tone = 'good';
        flag = 'On pace';
      }
      rest = ` — ${goalAmount(goal, goal.remaining)} to go, ${daysLeft}.`;
    }

    const node = document.createElement('div');
    node.className = tone ? `goal-note ${tone}` : 'goal-note';
    const flagNode = document.createElement('span');
    flagNode.className = 'flag';
    flagNode.textContent = flag;
    node.appendChild(flagNode);
    node.appendChild(document.createTextNode(rest));

    // A run of hit periods, counting back from now. The current one only joins
    // it once it has actually been hit, so a fresh Monday doesn't look like it
    // broke something you're still in the middle of extending.
    if (goal.streak >= 2) {
      node.appendChild(document.createTextNode(
        ` ${goal.streak} ${noun}s running.`
      ));
    }
    return node;
  }

  function goalRow(goal, period) {
    const whole = goal.series.length > 1 || goal.sport === 'all';
    const row = document.createElement('div');
    row.className = 'goal';

    const top = document.createElement('div');
    top.className = 'goal-top';
    const name = document.createElement('span');
    name.className = 'goal-name';
    const key = document.createElement('span');
    key.className = 'key';
    key.style.background = goalKeyBackground(goal.series);
    if (whole) key.title = goal.series.map((x) => x.label).join(', ');
    name.appendChild(key);
    name.appendChild(document.createTextNode(goal.sport_label));
    top.appendChild(name);
    top.appendChild(goalFigure(goal));
    row.appendChild(top);

    const meter = document.createElement('div');
    meter.className = 'meter';
    if (goal.hit) meter.dataset.state = 'hit';
    meter.setAttribute('role', 'img');
    meter.setAttribute('aria-label',
      `${goal.sport_label}: ${goalAmount(goal, goal.actual)} of `
      + `${goalTargetText(goal)} this ${PERIOD_NOUN[period.period]}.`);

    // The bar's length is the progress; inside it, one segment per sport that
    // contributed. A single-sport goal has exactly one segment filling the
    // whole thing, so both kinds are built the same way.
    const fill = document.createElement('div');
    fill.className = 'meter-fill';
    fill.style.width = `${Math.min(100, (goal.actual / goal.target) * 100)}%`;
    const done = goal.series.filter((s) => s.actual > 0);
    const parts = done.length ? done : goal.series.slice(0, 1);
    const sum = parts.reduce((acc, s) => acc + s.actual, 0);
    fill.style.background = stackGradient(parts, sum);
    for (const part of parts) {
      const seg = document.createElement('div');
      seg.className = 'meter-seg';
      seg.style.background = sportColor(part.key);
      seg.style.flexGrow = String(sum ? part.actual / sum : 1);
      if (whole) seg.title = `${part.label}: ${goalAmount(goal, part.actual)}`;
      fill.appendChild(seg);
    }
    meter.appendChild(fill);

    // The pace mark is only information while there is still time to act on
    // it: once the goal is hit, or the period is over, it says nothing.
    const running = period.elapsed_days < period.total_days;
    if (running && !goal.hit && goalHasPace(goal)) {
      const pace = document.createElement('div');
      pace.className = 'meter-pace';
      pace.style.left = `${Math.min(100, (goal.pace / goal.target) * 100)}%`;
      meter.appendChild(pace);
    }
    row.appendChild(meter);
    row.appendChild(goalNote(goal, period));
    return row;
  }

  function renderGoalPeriod(period) {
    const noun = PERIOD_NOUN[period.period];
    $(`goals-${period.period}-card`).hidden = false;

    const left = period.total_days - period.elapsed_days;
    $(`goals-${period.period}-sub`).textContent =
      `${spanText(period.start, period.end)} — day ${period.elapsed_days} of `
      + `${period.total_days}`
      + (left ? `, ${left} still to come.` : `. The ${noun} is done.`);

    const host = $(`goals-${period.period}`);
    host.textContent = '';
    for (const goal of period.goals) host.appendChild(goalRow(goal, period));
  }

  function renderGoalHistory(period) {
    const noun = PERIOD_NOUN[period.period];
    const card = $(`goals-${period.period}-history-card`);
    const host = $(`goals-${period.period}-history`);
    host.textContent = '';

    // Nothing to show until there is a completed period on file. History stops
    // at the first activity too, so this is empty rather than a row of zeros
    // from before there was any data.
    card.hidden = !period.buckets.length;
    if (!period.buckets.length) return;

    $(`goals-${period.period}-history-sub`).textContent =
      `The ${period.buckets.length} completed ${noun}s before this one. `
      + 'The dashed line is the target.';

    const buckets = period.buckets.map((b) => b.start);
    for (const goal of period.goals) {
      const fmt = METRIC_FMT[goal.metric];
      const series = goal.series.map((s) => ({
        key: s.key,
        label: s.label,
        color: sportColor(s.key),
        values: s.history,
      }));

      const facet = document.createElement('div');
      facet.className = 'facet';

      const head = document.createElement('div');
      head.className = 'facet-head';
      const title = document.createElement('span');
      title.className = 'facet-title';
      const key = document.createElement('span');
      key.className = 'key';
      key.style.background = goalKeyBackground(goal.series);
      if (series.length > 1) key.title = series.map((x) => x.label).join(', ');
      title.appendChild(key);
      title.appendChild(document.createTextNode(
        `${goal.sport_label} — ${goalTargetText(goal)}`
      ));

      const total = document.createElement('span');
      total.className = 'facet-total';
      const hits = document.createElement('strong');
      hits.textContent = String(goal.hits);
      total.appendChild(hits);
      const of = document.createElement('span');
      of.className = 'of';
      of.textContent = ` of ${goal.tracked} hit`;
      total.appendChild(of);

      head.appendChild(title);
      head.appendChild(total);

      const chart = document.createElement('div');
      chart.className = 'chart';
      // No legend row: it would push this facet's plot out of line with the
      // ones beside it, and the sports are named and coloured in the card
      // directly above. The stacked key and the tooltip carry it.
      facet.appendChild(head);
      facet.appendChild(chart);
      host.appendChild(facet);

      Charts.columns(chart, {
        buckets,
        series,
        xLabels: buckets.map((b) => xLabel(b, period.period)),
        xTooltips: buckets.map((b) => xTooltip(b, period.period)),
        formatValue: fmt.value,
        formatTick: fmt.tick,
        integerTicks: goal.metric === 'count',
        rule: goal.target,
        compact: true,
        ariaLabel: `${goal.sport_label}, ${goal.metric_label.toLowerCase()} per ${noun} `
          + `against a target of ${goalTargetText(goal)}: `
          + `${goal.hits} of the last ${goal.tracked} ${noun}s reached it.`,
      });
    }
  }

  function renderGoals(data) {
    const problems = (data && data.problems) || [];
    const banner = $('goals-problems');
    banner.hidden = !problems.length;
    if (problems.length) {
      const list = $('goals-problem-list');
      list.textContent = '';
      for (const problem of problems) {
        const item = document.createElement('li');
        item.textContent = problem;
        list.appendChild(item);
      }
    }

    const periods = (data && data.periods) || [];
    $('goals-empty').hidden = !!periods.length || !!problems.length;

    for (const key of Object.keys(PERIOD_NOUN)) {
      const period = periods.find((p) => p.period === key);
      if (!period) {
        $(`goals-${key}-card`).hidden = true;
        $(`goals-${key}-history-card`).hidden = true;
        continue;
      }
      renderGoalPeriod(period);
      renderGoalHistory(period);
    }
  }

  /* --- races ------------------------------------------------------------- */

  const DAY_MS = 86400000;
  const dayNumber = (isoDate) => parseDay(isoDate).getTime() / DAY_MS;

  function longDate(isoDate) {
    const d = parseDay(isoDate);
    return `${d.getDate()} ${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`;
  }

  function shortDate(isoDate) {
    const d = parseDay(isoDate);
    return `${MONTHS_SHORT[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
  }

  // X ticks for a race progression: year starts if the span covers years,
  // otherwise the races' own months.
  function raceTicks(isoDates) {
    const days = isoDates.map(dayNumber);
    const from = parseDay(isoDates[0]);
    const to = parseDay(isoDates[isoDates.length - 1]);
    const years = [];
    for (let y = from.getFullYear(); y <= to.getFullYear() + 1; y += 1) {
      years.push({ x: new Date(y, 0, 1).getTime() / DAY_MS, label: String(y) });
    }
    const inRange = years.filter((t) => t.x >= Math.min(...days) && t.x <= Math.max(...days));
    if (inRange.length >= 2) return inRange;
    // Too short a span for year marks — label each race's month instead.
    const seen = new Set();
    return isoDates.filter((iso) => {
      const key = iso.slice(0, 7);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((iso) => ({ x: dayNumber(iso), label: shortDate(iso) }));
  }

  // Times need their own axis formatter — seconds don't compact like distances,
  // and a tick reading "2:52" is easier to scan than "2:52.00".
  function timeTick(seconds) {
    const total = Math.round(seconds * 100) / 100;
    const h = Math.floor(total / 3600);
    const m = Math.floor((total - h * 3600) / 60);
    const s = total - h * 3600 - m * 60;
    const trimmed = parseFloat(s.toFixed(2));          // 55.80 -> 55.8, 52.00 -> 52
    const whole = Math.floor(trimmed);
    const frac = trimmed - whole;
    if (h || m) {
      const secs = String(whole).padStart(2, '0') + (frac ? String(parseFloat(frac.toFixed(2))).slice(1) : '');
      return h ? `${h}:${String(m).padStart(2, '0')}:${secs}` : `${m}:${secs}`;
    }
    return String(trimmed);
  }

  const RACE_TILES = [
    { key: 'races', label: 'Races logged' },
    { key: 'events', label: 'Events raced' },
  ];

  function renderRaceTiles(data) {
    const host = $('race-tiles');
    host.textContent = '';

    const tiles = [
      ...RACE_TILES.map((t) => ({ label: t.label, value: num(data.totals[t.key]) })),
      { label: `Bests set in ${data.totals.year}`, value: num(data.totals.bests_this_year) },
    ];

    for (const tile of tiles) {
      const card = document.createElement('div');
      card.className = 'tile';
      const label = document.createElement('div');
      label.className = 'tile-label';
      label.textContent = tile.label;
      const value = document.createElement('div');
      value.className = 'tile-value';
      value.textContent = tile.value;
      card.appendChild(label);
      card.appendChild(value);
      host.appendChild(card);
    }
  }

  function renderRaceBests(data) {
    const host = $('race-bests');
    host.textContent = '';

    for (const course of data.courses) {
      const block = document.createElement('div');
      block.className = 'course-block';

      const head = document.createElement('div');
      head.className = 'course-head';
      const title = document.createElement('h3');
      title.textContent = course.label;
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = `${course.events.length} event${course.events.length === 1 ? '' : 's'}`;
      head.appendChild(title);
      head.appendChild(count);
      block.appendChild(head);

      const wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      const table = document.createElement('table');
      table.className = 'data-table';
      wrap.appendChild(table);

      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      thead.appendChild(headRow);
      table.appendChild(thead);
      ['Event', 'Best', 'Per 100 m', 'When', 'Races', 'Taken off'].forEach((l) => cell(headRow, l));

      const body = document.createElement('tbody');
      table.appendChild(body);
      for (const event of course.events) {
        const tr = document.createElement('tr');
        body.appendChild(tr);
        cell(tr, event.label);
        cell(tr, event.best.display, 'best-time');
        cell(tr, event.pace, 'muted');
        cell(tr, longDate(event.best.date));
        cell(tr, num(event.races));
        if (event.improvement) cell(tr, event.improvement, 'gain');
        else if (event.best_on_debut) cell(tr, 'best on debut', 'muted');
        else cell(tr, '—', 'muted');
      }

      block.appendChild(wrap);
      host.appendChild(block);
    }
  }

  function renderRaceProgression(data) {
    const host = $('race-progression');
    host.textContent = '';
    const card = $('race-progression-card');

    if (!data.progression.length) {
      card.hidden = true;
      return;
    }
    card.hidden = false;

    const color = sportColor('swim');   // one series per facet, so one hue

    for (const event of data.progression) {
      const dates = event.points.map((p) => p.date);
      const days = dates.map(dayNumber);

      const facet = document.createElement('div');
      facet.className = 'facet';

      const head = document.createElement('div');
      head.className = 'facet-head';
      const title = document.createElement('span');
      title.className = 'facet-title';
      const key = document.createElement('span');
      key.className = 'key';
      key.style.background = color;
      title.appendChild(key);
      title.appendChild(document.createTextNode(event.label));
      const meta = document.createElement('span');
      meta.className = 'facet-total';
      meta.textContent = event.course_label;
      head.appendChild(title);
      head.appendChild(meta);

      const chart = document.createElement('div');
      chart.className = 'chart';

      facet.appendChild(head);
      facet.appendChild(chart);
      host.appendChild(facet);

      Charts.points(chart, {
        points: event.points.map((p) => ({
          x: dayNumber(p.date),
          y: p.seconds,
          label: p.display,
          date: p.date,
          tooltip: longDate(p.date),
          best: p.is_best,
          gap: p.gap,
          pace: p.pace,
        })),
        color,
        xMin: Math.min(...days),
        xMax: Math.max(...days),
        xTicks: raceTicks(dates),
        formatTick: timeTick,
        valueLabel: 'Time',
        compact: true,
        ariaLabel: `${event.label}, ${event.course_label}: ${event.races} races, `
          + `best ${event.best.display} on ${longDate(event.best.date)}. `
          + 'Every time is listed in the Every race table below.',
      });
    }
  }

  function renderRaceLog(data) {
    const table = $('race-log');
    table.textContent = '';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    thead.appendChild(headRow);
    table.appendChild(thead);
    ['Date', 'Event', 'Pool', 'Time', 'Per 100 m', 'vs best'].forEach((l) => cell(headRow, l));

    const body = document.createElement('tbody');
    table.appendChild(body);
    for (const race of data.log) {
      const tr = document.createElement('tr');
      body.appendChild(tr);
      cell(tr, longDate(race.date));
      cell(tr, `${race.distance} m ${race.stroke_label.toLowerCase()}`);
      cell(tr, race.course_label, 'muted');
      cell(tr, race.display, race.is_best ? 'best-time' : '');
      cell(tr, race.pace, 'muted');
      if (race.is_best) {
        const td = cell(tr, '');
        const flag = document.createElement('span');
        flag.className = 'pb-flag';
        flag.textContent = 'BEST';
        td.appendChild(flag);
      } else {
        cell(tr, race.gap || '—', 'muted');
      }
    }

    $('race-log-sub').textContent =
      `${data.count} race${data.count === 1 ? '' : 's'} from ${data.path}, newest first. `
      + '"vs best" compares each swim to your best in that same event and pool.';
  }

  function renderRaces(data) {
    const problems = $('races-problems');
    if (data.problems && data.problems.length) {
      const list = $('races-problem-list');
      list.textContent = '';
      for (const problem of data.problems) {
        const item = document.createElement('li');
        item.textContent = problem;
        list.appendChild(item);
      }
      problems.hidden = false;
    } else {
      problems.hidden = true;
    }

    if (!data.available) return;
    renderRaceTiles(data);
    renderRaceBests(data);
    renderRaceProgression(data);
    renderRaceLog(data);
  }

  async function loadGoals() {
    state.goals = await getJSON('/api/goals');
    renderGoals(state.goals);
    return state.goals;
  }

  async function loadRaces() {
    state.races = await getJSON('/api/races');
    if (state.races.available || (state.races.problems || []).length > 0) {
      renderRaces(state.races);
    }
    return state.races;
  }

  /* --- foldable cards ---------------------------------------------------- */

  // id -> whether it starts open the very first time you see it.
  const FOLDS = {
    'averages-card': false,
    'chart1-card': false,
    'facets-card': false,
    'chart3-card': false,
    'totals-card': false,
    'calendar-card': false,
  };

  // Cards that fetch their own data, and only once you've opened them.
  const FOLD_LOAD = { 'calendar-card': () => refreshCalendar() };

  function initFolds() {
    for (const [id, openByDefault] of Object.entries(FOLDS)) {
      const card = $(id);
      if (!card) continue;
      const saved = state.folds[id];
      card.open = typeof saved === 'boolean' ? saved : openByDefault;
      // Setting `open` queues a toggle event of its own. Start listening after
      // that has gone past: restoring a card you left open is not you opening
      // it, and it shouldn't cost a fetch the view is about to make anyway.
      setTimeout(() => {
        card.addEventListener('toggle', () => {
          state.folds[id] = card.open;
          saveState();
          if (!card.open) return;
          // Charts inside a shut card were laid out at zero width.
          requestAnimationFrame(() => Charts.redrawAll());
          if (FOLD_LOAD[id]) FOLD_LOAD[id]();
        });
      }, 0);
    }
  }

  /* --- this week --------------------------------------------------------- */

  // The four measures, as the week payload names them.
  const WEEK_FIELDS = ['count', 'distance', 'time', 'elevation'];

  // The API always returns Monday first, so position in the array *is* the
  // weekday and there is nothing to look up.
  const WEEKDAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday',
    'Saturday', 'Sunday'];

  function spanText(startIso, endIso, short) {
    const a = parseDay(startIso);
    const b = parseDay(endIso);
    const months = short ? MONTHS_SHORT : MONTHS_LONG;
    // The year is only worth saying once the week is out of this one.
    const year = b.getFullYear() === new Date().getFullYear() ? '' : ` ${b.getFullYear()}`;
    return a.getMonth() === b.getMonth()
      ? `${a.getDate()}–${b.getDate()} ${months[b.getMonth()]}${year}`
      : `${a.getDate()} ${months[a.getMonth()]} – ${b.getDate()} ${months[b.getMonth()]}${year}`;
  }

  // What the numbers are of, once the chips have had their say. With every
  // sport ticked they are the server's own totals; unticking one takes that
  // sport out of *both* sides of the comparison, so it stays like for like
  // instead of measuring one sport against last week's whole programme.
  function weekSelection(data) {
    const chosen = data.series.filter((s) => state.week.sports.has(s.key));
    if (chosen.length === data.series.length) {
      return { series: chosen, totals: data.totals, previous: data.previous };
    }
    const totals = {};
    const previous = {};
    for (const field of WEEK_FIELDS) {
      totals[field] = chosen.reduce((acc, s) => acc + s.totals[field], 0);
      previous[field] = chosen.reduce((acc, s) => acc + (s.previous[field] || 0), 0);
    }
    return { series: chosen, totals, previous };
  }

  function weekLabel(data) {
    if (data.offset === 0) return 'This week';
    if (data.offset === -1) return 'Last week';
    return spanText(data.start, data.end, true);
  }

  function renderWeekNav(data) {
    $('week-label').textContent = weekLabel(data);
    $('week-prev').disabled = !data.has_earlier;
    $('week-next').disabled = data.offset >= 0;
  }

  function renderWeekTiles(data, view) {
    const host = $('week-tiles');
    host.textContent = '';
    // Part of a week is measured against the same part of the one before it: a
    // Tuesday compared with a whole week is a decline every time.
    const note = data.elapsed_days < 7 ? 'vs same point last week' : 'vs the week before';
    for (const tile of TILES) {
      const current = view.totals[tile.field] || 0;
      const previous = view.previous[tile.field] || 0;
      const card = tileCard(tile.label, tile.field, current);
      card.appendChild(deltaNode(current, previous, note));
      host.appendChild(card);
    }
  }

  function renderWeekChart(data, view) {
    const fmt = METRIC_FMT[state.week.metric];
    const metricLabel = (METRICS.find((m) => m.key === state.week.metric) || METRICS[0]).label;
    const host = $('week-chart');
    const legend = $('week-legend');

    const series = view.series
      .map((s) => {
        const values = s[state.week.metric];
        return {
          key: s.key,
          label: s.label,
          values,
          // Strength training has no distance and no climb, so on those two
          // measures it used to drop off the chart entirely and a strength-only
          // day read as a rest day. The sessions it did have mark the day with
          // a sliver instead — true for any sport with a blank in this unit,
          // which is what the table already says with an em dash.
          stubs: values.map((v, i) => (v > 0 ? 0 : s.count[i])),
          color: sportColor(s.key),
        };
      })
      .filter((s) => s.values.some((v) => v > 0) || s.stubs.some((v) => v > 0))
      // Stacking draws series bottom-up in array order; hiking is the slowest,
      // heaviest-looking bar, so it reads best anchored at the base every time
      // rather than shuffling with whatever order the API happens to return.
      .sort((a, b) => (a.key === 'hike' ? -1 : b.key === 'hike' ? 1 : 0));

    const running = data.offset === 0;
    const slivers = series.some((s) => s.stubs.some((v) => v > 0));
    $('week-sub').textContent =
      `${spanText(data.start, data.end)}${running ? ` — day ${data.elapsed_days} of 7` : ''}. `
      + `${metricLabel} per day, stacked by sport.`
      + (slivers
        ? ` A sliver is a session with no ${metricLabel.toLowerCase()} to it.`
        : '')
      + (running && data.elapsed_days < 7
        ? ' The flat days at the end are the ones that haven\'t happened yet.'
        : '');

    if (!series.length) {
      host.textContent = '';
      // Say which of the nothings this is: an empty week, or a week with no
      // climb in it because you only swam, or a sport you've just unticked.
      const when = running ? 'this week' : 'that week';
      host.dataset.empty = view.series.length
        ? `No ${metricLabel.toLowerCase()} logged ${when}.`
        : `Nothing logged ${when}${running ? ' yet' : ''}.`;
      host.dataset.state = 'empty';
      legend.textContent = '';
      return;
    }
    delete host.dataset.state;
    renderLegend(legend, series.map((s) => ({ label: s.label, color: s.color })), 'rect');

    Charts.columns(host, {
      buckets: data.days,
      series,
      xLabels: data.days.map((_, i) => WEEKDAYS_SHORT[i]),
      xTooltips: data.days.map((day, i) => {
        const d = parseDay(day);
        return `${WEEKDAYS_LONG[i]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`
          + (day === data.today ? ' — today' : '');
      }),
      formatValue: fmt.value,
      formatTick: fmt.tick,
      formatStub: (n) => `${num(n, 0)} session${n === 1 ? '' : 's'}`,
      integerTicks: state.week.metric === 'count',
      labelWidth: 34,                       // 'Mon' needs far less room than a date
      emphasisIndex: data.days.indexOf(data.today),
      ariaLabel: `${metricLabel} per day by sport, ${data.start} to ${data.end}. `
        + 'The same figures are listed by sport below.',
    });
  }

  function renderWeekTable(data, view) {
    const table = $('week-table');
    const empty = $('week-table-empty');
    table.textContent = '';

    // Counted over the sports on show, so the line agrees with the table under
    // it rather than with a sport you've just unticked.
    const active = data.days.filter((_, i) => view.series.some((s) => s.count[i] > 0)).length;
    const elapsed = data.elapsed_days;
    const left = 7 - elapsed;
    $('week-table-sub').textContent = left
      ? `${active} of ${elapsed} day${elapsed === 1 ? '' : 's'} so far with a session, `
        + `${left} still to come.`
      : `${active} of 7 days with a session — the week is done.`;

    table.hidden = !view.series.length;
    empty.hidden = !!view.series.length;
    if (!view.series.length) return;

    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    head.appendChild(headRow);
    table.appendChild(head);
    ['Sport', 'Sessions', 'Distance (km)', 'Time', 'Climb (m)'].forEach((l) => cell(headRow, l));

    const body = document.createElement('tbody');
    table.appendChild(body);
    for (const s of view.series) {
      const tr = document.createElement('tr');
      body.appendChild(tr);

      const nameCell = cell(tr, '');
      const wrap = document.createElement('span');
      wrap.className = 'name';
      const key = document.createElement('span');
      key.className = 'key';
      key.style.background = sportColor(s.key);
      wrap.appendChild(key);
      wrap.appendChild(document.createTextNode(s.label));
      nameCell.appendChild(wrap);

      const { distance, elevation } = s.totals;
      cell(tr, num(s.totals.count));
      cell(tr, distance ? num(distance, kmDigits(distance)) : '—', distance ? '' : 'muted');
      cell(tr, hoursHuman(s.totals.time));
      cell(tr, elevation ? num(elevation) : '—', elevation ? '' : 'muted');
    }

    const foot = document.createElement('tfoot');
    const footRow = document.createElement('tr');
    foot.appendChild(footRow);
    table.appendChild(foot);
    cell(footRow, 'Total');
    cell(footRow, num(view.totals.count));
    cell(footRow, num(view.totals.distance, kmDigits(view.totals.distance)));
    cell(footRow, hoursHuman(view.totals.time));
    cell(footRow, num(view.totals.elevation));
  }

  // Rebuilt only when the week changes: doing it on every tick would replace
  // the checkbox under the pointer and throw the focus away with it.
  function buildWeekChips(data) {
    $('week-sports-filter').hidden = !data.series.length;
    buildSportChips(
      $('week-sports'),
      data.series.map((s) => ({ key: s.key, label: s.label })),
      state.week.sports,
      () => {
        for (const s of data.series) {
          if (state.week.sports.has(s.key)) state.week.excluded.delete(s.key);
          else state.week.excluded.add(s.key);
        }
        renderWeek(state.week.data);
      },
    );
  }

  function renderWeek(data) {
    const view = weekSelection(data);
    renderWeekNav(data);
    renderWeekTiles(data, view);
    renderWeekChart(data, view);
    renderWeekTable(data, view);
  }

  let weekSeq = 0;

  async function refreshWeek() {
    const seq = ++weekSeq;
    inFlight += 1;
    document.body.classList.add('is-loading');
    Charts.hideTooltip();
    try {
      const data = await getJSON(`/api/week?offset=${state.week.offset}`);
      if (seq !== weekSeq) return;          // a faster click already won
      state.week.data = data;
      state.week.loaded = true;
      // Carry your choices across, but only the ones you actually made: a
      // sport you unticked stays out, anything else the week contains is in.
      // Unticking everything a week has is not a state worth landing in, so
      // that week starts whole.
      const available = data.series.map((s) => s.key);
      const kept = available.filter((key) => !state.week.excluded.has(key));
      state.week.sports = new Set(kept.length ? kept : available);
      buildWeekChips(data);
      renderWeek(data);
    } catch (error) {
      console.error(error);
      if (seq === weekSeq) setSyncState(`Error: ${error.message}`);
    } finally {
      inFlight -= 1;
      if (!inFlight) document.body.classList.remove('is-loading');
    }
  }

  function stepWeek(delta) {
    const target = Math.min(0, state.week.offset + delta);   // never the future
    if (target === state.week.offset) return;
    state.week.offset = target;
    refreshWeek();
  }

  function buildWeekControls() {
    buildSegmented($('week-metric'), METRICS, 'week-metric', state.week.metric, (key) => {
      state.week.metric = key;
      saveState();
      // Only the chart is drawn in one measure; the tiles and the table show
      // all four whatever this is set to.
      if (state.week.data) renderWeekChart(state.week.data, weekSelection(state.week.data));
    });
    $('week-prev').addEventListener('click', () => stepWeek(-1));
    $('week-next').addEventListener('click', () => stepWeek(1));
  }

  /* --- workout log ------------------------------------------------------- */

  const LOG_COLUMNS = [
    { label: 'Date', sort: 'date' },
    { label: 'Workout' },
    { label: 'Distance (km)', sort: 'distance' },
    { label: 'Time', sort: 'time' },
    { label: 'Climb (m)', sort: 'elevation' },
    { label: 'Pace' },
  ];

  const LOG_SORT_KEYS = LOG_COLUMNS.filter((c) => c.sort).map((c) => c.sort);

  function mediumDate(isoDate) {
    const d = parseDay(isoDate);
    return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
  }

  function clock(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.round(seconds % 60);
    return h
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;
  }

  // Pace in the unit each sport is actually talked about in.
  function paceText(row) {
    if (!row.distance || !row.seconds) return '—';
    // Rides and hikes are talked about as speed; runs and swims as pace.
    if (row.group === 'ride' || row.group === 'hike') {
      return `${num(row.distance / (row.seconds / 3600), 1)} km/h`;
    }
    const perUnit = row.group === 'swim'
      ? row.seconds / (row.distance * 10)     // km -> 100 m units
      : row.seconds / row.distance;
    return `${clock(perUnit)} ${row.group === 'swim' ? '/100m' : '/km'}`;
  }

  function logHead(table) {
    const head = document.createElement('thead');
    const row = document.createElement('tr');
    head.appendChild(row);
    table.appendChild(head);

    for (const column of LOG_COLUMNS) {
      const th = document.createElement('th');
      if (!column.sort) {
        th.textContent = column.label;
        row.appendChild(th);
        continue;
      }
      const active = state.log.sort === column.sort;
      if (active) th.setAttribute('aria-sort', state.log.direction === 'asc' ? 'ascending' : 'descending');

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sort';
      button.appendChild(document.createTextNode(column.label));
      if (active) {
        const arrow = document.createElement('span');
        arrow.className = 'arrow';
        arrow.textContent = state.log.direction === 'asc' ? '▲' : '▼';
        button.appendChild(arrow);
      }
      button.addEventListener('click', () => {
        // Same column flips; a new one starts at "biggest/newest first".
        if (state.log.sort === column.sort) {
          state.log.direction = state.log.direction === 'asc' ? 'desc' : 'asc';
        } else {
          state.log.sort = column.sort;
          state.log.direction = 'desc';
        }
        saveState();
        refreshLog();
      });
      th.appendChild(button);
      row.appendChild(th);
    }
  }

  function logRows(body, rows) {
    for (const row of rows) {
      const tr = document.createElement('tr');
      body.appendChild(tr);

      cell(tr, mediumDate(row.date));

      const nameCell = cell(tr, '', 'log-name');
      const sport = document.createElement('span');
      sport.className = 'sport';
      const key = document.createElement('span');
      key.className = 'key';
      key.style.background = sportColor(row.group);
      sport.appendChild(key);
      // The label is what it is; the link is where the detail lives.
      const link = document.createElement('a');
      link.href = `https://www.strava.com/activities/${row.id}`;
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      link.textContent = row.label;
      link.title = 'Open on Strava';
      sport.appendChild(link);
      nameCell.appendChild(sport);

      cell(tr, row.distance ? num(row.distance, kmDigits(row.distance)) : '—',
        row.distance ? '' : 'muted');
      cell(tr, clock(row.seconds));
      cell(tr, row.elevation ? num(row.elevation) : '—', row.elevation ? '' : 'muted');
      cell(tr, paceText(row), 'muted');
    }
  }

  const LOG_TILES = [
    { field: 'count', label: 'Workouts' },
    { field: 'distance', label: 'Distance' },
    { field: 'time', label: 'Moving time' },
    { field: 'elevation', label: 'Elevation gain' },
  ];

  function renderLogTiles(totals) {
    const host = $('log-tiles');
    host.textContent = '';
    for (const tile of LOG_TILES) {
      host.appendChild(tileCard(tile.label, tile.field, totals[tile.field] || 0));
    }
  }

  function renderLog(data, append) {
    const table = $('log-table');
    let body = table.querySelector('tbody');

    if (!append) {
      table.textContent = '';
      logHead(table);
      body = document.createElement('tbody');
      table.appendChild(body);
      state.log.shown = 0;
      renderLogTiles(data.totals);
    }

    logRows(body, data.rows);
    state.log.shown += data.rows.length;

    const scope = state.log.q ? ` matching “${state.log.q}”` : '';
    $('log-sub').textContent = data.total
      ? `${num(data.total)} workout${data.total === 1 ? '' : 's'}${scope}`
        + `, showing ${num(state.log.shown)}. Named by sport — a walk counts as a `
        + 'hike, and anything outside the four sports keeps its own type. '
        + 'Each one links to Strava.'
      : '';
    $('log-empty').hidden = data.total > 0;
    table.hidden = data.total === 0;
    $('log-more').hidden = !data.has_more;
  }

  let logSeq = 0;

  async function refreshLog(append = false) {
    // The calendar shares this view's chips and search box, so it is redrawn
    // by the same things that redraw the list — but not by paging it.
    if (!append && calOpen()) refreshCalendar();

    const { start, end } = range('all');
    // Offline with a cold overview: no chip state yet, so don't filter by sport.
    const sports = state.log.sports ? [...state.log.sports].join(',') : '';
    const offset = append ? state.log.shown : 0;
    const query = `start=${start}&end=${end}&sports=${encodeURIComponent(sports)}`
      + `&q=${encodeURIComponent(state.log.q)}`
      + `&sort=${state.log.sort}&direction=${state.log.direction}`
      + `&limit=${LOG_PAGE}&offset=${offset}`;

    const seq = ++logSeq;
    const button = $('log-more');
    button.disabled = true;
    try {
      const data = await getJSON(`/api/activities?${query}`);
      if (seq !== logSeq) return;         // a newer keystroke already won
      state.log.loaded = true;
      renderLog(data, append);
    } catch (error) {
      console.error(error);
      if (seq === logSeq) setSyncState(`Error: ${error.message}`);
    } finally {
      if (seq === logSeq) button.disabled = false;
    }
  }

  function buildLogControls() {
    const search = $('log-q');
    let timer = null;
    search.value = state.log.q;
    search.addEventListener('input', () => {
      // Debounced: typing shouldn't fire a query per keystroke.
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.log.q = search.value.trim();
        refreshLog();
      }, 200);
    });

    $('log-more').addEventListener('click', () => refreshLog(true));
  }

  /* --- calendar ---------------------------------------------------------- */

  // The month grid asks a different question from the list below it: not "find
  // that session" but "what did that month look like". It borrows the log's
  // sport chips and search box — the two should never disagree about what
  // counts — but steps month by month rather than following the period.

  const CAL_LIMIT = 200;      // the log endpoint's own page cap
  const CAL_PAGES = 5;        // a month never gets near 1000 sessions; a guard, not a plan

  const calOpen = () => {
    const card = $('calendar-card');
    return !!card && card.open;
  };

  const monthOf = (d) => new Date(d.getFullYear(), d.getMonth(), 1);

  function calMonth() {
    if (!state.calendar.month) state.calendar.month = iso(monthOf(new Date()));
    return parseDay(state.calendar.month);
  }

  function calStep(delta) {
    const shown = calMonth();
    state.calendar.month = iso(new Date(shown.getFullYear(), shown.getMonth() + delta, 1));
    refreshCalendar();
  }

  // Monday first, matching the week view. Leading and trailing cells fill out
  // the weeks either side so the columns stay under their weekday.
  function calCells(first) {
    const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const lead = (first.getDay() + 6) % 7;        // JS weeks start on Sunday
    const cells = new Array(lead).fill(null);
    for (let day = 1; day <= days; day += 1) {
      cells.push(new Date(first.getFullYear(), first.getMonth(), day));
    }
    while (cells.length % 7) cells.push(null);
    return cells;
  }

  function calEntry(row, date) {
    const link = document.createElement('a');
    link.className = 'cal-entry';
    link.href = `https://www.strava.com/activities/${row.id}`;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    link.style.setProperty('--entry-color', sportColor(row.group));

    const key = document.createElement('span');
    key.className = 'key';
    link.appendChild(key);

    const text = document.createElement('span');
    text.className = 'cal-entry-text';
    // Distance is the headline where there is one; a gym session only has time.
    text.textContent = row.distance
      ? `${num(row.distance, kmDigits(row.distance))} km`
      : clock(row.seconds);
    link.appendChild(text);

    // A cell this small can only show one figure, so the rest goes in the
    // tooltip — and in the accessible name, which is otherwise just "12.4 km".
    const bits = [row.label];
    if (row.distance) bits.push(`${num(row.distance, kmDigits(row.distance))} km`);
    bits.push(clock(row.seconds));
    if (row.elevation) bits.push(`${num(row.elevation)} m climb`);
    if (row.distance && row.seconds) bits.push(paceText(row));
    const when = `${date.getDate()} ${MONTHS_SHORT[date.getMonth()]}`;
    link.title = `${when} — ${bits.join(' · ')}`;
    link.setAttribute('aria-label', `${when}: ${bits.join(', ')}. Open on Strava.`);
    return link;
  }

  function calDay(date, byDay, today) {
    const cell = document.createElement('div');
    cell.className = 'cal-day';
    if (!date) {
      cell.classList.add('cal-blank');
      return cell;
    }
    const key = iso(date);
    if (key === today) cell.classList.add('is-today');

    const number = document.createElement('span');
    number.className = 'cal-num';
    number.textContent = String(date.getDate());
    cell.appendChild(number);

    for (const row of byDay.get(key) || []) cell.appendChild(calEntry(row, date));
    return cell;
  }

  function renderCalendarNav(first) {
    $('cal-label').textContent = `${MONTHS_LONG[first.getMonth()]} ${first.getFullYear()}`;
    // Nothing ahead of this month, and nothing before the first thing on file.
    $('cal-next').disabled = first >= monthOf(new Date());
    const earliest = state.overview && state.overview.first_date;
    $('cal-prev').disabled = !!earliest && first <= monthOf(parseDay(earliest));
  }

  function calTotalsText(rows, totals, truncated) {
    if (!rows.length) return 'Nothing logged this month.';
    const parts = [`${num(rows.length)} workout${rows.length === 1 ? '' : 's'}`];
    if (totals.distance) parts.push(`${num(totals.distance, kmDigits(totals.distance))} km`);
    if (totals.time) parts.push(hoursHuman(totals.time));
    if (totals.elevation) parts.push(`${num(totals.elevation)} m climb`);
    // Said out loud rather than silently cut: a grid that stops short should
    // never read as a complete month.
    return parts.join(' · ') + (truncated ? ` — first ${num(rows.length)} shown` : '');
  }

  function renderCalendar(rows, totals, truncated) {
    const first = calMonth();
    const host = $('calendar');
    host.textContent = '';

    // Rows arrive oldest day first, but newest *within* a day — the log's own
    // tie-break. Unshifting puts each day back in the order you did it.
    const byDay = new Map();
    for (const row of rows) {
      if (!byDay.has(row.date)) byDay.set(row.date, []);
      byDay.get(row.date).unshift(row);
    }

    for (const label of WEEKDAYS_SHORT) {
      const head = document.createElement('div');
      head.className = 'cal-head';
      head.textContent = label;
      host.appendChild(head);
    }

    const today = iso(new Date());
    for (const date of calCells(first)) host.appendChild(calDay(date, byDay, today));

    renderCalendarNav(first);
    $('cal-totals').textContent = calTotalsText(rows, totals, truncated);
  }

  let calSeq = 0;

  async function refreshCalendar() {
    const first = calMonth();
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
    // Offline with a cold overview: no chip state yet, so don't filter by sport.
    const sports = state.log.sports ? [...state.log.sports].join(',') : '';
    const query = `start=${iso(first)}&end=${iso(last)}`
      + `&sports=${encodeURIComponent(sports)}&q=${encodeURIComponent(state.log.q)}`
      + `&sort=date&direction=asc&limit=${CAL_LIMIT}`;

    const seq = ++calSeq;
    const buttons = [$('cal-prev'), $('cal-next')];
    for (const button of buttons) button.disabled = true;
    try {
      // Paged rather than assumed: one call returns 200 rows at most, and a
      // busier month than that is one this would otherwise quietly truncate.
      const rows = [];
      let data = null;
      for (let page = 0; page < CAL_PAGES; page += 1) {
        data = await getJSON(`/api/activities?${query}&offset=${rows.length}`);
        if (seq !== calSeq) return;             // a newer month already won
        rows.push(...data.rows);
        if (!data.has_more) break;
      }
      renderCalendar(rows, data.totals, data.has_more);
    } catch (error) {
      console.error(error);
      if (seq === calSeq) setSyncState(`Error: ${error.message}`);
    } finally {
      // Idempotent: the arrows are enabled by where the month sits in the
      // record, so this both re-enables them and puts them back after a failure.
      if (seq === calSeq) renderCalendarNav(calMonth());
    }
  }

  function buildCalendarControls() {
    $('cal-prev').addEventListener('click', () => calStep(-1));
    $('cal-next').addEventListener('click', () => calStep(1));
  }

  /* --- map --------------------------------------------------------------- */

  // Leaflet is 150 KB the other views never touch, so it is fetched the first
  // time the map is opened rather than on every launch. A failure to load it
  // costs the map, never the rest of the app.
  let leafletLoading = null;

  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (!leafletLoading) {
      leafletLoading = new Promise((resolve, reject) => {
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = '/vendor/leaflet/leaflet.css';
        // Ahead of styles.css, so the app's overrides of Leaflet's chrome win.
        document.head.insertBefore(css, document.head.querySelector('link[rel="stylesheet"]'));
        const script = document.createElement('script');
        script.src = '/vendor/leaflet/leaflet.js';
        script.onload = () => resolve();
        script.onerror = () => {
          leafletLoading = null;            // let the next open try again
          reject(new Error('could not load the map library'));
        };
        document.head.appendChild(script);
      });
    }
    return leafletLoading;
  }

  // Google's encoded polyline format, precision 5 — what Strava's
  // summary_polyline is. Decoded once per trace and kept on it.
  function decodePolyline(encoded) {
    const points = [];
    let index = 0;
    let lat = 0;
    let lng = 0;
    const next = () => {
      let result = 0;
      let shift = 0;
      let byte;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && index < encoded.length);
      return (result & 1) ? ~(result >> 1) : (result >> 1);
    };
    while (index < encoded.length) {
      lat += next();
      lng += next();
      points.push([lat / 1e5, lng / 1e5]);
    }
    return points;
  }

  // OpenStreetMap's own tiles, the one basemap that needs no key. They are
  // drawn in full colour, and their orange main roads would fight the traces,
  // so the stylesheet drains the colour out of the tile pane (and inverts it
  // in the dark theme) — see .map .leaflet-tile-pane in styles.css.
  const MAP_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

  const map = {
    leaflet: null,        // the L.Map, once the view has been opened
    layer: null,          // every drawn trace
    renderer: null,
    bounds: null,         // of everything drawn, for "Show all"
    home: null,           // of where most of it is, for the first frame
    framed: false,        // has the map been put somewhere worth remembering
  };

  function ensureMap() {
    if (map.leaflet) return;
    map.leaflet = L.map('map', { worldCopyJump: true, zoomSnap: 0.5 });
    // One canvas for every trace: a thousand SVG paths would make panning on a
    // phone stutter. A generous tolerance makes a 2px line tappable.
    map.renderer = L.canvas({ tolerance: 8 });
    map.layer = L.layerGroup().addTo(map.leaflet);
    L.tileLayer(MAP_TILES, {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map.leaflet);
    // Leaflet refuses vector layers until the map has a view, so there is
    // always one — the saved spot, or a placeholder that renderMap replaces
    // with a frame around every trace the first time it draws.
    const saved = state.map.viewport;
    map.framed = !!saved;
    if (saved) map.leaflet.setView([saved.lat, saved.lng], saved.zoom);
    else map.leaflet.setView([46.5, 2.5], 5);
    map.leaflet.on('moveend', () => {
      if (!map.framed) return;              // the placeholder isn't worth remembering
      const centre = map.leaflet.getCenter();
      state.map.viewport = {
        lat: +centre.lat.toFixed(5), lng: +centre.lng.toFixed(5), zoom: map.leaflet.getZoom(),
      };
      saveState();
    });
  }

  function trackPopup(track) {
    const box = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = track.label;
    box.appendChild(title);
    const meta = document.createElement('div');
    meta.className = 'muted';
    meta.textContent = `${longDate(track.date)} · ${num(track.distance, kmDigits(track.distance))} km`;
    box.appendChild(meta);
    const link = document.createElement('a');
    link.href = `https://www.strava.com/activities/${track.id}`;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Open on Strava';
    box.appendChild(link);
    return box;
  }

  function renderMap() {
    const data = state.map.data;
    if (!data || !map.leaflet) return;
    map.layer.clearLayers();
    // Translucent on purpose: canvas strokes stack, so a street you have been
    // down twenty times comes out solid and one you took once stays faint.
    const style = {
      renderer: map.renderer, color: cssVar('--track'), weight: 2.5, opacity: 0.55,
    };
    let bounds = null;
    let km = 0;
    const drawn = [];
    for (const track of data.tracks) {
      if (!state.map.sports.has(track.group)) continue;
      if (!track.points) track.points = decodePolyline(track.line);
      if (track.points.length < 2) continue;
      const line = L.polyline(track.points, style);
      line.bindPopup(() => trackPopup(track));
      map.layer.addLayer(line);
      const b = line.getBounds();
      bounds = bounds ? bounds.extend(b) : L.latLngBounds(b.getSouthWest(), b.getNorthEast());
      drawn.push({ track, bounds: b });
      km += track.distance;
    }
    const shown = drawn.length;
    map.bounds = bounds;
    map.home = homeBounds(drawn);
    $('map-fit').disabled = !bounds;
    $('map-sub').textContent = shown
      ? `${num(shown)} trace${shown === 1 ? '' : 's'}, ${num(km, 0)} km. `
        + 'The more often you went somewhere, the bolder the line. Tap one for the session.'
      : 'No GPS traces for these sports.';
    // First visit: frame where you usually go — everything would mean a map of
    // the continent with home a smudge in the middle of it, because of one
    // holiday. After that the map opens where you left it.
    if (!map.framed && bounds) {
      map.framed = true;
      map.leaflet.fitBounds(map.home || bounds, { padding: [16, 16] });
    }
  }

  // The traces that start near the median start point: "home", for whatever
  // home has meant across the history. A median rather than a mean, so a trip
  // abroad pulls it nowhere.
  function homeBounds(drawn) {
    if (!drawn.length) return null;
    const median = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    };
    const lat = median(drawn.map((d) => d.track.points[0][0]));
    const lng = median(drawn.map((d) => d.track.points[0][1]));
    let home = null;
    for (const d of drawn) {
      const [startLat, startLng] = d.track.points[0];
      // About 40 km either way: a day's hike from the door, not a holiday.
      if (Math.abs(startLat - lat) > 0.36 || Math.abs(startLng - lng) > 0.5) continue;
      home = home ? home.extend(d.bounds) : L.latLngBounds(d.bounds.getSouthWest(), d.bounds.getNorthEast());
    }
    return home;
  }

  function fitMap() {
    if (map.leaflet && map.bounds) map.leaflet.fitBounds(map.bounds, { padding: [16, 16] });
  }

  // The chips list only the sports that have a trace — a chip for swimming
  // laps in a pool is a control with nothing behind it.
  function buildMapChips() {
    const present = new Set(state.map.data.tracks.map((t) => t.group));
    const groups = ((state.overview && state.overview.groups) || [])
      .filter((g) => present.has(g.key));
    const kept = groups.map((g) => g.key).filter((k) => !state.map.excluded.has(k));
    state.map.sports = new Set(kept.length ? kept : groups.map((g) => g.key));
    const container = $('map-sports');
    buildSportChips(container, groups, state.map.sports, renderMap, state.map.excluded);
    // Every trace is drawn in the one colour, so the chips wear it too rather
    // than promising a per-sport colour the map doesn't use.
    const colour = cssVar('--track');
    for (const chip of container.children) chip.style.setProperty('--chip-color', colour);
  }

  let mapSeq = 0;

  async function refreshMap() {
    const seq = ++mapSeq;
    try {
      const [data] = await Promise.all([getJSON('/api/tracks'), loadLeaflet()]);
      if (seq !== mapSeq) return;
      state.map.data = data;
      state.map.loaded = true;
      // Built after the map is visible: Leaflet measures its container once,
      // and a hidden one measures zero.
      ensureMap();
      map.leaflet.invalidateSize();
      buildMapChips();
      renderMap();
    } catch (error) {
      console.error(error);
      if (seq === mapSeq) $('map-sub').textContent = `Map unavailable — ${error.message}.`;
    }
  }

  function buildMapControls() {
    const fit = $('map-fit');
    if (!fit) return;                       // stale shell; the map tab won't work, the rest will
    fit.addEventListener('click', fitMap);
  }

  /* --- views ------------------------------------------------------------- */

  // Rising bars for the charts view, a calendar for this week, a bulleted list
  // for the session log, a trophy for race results. The list is bulleted rather
  // than three plain rules so it doesn't read as a hamburger menu sitting in the
  // header, and races is a trophy rather than a medal because a medal's ribbon
  // turns to mush at 16px.
  const VIEW_ICONS = {
    // A folded paper map: three panels, the middle one set back.
    map: [
      ['path', {
        d: 'M1.9 4.1 5.9 2.6l4.2 1.6 4-1.5v9.2l-4 1.5-4.2-1.6-4 1.5Z',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 1.4,
        'stroke-linejoin': 'round',
      }],
      ['path', {
        d: 'M5.9 2.6v9.2M10.1 4.2v9.2',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 1.4,
      }],
    ],
    training: [
      ['rect', { x: 2.25, y: 8.5, width: 3, height: 5.25, rx: 1, fill: 'currentColor' }],
      ['rect', { x: 6.5, y: 5.5, width: 3, height: 8.25, rx: 1, fill: 'currentColor' }],
      ['rect', { x: 10.75, y: 2.5, width: 3, height: 11.25, rx: 1, fill: 'currentColor' }],
    ],
    week: [
      ['rect', {
        x: 2.2, y: 3.4, width: 11.6, height: 10.4, rx: 2,
        fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4,
      }],
      ['path', {
        d: 'M2.2 6.9h11.6M5.4 2.1v2.6M10.6 2.1v2.6',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 1.4,
        'stroke-linecap': 'round',
      }],
      ['rect', { x: 4.6, y: 9, width: 2.6, height: 2.6, rx: 0.8, fill: 'currentColor' }],
    ],
    workouts: [
      ['circle', { cx: 3.1, cy: 4, r: 1.1, fill: 'currentColor' }],
      ['circle', { cx: 3.1, cy: 8, r: 1.1, fill: 'currentColor' }],
      ['circle', { cx: 3.1, cy: 12, r: 1.1, fill: 'currentColor' }],
      ['path', {
        d: 'M6.4 4h7.1M6.4 8h7.1M6.4 12h7.1',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 1.5,
        'stroke-linecap': 'round',
      }],
    ],
    // A target: concentric rings with a filled centre.
    goals: [
      ['circle', {
        cx: 8, cy: 8, r: 6,
        fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4,
      }],
      ['circle', {
        cx: 8, cy: 8, r: 3.1,
        fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4,
      }],
      ['circle', { cx: 8, cy: 8, r: 1.2, fill: 'currentColor' }],
    ],
    races: [
      ['path', {
        d: 'M4.9 2.3h6.2v2.9a3.1 3.1 0 0 1-6.2 0z',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 1.4,
        'stroke-linejoin': 'round',
      }],
      ['path', {
        d: 'M4.9 3.2H3.3a1.8 1.8 0 0 0 1.9 2.5M11.1 3.2h1.6a1.8 1.8 0 0 1-1.9 2.5',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 1.4,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      }],
      ['path', {
        d: 'M8 8.3v2.5M5.5 13.5h5',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 1.4,
        'stroke-linecap': 'round',
      }],
    ],
  };

  // Goals and Races each appear only once their file has something in it;
  // the other three always do. Switcher order, left to right: goals first
  // because "am I doing what I said I would" is the sharpest version of the
  // question you open the app with, then the week it plays out in, then the
  // longer views you scroll on to.
  const VIEWS = [
    { key: 'goals', label: 'Goals', icon: VIEW_ICONS.goals, optional: true },
    { key: 'week', label: 'This week', short: 'Week', icon: VIEW_ICONS.week },
    { key: 'training', label: 'Training', icon: VIEW_ICONS.training },
    { key: 'workouts', label: 'Workouts', icon: VIEW_ICONS.workouts },
    { key: 'map', label: 'Map', icon: VIEW_ICONS.map },
    { key: 'races', label: 'Races', icon: VIEW_ICONS.races, optional: true },
  ];

  // An optional view earns its tab by having something to show — including a
  // file with a typo in it, since a view that vanishes is a worse way to learn
  // about the typo than a banner explaining it.
  const HAS_DATA = {
    goals: () => !!state.goals
      && (state.goals.available || (state.goals.problems || []).length > 0),
    races: () => !!state.races
      && (state.races.available || (state.races.problems || []).length > 0),
  };

  // Null until its file has been fetched. "Not answered yet" and "nothing to
  // show" both make HAS_DATA false, and only the first of them is temporary.
  const PENDING = {
    goals: () => state.goals === null,
    races: () => state.races === null,
  };

  function availableViews() {
    return VIEWS.filter((v) => !v.optional || HAS_DATA[v.key]());
  }

  function applyView() {
    // The tooltip is a single node outside every view container, so nothing
    // here would otherwise take it down when the tab changes under it.
    Charts.hideTooltip();
    for (const view of VIEWS) {
      $(`view-${view.key}`).hidden = state.view !== view.key;
    }
    // Charts drawn inside a hidden container have no width; redraw on reveal.
    // The map is the same story: Leaflet sized itself while it was hidden.
    requestAnimationFrame(() => {
      Charts.redrawAll();
      if (state.view === 'map' && map.leaflet) map.leaflet.invalidateSize();
    });
  }

  function buildViewSwitcher() {
    const views = availableViews();
    $('views').hidden = views.length < 2;
    // A saved view whose file hasn't come back yet is unknown, not absent, and
    // falling back to the first tab here would mean reopening the app on Goals
    // or Races always landed you somewhere else.
    const waiting = state.view in PENDING && PENDING[state.view]();
    if (!waiting && !views.some((v) => v.key === state.view)) state.view = views[0].key;
    buildSegmented($('views'), views, 'view', state.view, (key) => {
      state.view = key;
      saveState();
      applyView();
      // Each of these is only fetched when it is first looked at.
      if (key === 'workouts' && !state.log.loaded) refreshLog();
      if (key === 'week' && !state.week.loaded) refreshWeek();
      if (key === 'map' && !state.map.loaded) refreshMap();
    });
  }

  /* --- data flow --------------------------------------------------------- */

  async function getJSON(url) {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.detail || `${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  let inFlight = 0;

  async function refresh() {
    const { start, end } = range(state.period);
    const sports = [...state.sports].join(',');
    const query = `start=${start}&end=${end}&sports=${encodeURIComponent(sports)}`;

    inFlight += 1;
    document.body.classList.add('is-loading');
    Charts.hideTooltip();

    try {
      const [series, totals, records, averages] = await Promise.all([
        getJSON(`/api/series?metric=${state.metric}&bucket=${state.bucket}&${query}`),
        getJSON(`/api/totals?${query}`),
        getJSON(`/api/records?metric=${state.metric}&${query}`),
        getJSON(`/api/averages?metric=${state.metric}&${query}`),
      ]);
      state.lastSeries = series;

      renderTiles(totals);
      renderRecords(records);
      renderAverages(averages);
      renderMainChart(series);
      renderFacets(series);
      renderTotalsTable(totals);
      renderSeriesTable(series);

      const withData = series.series.filter((s) => s.values.some((v) => v > 0)).map((s) => s.key);
      const cumulative = await Promise.all(withData.map((group) =>
        getJSON(`/api/cumulative?metric=${state.metric}&group=${group}&years=6`).catch(() => null)
      ));
      renderCumulative(cumulative);

      $('foot-range').textContent = state.overview && state.overview.first_date
        ? `${state.overview.activity_count} activities on file, ${state.overview.first_date} to ${state.overview.last_date}.`
        : '';
    } catch (error) {
      console.error(error);
      setSyncState(`Error: ${error.message}`);
    } finally {
      inFlight -= 1;
      if (!inFlight) document.body.classList.remove('is-loading');
    }
  }

  function setSyncState(text) {
    $('sync-state').textContent = text;
  }

  function relativeTime(isoString) {
    if (!isoString) return 'never synced';
    const then = new Date(isoString);
    const mins = Math.round((Date.now() - then.getTime()) / 60000);
    if (mins < 2) return 'synced just now';
    if (mins < 60) return `synced ${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `synced ${hours}h ago`;
    return `synced ${Math.round(hours / 24)}d ago`;
  }

  // Sessions Strava is holding twice. Named rather than quietly corrected: the
  // rows are real and both are on Strava, so the app showing one of them would
  // just be a different wrong number. Each copy links straight to Strava, which
  // is where deleting it actually helps.
  function renderDuplicates(groups) {
    const notice = $('dupes-notice');
    notice.hidden = !groups.length;
    if (!groups.length) return;

    const km = groups.reduce((acc, g) => acc + g.extra_distance, 0);
    const hours = groups.reduce((acc, g) => acc + g.extra_hours, 0);
    const counted = [
      km >= 0.01 ? `${num(km, kmDigits(km))} km` : '',
      hours >= 0.01 ? hoursHuman(hours) : '',
    ].filter(Boolean).join(' and ');
    $('dupes-title').textContent =
      `${groups.length} session${groups.length === 1 ? '' : 's'} look like `
      + `${groups.length === 1 ? 'it is' : 'they are'} in Strava twice`
      + (counted ? `, counting ${counted} more than once.` : '.');

    // Capped, but never silently: an account that has been double-posting for
    // years would otherwise push the whole app off the screen.
    const LIMIT = 8;
    const shown = groups.slice(0, LIMIT);
    const list = $('dupes-list');
    list.textContent = '';
    for (const group of shown) {
      const item = document.createElement('li');
      const head = document.createElement('div');
      head.className = 'dupe-head';
      head.textContent = `${longDate(group.date)} — ${group.sport_label}`;
      item.appendChild(head);

      const copies = document.createElement('ul');
      for (const copy of group.activities) {
        const line = document.createElement('li');
        const amount = document.createElement('span');
        amount.className = 'amount';
        amount.textContent = copy.distance
          ? `${num(copy.distance, 2)} km · ${copy.minutes} min`
          : `${copy.minutes} min`;
        line.appendChild(amount);
        const link = document.createElement('a');
        link.href = copy.url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = copy.name || `activity ${copy.id}`;
        line.appendChild(link);
        copies.appendChild(line);
      }
      item.appendChild(copies);
      list.appendChild(item);
    }
    if (groups.length > shown.length) {
      const more = document.createElement('li');
      more.className = 'dupe-head';
      more.textContent = `…and ${groups.length - shown.length} more, oldest first `
        + 'in `app.cli status`.';
      list.appendChild(more);
    }
  }

  async function loadOverview() {
    const overview = await getJSON('/api/overview');
    state.overview = overview;

    $('setup-notice').hidden = overview.authorised;
    $('empty-notice').hidden = overview.activity_count > 0;
    renderDuplicates(overview.duplicates || []);
    setSyncState(relativeTime(overview.last_sync));

    // How far back the year stepper may go is a fact about the data, and this
    // is the moment we learn it.
    renderYearNav();

    // Anything the database now has, minus what you've unticked. Unticking
    // everything is not a state worth landing in, so that falls back to whole.
    const available = overview.groups.map((g) => g.key);
    const kept = available.filter((k) => !state.excluded.has(k));
    state.sports = new Set(kept.length ? kept : available);
    const keptLog = available.filter((k) => !state.log.excluded.has(k));
    state.log.sports = new Set(keptLog.length ? keptLog : available);

    buildSportChips($('f-sports'), overview.groups, state.sports, refresh, state.excluded);
    buildSportChips($('log-sports'), overview.groups, state.log.sports, () => {
      state.log.shown = 0;
      refreshLog();
    }, state.log.excluded);
    return overview;
  }

  /* --- theme ------------------------------------------------------------- */

  function applyTheme(theme) {
    if (theme) document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('workouts.theme', theme || ''); } catch (_) { /* ignore */ }
    // Colours are read from CSS custom properties at draw time, so both views
    // have to be re-rendered rather than just re-laid-out.
    requestAnimationFrame(() => {
      if (state.lastSeries) refresh();
      // Chips carry their sport's colour as an inline value, and the two themes
      // don't use the same one — they have to be built again, not just redrawn.
      if (state.week.data) {
        buildWeekChips(state.week.data);
        renderWeek(state.week.data);
      }
      if (state.log.loaded) refreshLog();
      if (state.goals) renderGoals(state.goals);
      if (state.races && state.races.available) renderRaces(state.races);
      // The trace colour changes with the theme; the basemap follows by CSS.
      if (map.leaflet && state.map.data) {
        buildMapChips();
        renderMap();
      }
    });
  }

  function initTheme() {
    let stored = '';
    try { stored = localStorage.getItem('workouts.theme') || ''; } catch (_) { /* ignore */ }
    if (stored) document.documentElement.setAttribute('data-theme', stored);

    $('theme-btn').addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const effective = current || (systemDark ? 'dark' : 'light');
      applyTheme(effective === 'dark' ? 'light' : 'dark');
    });
  }

  /* --- boot -------------------------------------------------------------- */

  async function syncNow() {
    const button = $('sync-btn');
    button.disabled = true;
    button.classList.add('is-busy');
    setSyncState('syncing…');
    try {
      const result = await fetch('/api/sync?full=true', { method: 'POST' }).then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
        return r.json();
      });
      setSyncState(result.new ? `+${result.new} new` : 'up to date');
      await loadOverview();
      await refresh();
      if (state.week.loaded) await refreshWeek();
      if (state.log.loaded) await refreshLog();
      if (state.map.loaded) await refreshMap();
      if (state.goals) await loadGoals();
    } catch (error) {
      setSyncState(`sync failed: ${error.message}`);
    } finally {
      button.disabled = false;
      button.classList.remove('is-busy');
    }
  }

  async function boot() {
    restoreState();
    initTheme();
    initFolds();
    buildControls();
    buildWeekControls();
    buildLogControls();
    buildCalendarControls();
    buildMapControls();
    buildViewSwitcher();
    applyView();
    $('sync-btn').addEventListener('click', syncNow);

    // Goals and Races each decide whether their own tab exists, so the
    // switcher isn't final until both have answered — and which view you land
    // on decides what else is worth fetching. They ride along with the
    // overview, which boot waits for anyway, so they cost nothing extra.
    const [overview, goalsResult, racesResult] = await Promise.allSettled([
      loadOverview(), loadGoals(), loadRaces(),
    ]);
    if (goalsResult.status === 'rejected') console.error('goals unavailable', goalsResult.reason);
    if (racesResult.status === 'rejected') console.error('races unavailable', racesResult.reason);
    buildViewSwitcher();     // rebuild so the restored view stays selected
    applyView();

    if (overview.status === 'rejected') {
      setSyncState(`offline — ${overview.reason.message}`);
    } else {
      try {
        if (state.overview.activity_count > 0) {
          await refresh();
          // Only the view you're looking at pays for its data on open.
          if (state.view === 'week') await refreshWeek();
          if (state.view === 'workouts') await refreshLog();
          if (state.view === 'map') await refreshMap();
        }
      } catch (error) {
        setSyncState(`offline — ${error.message}`);
      }
    }

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => { /* not fatal */ });
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
