/* Buques Puerto Madryn — visor de movimientos de buques (fuente: planilla pública de APPM). */
(function () {
  'use strict';

  var SHEET_ID = '1ngrSwwqTimfaHQHaNAovd5uIzFCTVB_J10dHe4m37rQ';
  var CSV_URL = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/gviz/tq?tqx=out:csv&gid=0';
  var REFRESH_MS = 10 * 60 * 1000;
  var LS_CSV = 'buquesPM.csv';
  var LS_TIME = 'buquesPM.time';
  // Alias de Mercado Pago para aportes (se copia al portapapeles al tocar el botón).
  var DONATION_ALIAS = 'denovaje';
  var ONESIGNAL_APP_ID = '82ff32e7-0aa5-48e9-a9b1-1cbe96249a48';
  var APP_VER = 'v12';

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
      item.dir = lookupShip(item.buque);
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

  /* Clave normalizada para el directorio de buques (ship-data.js). */
  function shipKey(name) {
    return norm(name).replace(/\(.*?\)/g, '').replace(/[^a-z0-9 ]/g, '')
      .replace(/\s+/g, ' ').trim().toUpperCase();
  }

  function lookupShip(name) {
    return (window.SHIP_DIRECTORY || {})[shipKey(name)] || {};
  }

  /* Texto donde busca el buscador: nombre, clase, actividad, empresa, matrícula, etc. */
  function haystack(it) {
    return norm([it.buque, it.clase, it.actividad, it.detalle, it.estado,
      it.servicios, it.observacion, it.posicion, it.sitio ? 'sitio ' + it.sitio : '',
      it.dir.empresa || '', it.dir.matricula || '', it.dir.tipo || ''].join(' '));
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

  /* Campo con contenido real (descarta vacíos, '#N/A' y marcas internas). */
  function meaningful(v) {
    var t = String(v || '').trim();
    return t && t !== '#N/A' && norm(t) !== 'obs';
  }

  /* Detalle expandible: campos con datos de la planilla + directorio + enlaces. */
  function detailHTML(it) {
    var rows = [
      ['Empresa / armador', it.dir.empresa],
      ['Matrícula', it.dir.matricula],
      ['Tipo registrado', it.dir.tipo],
      ['Amarre', it.amarre ? fmtTimeRef(it.amarre, it.day) : ''],
      ['Zarpe', it.zarpe],
      ['Clase', it.clase],
      ['Estado', it.estado || (BADGES[it.cat] || '')],
      ['Sitio', it.sitio],
      ['Posición', it.posicion],
      ['Movimientos', it.movimientos],
      ['Opera (estimado)', it.fecha],
      ['Actividad', it.actividad],
      ['Detalle', it.detalle],
      ['Servicios', it.servicios],
      ['Observación', it.observacion],
      ['Obs.', it.obs],
      ['Pasavante', it.pasavante]
    ].filter(function (r) { return meaningful(r[1]); });
    var table = rows.map(function (r) {
      return '<tr><th>' + r[0] + '</th><td>' + esc(r[1]) + '</td></tr>';
    }).join('');
    var links = '';
    if (it.cat !== 'aviso') {
      var nombre = it.buque.replace(/\(.*?\)/g, '').trim();
      links = '<div class="detail-actions">' +
        '<a class="ais" target="_blank" rel="noopener" href="https://www.vesselfinder.com/vessels?name=' +
        encodeURIComponent(nombre) + '">🌍 Posición en el mapa (AIS)</a>' +
        '<a class="ais" target="_blank" rel="noopener" href="https://www.google.com/search?q=' +
        encodeURIComponent(nombre + ' buque ' + (it.clase || '').toLowerCase()) + '">🔎 Buscar datos del buque</a>' +
        '</div>';
    }
    return '<div class="detail"><table>' + table + '</table>' + links + '</div>';
  }

  /* Amarre/Zarpe; para buques anunciados que aún no amarraron muestra la
     llegada estimada (hora prevista de operación o día anunciado en la planilla). */
  function timesHTML(it) {
    var pending = !it.amarre &&
      (it.cat === 'navegando' || it.cat === 'rada' || it.cat === 'golfo' || it.cat === 'programado');
    if (pending) {
      var est = it.fecha || (it.day ? ddmm(it.day) : '—');
      return '<div class="t est"><small>Llegada estimada</small><b>' + esc(est) + '</b></div>' +
        '<div class="t dep"><small>Zarpe</small><b>' + esc(it.zarpe || '—') + '</b></div>';
    }
    return '<div class="t arr"><small>Amarre</small><b>' + esc(fmtTimeRef(it.amarre, it.day)) + '</b></div>' +
      '<div class="t dep"><small>Zarpe</small><b>' + esc(it.zarpe || '—') + '</b></div>';
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
      (it.dir.empresa ? '<div class="owner-line">🏢 ' + esc(it.dir.empresa) + '</div>' : '') +
      '<div class="times">' + timesHTML(it) + '</div>' +
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

  var $donate = document.getElementById('donateBtn');
  if ($donate) {
    var donateHTML = $donate.innerHTML;
    $donate.addEventListener('click', function () {
      var ok = function () {
        $donate.innerHTML = '✅ Alias <b>' + DONATION_ALIAS + '</b> copiado. Pegalo en Mercado Pago o en tu banco. ¡Gracias!';
        setTimeout(function () { $donate.innerHTML = donateHTML; }, 5000);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(DONATION_ALIAS).then(ok, function () { fallbackCopy(); });
      } else {
        fallbackCopy();
      }
      function fallbackCopy() {
        var ta = document.createElement('textarea');
        ta.value = DONATION_ALIAS;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); ok(); } catch (e) { /* sin portapapeles */ }
        document.body.removeChild(ta);
      }
    });
  }

  var $clearSearch = document.getElementById('clearSearch');

  $search.addEventListener('input', function () {
    state.query = $search.value;
    $clearSearch.classList.toggle('hidden', !state.query);
    render();
  });

  $clearSearch.addEventListener('click', function () {
    $search.value = '';
    state.query = '';
    $clearSearch.classList.add('hidden');
    $search.focus();
    render();
  });

  window.addEventListener('online', function () { load(); });

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

  /* ---------------- notificaciones (OneSignal) ---------------- */

  var basePath = location.pathname.replace(/[^/]*$/, '');
  var osSDK = null;      // referencia al SDK una vez inicializado
  var osError = '';      // diagnóstico si algo impide iniciar

  function setOsError(msg) {
    if (osSDK) return;
    osError = msg;
    if (!$notifModal.classList.contains('hidden')) refreshNotifModal();
  }

  function loadOneSignal() {
    var esIphone = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (!('Notification' in window)) {
      setOsError(esIphone
        ? 'Este iPhone no permite notificaciones acá. Requisitos: iOS 16.4 o más nuevo, la app instalada en la pantalla de inicio (Compartir → Agregar a pantalla de inicio) y abierta desde ese ícono.'
        : 'Este navegador no soporta notificaciones web. Probá con Chrome o Firefox actualizados.');
      return;
    }
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    window.OneSignalDeferred.push(function (OneSignal) {
      return OneSignal.init({
        appId: ONESIGNAL_APP_ID,
        safari_web_id: 'web.onesignal.auto.13dd012d-81c7-44d8-8660-15690626d9c4',
        serviceWorkerPath: basePath + 'sw.js',
        serviceWorkerParam: { scope: basePath },
        allowLocalhostAsSecureOrigin: true
      }).then(function () {
        osSDK = OneSignal;
        osError = '';
        onSdkReady();
      }).catch(function (err) {
        setOsError('El servicio de avisos falló al iniciar: ' + ((err && err.message) || err || 'error desconocido'));
      });
    });
    var s = document.createElement('script');
    s.src = 'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js';
    s.defer = true;
    s.onerror = function () {
      setOsError('No se pudo descargar el servicio de avisos. Puede estar bloqueado por un bloqueador de contenido, un DNS con filtro o la red. La app funciona igual; solo fallan los avisos.');
    };
    document.head.appendChild(s);
    setTimeout(function () {
      if (!osSDK && !osError) {
        setOsError('El servicio de avisos no terminó de iniciar (el resto de la app funciona normal). Cerrá la app por completo, volvé a abrirla y reintentá.');
      }
    }, 20000);
  }

  var $notifBtn = document.getElementById('notifBtn');
  var $notifModal = document.getElementById('notifModal');
  var $notifStatus = document.getElementById('notifStatus');
  var $notifSave = document.getElementById('notifSave');
  var CATS = { fresco: 'catFresco', congelado: 'catCongelado', mercante: 'catMercante' };

  function setNotifStatus(msg) { $notifStatus.textContent = msg; }

  /* El botón queda deshabilitado hasta que el SDK esté listo: en iPhone el
     permiso debe pedirse en el mismo instante del toque, sin esperas. */
  function onSdkReady() {
    $notifSave.disabled = false;
    if (!$notifModal.classList.contains('hidden')) refreshNotifModal();
  }

  function refreshNotifModal() {
    if (!osSDK) {
      $notifSave.disabled = true;
      setNotifStatus(osError || 'Preparando el servicio de avisos…');
      return;
    }
    $notifSave.disabled = false;
    setNotifStatus(osSDK.Notifications.permission
      ? 'Los avisos ya están activados en este dispositivo. Podés cambiar las categorías y guardar.'
      : '');
    try {
      Promise.resolve(osSDK.User.getTags ? osSDK.User.getTags() : null).then(function (t) {
        if (!t) return;
        Object.keys(CATS).forEach(function (c) {
          if (t[c] !== undefined) document.getElementById(CATS[c]).checked = t[c] === '1';
        });
      }).catch(function () { });
    } catch (e) { /* etiquetas no disponibles aún */ }
  }

  $notifBtn.addEventListener('click', function () {
    $notifModal.classList.remove('hidden');
    refreshNotifModal();
  });

  document.getElementById('notifClose').addEventListener('click', function () {
    $notifModal.classList.add('hidden');
  });

  $notifModal.addEventListener('click', function (e) {
    if (e.target === $notifModal) $notifModal.classList.add('hidden');
  });

  $notifSave.addEventListener('click', function () {
    if (!osSDK) { refreshNotifModal(); return; }
    var tags = {};
    Object.keys(CATS).forEach(function (c) {
      tags[c] = document.getElementById(CATS[c]).checked ? '1' : '0';
    });
    setNotifStatus('Activando…');
    // Pedir el permiso inmediatamente, dentro del gesto del usuario (clave en iPhone).
    osSDK.Notifications.requestPermission()
      .then(function () {
        if (!osSDK.Notifications.permission) {
          setNotifStatus('El permiso fue rechazado. Activalo para este sitio desde la configuración de notificaciones del teléfono e intentá de nuevo.');
          return;
        }
        return Promise.resolve(osSDK.User.addTags(tags)).then(function () {
          var elegidas = Object.keys(tags).filter(function (c) { return tags[c] === '1'; });
          setNotifStatus(elegidas.length
            ? '✅ Avisos activados: ' + elegidas.join(', ') + '. Vas a recibir una notificación cuando haya actividad programada.'
            : 'Guardado, pero no elegiste ninguna categoría: no vas a recibir avisos.');
        });
      })
      .catch(function (err) {
        setNotifStatus('No se pudieron activar los avisos (' + (err && err.message ? err.message : 'error desconocido') + '). En iPhone, la app debe estar instalada en la pantalla de inicio.');
      });
  });

  var $ver = document.getElementById('verLine');
  if ($ver) $ver.textContent += ' · ' + APP_VER;

  loadOneSignal();
  load();
})();
