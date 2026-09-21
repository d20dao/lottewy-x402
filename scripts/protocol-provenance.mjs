import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root='src/protocol/';
const paths=['shared','worker','docs'].flatMap(dir=>readdirSync(root+dir).map(file=>dir+'/'+file)).sort();
const hashes=Object.fromEntries(paths.map(path=>[path,createHash('sha256').update(readFileSync(root+path)).digest('hex')]));
if(process.argv.includes('--write')){
  const commit=execFileSync('git',['-C','../giveaway-app','rev-parse','HEAD'],{encoding:'utf8'}).trim();
  for(const path of paths){
    const source=execFileSync('git',['-C','../giveaway-app','show',`${commit}:${path}`],{maxBuffer:16*1024*1024});
    if(createHash('sha256').update(source).digest('hex')!==hashes[path])throw new Error('Protocol copy differs from the pinned Git source: '+path);
  }
  writeFileSync(root+'provenance.json',JSON.stringify({repository:'https://github.com/d20dao/lottewy',commit,files:hashes},null,2)+'\n');
}else{
  const pinned=JSON.parse(readFileSync(root+'provenance.json','utf8'));
  if(JSON.stringify(pinned.files)!==JSON.stringify(hashes))throw new Error('Protocol copy changed: review and update provenance explicitly');
  console.log('Pinned protocol hashes match.');
}
