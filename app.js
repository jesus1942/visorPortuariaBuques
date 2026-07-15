/* Buques Puerto Madryn — visor de movimientos de buques (fuente: planilla pública de APPM). */
(function () {
  'use strict';

  var SHEET_ID = '1ngrSwwqTimfaHQHaNAovd5uIzFCTVB_J10dHe4m37rQ';
  var CSV_URL = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/gviz/tq?tqx=out:csv&gid=0';
  var REFRESH_MS = 10 * 60 * 1000;
  var LS_CSV = 'buquesPM.csv';
  var LS_TIME = 'buquesPM.time';
  // Enlace de Mercado Pago para aportes. Al completarlo aparece el botón en el pie.
  var DONATION_URL = '';

  var MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  var DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

  var state = {
    days: [],        // [{date, items:[...]}] en el orden de la planilla
    tab: 'actual',
    query: '',
    fetchedAt: null,
    fromCache: false,
    timer: null
  };

  var $content = document.getElementById('content');
  var $updated = document.getElementById('updated');
  var $banner = document.getElementById('offlineBanner');
  var $refresh = document.getElementById('refreshBtn');
  var $search = document.getElementById('search');

  /* ---------------- CSV ---------------- */

  function parseCSV(text) {
    var rows = [], row = [], field = '', i = 0, inQ = false, c;
    while (i < text.length) {
      c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQ = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        rows.push(row); row = [];
        i++; continue;
      }
      field += c; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function parseDayDate(s) {
    var m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s.trim());
    if (!m) return null;
    var y = +m[3]; if (y < 100) y += 2000;
    var d = new Date(y, +m[2] - 1, +m[1]);
    return isNaN(d.getTime()) ? null : d;
  }

  /* Convierte las filas del CSV en grupos por día. */
  function buildDays(rows) {
    var days = [], current = null;
    rows.forEach(function (r) {
      var c = function (n) { return (r[n] || '').trim(); };
      if (c(0).toUpperCase() === 'AMARRE') return; // encabezado
      var dayDate = parseDayDate(c(1));
      if (dayDate && !c(3)) { // fila de día: fecha en col 2 y sin nombre de buque
        current = { date: dayDate, items: [] };
        days.push(current);
        return;
      }
      if (!c(3)) return; // fila vacía
      var item = {
        amarre: c(0), zarpe: c(1), clase: c(2), buque: c(3), obs: c(4),
        estado: c(5).toUpperCase(), sitio: c(6), posicion: c(7), movimientos: c(8),
        fecha: c(9), actividad: c(10), detalle: c(11), servicios: c(12),
        observacion: c(13), pasavante: c(14),
        day: current ? current.date : null
      };
      item.cat = categorize(item);
      item.zarpeDate = parseShipDate(item.zarpe, item.day);
      if (current) current.items.push(item);
      else { current = { date: null, items: [item] }; days.push(current); }
    });
    return days.filter(function (d) { return d.items.length; });
  }

  function categorize(it) {
    if (it.clase.toUpperCase() === 'NOVEDAD') return 'aviso';
    switch (it.estado) {
      case 'AMARRADO': return 'amarrado';
      case 'ZARPO': return 'zarpo';
      case 'NAVEGANDO': return 'navegando';
      case 'RADA': return 'rada';
      case 'GOLFO': return 'golfo';
      case 'CERRADO': return 'aviso';
      case '': return it.zarpe ? 'zarpo' : 'programado';
      default: return 'programado';
    }
  }

  /* "06/07 15:00" | "14:00" -> Date (el año se toma del día del grupo) */
  function parseShipDate(s, groupDay) {
    if (!s) return null;
    var base = groupDay || new Date();
    var m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?:\s+(\d{1,2}):(\d{2}))?$/.exec(s.trim());
    if (m) {
      var y = m[3] ? (+m[3] < 100 ? +m[3] + 2000 : +m[3]) : base.getFullYear();
      if (!m[3] && +m[2] < base.getMonth() - 4) y += 1; // cruce de año
      return new Date(y, +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0));
    }
    m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
    if (m && groupDay) {
      return new Date(base.getFullYear(), base.getMonth(), base.getDate(), +m[1], +m[2]);
    }
    return null;
  }

  /* ---------------- utilidades ---------------- */

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function norm(s) {
    return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  /* Texto donde busca el buscador: nombre, clase, actividad, detalle, estado, etc. */
  function haystack(it) {
    return norm([it.buque, it.clase, it.actividad, it.detalle, it.estado,
      it.servicios, it.observacion, it.sitio ? 'sitio ' + it.sitio : ''].join(' '));
  }

  function sameDay(a, b) {
    return a && b && a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function today() {
    var n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  }

  function fmtDay(d) {
    if (!d) return 'Sin fecha';
    return DIAS[d.getDay()] + ' ' + d.getDate() + ' de ' + MESES[d.getMonth()];
  }

  function relLabel(d) {
    if (!d) return '';
    var t = today(), diff = Math.round((d - t) / 86400000);
    if (diff === 0) return 'Hoy';
    if (diff === 1) return 'Mañana';
    if (diff === -1) return 'Ayer';
    return '';
  }

  function ddmm(d) {
    return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2);
  }

  function fmtTimeRef(raw, groupDay) {
    if (!raw) return '—';
    if (raw.indexOf('/') === -1 && groupDay) return ddmm(groupDay) + ' ' + raw;
    return raw;
  }

  var BADGES = {
    amarrado: 'En puerto',
    zarpo: 'Zarpó',
    navegando: 'Navegando',
    rada: 'En rada',
    golfo: 'En golfo',
    programado: 'Anunciado',
    aviso: 'Aviso'
  };

  /* ---------------- render ---------------- */

  /* Detalle expandible: todos los campos de la planilla + enlace al mapa AIS. */
  function detailHTML(it) {
    var rows = [
      ['Amarre', fmtTimeRef(it.amarre, it.day)],
      ['Zarpe', it.zarpe],
      ['Clase', it.clase],
      ['Estado', it.estado || (BADGES[it.cat] || '')],
      ['Sitio', it.sitio],
      ['Posición', it.posicion],
      ['Movimientos', it.movimientos],
      ['Fecha operación', it.fecha],
      ['Actividad', it.actividad],
      ['Detalle', it.detalle],
      ['Servicios', it.servicios],
      ['Observación', it.observacion],
      ['Obs.', it.obs],
      ['Pasavante', it.pasavante]
    ];
    var table = rows.map(function (r) {
      return '<tr><th>' + r[0] + '</th><td>' + esc(r[1] || '—') + '</td></tr>';
    }).join('');
    var mapa = '';
    if (it.cat !== 'aviso') {
      var q = encodeURIComponent(it.buque.replace(/\(.*?\)/g, '').trim());
      mapa = '<a class="ais" target="_blank" rel="noopener" href="https://www.vesselfinder.com/vessels?name=' + q + '">' +
        '🌍 Ver última posición del buque en el mapa (AIS)</a>';
    }
    return '<div class="detail"><table>' + table + '</table>' + mapa + '</div>';
  }

  function cardHTML(it) {
    var badge = BADGES[it.cat] || it.estado || '';
    if (it.cat === 'aviso' && it.estado) badge = it.estado === 'CERRADO' ? 'Sitio cerrado' : 'Aviso';
    var claseLine = it.clase ? it.clase.toLowerCase() : '';

    var chips = [];
    if (it.sitio) chips.push('<span class="chip site">Sitio ' + esc(it.sitio) + (it.posicion ? ' · ' + esc(it.posicion) : '') + '</span>');
    else if (it.posicion) chips.push('<span class="chip site">Pos. ' + esc(it.posicion) + '</span>');
    if (it.actividad) chips.push('<span class="chip">' + esc(it.actividad) + (it.fecha ? ' · ' + esc(it.fecha) : '') + '</span>');
    if (it.detalle) chips.push('<span class="chip">' + esc(it.detalle) + '</span>');
    if (it.movimientos && it.movimientos.toUpperCase() !== 'SI') chips.push('<span class="chip">' + esc(it.movimientos) + '</span>');
    if (it.servicios) chips.push('<span class="chip">' + esc(it.servicios) + '</span>');
    if (it.pasavante) chips.push('<span class="chip">Pasavante ' + esc(it.pasavante) + '</span>');

    var notes = [];
    if (it.observacion && it.observacion !== '#N/A') notes.push(it.observacion);
    if (it.obs && it.obs !== 'obs' && it.obs !== '#N/A') notes.push(it.obs);

    return '<article class="card expandable">' +
      '<div class="card-top"><div>' +
      '<div class="ship-name">' + esc(it.buque) + '</div>' +
      (claseLine ? '<span class="ship-class">' + esc(claseLine) + '</span>' : '') +
      '</div>' +
      '<span class="badge ' + it.cat + '">' + esc(badge) + '</span></div>' +
      '<div class="times">' +
      '<div class="t arr"><small>Amarre</small><b>' + esc(fmtTimeRef(it.amarre, it.day)) + '</b></div>' +
      '<div class="t dep"><small>Zarpe</small><b>' + esc(it.zarpe || '—') + '</b></div>' +
      '</div>' +
      (chips.length ? '<div class="meta">' + chips.join('') + '</div>' : '') +
      (notes.length ? '<div class="note">' + esc(notes.join(' · ')) + '</div>' : '') +
      detailHTML(it) +
      '<div class="expand-hint" aria-hidden="true">▾</div>' +
      '</article>';
  }

  function dayHeadHTML(date) {
    var rel = relLabel(date);
    return '<h2 class="day-head">' + esc(fmtDay(date)) +
      (rel ? ' <span class="rel">' + rel + '</span>' : '') + '</h2>';
  }

  function groupedHTML(items, dir, useZarpeDate) {
    var groups = [], map = {};
    items.forEach(function (it) {
      var d = useZarpeDate ? (it.zarpeDate || it.day) : it.day;
      if (d) d = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      var key = d ? d.getTime() : 0;
      if (!map[key]) { map[key] = { date: d, items: [] }; groups.push(map[key]); }
      map[key].items.push(it);
    });
    groups.sort(function (a, b) {
      var ta = a.date ? a.date.getTime() : 0, tb = b.date ? b.date.getTime() : 0;
      return dir === 'asc' ? ta - tb : tb - ta;
    });
    return groups.map(function (g) {
      var d = g.date ? new Date(g.date.getFullYear(), g.date.getMonth(), g.date.getDate()) : null;
      return dayHeadHTML(d) + g.items.map(cardHTML).join('');
    }).join('');
  }

  function allItems() {
    var out = [];
    state.days.forEach(function (d) { out.push.apply(out, d.items); });
    return out;
  }

  function render() {
    var items = allItems();
    var q = norm(state.query.trim());
    var html = '';

    if (q) {
      var tokens = q.split(/\s+/);
      var found = items.filter(function (it) {
        var hs = haystack(it);
        return tokens.every(function (t) { return hs.indexOf(t) !== -1; });
      });
      html = found.length
        ? '<p class="section-title">' + found.length + ' resultado' + (found.length === 1 ? '' : 's') + '</p>' +
          groupedHTML(found, 'desc', false)
        : '<div class="empty">No se encontraron buques para «' + esc(state.query) + '».</div>';
      $content.innerHTML = html;
      return;
    }

    var t = today();

    if (state.tab === 'actual') {
      var enPuerto = items.filter(function (it) { return it.cat === 'amarrado'; });
      var porLlegar = items.filter(function (it) {
        return (it.cat === 'navegando' || it.cat === 'rada' || it.cat === 'golfo' || it.cat === 'programado') &&
          (!it.day || it.day >= new Date(t.getTime() - 86400000));
      });
      var avisos = items.filter(function (it) {
        return it.cat === 'aviso' && it.day && it.day >= new Date(t.getTime() - 86400000);
      });
      var zarpesHoy = items.filter(function (it) {
        return it.cat === 'zarpo' && sameDay(it.zarpeDate, t);
      });

      html += '<div class="summary">' +
        '<div class="pill"><b>' + enPuerto.length + '</b><span>En puerto</span></div>' +
        '<div class="pill"><b>' + porLlegar.length + '</b><span>Por llegar</span></div>' +
        '<div class="pill"><b>' + zarpesHoy.length + '</b><span>Zarpes hoy</span></div>' +
        '</div>';

      if (avisos.length) {
        html += '<p class="section-title">Avisos del puerto</p>' + avisos.map(cardHTML).join('');
      }
      html += '<p class="section-title">Amarrados en puerto</p>';
      html += enPuerto.length
        ? groupedHTML(enPuerto, 'desc', false)
        : '<div class="empty">No hay buques amarrados en este momento.</div>';

      html += '<p class="section-title">Por llegar / anunciados</p>';
      html += porLlegar.length
        ? groupedHTML(porLlegar, 'asc', false)
        : '<div class="empty">No hay buques anunciados.</div>';

      if (zarpesHoy.length) {
        html += '<p class="section-title">Zarparon hoy</p>' + zarpesHoy.map(cardHTML).join('');
      }
    } else if (state.tab === 'zarpados') {
      var zarpados = items.filter(function (it) { return it.cat === 'zarpo'; });
      html = zarpados.length
        ? groupedHTML(zarpados, 'desc', true)
        : '<div class="empty">Sin zarpes registrados.</div>';
    } else {
      html = items.length
        ? groupedHTML(items, 'desc', false)
        : '<div class="empty">Sin datos.</div>';
    }

    $content.innerHTML = html;
  }

  function renderError() {
    $content.innerHTML = '<div class="error-box">' +
      '<p>No se pudieron obtener los datos.<br>Revisá tu conexión a internet.</p>' +
      '<button type="button" id="retryBtn">Reintentar</button></div>';
    var b = document.getElementById('retryBtn');
    if (b) b.addEventListener('click', function () { load(); });
  }

  function updatedLabel() {
    if (!state.fetchedAt) { $updated.textContent = ''; return; }
    var d = new Date(state.fetchedAt);
    var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    $updated.textContent = (state.fromCache ? 'Datos guardados · ' : 'Actualizado ') +
      (sameDay(d, new Date()) ? hm : ddmm(d) + ' ' + hm);
  }

  /* ---------------- datos ---------------- */

  function applyCsv(text, fetchedAt, fromCache) {
    state.days = buildDays(parseCSV(text));
    state.fetchedAt = fetchedAt;
    state.fromCache = fromCache;
    $banner.classList.toggle('hidden', !fromCache);
    updatedLabel();
    render();
  }

  function load() {
    $refresh.classList.add('spinning');
    return fetch(CSV_URL + '&_=' + Date.now(), { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function (text) {
        if (text.indexOf('AMARRE') === -1) throw new Error('formato inesperado');
        var now = Date.now();
        try {
          localStorage.setItem(LS_CSV, text);
          localStorage.setItem(LS_TIME, String(now));
        } catch (e) { /* almacenamiento lleno o deshabilitado */ }
        applyCsv(text, now, false);
      })
      .catch(function () {
        var cached = null, time = null;
        try {
          cached = localStorage.getItem(LS_CSV);
          time = +localStorage.getItem(LS_TIME) || null;
        } catch (e) { /* sin almacenamiento */ }
        if (cached) applyCsv(cached, time, true);
        else renderError();
      })
      .then(function () { $refresh.classList.remove('spinning'); });
  }

  /* ---------------- eventos ---------------- */

  $refresh.addEventListener('click', function () { load(); });

  // Tocar una tarjeta la expande/contrae (los enlaces internos siguen funcionando).
  $content.addEventListener('click', function (e) {
    if (e.target.closest('a')) return;
    var card = e.target.closest('.card.expandable');
    if (card) card.classList.toggle('open');
  });

  if (DONATION_URL) {
    var row = document.getElementById('donateRow');
    var link = document.getElementById('donateLink');
    if (row && link) { link.href = DONATION_URL; row.classList.remove('hidden'); }
  }

  $search.addEventListener('input', function () {
    state.query = $search.value;
    render();
  });

  document.querySelectorAll('.tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.tab').forEach(function (b) {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
      });
      state.tab = btn.dataset.tab;
      state.query = '';
      $search.value = '';
      render();
      window.scrollTo({ top: 0 });
    });
  });

  setInterval(function () {
    if (document.visibilityState === 'visible') load();
  }, REFRESH_MS);

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && state.fetchedAt &&
      Date.now() - state.fetchedAt > 2 * 60 * 1000) {
      load();
    }
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { /* sin SW */ });
    });
  }

  load();
})();
