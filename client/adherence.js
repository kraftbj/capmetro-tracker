/*
 * adherence.js — the lateness badge, which is the anchor object of the board.
 *
 * Task D1: colour is never the only channel. Every indicator carries
 *   shape (the contract's glyph) + a signed number + colour,
 * so a grayscale screenshot stays fully readable. Green #22c55e and amber
 * #f59e0b differ by 1.06:1 in luminance — in grayscale they are the same dot,
 * and only ● vs ▲ and −0m vs +4m tell them apart.
 *
 * The client makes no inference: state, seconds and glyph all come from the
 * payload. The only local decision is what to draw for each named glyph.
 */
(function (global) {
  'use strict';

  var fmt = global.CMB.fmt;

  /* Contract glyph name -> the character we draw. */
  var GLYPHS = {
    'left-triangle': '◀',
    'circle': '●',
    'up-triangle': '▲',
    'square': '■',
    'question': '?',
    'ring': '○'
  };

  /* Fallback only: used when a payload omits glyph, which the contract allows
   * no more than any other absent field. State is always present. */
  var GLYPH_FOR_STATE = {
    early: 'left-triangle',
    ontime: 'circle',
    late: 'up-triangle',
    very_late: 'square',
    unknown: 'question',
    deadhead: 'ring'
  };

  var STATE_LABEL = {
    early: 'early',
    ontime: 'on time',
    late: 'late',
    very_late: 'very late',
    unknown: 'unknown',
    deadhead: 'not in service'
  };

  /* Why a state is unknown, in words a parent can act on. */
  var REASON_LABEL = {
    no_trip_update: 'no live prediction for this trip',
    trip_canceled: 'trip canceled',
    no_stop_predictions: 'no stop predictions in the feed',
    trip_not_in_schedule: 'trip is not in today\'s schedule',
    stale_data: 'feed too old to judge lateness',
    no_progress: 'feed does not say where the bus is on the trip'
  };

  /* Order the board sorts by: worst news first. */
  var SEVERITY = {
    very_late: 0, late: 1, early: 2, unknown: 3, ontime: 4, deadhead: 5
  };

  function glyphChar(adherence) {
    var name = (adherence && adherence.glyph) ||
      GLYPH_FOR_STATE[(adherence && adherence.state) || 'unknown'] || 'question';
    return GLYPHS[name] || '?';
  }

  /*
   * The one place that decides whether a number may be shown.
   *
   * staleness.suppress_adherence is authoritative and is read as a flag; feed
   * ages are never inspected here. When it is true no lateness value is
   * rendered anywhere, whatever the vehicle object still carries.
   */
  function view(vehicle, staleness) {
    var adh = vehicle.adherence || { state: 'unknown', seconds: null, reason: null };
    var suppressed = !!(staleness && staleness.suppress_adherence);
    var state = adh.state;
    var seconds = adh.seconds;
    var reason = adh.reason;

    if (suppressed && state !== 'deadhead') {
      state = 'unknown';
      seconds = null;
      reason = reason || 'stale_data';
    }
    if (state === 'unknown' || state === 'deadhead') seconds = null;

    var value;
    if (state === 'deadhead') value = 'OUT';
    else if (seconds === null || seconds === undefined) value = '—';
    else value = fmt.signedMinutes(seconds);

    return {
      state: state,
      seconds: seconds,
      reason: reason,
      suppressed: suppressed,
      glyph: state === 'unknown' ? GLYPHS.question
        : state === 'deadhead' ? GLYPHS.ring
          : glyphChar(adh),
      value: value,
      label: STATE_LABEL[state] || state,
      reasonLabel: reason ? (REASON_LABEL[reason] || reason.replace(/_/g, ' ')) : null,
      /* what a screen reader hears in place of the badge */
      spoken: state === 'deadhead' ? 'not in service'
        : state === 'unknown'
          ? 'lateness unknown' + (reason ? ', ' + (REASON_LABEL[reason] || reason) : '')
          : fmt.lateSpoken(seconds),
      severity: SEVERITY[state] === undefined ? 9 : SEVERITY[state]
    };
  }

  /*
   * The badge element. Same markup in rows, ladder tooltips and map chips, so
   * the shape+number+colour rule cannot be honoured in one place and lost in
   * another.
   */
  function badge(v, opts) {
    opts = opts || {};
    var el = document.createElement('span');
    el.className = 'badge badge--' + v.state + (opts.small ? ' badge--sm' : '');
    var g = document.createElement('span');
    g.className = 'badge__glyph';
    g.textContent = v.glyph;
    var n = document.createElement('span');
    n.className = 'badge__value';
    n.textContent = v.value;
    el.appendChild(g);
    el.appendChild(n);
    el.setAttribute('aria-hidden', 'true'); /* the row's own label speaks it */
    return el;
  }

  global.CMB.adherence = {
    GLYPHS: GLYPHS,
    STATE_LABEL: STATE_LABEL,
    REASON_LABEL: REASON_LABEL,
    glyphChar: glyphChar,
    view: view,
    badge: badge
  };
})(window);
