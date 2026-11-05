# Facturas desde imágenes y artículos del ejemplo

En **Facturas de compra → Importar imagen de factura**, un administrador puede subir
una fotografía JPEG, PNG o WebP (hasta 8 MB y 12 megapíxeles). El lector predeterminado
es **Gemini con visión**: interpreta la página completa y devuelve datos estructurados,
sin depender de una plantilla fija por proveedor. Requiere conexión y una clave de Google.
La interpretación puede fallar u omitir campos; siempre se revisa antes de guardar.

## Configurar Gemini

En Google AI Studio, crea una clave desde https://aistudio.google.com/api-keys.
En Render → **nexo-facturacion-demo → Environment**, configura de forma privada:

```text
INVOICE_READER_PROVIDER=gemini
GEMINI_MODEL=gemini-flash-latest
GEMINI_API_KEY=<clave privada del proyecto>
```

`gemini-flash-latest` es el alias documentado por el [SDK oficial de Google](https://github.com/googleapis/js-genai).
Puede cambiar el modelo al que apunta; `GEMINI_MODEL` permite seleccionar otro modelo
Gemini compatible con imágenes y salida estructurada disponible en la cuenta.
Guardar y desplegar los cambios de entorno es necesario. En un Blueprint existente,
una entrada nueva `sync: false` no rellena la clave: debe añadirse en Environment.

El cupo gratuito depende del proyecto, región, modelo y límites vigentes de Google.
Esta integración no activa facturación ni cambia planes. Una clave vinculada a un proyecto
con facturación puede generar consumo facturable según su configuración; revisa ese proyecto
si quieres usar exclusivamente su cupo gratuito. Al agotarse la cuota se muestra el error,
sin reintentos automáticos ni cambio silencioso a otro proveedor.

La clave permanece en el servidor; nunca se envía al navegador ni debe guardarse como variable
`VITE_*`. La pantalla avisa que la fotografía se enviará a Google. El servidor envía solo
la imagen preparada y las instrucciones de extracción, sin credenciales de aplicación,
sesiones, datos de otras facturas ni herramientas ejecutables. Revisa las condiciones de uso
y tratamiento de datos del proveedor para el proyecto que elijas.

`GET /api/goods/invoice-images/status` requiere administrador y comunica proveedor,
modelo y presencia de configuración; no prueba la validez de la clave ni consume cuota.
Sin clave, se muestra el aviso de configuración y se desactiva el botón de lectura.
El resto de las compras manuales sigue disponible.

## Lectura, límites y revisión

El servidor valida los bytes y dimensiones, aplica giro/recorte y prepara un JPEG de hasta
2400 × 3200 píxeles, sin ampliar el original. La petición usa el endpoint HTTPS fijo de
Google, con la clave en un encabezado, sin redirecciones ni herramientas. La salida JSON
se valida con un esquema estricto; las instrucciones dentro de la imagen se tratan como datos.
La API descarta respuestas truncadas, vacías o inválidas y limita su tamaño a 1 MiB.
Los errores del proveedor se comunican mediante códigos y mensajes estáticos, sin imprimir
claves, fotografías, respuestas completas ni texto de documentos en los registros.

Cada instancia admite dos solicitudes de Gemini simultáneas, con un plazo completo de
90 segundos incluyendo preparación y recepción. Este límite por instancia no sustituye
la cuota global del proyecto de Google. Durante la lectura se muestra el tiempo transcurrido
y **Cancelar lectura**. Cancelar, cerrar la conexión o apagar el servidor aborta la petición
y libera el registro de la operación; no se espera indefinidamente al proveedor.
Empresa, usuario e identificador deben coincidir para cancelar. El navegador limita su espera
a 110 segundos y conserva la imagen para reintentar sin volver a seleccionarla.

Si se repite un envío con el mismo identificador, empresa, usuario, imagen y opciones,
el servidor comparte la lectura en curso en lugar de responder «Esta lectura ya está en
curso». Tampoco consume otro espacio ni realiza otra consulta a Google. Tras completarse,
el resultado puede recuperarse durante 60 segundos (máximo 16 resultados en memoria por
instancia); no se conserva la fotografía. Reutilizar el identificador con otra imagen u
opciones se rechaza. Usuarios y empresas no comparten resultados. Si uno de los transportes
repetidos se desconecta, el otro puede seguir esperando; la cancelación explícita del intento
los detiene a todos. Los errores no se guardan en esta caché. Estos reenvíos se coordinan
por instancia, sin persistencia ni coordinación entre varias réplicas.

Antes de leer puedes **Girar 90°** o arrastrar sobre la vista previa para seleccionar el papel
y excluir pantalla, mesa o bordes. El recorte se calcula después del giro; el hash identifica
el archivo original. La fotografía pequeña o borrosa no recupera detalle por usar visión.

La cancelación no guarda artículos ni facturas y no mueve inventario. La ventana puede
cerrarse tras cancelar para usar la entrada manual existente.

La pantalla muestra la fotografía, proveedor, RIF, tipo y número de documento, control, fecha, cantidades,
costos, descuentos, IVA y total para revisión. Los campos que no se reconocen quedan
pendientes: el OCR puede omitir renglones, confundir caracteres o fallar con fotos torcidas.
Gemini muestra **Revisión requerida**, sin inventar un porcentaje de confianza. La lectura no determina tratamiento fiscal.
Para esta primera versión, los importes de cada renglón se calculan como cantidad × costo,
menos descuento, más IVA. Otros recargos/retenciones no se interpretan automáticamente.
El total calculado debe coincidir con el declarado y el usuario debe confirmar su revisión.

Los separadores numéricos se resuelven contrastando cantidad × costo, descuento e IVA
contra el importe del renglón. Por ejemplo, `2.000 × 0.3000 = 600.00` representa 2000 unidades
a USD 0,30, no 2 unidades a USD 3000. Si dos interpretaciones cuadran, los campos ambiguos
quedan pendientes. También se compara el total de unidades, cuando está impreso. No se
fabrica una exención porque el IVA total sea cero; se exige revisar la alícuota de los
renglones y se ofrece **IVA para todos** como acción explícita del usuario.

## Notas de entrega

Una nota como el ejemplo VIPSalud se identifica por su título y se importa con tipo
**Nota de entrega · No fiscal**. No requiere ni inventa número de control fiscal. Conserva
número, fecha de emisión, vencimiento y condición de crédito cuando se reconocen. El texto
«sin derecho a crédito fiscal» por sí solo no establece una condición de pago a crédito.
La identidad del emisor se busca antes de los datos del receptor para evitar usar el RIF
del cliente. Si no se identifica con certeza, el campo queda para revisión.

La moneda también se busca en el pie (por ejemplo, «expresada en dólares americanos»).
Si no hay tasa numérica, una recepción USD requiere introducirla manualmente; mencionar
la tasa BCV del día de pago no aporta un valor numérico. No se toma la tasa de otra factura.

Las notas mantienen el flujo borrador → márgenes → confirmación y se distinguen con número
interno `NE-...`; facturas y notas comparten el contador interno de compras, que no es fiscal.
La unicidad del número del proveedor incluye el tipo de documento; una factura y una nota
pueden tener el mismo número sin confundirse. No hay generación de crédito fiscal de compras
ni conciliación posterior automática de una nota con la factura definitiva.

Los códigos del proveedor, lotes, vencimientos y unidades extraídos se muestran como
referencia y permanecen en el texto OCR de origen. No se convierten automáticamente en
códigos de barras ni en registros de lotes del inventario. Se conserva la unidad base UNI;
si el documento expresa cajas, peso o volumen se deben revisar las equivalencias.

Al guardar se crea **un borrador de compra** y sus maestros en una transacción:

- Proveedor identificado por RIF normalizado, sin sobrescribir datos del existente.
- Artículos reutilizados por código explícito o nombre completo único normalizado.
  No se agrupan medicamentos por similitud de marca, concentración o principio activo.
  Si hay varios nombres coincidentes, se exige seleccionar el código existente.
- Artículos nuevos con código interno, sin código de barras supuesto y **precio de venta
  pendiente**. Los costos de compra nunca se copian como precios de venta en USD.
- Documento con texto reconocido y SHA-256 de la imagen. El mismo archivo o número de
  factura del proveedor no se pueden importar de nuevo en la misma empresa.
- Ninguna existencia cambia hasta usar **Confirmar y recibir** en el documento guardado.
  La confirmación y los reintentos usan el control de inventario existente.

Los precios de venta pendientes impiden cotizar esos artículos, incluso llamando a la API.
La ficha permite corregir nombres e IVA manteniendo el precio pendiente en cero; indicar
un precio mayor que cero permite cotizar. Después de importar también se abre la pantalla
**Márgenes de ganancia**: permite fijar cada porcentaje sobre costo neto y añadir el IVA después.
La propuesta modifica los precios de artículos nuevos o existentes al confirmar la recepción,
según [el flujo de márgenes de compra](goods-documents.md#ganancia-e-iva-por-artículo).
Todas las operaciones requieren sesión y administrador; los registros mantienen el RLS.

El archivo original no se conserva en el disco efímero de Render ni en PostgreSQL. Solo
la vista actual permite cotejar la fotografía; el documento conserva su hash y texto OCR.
El archivo debe archivarse por separado. Un archivo recortado/recomprimido tendrá otro hash,
por lo que la restricción adicional por proveedor/número de factura sigue siendo necesaria.

## Ejemplo NICO PHARMA proporcionado

Se transcribieron 18 artículos con códigos internos `NP-EJ-001` a `NP-EJ-018`.
La presentación y marca BIOAIR deben cotejarse con el original. La transcripción es una
referencia manual, distinguida de una lectura OCR de la imagen que el usuario seleccione.

Los primeros 17 renglones suman **Bs 199.836,60**, igual al total impreso. El renglón
JERINGA DE INSULINA 1 ML (100 × Bs 35,45) agregaría **Bs 3.545,00**: con los 18, el total
sería Bs 203.381,60. La pantalla de ejemplo conserva la discrepancia y bloquea guardar
hasta que se revise; no descarta el artículo ni lo trata como bonificación automáticamente.
La tasa impresa Bs/USD 887,3 es referencia del documento, no una tasa BCV actual.
Como los costos y total están expresados en VES, la conversión a la moneda base VES es 1.

El arranque de desarrollo en Render carga el catálogo de 18 artículos en la empresa del
bootstrap, de forma idempotente, sin recibir stock ni registrar la factura discrepante.
Puede desactivarse con `SEED_NICOPHARMA_EXAMPLE=false`. La ventana también ofrece
**Crear artículos del ejemplo** para la empresa seleccionada. Los artículos que ya existen
con nombre completo coincidente conservan sus precios y datos; los códigos internos pueden
variar si se reutiliza un registro o si el código sugerido ya está ocupado.

Para cargar el catálogo en el desarrollo local, con migraciones aplicadas y bootstrap local:

```sh
cd backend
npm run build
npm run migrate
npm run seed:example
```

Ese helper rechaza servidores fuera de localhost y no imprime credenciales.

## Motor local opcional y pruebas

El motor anterior permanece disponible solo con `INVOICE_READER_PROVIDER=local`.
No es una alternativa automática ante errores de Gemini. Usa Tesseract en español,
reconstruye columnas por encabezados y admite **Lectura detallada**. Procesa una imagen
por instancia en un proceso separado y desechable, con plazo de 60/90 segundos y cancelación.
El hijo no hereda claves de Gemini, base de datos, bootstrap ni Render. No envía fotos a Google.


El modelo español de `tesseract-ocr/tessdata_fast`, bajo Apache-2.0, se incluye comprimido en
`resources/ocr`. `manifest.json` fija la revisión y hashes; el build de Render verifica su
integridad. El origen de cada archivo se comprobó contra el blob de esa revisión. No se
requiere descargar modelos al iniciar el servicio. `sharp` y Tesseract tienen soporte Node 24
Linux; el worker se termina al acabar cada lectura para liberar su memoria.

Se probó el OCR real con imágenes sintéticas de factura y de nota de entrega, incluyendo
columnas reordenadas, cuatro decimales, miles, giro y recorte, además del recorrido multipart
en Chromium y las transacciones en PostgreSQL. Las imágenes de prueba se generan desde
una transcripción de campos visibles: no son el archivo original de la fotografía del chat. Esto no certifica exactitud sobre todas las fotos
ni reemplaza una revisión de los datos del proveedor.

La integración Gemini se verifica con respuestas simuladas: esquema, claves ausentes,
errores de acceso/cuota/modelo, cancelación, plazo, concurrencia, importes netos/brutos y
flujo de navegador hasta el borrador y sus márgenes. Una prueba HTTP multipart adicional
comprueba envíos repetidos simultáneos, recuperación de resultados y conflicto de opciones. Estas pruebas no envían fotografías a
Google. Para comprobar la precisión sobre las fotografías originales se necesita configurar
una clave válida y ejecutar una lectura real en el servicio desplegado.
