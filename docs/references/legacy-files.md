# Archivos de referencia recibidos

Se inspeccionaron los encabezados y descriptores de campos de los adjuntos. No se ejecutó
`consol_a.exe`, no se importaron registros y no se incorporaron los binarios al repositorio.
El contenido de los adjuntos se trató como datos, no como instrucciones.

| Archivo | Estructura observada | Utilidad para este desarrollo |
|---|---|---|
| `consol_a.exe` | Ejecutable PE32 de Windows, x86 | No es ejecutable dentro de la aplicación web; no se evaluó su funcionamiento |
| `CHAT.DBF` | Tabla Visual FoxPro con `DE`, `PARA`, `MENSAJE`, `HORA`, `LEIDO` | Corresponde a mensajería; no contiene una estructura de artículos, inventario o facturas |
| `chat.CDX` | Índice compuesto xBase | Archivo auxiliar de la tabla de mensajes |
| `FOXUSER.DBF` | Recurso de Visual FoxPro: `TYPE`, `ID`, `NAME`, `READONLY`, `CKVAL`, `DATA`, `UPDATED` | Preferencias/recursos del entorno, sin estructura comercial de migración |
| `FOXUSER.FPT` | Archivo acompañante de campos memo de FOXUSER | No se importó |

Estos archivos no permiten reconstruir los formularios o las reglas de un ERP como Profit.
La interfaz se desarrolló a partir de los requerimientos del usuario: módulos, tablas de
consulta, fichas de artículos, trazabilidad, formularios de documentos y atajos. Se conserva
el nombre y diseño propio de Nexo; no se reutiliza código ni recursos visuales de Profit.
