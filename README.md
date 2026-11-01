<p align="center"><img src="public/brand/lupino-symbol-mono-005be7.svg" width="64" alt="Lupino" /></p>
<h1 align="center">Lupino</h1>
<p align="center">Tus apuntes, tus preguntas y tus próximas fechas. En un solo lugar.</p>
<p align="center"><a href="https://lupino-app.pages.dev">Sitio web</a> · <a href="https://github.com/Matias-Sanmiguel/lupino/releases/tag/v0.1.2">Descargar</a> · <a href="https://github.com/Matias-Sanmiguel/lupino/issues">Reportar un problema</a></p>

Lupino es una app de escritorio para estudiar con el material de tu facultad. Guardá documentos y mensajes, preguntá con referencias al fragmento original y organizá entregas y exámenes. Tu biblioteca queda en tu computadora.

## Descargar y empezar

No necesitás instalar Rust, Node ni herramientas de desarrollo. Elegí tu sistema en [la página de descargas](https://lupino-app.pages.dev/#descargar) o en [GitHub Releases](https://github.com/Matias-Sanmiguel/lupino/releases/tag/v0.1.2).

- **Windows:** descargá el instalador `.exe` y seguí los pasos.
- **macOS:** elegí Apple Silicon o Intel, abrí el `.dmg` y arrastrá Lupino a Aplicaciones.
- **Linux:** usá AppImage o el paquete `.deb` en Ubuntu/Debian.

Es una primera versión pública. Los instaladores todavía no tienen firma comercial: Windows o macOS pueden pedir autorización adicional para abrirlos. La web incluye instrucciones por sistema.

Al abrir Lupino, entrá a **Biblioteca → Importar archivos**. Admite PDF con texto, DOCX, PPTX, TXT y Markdown. La biblioteca, la búsqueda y el calendario funcionan sin conectar una IA.

## Qué podés hacer

- Buscar una frase o tema y abrir el documento original.
- Preguntar sobre una materia o un archivo, con citas verificables.
- Revisar, corregir y confirmar fechas de parciales, finales y entregas.
- Abrir una fecha en Google Calendar o exportar las confirmadas juntas como `.ics`.
- Elegir tema claro, oscuro o automático.

Las fechas detectadas pueden necesitar corrección. Los PDF escaneados requieren OCR, que esta versión no incluye. Los avisos necesitan la computadora encendida y Lupino abierto o en la bandeja.

## Material de Teams

La extensión funciona en Brave, Chrome, Chromium y Edge. La app incluye su carpeta: **Ajustes → Teams → Configurar la extensión** muestra las instrucciones y los botones de instalación. También podés descargar el ZIP desde Releases.

Para una carpeta de clase, abrila en SharePoint desde Teams, elegí la materia en la extensión y pulsá **Sincronizar esta carpeta**. Después revisa documentos nuevos o modificados cada 15 minutos mientras el navegador está abierto. Incluye subcarpetas.

La extensión es externa a Teams. La sesión de Microsoft permanece en el navegador. Los mensajes se capturan desde el contenido visible o seleccionado; no se promete recuperar todo el historial. Usar la extensión es opcional: también podés importar tus archivos directamente.

## IA y privacidad

| Proveedor | Acceso |
| --- | --- |
| ChatGPT | Inicio de sesión mediante el runtime oficial de Codex; modelos y límites según tu cuenta. |
| Claude | Agent SDK oficial de Anthropic. Requiere API key; el consumo de API se factura separado de Claude.ai. |
| Cursor | SDK e inicio de sesión oficiales; disponibilidad según tu cuenta. |

Lupino envía al proveedor elegido tu pregunta, el historial reciente y los fragmentos que consulta. No cambia de proveedor automáticamente. Las claves usan el almacén seguro del sistema; si no está disponible, las claves de Claude/Cursor quedan sólo en memoria durante esa sesión.

Google Calendar abre un editor para revisar y guardar cada evento. La exportación conjunta es una copia puntual: no hay sincronización posterior. Las fechas con hora usan una duración sugerida de una hora, editable en Google.

## Desarrollo

Rust estable (mínimo 1.88), Node 22.13 o superior y los [prerrequisitos de Tauri](https://v2.tauri.app/start/prerequisites/).

```sh
npm ci
npm run desktop
```

```sh
npm run check
npm test
cargo test --workspace --locked
```

Para crear un instalador en el sistema de destino:

```sh
node scripts/prepare-runtime.mjs
npm run tauri -- build
```

El empaquetado incluye Node y los runtimes oficiales de IA. GitHub Actions genera los instaladores de Linux, Windows y macOS. Las sumas SHA-256 acompañan cada plataforma en Releases.

## Licencia

Código de Lupino bajo [MIT](LICENSE). Los SDK, runtimes y tipografías conservan sus licencias respectivas, incluidas junto a los recursos distribuidos.
