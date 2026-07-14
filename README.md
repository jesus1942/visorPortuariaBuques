# Buques Puerto Madryn 🚢

PWA (aplicación web progresiva) para ver desde el celular los **movimientos de buques del Puerto de Puerto Madryn**: buques amarrados, anunciados/por llegar y zarpes.

> **Idea y proyecto de [@jesus1942](https://github.com/jesus1942)** · Desarrollo asistido con Claude Code · Datos de la [APPM](https://appm.com.ar/movbuquesdinamica).

Los datos salen de la [planilla dinámica pública de la APPM](https://appm.com.ar/movbuquesdinamica) (Administración Portuaria de Puerto Madryn), que la app lee directamente desde el navegador. **No requiere login, ni servidor, ni base de datos.**

## Características

- 📱 **PWA instalable**: se puede agregar a la pantalla de inicio en Android e iOS y se abre como una app.
- 🔄 **Datos en vivo**: lee la planilla oficial de APPM y se actualiza automáticamente cada 10 minutos (y con el botón de refrescar).
- ⚓ **Pestaña "Actual"**: resumen de buques en puerto, por llegar y zarpes del día, más avisos del puerto.
- 🛳 **Pestaña "Zarpados"**: historial de zarpes agrupado por día.
- 🔎 **Búsqueda** por nombre de buque (ignora mayúsculas y tildes).
- 📴 **Funciona sin conexión**: guarda los últimos datos y la app misma en caché.
- 🌙 Modo claro/oscuro automático según el sistema.

## Cómo publicar en GitHub Pages

> ⚠️ **Importante**: en cuentas gratuitas de GitHub, Pages solo funciona con **repositorios públicos**. Si el repo es privado, primero hacerlo público en **Settings → General → Danger Zone → Change repository visibility**.

1. En GitHub, ir a **Settings → Pages** y en **Build and deployment → Source** elegir **GitHub Actions** (el workflow también intenta habilitarlo solo).
2. Ir a la pestaña **Actions**, abrir el workflow *Publicar en GitHub Pages* y ejecutarlo con **Run workflow** (también corre automáticamente con cada push).

La app queda disponible en `https://<usuario>.github.io/visorPortuariaBuques/`.

## Estructura

```
index.html            Página principal
styles.css            Estilos (mobile-first, tema claro/oscuro)
app.js                Lógica: descarga y parseo del CSV, filtros y render
sw.js                 Service worker (caché para uso sin conexión)
manifest.webmanifest  Manifiesto de la PWA
icons/                Íconos de la app
.github/workflows/    Despliegue automático a GitHub Pages
```

## Cómo funciona

La página de APPM incrusta una planilla de Google Sheets pública. Esta app descarga esa misma planilla en formato CSV (`.../gviz/tq?tqx=out:csv`), la parsea en el navegador y muestra cada buque como una tarjeta con su amarre, zarpe, sitio, actividad y estado (`AMARRADO`, `ZARPO`, `NAVEGANDO`, `RADA`, `GOLFO`, anunciado, etc.). La última respuesta se guarda en `localStorage` para poder consultarla sin conexión.

## Créditos

- **Idea y dirección del proyecto**: [@jesus1942](https://github.com/jesus1942)
- **Desarrollo**: asistido con Claude Code
- **Datos**: Administración Portuaria de Puerto Madryn (APPM)

> App no oficial. Los datos pertenecen a la Administración Portuaria de Puerto Madryn.
