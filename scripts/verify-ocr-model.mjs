import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../resources/ocr');
const manifest=JSON.parse(readFileSync(resolve(root,'manifest.json'),'utf8'));
for(const [name,expected] of Object.entries(manifest.files)){
 const data=readFileSync(resolve(root,name));
 if(data.length!==expected.size||createHash('sha256').update(data).digest('hex')!==expected.sha256)
  throw new Error('OCR model integrity check failed: '+name);
}
console.log('OCR model integrity verified.');
