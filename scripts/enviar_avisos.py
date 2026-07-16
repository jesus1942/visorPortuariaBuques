#!/usr/bin/env python3
"""Robot de avisos: lee la planilla de movimientos de buques de la APPM y envía
notificaciones push (OneSignal) cuando hay actividad de carga/descarga programada
en las próximas 12-26 horas. Corre desde GitHub Actions cada 2 horas.

Categorías (etiquetas de suscripción en la app):
  fresco    -> actividad FRESCO (cajoneros)
  congelado -> actividad CONGELADO (pesqueros)
  mercante  -> mercantes: aluminio, mineral, coque, contenedores, carga
"""
import csv
import io
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

SHEET_ID = "1ngrSwwqTimfaHQHaNAovd5uIzFCTVB_J10dHe4m37rQ"
CSV_URL = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/gviz/tq?tqx=out:csv&gid=0"
APP_ID = "82ff32e7-0aa5-48e9-a9b1-1cbe96249a48"
APP_URL = "https://jesus1942.github.io/visorPortuariaBuques/"
STATE_FILE = os.path.join(os.path.dirname(__file__), "..", "data", "avisos_enviados.json")
TZ = ZoneInfo("America/Argentina/Buenos_Aires")

CAT_LABELS = {
    "fresco": "🐟 FRESCO",
    "congelado": "❄️ CONGELADO",
    "mercante": "🚢 MERCANTE",
}


def categoria(clase, actividad):
    a = actividad.upper()
    cl = clase.upper()
    if "FRESCO" in a or cl == "CAJONERO":  # un cajonero es siempre fresquero
        return "fresco"
    if "CONGELADO" in a:
        return "congelado"
    if cl == "MERCANTE" or any(
        k in a for k in ("ALUMINIO", "MINERAL", "COQUE", "CONTENEDOR", "CARGA")
    ):
        return "mercante"
    return None


def parse_fecha(s, now):
    """'15/7 7:00', '15/07' o '7:00' -> datetime local (sin hora: 07:00)."""
    s = s.strip()
    m = re.match(r"^(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?(?:\s+(\d{1,2}):(\d{2}))?$", s)
    if m:
        year = int(m.group(3)) if m.group(3) else now.year
        if year < 100:
            year += 2000
        month, day = int(m.group(2)), int(m.group(1))
        if not m.group(3):  # sin año: si el mes quedó muy atrás, es del año próximo
            if month < now.month - 6:
                year += 1
            elif month > now.month + 6:
                year -= 1
        h = int(m.group(4)) if m.group(4) else 7
        mi = int(m.group(5)) if m.group(5) else 0
        try:
            return datetime(year, month, day, h, mi, tzinfo=TZ)
        except ValueError:
            return None
    return None


def leer_planilla():
    with urllib.request.urlopen(CSV_URL, timeout=60) as r:
        text = r.read().decode("utf-8")
    if "AMARRE" not in text:
        raise RuntimeError("La planilla no tiene el formato esperado")
    rows = list(csv.reader(io.StringIO(text)))
    barcos = []
    for r in rows:
        c = [x.strip() for x in r] + [""] * 15
        if c[0].upper() == "AMARRE":
            continue
        if re.match(r"^\d{1,2}/\d{1,2}/\d{2,4}$", c[1]) and not c[3]:
            continue  # fila de día
        if not c[3] or c[2].upper() == "NOVEDAD":
            continue
        barcos.append({
            "buque": c[3], "clase": c[2], "estado": c[5].upper(),
            "sitio": c[6], "fecha": c[9], "actividad": c[10],
        })
    return barcos


def main():
    api_key = os.environ.get("ONESIGNAL_API_KEY", "").strip()
    if not api_key:
        print("AVISO: falta el secreto ONESIGNAL_API_KEY; no se envía nada.")
        return

    now = datetime.now(TZ)
    ventana_ini = now + timedelta(hours=1)
    ventana_fin = now + timedelta(hours=26)

    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            enviados = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        enviados = {}

    # Limpiar registros de hace más de 7 días
    limite = (now - timedelta(days=7)).isoformat()
    enviados = {k: v for k, v in enviados.items() if v >= limite}

    por_cat = {}
    for b in leer_planilla():
        if b["estado"] == "ZARPO" or not b["fecha"]:
            continue
        cat = categoria(b["clase"], b["actividad"])
        if not cat:
            continue
        op = parse_fecha(b["fecha"], now)
        if not op or not (ventana_ini <= op <= ventana_fin):
            continue
        clave = f"{b['buque']}|{op.date().isoformat()}|{cat}"
        if clave in enviados:
            continue
        por_cat.setdefault(cat, []).append((b, op, clave))

    if not por_cat:
        print("Sin actividad nueva para avisar.")
    for cat, items in por_cat.items():
        items.sort(key=lambda x: x[1])
        partes = []
        for b, op, _ in items[:5]:
            dia = "hoy" if op.date() == now.date() else "mañana" if op.date() == (now + timedelta(days=1)).date() else op.strftime("%d/%m")
            sitio = f", sitio {b['sitio']}" if b["sitio"] else ""
            partes.append(f"{b['buque']} ({dia} {op.strftime('%H:%M')} hs{sitio})")
        extra = f" y {len(items) - 5} más" if len(items) > 5 else ""
        titulo = f"⚓ Actividad {CAT_LABELS[cat]} en el puerto"
        cuerpo = "Operación programada: " + "; ".join(partes) + extra + "."

        payload = {
            "app_id": APP_ID,
            "target_channel": "push",
            "headings": {"en": titulo, "es": titulo},
            "contents": {"en": cuerpo, "es": cuerpo},
            "url": APP_URL,
            "filters": [{"field": "tag", "key": cat, "relation": "=", "value": "1"}],
        }
        auth = f"Key {api_key}" if api_key.startswith("os_v2_") else f"Basic {api_key}"
        req = urllib.request.Request(
            "https://api.onesignal.com/notifications",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "Authorization": auth},
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                resp = json.load(r)
            print(f"[{cat}] enviado: {cuerpo}")
            print(f"[{cat}] respuesta OneSignal: {resp}")
            if resp.get("errors"):
                continue  # no marcar como enviados (p. ej. sin suscriptores aún)
            for _, _, clave in items:
                enviados[clave] = now.isoformat()
        except urllib.error.HTTPError as e:
            print(f"[{cat}] ERROR OneSignal HTTP {e.code}: {e.read().decode()[:500]}", file=sys.stderr)

    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(enviados, f, ensure_ascii=False, indent=1, sort_keys=True)


if __name__ == "__main__":
    main()
