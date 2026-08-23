/*
 * states.js — task D2. Every panel has a defined LOADING / EMPTY / ERROR /
 * PARTIAL / STALE rendering, plus a first-run screen. This file owns the
 * shared furniture for those states so no panel can quietly ship a blank div.
 *
 * The governing rule from the design doc: **empty is a feature**. A blank
 * panel at 7:50am reads as "no bus is coming", which is the exact failure that
 * stranded a real rider. Every empty state names what is missing and what
 * happens next.
 *
 * Force any state for inspection with ?state=<name> — see STATE_SCENARIOS.
 */
(function (global) {
  'use strict';

  var fmt = global.CMB.fmt;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  /*
   * A stated absence: headline plus the next fact the user actually wants.
   * `next` is optional but its absence is itself reported, never hidden.
   */
  function notice(kind, headline, detail, action) {
    var box = el('div', 'notice notice--' + kind);
    box.appendChild(el('p', 'notice__head', headline));
    if (detail) box.appendChild(el('p', 'notice__detail', detail));
    if (action) box.appendChild(action);
    return box;
  }

  function retryButton(label, onClick) {
    var b = el('button', 'btn btn--retry', label || 'Try again');
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  /* Skeleton rows. Structure matches the real row so nothing jumps on load. */
  function skeletonRows(count) {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < (count || 3); i++) {
      var r = el('div', 'vrow vrow--skeleton');
      r.setAttribute('aria-hidden', 'true');
      r.appendChild(el('span', 'sk sk--vid'));
      r.appendChild(el('span', 'sk sk--badge'));
      var m = el('span', 'sk-meta');
      m.appendChild(el('span', 'sk sk--line1'));
      m.appendChild(el('span', 'sk sk--line2'));
      r.appendChild(m);
      frag.appendChild(r);
    }
    return frag;
  }

  function skeletonBlock(height) {
    var b = el('div', 'sk sk--block');
    b.style.height = (height || 120) + 'px';
    b.setAttribute('aria-hidden', 'true');
    return b;
  }

  /*
   * The staleness banner. Wording comes from the level, the numbers come from
   * the server. The client never decides that data is stale.
   */
  function stalenessBanner(staleness, feeds, onRetry) {
    if (!staleness || staleness.level === 'fresh') return null;
    var level = staleness.level;
    var kind = level === 'dead' ? 'danger' : level === 'stale' ? 'warn' : 'info';
    var b = el('div', 'banner banner--' + kind);
    b.setAttribute('role', 'status');

    var head;
    if (level === 'aging') head = 'Data ' + fmt.age(staleness.oldest_feed_age_s) + '.';
    else if (level === 'stale') head = 'Data ' + fmt.age(staleness.oldest_feed_age_s) +
      '. Lateness is hidden until the feed catches up.';
    else head = 'Feed is down. Showing the last positions received, ' +
      fmt.age(staleness.oldest_feed_age_s) + '.';

    b.appendChild(el('strong', 'banner__head', head));
    var bits = [];
    if (staleness.reason) bits.push(staleness.reason);
    if (feeds && feeds.positions_at) bits.push('last position ' + fmt.clock(feeds.positions_at));
    if (staleness.schedule_age_days !== undefined && staleness.schedule_age_days !== null) {
      bits.push('schedule ' + fmt.plural(staleness.schedule_age_days, 'day', 'days') + ' old');
    }
    if (bits.length) b.appendChild(el('span', 'banner__detail', bits.join(' · ')));
    if (onRetry) b.appendChild(retryButton('Reload', onRetry));
    return b;
  }

  /* The whole-app refusal required by the contract: schema newer than we know. */
  function schemaTooNew(seen, known) {
    var box = el('section', 'screen screen--block');
    box.appendChild(el('h2', 'screen__head', 'This app needs updating'));
    box.appendChild(el('p', 'screen__detail',
      'The board received data written for format ' + seen + '. This copy of the app ' +
      'understands format ' + known + ', so it will not draw anything rather than draw ' +
      'it wrongly. Reload after updating the app.'));
    box.appendChild(retryButton('Reload', function () { global.location.reload(); }));
    return box;
  }

  /*
   * First run: no route chosen yet. Never a picker floating in a blank screen —
   * the six watched routes are pre-offered and the board says what it is.
   */
  function firstRun(routes, onPick) {
    var box = el('section', 'screen');
    box.appendChild(el('h2', 'screen__head', 'Pick a route to watch'));
    box.appendChild(el('p', 'screen__detail',
      'This board shows every CapMetro bus on one route right now, how late each one is ' +
      'against its schedule, and where it sits between timepoints. No account, no login.'));
    var list = el('div', 'routegrid');
    routes.forEach(function (r) {
      var b = el('button', 'routegrid__item');
      b.type = 'button';
      b.appendChild(el('span', 'routegrid__id', r.id));
      if (r.name) b.appendChild(el('span', 'routegrid__name', r.name));
      b.addEventListener('click', function () { onPick(r.id); });
      list.appendChild(b);
    });
    box.appendChild(list);
    return box;
  }

  /*
   * Scenario transforms. These exist so every row of the state table can be
   * rendered and looked at, which is the only way the table gets verified.
   * They never run unless ?state= names one.
   */
  /*
   * Null-prototype because `?state=` names one of these directly, and a bare
   * object literal answers to every member of Object.prototype as well.
   *
   * `?state=valueOf` passed app.js's `if (q.state && S.STATE_SCENARIOS[q.state])`
   * guard, because every prototype member is truthy. Two things then happened,
   * both permanent for that tab. `scenario.apply` exists on every function
   * (it is Function.prototype.apply), so the payload was rewritten: with
   * `constructor` the board rendered "this board is too old for the data" and
   * nothing else, and with `valueOf` it rendered correctly. And app.js gates the
   * 60s refresh on `!state.scenario`, so in both cases the board never updated
   * again. The quiet variant is the worse one: a board that looks current, is
   * not, and has no way back except a reload nobody knows to do.
   */
  var STATE_SCENARIOS = Object.assign(Object.create(null), {
    loading: { hold: true, note: 'LOADING — payload deliberately never resolves' },
    empty: {
      note: 'EMPTY — route has no vehicles',
      apply: function (d) { d.vehicles = []; return d; }
    },
    error: { fail: 'Simulated fetch failure', note: 'ERROR — feed unreachable' },
    partial: {
      note: 'PARTIAL — positions known, predictions missing',
      apply: function (d) {
        d.vehicles.forEach(function (v, i) {
          if (!v.in_service || i % 2 === 0) return;
          v.adherence = {
            state: 'unknown', seconds: null, glyph: 'question',
            against: null, reason: 'no_trip_update'
          };
        });
        return d;
      }
    },
    stale: {
      note: 'STALE — suppress_adherence true, no lateness may be drawn',
      apply: function (d) {
        d.staleness = {
          level: 'stale', oldest_feed_age_s: 940, schedule_age_days: 1,
          suppress_adherence: true, reason: 'positions feed has not updated since 9:54a'
        };
        return d;
      }
    },
    dead: {
      note: 'DEAD — feed down over an hour',
      apply: function (d) {
        d.staleness = {
          level: 'dead', oldest_feed_age_s: 5220, schedule_age_days: 1,
          suppress_adherence: true, reason: 'no successful feed poll since 8:43a'
        };
        return d;
      }
    },
    schema: {
      note: 'SCHEMA TOO NEW — app must refuse to render',
      apply: function (d) { d.schema = 2; return d; }
    },
    'first-run': { firstRun: true, note: 'FIRST RUN — nothing chosen yet' },
    /*
     * Every adherence state on one screen. The fixture is honest data but it
     * happens to contain five on-time buses, which cannot prove the grayscale
     * rule. This rewrites adherence only — positions, trips and blocks stay
     * real — so the shape + signed number channel can actually be looked at.
     */
    'all-states': {
      note: 'ALL STATES — synthetic adherence, for the grayscale check',
      apply: function (d) {
        var script = [
          { state: 'very_late', seconds: 512, glyph: 'square' },
          { state: 'late', seconds: 236, glyph: 'up-triangle' },
          { state: 'early', seconds: -184, glyph: 'left-triangle' },
          { state: 'ontime', seconds: 41, glyph: 'circle' },
          { state: 'unknown', seconds: null, glyph: 'question', reason: 'no_trip_update' }
        ];
        var i = 0;
        d.vehicles.forEach(function (v) {
          if (!v.in_service || i >= script.length) return;
          var s = script[i++];
          v.adherence = {
            state: s.state, seconds: s.seconds, glyph: s.glyph,
            against: s.state === 'unknown' ? null : v.adherence.against,
            reason: s.reason || null
          };
          if (s.state !== 'unknown' && v.adherence.against) {
            v.adherence.against.predicted_at = v.adherence.against.scheduled_at + s.seconds;
          }
        });
        d.vehicles[0].pattern.is_special = true;
        return d;
      }
    },
    /*
     * Layout probe for the one case the design doc flagged as unresolved:
     * BOTH directions on route 7, which stacks to 17 timepoint rows. Route 7
     * has no generated file yet, so this fabricates a route of that SHAPE
     * (8 + 9 timepoints, real Austin stop names recycled for realistic label
     * widths) purely to measure pitch and wrapping at 412px. It is a ruler,
     * not data.
     */
    'ladder-probe': {
      note: 'LAYOUT PROBE — synthetic 8+9 timepoint route, not real data',
      apply: function (d) {
        var names = [
          'Pleasant Valley/5th', '7th/Northwestern', 'Chicon/East 7th', '8th/Congress',
          '6th/West Lynn', 'Campbell/5th', 'Dove Springs NB', 'Stassney/Todd',
          'Riverside/Pleasant Valley'
        ];
        var tps = [];
        [8, 9].forEach(function (count, dir) {
          for (var i = 0; i < count; i++) {
            tps.push({
              stop_id: 'probe-' + dir + '-' + i,
              stop_name: names[i % names.length],
              stop_name_full: names[i % names.length],
              stop_sequence: 1 + i * 6,
              direction_id: dir,
              lat: 30.25 + i * 0.004, lon: -97.76 + i * 0.005,
              service_status: { served: i !== 3, source: i === 3 ? 'alert_no_service' : null,
                detail: i === 3 ? 'Closed by alert' : null },
              minor_stops: i === count - 1 ? [] : [
                { stop_id: 'm' + dir + i + 'a', stop_name: '7th/Calles', stop_sequence: 3 + i * 6,
                  lat: 30.26, lon: -97.71, service_status: { served: true, source: null, detail: null } },
                { stop_id: 'm' + dir + i + 'b', stop_name: '7th/Pedernales', stop_sequence: 5 + i * 6,
                  lat: 30.26, lon: -97.71, service_status: { served: true, source: null, detail: null } }
              ]
            });
          }
        });
        d.timepoints = tps;
        d.vehicles.forEach(function (v, i) {
          if (v.progress) v.progress.current_stop_sequence = 2 + i * 9;
        });
        return d;
      }
    },
    'no-timepoints': {
      note: 'PARTIAL LADDER — no timepoints published',
      apply: function (d) { d.timepoints = []; return d; }
    }
  });

  global.CMB.states = {
    el: el,
    clear: clear,
    notice: notice,
    retryButton: retryButton,
    skeletonRows: skeletonRows,
    skeletonBlock: skeletonBlock,
    stalenessBanner: stalenessBanner,
    schemaTooNew: schemaTooNew,
    firstRun: firstRun,
    STATE_SCENARIOS: STATE_SCENARIOS
  };
})(window);
