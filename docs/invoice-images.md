# Facturas desde imágenes y artículos del ejemplo

En **Facturas de compra → Importar imagen de factura**, un administrador puede subir
una fotografía JPEG, PNG o WebP (hasta 8 MB y 12 megapíxeles). El servidor valida los bytes,
normaliza la imagen y ejecuta Tesseract en español. No utiliza un servicio OCR externo
ni necesita una clave de IA. Solo se procesa una imagen a la vez por proceso; si hay otra
lectura devuelve 429. La lectura tiene un límite de 90 segundos, después de iniciar el motor.

El lector reconstruye columnas por encabezados y posición de las palabras, con sinónimos
como Cant/Cantidad, Descripción/Artículo y Costo/Precio unitario. Admite columnas en distinto
orden y usa como alternativa los renglones de texto. La extracción no se selecciona por el
nombre del proveedor ni por una plantilla fija. Cada intento conserva una lectura coherente;
no se mezclan cantidades y costos de intentos diferentes.

El motor corrige inclinación, amplía el texto y reintenta con segmentación dispersa y
compensación de iluminación si la lectura inicial queda incompleta. **Lectura detallada**
fuerza las tres pasadas. Antes de leer puedes **Girar 90°** o arrastrar sobre la vista previa
para seleccionar el papel y excluir pantalla, mesa o bordes. El recorte se calcula después
del giro; el archivo subido no se modifica y su hash sigue identificando el original.

La pantalla muestra la fotografía, proveedor, RIF, tipo y número de documento, control, fecha, cantidades,
costos, descuentos, IVA y total para revisión. Los campos que no se reconocen quedan
pendientes: el OCR puede omitir renglones, confundir caracteres o fallar con fotos torcidas.
La confianza mostrada es orientativa; no garantiza exactitud ni determina tratamiento fiscal.
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

## Modelo OCR y despliegue

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
