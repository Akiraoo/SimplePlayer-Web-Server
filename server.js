const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
// Use the FFmpeg installed on the system (e.g. Chocolatey: choco install ffmpeg).
const ffmpegPath = 'ffmpeg';

const PORT = 50000;
const MOBILE_PORT = 55555;
const CONFIG_FILE = path.join(__dirname, 'config.json');
const DEFAULT_CONFIG = {
  musicDir: 'Music',
  cacheDir: '.metadata-cache',
  publicOrigin: ''
};
function loadConfig(){
  let raw={};
  try{
    raw=JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8'))||{};
  }catch(e){
    if(e.code==='ENOENT'){
      // First run: create a config with the defaults.
      try{fs.writeFileSync(CONFIG_FILE,JSON.stringify(DEFAULT_CONFIG,null,2));}catch{}
    }else{
      // Never overwrite an existing config the user can still fix by hand.
      console.warn(`config.json could not be read (${e.message}); using defaults for this run.`);
    }
  }
  // Empty or missing values fall back to the defaults instead of resolving to the working directory.
  const pick=key=>{const v=raw[key];return typeof v==='string'&&v.trim()?v.trim():DEFAULT_CONFIG[key];};
  return {
    ...raw,
    musicDir: pick('musicDir'),
    cacheDir: pick('cacheDir'),
    publicOrigin: typeof raw.publicOrigin==='string'?raw.publicOrigin:''
  };
}
const CONFIG = loadConfig();
// Relative paths are resolved against the folder that contains server.js,
// so the server behaves the same no matter which directory it is started from.
const MUSIC_DIR = path.resolve(__dirname, CONFIG.musicDir);
const CACHE_DIR = path.resolve(__dirname, CONFIG.cacheDir);
const METADATA_CACHE_DIR = path.join(CACHE_DIR, 'metadata');
const COVER_CACHE_DIR = path.join(CACHE_DIR, 'covers');
const TRANSCODE_DIR = path.join(CACHE_DIR, 'm4a-flac');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PLAYLIST_FILE = path.join(__dirname, 'playlists.json');
// User-made share playlists (/c/<id>). Each one expires CUSTOM_TTL_MS after it
// is created and is removed from custom-playlists.json automatically.
const CUSTOM_FILE = path.join(__dirname, 'custom-playlists.json');
const CUSTOM_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CUSTOM_MAX_TRACKS = 500;
const CUSTOM_MAX_LISTS = 2000;
const CUSTOM_MAX_NAME = 80;

// ---------------------------------------------------------------------------
// publicOrigin
//
// Optional. When this server is exposed to the internet behind a reverse proxy
// (Nginx, Cloudflare Tunnel, etc.), set publicOrigin to the public URL, e.g.
//
//   { "publicOrigin": "https://music.example.com" }
//
// It is used only to build absolute URLs in OGP / Twitter meta tags for the
// /s/<id> and /p/<name> share pages. Leave it empty for pure-LAN usage; the
// share pages will then use relative paths, which works fine on the same host.
//
// The PUBLIC_ORIGIN environment variable overrides config.json when set.
// ---------------------------------------------------------------------------
const PUBLIC_ORIGIN = String(
  (process.env.PUBLIC_ORIGIN != null && process.env.PUBLIC_ORIGIN !== '')
    ? process.env.PUBLIC_ORIGIN
    : (CONFIG.publicOrigin || '')
).trim().replace(/\/+$/, '');

// Origin used for absolute URLs on share pages (og:url / og:image).
// publicOrigin wins; otherwise use the request's own host, honouring X-Forwarded-Proto
// so links stay https when the server sits behind a reverse proxy.
function requestOrigin(req){
  if(PUBLIC_ORIGIN)return PUBLIC_ORIGIN;
  const fwd=String(req.headers['x-forwarded-proto']||'').split(',')[0].trim().toLowerCase();
  const proto=fwd==='https'||fwd==='http'?fwd:'http';
  return `${proto}://${req.headers.host||'localhost'}`;
}

// POST /api/scan walks the whole library; repeated calls within this window
// return the previous result instead of rescanning again.
const SCAN_COOLDOWN_MS = 10000;
let lastScan = null;

// ---------------------------------------------------------------------------
// FLAC seek tables
//
// FLAC files without a SEEKTABLE force players (ExoPlayer, browsers) to find a
// seek position by binary search: a dozen+ sequential range requests, which is
// slow through a reverse proxy. With "flacSeekTable" enabled in config.json the
// scan adds one seek point per second (metaflac --add-seekpoint=1s) to new or
// changed FLAC files *before* they are added to the library.
//
//   "flacSeekTable": false    off (default)
//   "flacSeekTable": "check"  only detect and record which files lack a table
//   "flacSeekTable": true     add missing tables (audio data is not touched)
//   "metaflacPath": "..."     optional, defaults to "metaflac" on PATH
//
// Results are recorded per file in seektable.json next to config.json, so
// unchanged files are skipped on the next scan and removed files are dropped.
// The file's modification time is restored after metaflac runs, so the change
// does not make clients resync the track.
// ---------------------------------------------------------------------------
const SEEKTABLE_MODE = CONFIG.flacSeekTable === true || CONFIG.flacSeekTable === 'add'
  ? 'add'
  : CONFIG.flacSeekTable === 'check' ? 'check' : 'off';
const METAFLAC = (typeof CONFIG.metaflacPath === 'string' && CONFIG.metaflacPath.trim()) || 'metaflac';
const SEEKTABLE_FILE = path.join(__dirname, 'seektable.json');
let seekIndex = loadSeekIndex();
let metaflacOk = null;

function loadSeekIndex(){
  try{
    const d=JSON.parse(fs.readFileSync(SEEKTABLE_FILE,'utf8'));
    if(d&&typeof d.files==='object'&&d.files)return {version:1,files:d.files};
  }catch{}
  return {version:1,files:{}};
}
function saveSeekIndex(){
  try{
    const tmp=SEEKTABLE_FILE+'.tmp';
    fs.writeFileSync(tmp,JSON.stringify(seekIndex,null,1));
    fs.renameSync(tmp,SEEKTABLE_FILE);
  }catch(e){console.warn('seektable.json write failed:',e.message);}
}
// true = has SEEKTABLE, false = FLAC without one, null = not a plain FLAC stream (e.g. ID3-prefixed)
async function flacHasSeekTable(file){
  const fh=await fs.promises.open(file,'r');
  try{
    const h=Buffer.alloc(4);
    let r=await fh.read(h,0,4,0);
    if(r.bytesRead<4||h.toString('latin1')!=='fLaC')return null;
    let off=4;
    for(let i=0;i<128;i++){
      r=await fh.read(h,0,4,off);
      if(r.bytesRead<4)return false;
      const last=(h[0]&0x80)!==0, type=h[0]&0x7f, len=h.readUIntBE(1,3);
      if(type===3)return true;
      off+=4+len;
      if(last)return false;
    }
    return false;
  }finally{await fh.close();}
}
function runMetaflac(args){
  return new Promise((resolve,reject)=>{
    let err='';
    let p;
    try{p=spawn(METAFLAC,args,{stdio:['ignore','ignore','pipe'],windowsHide:true});}catch(e){return reject(e);}
    p.stderr.on('data',d=>{err+=String(d);});
    p.on('error',reject);
    p.on('close',code=>code===0?resolve():reject(new Error(err.trim()||`metaflac exited with code ${code}`)));
  });
}
async function checkMetaflac(){
  if(metaflacOk!==null)return metaflacOk;
  try{await runMetaflac(['--version']);metaflacOk=true;}
  catch(e){metaflacOk=false;console.warn(`metaflac not found (${METAFLAC}): ${e.message}. FLAC seek tables will not be added.`);}
  return metaflacOk;
}
// Runs inside a scan, before metadata is read. Updates size/mtime of entries whose file changed.
async function ensureSeekTables(discovered){
  if(SEEKTABLE_MODE==='off')return;
  const files=seekIndex.files;
  const live=new Set();
  const todo=[];
  for(const t of discovered){
    if(t.ext!=='.flac')continue;
    live.add(t.path);
    const prev=files[t.path];
    if(prev&&prev.size===t.size&&prev.mtime===t.mtime&&prev.status!=='failed'&&!(prev.status==='missing'&&SEEKTABLE_MODE==='add'))continue;
    todo.push(t);
  }
  let removed=0;
  for(const k of Object.keys(files))if(!live.has(k)){delete files[k];removed++;}
  if(!todo.length){if(removed)saveSeekIndex();return;}
  const canAdd=SEEKTABLE_MODE==='add'&&await checkMetaflac();
  console.log(`Seek tables: checking ${todo.length} FLAC file(s)${canAdd?'':' (check only)'}...`);
  const count={present:0,added:0,missing:0,failed:0,unsupported:0};
  let n=0;
  for(const t of todo){
    n++;
    const file=safePath(t.path);
    const rec=status=>{
      let st;try{st=fs.statSync(file);}catch{}
      if(st&&(st.size!==t.size||st.mtimeMs!==t.mtime)){
        // Tags and cover are untouched by metaflac, so carry the cached metadata over
        // to the new size/mtime instead of re-parsing the file.
        try{
          const mp=metadataCachePath(t.id);
          const data=JSON.parse(fs.readFileSync(mp,'utf8'));
          if(Number(data.mtime)===Number(t.mtime)&&Number(data.size)===Number(t.size)){
            data.mtime=st.mtimeMs;data.size=st.size;fs.writeFileSync(mp,JSON.stringify(data));
          }
        }catch{}
        t.size=st.size;t.mtime=st.mtimeMs;
      }
      files[t.path]={size:t.size,mtime:t.mtime,status,at:new Date().toISOString()};
      count[status]++;
    };
    try{
      const has=await flacHasSeekTable(file);
      if(has===true){rec('present');}
      else if(has===null){rec('unsupported');}
      else if(!canAdd){rec('missing');}
      else{
        const before=await fs.promises.stat(file);
        try{
          await runMetaflac(['--add-seekpoint=1s',file]);
        }finally{
          // Keep the original modification time so clients do not treat the track as changed.
          try{await fs.promises.utimes(file,before.atimeMs/1000,before.mtimeMs/1000);}catch{}
        }
        rec(await flacHasSeekTable(file)===true?'added':'failed');
      }
    }catch(e){
      console.warn(`Seek table failed: ${t.path}: ${e.message}`);
      rec('failed');
    }
    if(n%50===0){saveSeekIndex();console.log(`Seek tables: ${n}/${todo.length}`);}
  }
  saveSeekIndex();
  console.log(`Seek tables: ${count.added} added, ${count.present} already had one, ${count.missing} missing (not modified), ${count.failed} failed, ${count.unsupported} unsupported, ${removed} removed from index`);
}

const AUDIO_EXTS = new Set(['.mp3','.flac','.m4a','.aac','.ogg','.oga','.opus','.wav','.webm']);
const MIME = {
  '.mp3':'audio/mpeg','.flac':'audio/flac','.m4a':'audio/mp4','.aac':'audio/aac',
  '.ogg':'audio/ogg','.oga':'audio/ogg','.opus':'audio/ogg','.wav':'audio/wav','.webm':'audio/webm'
};

let cachedTracks=[];
let mmPromise=null;
// Server-side metadata index: only lightweight title/artist/album/cover flags stay in RAM.
let songNameList=new Map();
let scanPromise=null;
const m4aLocks=new Map();
fs.mkdirSync(METADATA_CACHE_DIR,{recursive:true});
fs.mkdirSync(COVER_CACHE_DIR,{recursive:true});
fs.mkdirSync(TRANSCODE_DIR,{recursive:true});
function getMM(){if(!mmPromise)mmPromise=import('music-metadata');return mmPromise;}
function loadPlaylists(){try{return JSON.parse(fs.readFileSync(PLAYLIST_FILE,'utf8'));}catch{return {};}}
function savePlaylists(data){fs.writeFileSync(PLAYLIST_FILE,JSON.stringify(data,null,2));}
let customLists=null;
function loadCustomLists(){if(customLists)return customLists;try{const raw=JSON.parse(fs.readFileSync(CUSTOM_FILE,'utf8'));customLists=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{};}catch{customLists={};}pruneCustomLists();return customLists;}
function saveCustomLists(){const tmp=CUSTOM_FILE+'.tmp';try{fs.writeFileSync(tmp,JSON.stringify(customLists||{},null,2));fs.renameSync(tmp,CUSTOM_FILE);}catch(e){console.warn('Could not save custom playlists:',e.message);}}
function pruneCustomLists(){const lists=customLists||{};const now=Date.now();let removed=0;for(const [id,v] of Object.entries(lists)){if(!v||!(Number(v.expiresAt)>now)){delete lists[id];removed++;}}if(removed)saveCustomLists();return removed;}
function getCustomList(id){const lists=loadCustomLists();const v=lists[id];if(!v)return null;if(!(Number(v.expiresAt)>Date.now())){delete lists[id];saveCustomLists();return null;}return v;}
function newCustomId(){const lists=loadCustomLists();for(;;){const id=crypto.randomBytes(6).toString('base64url');if(!lists[id])return id;}}
function readJsonBody(req,limit=64*1024){return new Promise((resolve,reject)=>{let size=0;const chunks=[];req.on('data',c=>{size+=c.length;if(size>limit){reject(Object.assign(new Error('Body too large'),{status:413}));req.destroy();return;}chunks.push(c);});req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}'));}catch{reject(Object.assign(new Error('Invalid JSON'),{status:400}));}});req.on('error',reject);});}
function customListInfo(id,v,base){return {id,name:v.name,tracks:v.tracks,createdAt:v.createdAt,expiresAt:v.expiresAt,url:`${base}/c/${encodeURIComponent(id)}`};}
function safePath(rel){const full=path.resolve(MUSIC_DIR,rel||'');if(full!==MUSIC_DIR&&!full.startsWith(MUSIC_DIR+path.sep))return null;return full;}
function idFor(rel){return crypto.createHash('sha1').update(rel).digest('hex').slice(0,16);}
function walk(dir,out=[]){if(!fs.existsSync(dir))return out;let entries;try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch{return out;}for(const ent of entries){if(ent.name.startsWith('.'))continue;const abs=path.join(dir,ent.name);if(ent.isDirectory())walk(abs,out);else if(AUDIO_EXTS.has(path.extname(ent.name).toLowerCase())){const rel=path.relative(MUSIC_DIR,abs).split(path.sep).join('/');try{const st=fs.statSync(abs);const parts=rel.split('/');parts.pop();out.push({id:idFor(rel),path:rel,name:path.basename(ent.name,path.extname(ent.name)),folder:parts.join(' / '),ext:path.extname(ent.name).toLowerCase(),size:st.size,mtime:st.mtimeMs});}catch{}}}return out;}
async function scanLibraryChanges(){
  if(scanPromise)return scanPromise;
  scanPromise=(async()=>{
    const discovered=walk(MUSIC_DIR);
    await ensureSeekTables(discovered);
    const oldByPath=new Map(cachedTracks.map(t=>[t.path,t]));
    const next=[]; const seen=new Set();
    let added=0,changed=0,removed=0;
    for(const t of discovered){
      seen.add(t.path);
      const old=oldByPath.get(t.path);
      if(!old)added++; else if(old.mtime!==t.mtime||old.size!==t.size)changed++;
      next.push(t);
    }
    for(const old of cachedTracks){
      if(!seen.has(old.path)){
        removed++; deleteMetadataCache(old.id); songNameList.delete(old.id);
      }
    }
    next.sort((a,b)=>a.path.localeCompare(b.path,undefined,{numeric:true,sensitivity:'base'}));
    cachedTracks=next;
    for(const t of cachedTracks){
      const old=oldByPath.get(t.path);
      const changedFile=!old||old.mtime!==t.mtime||old.size!==t.size||!hasMetadataCache(t);
      if(changedFile){
        const meta=await readMetadata(t);
        songNameList.set(t.id,{title:meta.title||t.name,artist:meta.artist||'',album:meta.album||'',hasCover:!!meta.hasCover});
      }else{
        const meta=readMetadataCache(t);
        if(meta)songNameList.set(t.id,{title:meta.title||t.name,artist:meta.artist||'',album:meta.album||'',hasCover:!!meta.hasCover});
      }
    }
    syncFolderPlaylists(cachedTracks);
    return {tracks:cachedTracks,added,changed,removed};
  })().finally(()=>{scanPromise=null});
  return scanPromise;
}
function scanLibrary(){return cachedTracks;}
function syncFolderPlaylists(tracks){
  const raw=loadPlaylists();
  delete raw.Favorites;
  delete raw['Recently Added'];
  const oldAuto=new Set(Object.entries(raw).filter(([,v])=>v&&v.__autoFolder).map(([n])=>n));
  for(const n of oldAuto)delete raw[n];
  const folderMap=new Map();
  for(const t of tracks){const parts=t.path.split('/');parts.pop();const folderPath=parts.join('/');const name=parts.length?parts[parts.length-1]:'Music';if(!folderMap.has(folderPath))folderMap.set(folderPath,{name,ids:[]});folderMap.get(folderPath).ids.push(t.id);}
  for(const [folderPath,info] of folderMap){let name=info.name;if(raw[name])name=folderPath||'Music (Folder)';while(raw[name])name=(folderPath?folderPath+'/':'')+info.name+' (Folder)';raw[name]={tracks:[...new Set(info.ids)],__autoFolder:true,folderPath};}
  savePlaylists(raw);
}
function normalizePlaylists(raw){const out={};for(const [name,v] of Object.entries(raw)){out[name]=Array.isArray(v)?v:Array.isArray(v?.tracks)?v.tracks:[];}return out;}
function metadataCachePath(id){return path.join(METADATA_CACHE_DIR,`${id}.json`);}
function coverCachePath(id){return path.join(COVER_CACHE_DIR,id);}
function normalizeLyrics(lyrics){
  if(!Array.isArray(lyrics)||!lyrics.length)return [];
  const out=[];const seen=new Set();
  for(const raw of lyrics){
    const text=String(raw?.text??'').trimEnd();
    const hasTime=Number.isFinite(Number(raw?.time));
    const time=hasTime?Number(raw.time):null;
    if(!text.trim()&&!hasTime)continue;
    const key=hasTime?`t:${time}|${text}`:`u:${text}`;
    if(seen.has(key))continue;
    seen.add(key);out.push({time,text});
  }
  if(out.some(x=>Number.isFinite(x.time)))out.sort((a,b)=>(a.time??Infinity)-(b.time??Infinity));
  return out;
}
function readMetadataCache(track){
  try{
    const file=metadataCachePath(track.id);
    const stat=fs.statSync(file);
    if(stat.isFile()){
      const data=JSON.parse(fs.readFileSync(file,'utf8'));
      if(Number(data?.mtime)===Number(track.mtime) && Number(data?.size)===Number(track.size)){
        const normalized=normalizeLyrics(data.lyrics);
        const changed=JSON.stringify(normalized)!==JSON.stringify(Array.isArray(data.lyrics)?data.lyrics:[]);
        if(changed){data.lyrics=normalized;try{fs.writeFileSync(file,JSON.stringify(data));}catch{}}
        else if(!Array.isArray(data.lyrics))data.lyrics=normalized;
        return data;
      }
    }
  }catch{}
  return null;
}
function hasMetadataCache(track){return !!readMetadataCache(track);}
function deleteMetadataCache(id){
  try{fs.rmSync(metadataCachePath(id),{force:true});}catch{}
  try{for(const name of fs.readdirSync(COVER_CACHE_DIR)){if(name.startsWith(id+'.'))fs.rmSync(path.join(COVER_CACHE_DIR,name),{force:true});}}catch{}
}
function coverCacheFile(id,format){
  const ext=String(format||'image/jpeg').toLowerCase().includes('png')?'.png':String(format||'').toLowerCase().includes('webp')?'.webp':'.jpg';
  return coverCachePath(id)+ext;
}
function findCachedCover(id){
  try{const names=fs.readdirSync(COVER_CACHE_DIR);const name=names.find(x=>x.startsWith(id+'.'));return name?path.join(COVER_CACHE_DIR,name):null;}catch{return null;}
}
async function readMetadata(track){
  const file=safePath(track.path);if(!file)return {lyrics:[]};
  const cached=readMetadataCache(track);if(cached)return cached;
  try{
    const mm=await getMM();
    const meta=await mm.parseFile(file,{skipCovers:false,duration:false});
    const common=meta.common||{};
    const lyricTags=Array.isArray(common.lyrics)?common.lyrics:[];
    let lyrics=[];
    for(const tag of lyricTags){
      if(Array.isArray(tag?.syncText)&&tag.syncText.length){
        for(const item of tag.syncText)if(typeof item?.text==='string')lyrics.push({time:Number(item.timestamp)/1000,text:item.text});
      }else if(typeof tag?.text==='string'){
        for(const line of tag.text.replace(/\r/g,'').split('\n'))if(line.trim())lyrics.push({text:line});
      }
    }
    lyrics=normalizeLyrics(lyrics);
    const picture=Array.isArray(common.picture)&&common.picture[0]?.data?{format:common.picture[0].format||'image/jpeg',data:Buffer.from(common.picture[0].data)}:null;
    if(picture){
      const out=coverCacheFile(track.id,picture.format);
      try{fs.writeFileSync(out,picture.data);for(const n of fs.readdirSync(COVER_CACHE_DIR)){if(n.startsWith(track.id+'.')&&path.join(COVER_CACHE_DIR,n)!==out)fs.rmSync(path.join(COVER_CACHE_DIR,n),{force:true});}}catch(e){console.warn('Cover cache write failed:',track.path,e.message);}
    }else{
      const old=findCachedCover(track.id);if(old)try{fs.rmSync(old,{force:true})}catch{}
    }
    const data={mtime:track.mtime,size:track.size,title:common.title||track.name,artist:common.artist||common.artists?.join(', ')||'',album:common.album||'',lyrics,hasCover:!!picture,coverFormat:picture?.format||null};
    try{fs.writeFileSync(metadataCachePath(track.id),JSON.stringify(data));}catch(e){console.warn('Metadata cache write failed:',track.path,e.message);}
    return data;
  }catch(e){
    console.warn(`Metadata read failed: ${track.path}: ${e.message}`);
    const data={mtime:track.mtime,size:track.size,title:track.name,artist:'',album:'',lyrics:[],hasCover:false,coverFormat:null};
    try{fs.writeFileSync(metadataCachePath(track.id),JSON.stringify(data));}catch{}
    return data;
  }
}
function json(res,status,obj){const body=JSON.stringify(obj);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(body);}
async function ensureM4aFlac(track){
  const file=safePath(track.path);
  if(!file)throw new Error('Invalid source path');
  const st=await fs.promises.stat(file);
  const key=`${track.id}-${Math.round(st.mtimeMs)}-${st.size}`;
  const out=path.join(TRANSCODE_DIR,`${key}.flac`);
  try{const os=await fs.promises.stat(out);if(os.size>0)return out;}catch{}
  if(m4aLocks.has(key))return m4aLocks.get(key);
  const job=(async()=>{
    const tmp=`${out}.tmp-${process.pid}-${Date.now()}`;
    try{
      await new Promise((resolve,reject)=>{
        const ff=spawn(ffmpegPath,[
          '-hide_banner','-loglevel','error','-y',
          '-i',file,
          '-map','0:a:0',
          '-map_metadata','0',
          '-map_chapters','0',
          '-c:a','flac',
          '-compression_level','5',
          '-f','flac',tmp
        ],{stdio:['ignore','ignore','pipe']});
        let err='';
        ff.stderr.on('data',d=>{err+=String(d);});
        ff.on('error',reject);
        ff.on('close',code=>code===0?resolve():reject(new Error(err.trim()||`FFmpeg exited with code ${code}`)));
      });
      await fs.promises.rename(tmp,out);
      return out;
    }finally{try{await fs.promises.unlink(tmp)}catch{}}
  })();
  m4aLocks.set(key,job);
  try{return await job;}finally{m4aLocks.delete(key);}
}
async function streamM4aAsFlac(req,res,track,disposition='inline',downloadName=''){
  const out=await ensureM4aFlac(track);
  return streamFile(req,res,out,'audio/flac',disposition,downloadName);
}
function streamFile(req,res,file,forcedMime=null,disposition='inline',downloadName=''){
  const cd=disposition==='attachment' ? `attachment; filename*=UTF-8''${encodeURIComponent(downloadName||path.basename(file))}` : 'inline';let st;try{st=fs.statSync(file)}catch{return res.writeHead(404).end();}const size=st.size,range=req.headers.range,mime=forcedMime||MIME[path.extname(file).toLowerCase()]||'application/octet-stream';res.setHeader('Content-Type',mime);res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Accept-Ranges','bytes');res.setHeader('Cache-Control','no-store');if(!range){res.writeHead(200,{'Content-Length':size,'Accept-Ranges':'bytes','Content-Disposition':cd});if(req.method==='HEAD')return res.end();return fs.createReadStream(file).pipe(res);}const m=/bytes=(\d*)-(\d*)/.exec(range);if(!m)return res.writeHead(416,{'Content-Range':`bytes */${size}`}).end();let start=m[1]?Number(m[1]):0,end=m[2]?Number(m[2]):size-1;if(!Number.isFinite(start)||!Number.isFinite(end)||start>end||start>=size)return res.writeHead(416,{'Content-Range':`bytes */${size}`}).end();end=Math.min(end,size-1);res.writeHead(206,{'Content-Length':end-start+1,'Content-Range':`bytes ${start}-${end}/${size}`,'Accept-Ranges':'bytes','Content-Disposition':cd});if(req.method==='HEAD')return res.end();fs.createReadStream(file,{start,end}).pipe(res);}
const handleRequest=async(req,res)=>{try{const u=new URL(req.url,`http://${req.headers.host}`),p=u.pathname;
  if(p==='/web.ico'&&['GET','HEAD'].includes(req.method)){let icon=path.join(__dirname,'web.ico'),type='image/x-icon';let st;try{st=fs.statSync(icon)}catch{}if(!st||!st.isFile()){icon=path.join(PUBLIC_DIR,'icon-192.png');type='image/png';try{st=fs.statSync(icon)}catch{return res.writeHead(404).end();}}res.writeHead(200,{'Content-Type':type,'Content-Length':st.size,'Cache-Control':'public,max-age=86400'});if(req.method==='HEAD')return res.end();return fs.createReadStream(icon).pipe(res);}
  if((p==='/manifest.webmanifest'||p==='/service-worker.js'||p==='/icon-192.png'||p==='/icon-512.png'||p==='/default-cover.png')&&['GET','HEAD'].includes(req.method)){const file=path.join(PUBLIC_DIR,p.slice(1));let st;try{st=fs.statSync(file)}catch{return res.writeHead(404).end();}const types={'/manifest.webmanifest':'application/manifest+json','/service-worker.js':'application/javascript','/icon-192.png':'image/png','/icon-512.png':'image/png','/default-cover.png':'image/png'};res.writeHead(200,{'Content-Type':types[p],'Content-Length':st.size,'Cache-Control':p==='/service-worker.js'?'no-cache':'public,max-age=86400'});if(req.method==='HEAD')return res.end();return fs.createReadStream(file).pipe(res);}

  // Client bootstrap. publicOrigin is only informational now; it is used by
  // the Android app to know which ports the server is serving.
  if(p==='/api/config'&&req.method==='GET'){
    return json(res,200,{
      publicOrigin: PUBLIC_ORIGIN,
      webPort: PORT,
      mobileApiPort: MOBILE_PORT
    });
  }

  if(p==='/api/library'&&req.method==='GET'){const enriched=cachedTracks.map(t=>{const meta=songNameList.get(t.id)||readMetadataCache(t)||{};return {...t,title:meta.title||t.name,artist:meta.artist||'',album:meta.album||'',hasCover:!!meta.hasCover}});return json(res,200,{tracks:enriched});}
  if(p==='/api/playlists'&&req.method==='GET'){return json(res,200,normalizePlaylists(loadPlaylists()));}
  const cv=p.match(/^\/api\/track\/([^/]+)\/cover$/);
  if(cv&&req.method==='GET'){scanLibrary();const id=decodeURIComponent(cv[1]);const t=cachedTracks.find(x=>x.id===id);if(!t)return res.writeHead(404).end();const meta=readMetadataCache(t);let cover=findCachedCover(id);if(!cover||!meta||Number(meta.mtime)!==Number(t.mtime)||Number(meta.size)!==Number(t.size)){await readMetadata(t);cover=findCachedCover(id);}if(!cover)return res.writeHead(404,{'Cache-Control':'no-store'}).end();const ext=path.extname(cover).toLowerCase();const format=ext==='.png'?'image/png':ext==='.webp'?'image/webp':'image/jpeg';const st=fs.statSync(cover);res.writeHead(200,{'Content-Type':format,'Content-Length':st.size,'Cache-Control':'no-store','Access-Control-Allow-Origin':'*'});return fs.createReadStream(cover).pipe(res);}
  const tm=p.match(/^\/api\/track\/([^/]+)\/metadata$/);
  if(tm&&req.method==='GET'){scanLibrary();const id=decodeURIComponent(tm[1]);const t=cachedTracks.find(x=>x.id===id);if(!t)return json(res,404,{error:'Track not found'});return json(res,200,await readMetadata(t));}
  const tl=p.match(/^\/api\/track\/([^/]+)\/lyrics$/);
  if(tl&&req.method==='GET'){scanLibrary();const id=decodeURIComponent(tl[1]);const t=cachedTracks.find(x=>x.id===id);if(!t)return json(res,404,{error:'Track not found'});const meta=await readMetadata(t);return json(res,200,{lyrics:meta.lyrics||[]});}
  if(p==='/api/scan'&&req.method==='POST'){if(lastScan&&Date.now()-lastScan.at<SCAN_COOLDOWN_MS)return json(res,200,{...lastScan.body,cached:true});const result=await scanLibraryChanges();const body={ok:true,tracks:result.tracks.length,added:result.added,changed:result.changed,removed:result.removed,scannedAt:new Date().toISOString()};lastScan={at:Date.now(),body};return json(res,200,body);}
  if(p==='/api/custom-playlists'&&req.method==='POST'){
    let body;try{body=await readJsonBody(req);}catch(e){return json(res,e.status||400,{error:e.message});}
    const name=String(body?.name??'').replace(/[\u0000-\u001f]/g,' ').trim().slice(0,CUSTOM_MAX_NAME)||'自訂播放清單';
    const known=new Set(cachedTracks.map(t=>t.id));
    const ids=[...new Set(Array.isArray(body?.tracks)?body.tracks.map(String):[])].filter(id=>known.has(id));
    if(!ids.length)return json(res,400,{error:'No valid tracks'});
    if(ids.length>CUSTOM_MAX_TRACKS)return json(res,400,{error:`Too many tracks (max ${CUSTOM_MAX_TRACKS})`});
    const lists=loadCustomLists();pruneCustomLists();
    if(Object.keys(lists).length>=CUSTOM_MAX_LISTS)return json(res,429,{error:'Too many custom playlists'});
    const id=newCustomId(),now=Date.now();
    const entry={name,tracks:ids,createdAt:now,expiresAt:now+CUSTOM_TTL_MS,deleteToken:crypto.randomBytes(16).toString('hex')};
    lists[id]=entry;saveCustomLists();
    return json(res,201,{...customListInfo(id,entry,requestOrigin(req)),deleteToken:entry.deleteToken});
  }
  const cpl=p.match(/^\/api\/custom-playlists\/([^/]+)$/);
  if(cpl&&req.method==='GET'){const id=decodeURIComponent(cpl[1]);const v=getCustomList(id);if(!v)return json(res,404,{error:'Playlist not found or expired'});return json(res,200,customListInfo(id,v,requestOrigin(req)));}
  if(cpl&&req.method==='DELETE'){const id=decodeURIComponent(cpl[1]);const v=getCustomList(id);if(!v)return json(res,200,{ok:true});const token=String(req.headers['x-delete-token']||u.searchParams.get('token')||'');if(!token||token!==v.deleteToken)return json(res,403,{error:'Wrong delete token'});delete loadCustomLists()[id];saveCustomLists();return json(res,200,{ok:true});}
  const playlistShare=p.match(/^\/(p|c)\/([^/]+)$/);
  if(playlistShare&&req.method==='GET'){
    scanLibrary();
    const shareKind=playlistShare[1],shareKey=decodeURIComponent(playlistShare[2]);
    let playlistName,ids;
    if(shareKind==='c'){const v=getCustomList(shareKey);playlistName=v?.name;ids=v?v.tracks:null;}
    else{playlistName=shareKey;const raw=normalizePlaylists(loadPlaylists());ids=Array.isArray(raw[playlistName])?raw[playlistName]:null;}
    if(!ids)return res.writeHead(404,{'Content-Type':'text/html; charset=utf-8'}).end(shareKind==='c'?'<!doctype html><meta charset="utf-8"><title>Expired · Simple Player</title><style>body{font:16px system-ui;background:#141617;color:#e4e6e8;display:grid;place-items:center;height:100vh;margin:0}</style><p>這個播放清單不存在或已過期（自訂清單保存 30 天）</p>':'<h1>404</h1><p>Playlist not found</p>');
    const tracks=ids.map(id=>cachedTracks.find(t=>t.id===id)).filter(Boolean).map(t=>{const meta=songNameList.get(t.id)||readMetadataCache(t)||{};return {...t,title:meta.title||t.name,artist:meta.artist||'',album:meta.album||'',hasCover:!!meta.hasCover}});
    if(!tracks.length)return res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}).end('<!doctype html><meta charset="utf-8"><title>Empty Playlist · Simple Player</title><style>body{font:16px system-ui;background:#141617;color:#e4e6e8;display:grid;place-items:center;height:100vh;margin:0}</style><p>這個歌單目前沒有可播放的歌曲</p>');
    const escHtml=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const base=requestOrigin(req);
    const pageUrl=`${base}/${shareKind}/${encodeURIComponent(shareKey)}`;
    const publicTracks=tracks.map(t=>({id:t.id,title:t.title,artist:t.artist,album:t.album,folder:t.folder,hasCover:t.hasCover}));
    const first=tracks[0], firstMeta=await readMetadata(first);
    const firstTitle=firstMeta.title||first.title||first.name, firstArtist=firstMeta.artist||first.artist||'', firstAlbum=firstMeta.album||first.album||'';
    const firstCover=firstMeta.hasCover?`/api/track/${encodeURIComponent(first.id)}/cover`:'';
    const firstLyrics=Array.isArray(firstMeta.lyrics)?firstMeta.lyrics:[];
    const firstLyricJson=JSON.stringify(firstLyrics.map(x=>({time:Number.isFinite(x.time)?x.time:null,text:String(x.text??'')})).filter(x=>Number.isFinite(x.time)||x.text.trim())).replace(/</g,'\\u003c');
    const trackJson=JSON.stringify(publicTracks).replace(/</g,'\\u003c');
    const body=`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><link rel="icon" href="/web.ico"><title>${escHtml(playlistName)} · Simple Player</title><meta property="og:type" content="music.playlist"><meta property="og:title" content="${escHtml(playlistName)}"><meta property="og:description" content="${tracks.length} 首歌曲 · Simple Player"><meta property="og:url" content="${escHtml(pageUrl)}">${firstCover?`<meta property="og:image" content="${escHtml(base+firstCover)}"><meta name="twitter:image" content="${escHtml(base+firstCover)}">`:''}<meta name="twitter:card" content="summary"><style>:root{color-scheme:dark}*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}body{background:#141617;color:#e4e6e8;font:14px system-ui,-apple-system,Segoe UI,sans-serif;display:flex;justify-content:center;align-items:center;padding:10px}.card{width:min(900px,100%);height:min(96vh,820px);background:#181a1c;border:1px solid #2b3034;border-radius:12px;overflow:hidden;box-shadow:0 12px 40px #0006;display:grid;grid-template-columns:minmax(0,1fr) 290px;grid-template-rows:auto auto auto 1fr}.top{grid-column:1/3;display:grid;grid-template-columns:150px 1fr;gap:18px;align-items:center;padding:18px 20px 10px}.cover{width:150px;height:150px;border-radius:7px;background:#25292c center/cover no-repeat;display:grid;place-items:center;font-size:42px;color:#62686e}.info{min-width:0}.label{font-size:11px;color:#858b91;letter-spacing:.08em;text-transform:uppercase}.title{margin-top:4px;font-size:21px;font-weight:700;overflow-wrap:anywhere}.sub{margin-top:6px;color:#858b91;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.player{grid-column:1/3;display:grid;grid-template-columns:42px minmax(0,1fr);grid-template-rows:34px;gap:10px;align-items:center;padding:7px 20px 8px;background:#151719;border-top:1px solid #252a2e;border-bottom:1px solid #252a2e}.player audio{display:none}.controls{display:flex;justify-content:center;align-items:center}.play-btn{width:31px;height:31px;border:0;border-radius:50%;background:#e4e6e8;color:#181a1c;cursor:pointer;display:grid;place-items:center;padding:0}.play-btn::before{content:'';display:block;width:0;height:0;border-top:5px solid transparent;border-bottom:5px solid transparent;border-left:7px solid currentColor;margin-left:2px}.play-btn.is-playing::before{width:9px;height:11px;border:0;background:linear-gradient(to right,currentColor 0 3px,transparent 3px 6px,currentColor 6px 9px);box-shadow:none;margin-left:0}.progress{min-width:0;display:grid;grid-template-columns:34px 1fr 34px;align-items:center;gap:7px;color:#858b91;font:9px/1 monospace}.progress input{width:100%;margin:0;appearance:none;-webkit-appearance:none;background:transparent;cursor:pointer}.progress input::-webkit-slider-runnable-track{height:3px;border-radius:3px;background:linear-gradient(to right,#e4e6e8 0%,#e4e6e8 var(--range-progress,0%),#383d41 var(--range-progress,0%),#383d41 100%)}.progress input::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;width:9px;height:9px;margin-top:-3px;border-radius:50%;border:0;background:#e4e6e8}.progress input::-moz-range-track{height:3px;border-radius:3px;background:#383d41}.progress input::-moz-range-progress{height:3px;border-radius:3px;background:#e4e6e8}.progress input::-moz-range-thumb{width:9px;height:9px;border:0;border-radius:50%;background:#e4e6e8}.spectrum{grid-column:1/3;height:58px;padding:5px 20px 4px;background:#151719;border-bottom:1px solid #252a2e}.spectrum canvas{display:block;width:100%;height:100%}.lyrics{min-height:0;grid-column:1;display:flex;flex-direction:column;border-top:1px solid #2b3034;padding:10px 20px 14px}.lyrics h2{flex:0 0 auto;margin:0 0 5px;font-size:11px;color:#858b91;letter-spacing:.08em;text-align:center}.lyrics-box{min-height:0;flex:1;overflow-y:auto;scrollbar-width:thin;padding:4px 8px}.lyric-line{text-align:center;line-height:1.45;padding:3px 8px;color:#73797e;transition:color .12s,transform .12s,font-size .12s}.lyric-line.active{color:#fff;font-weight:700;font-size:1.08em}.empty{color:#62686e;text-align:center;padding-top:10px}.selector{min-height:0;grid-column:2;grid-row:4;border-top:1px solid #2b3034;border-left:1px solid #2b3034;display:flex;flex-direction:column}.selector-head{padding:11px 13px 8px;color:#858b91;font-size:11px;letter-spacing:.08em}.list{min-height:0;overflow-y:auto;padding:0 7px 9px}.item{width:100%;border:0;background:transparent;color:#bfc3c6;text-align:left;padding:9px 8px;border-radius:7px;display:grid;grid-template-columns:25px minmax(0,1fr);gap:6px;cursor:pointer}.item:hover{background:#23272a}.item.active{background:#2a2e31;color:#fff}.num{color:#62686e;font:10px monospace;padding-top:2px}.item.active .num{color:#fff}.ititle{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.iartist{font-size:11px;color:#777e83;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}.item.active .iartist{color:#aeb3b7}.select-btn,.selector-shade{display:none}.select-btn{position:absolute;right:12px;top:12px;z-index:5;border:1px solid #363b3f;background:#23272a;color:#e4e6e8;border-radius:18px;padding:7px 11px;font:12px system-ui;cursor:pointer}.selector-shade{position:absolute;inset:0;z-index:19;background:#0008}.selector.open~*{}
@media(max-width:700px){body{padding:0}.card{width:100%;height:100%;border:0;border-radius:0;display:flex;flex-direction:column;position:relative}.top{display:grid;grid-template-columns:96px 1fr;gap:12px;padding:12px 14px 6px}.cover{width:96px;height:96px}.title{font-size:17px}.sub{font-size:12px}.player{grid-column:auto;display:grid;grid-template-columns:38px minmax(0,1fr);grid-template-rows:30px;padding:5px 14px 6px;gap:2px 8px}.spectrum{grid-column:auto;height:48px;flex-basis:48px;padding:4px 10px 3px}.lyrics{order:3;min-height:0;flex:1;padding:8px 10px 10px}.lyrics-box{padding:2px 4px}.lyric-line{padding:2px 5px;line-height:1.35}.lyric-line.active{font-size:1.04em}.selector{position:absolute;z-index:20;top:0;right:0;width:min(86vw,360px);height:100%;border:0;background:#181a1c;transform:translateX(102%);transition:transform .22s ease;box-shadow:-12px 0 35px #0007;display:flex;flex-direction:column;order:unset}.selector.open{transform:translateX(0)}.selector-shade.open{display:block}.select-btn{display:block}.selector-head{display:flex;align-items:center;justify-content:space-between;padding:14px 12px 10px;border-bottom:1px solid #2b3034}.selector-head::after{content:'×';font-size:24px;line-height:20px;color:#858b91}.selector-head{cursor:pointer}.list{display:block;overflow-y:auto;overflow-x:hidden;padding:6px 8px 12px}.item{min-width:0;width:100%;grid-template-columns:25px minmax(0,1fr);align-content:center;padding:11px 8px}.item.active{background:#2a2e31}}@media(max-height:520px){.top{grid-template-columns:72px 1fr;padding:6px 12px 3px}.cover{width:72px;height:72px}.player{padding:2px 12px}.selector{height:110px}.lyrics{padding-top:4px}}</style></head><body><main class="card"><div class="top"><div class="cover" id="cover">${firstCover?`<span style="display:none">♪</span>`:'♪'}</div><div class="info"><div class="label">PLAYLIST · ${tracks.length} TRACKS</div><div class="title" id="title">${escHtml(firstTitle)}</div><div class="sub" id="sub">${escHtml([firstArtist,firstAlbum].filter(Boolean).join(' · '))}</div></div></div><div class="player"><audio id="audio" crossorigin="anonymous" preload="metadata"></audio><div class="controls"><button id="play" class="play-btn" type="button" aria-label="播放/暫停"></button></div><div class="progress"><span id="cur">0:00</span><input id="seek" type="range" min="0" max="1000" value="0" aria-label="播放進度"><span id="dur">0:00</span></div></div><div class="spectrum"><canvas id="spectrum" aria-label="音頻頻譜可視化"></canvas></div><section class="lyrics"><h2>SYNCED LYRICS</h2><div id="lyricsBox" class="lyrics-box"><div class="empty">選擇歌曲開始播放</div></div></section><button id="selectBtn" class="select-btn" type="button" aria-label="選擇歌曲">☰ 歌曲</button><div id="selectorShade" class="selector-shade"></div><aside class="selector"><div class="selector-head" id="selectorHead">${escHtml(playlistName)}</div><div id="list" class="list"></div></aside></main><script>const tracks=${trackJson},initialLyrics=${firstLyricJson},audio=document.getElementById('audio'),playBtn=document.getElementById('play'),seek=document.getElementById('seek'),cur=document.getElementById('cur'),dur=document.getElementById('dur'),titleEl=document.getElementById('title'),subEl=document.getElementById('sub'),cover=document.getElementById('cover'),lyricsBox=document.getElementById('lyricsBox'),canvas=document.getElementById('spectrum');const selector=document.querySelector('.selector'),selectorHead=document.getElementById('selectorHead'),selectorShade=document.getElementById('selectorShade'),selectBtn=document.getElementById('selectBtn');function toggleSelector(open){selector.classList.toggle('open',open);selectorShade.classList.toggle('open',open)}selectBtn.onclick=()=>toggleSelector(true);selectorShade.onclick=()=>toggleSelector(false);selectorHead.onclick=()=>toggleSelector(false);let index=0,lyrics=initialLyrics,active=-1,audioCtx=null,analyser=null,sourceNode=null,raf=0;const fmt=s=>{s=Number(s)||0;return Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0')};const range=(v)=>seek.style.setProperty('--range-progress',Math.max(0,Math.min(100,v))+'%');const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));function renderList(){const box=document.getElementById('list');box.innerHTML='';tracks.forEach((t,i)=>{const b=document.createElement('button');b.className='item'+(i===index?' active':'');b.type='button';b.innerHTML='<span class="num">'+(i+1)+'</span><span><div class="ititle">'+esc(t.title||'Unknown')+'</div><div class="iartist">'+esc(t.artist||t.album||t.folder||'')+'</div></span>';b.onclick=()=>{loadTrack(i,true);if(window.innerWidth<=700)toggleSelector(false)};box.appendChild(b)})}function setPlay(){playBtn.classList.toggle('is-playing',!audio.paused);playBtn.setAttribute('aria-label',audio.paused?'播放':'暫停')}function updateMediaSession(){if(!('mediaSession' in navigator))return;const t=tracks[index];try{navigator.mediaSession.metadata=new MediaMetadata({title:t.title||'Unknown',artist:t.artist||'',album:t.album||t.folder||'',artwork:[256,512].map(size=>({src:new URL('/api/track/'+encodeURIComponent(t.id)+'/cover',location.origin).href,sizes:size+'x'+size,type:'image/jpeg'}))})}catch(e){}for(const [a,h] of Object.entries({play:()=>audio.play(),pause:()=>audio.pause(),previoustrack:()=>loadTrack(index-1,true),nexttrack:()=>loadTrack(index+1,true),seekbackward:()=>audio.currentTime=Math.max(0,audio.currentTime-10),seekforward:()=>audio.currentTime=Math.min(audio.duration||Infinity,audio.currentTime+10)})){try{navigator.mediaSession.setActionHandler(a,h)}catch(e){}}navigator.mediaSession.playbackState=audio.paused?'paused':'playing'}function renderLyrics(){lyricsBox.innerHTML='';if(!lyrics.length){lyricsBox.innerHTML='<div class="empty">這首歌沒有可用的內嵌歌詞</div>';return}lyrics.forEach((x,i)=>{const d=document.createElement('div');d.className='lyric-line';d.dataset.i=i;d.textContent=x.text||'';d.onclick=()=>{if(Number.isFinite(x.time)){audio.currentTime=x.time;syncLyrics(audio.currentTime)}};lyricsBox.appendChild(d)})}function syncLyrics(t){if(!lyrics.some(x=>Number.isFinite(x.time)))return;let i=-1;for(let n=0;n<lyrics.length;n++){if(Number.isFinite(lyrics[n].time)&&lyrics[n].time<=t)i=n;else if(Number.isFinite(lyrics[n].time)&&lyrics[n].time>t)break}if(i===active)return;active=i;lyricsBox.querySelectorAll('.lyric-line').forEach((el,n)=>el.classList.toggle('active',n===i));if(i>=0&&lyrics[i]?.text.trim()){const el=lyricsBox.querySelector('.lyric-line[data-i="'+i+'"]');if(el)el.scrollIntoView({behavior:'smooth',block:'center'})}}async function loadTrack(i,auto){if(i<0||i>=tracks.length)return;index=i;const t=tracks[i];lyrics=[];active=-1;audio.src='/stream/'+encodeURIComponent(t.id);titleEl.textContent=t.title||'Unknown';subEl.textContent=[t.artist,t.album||t.folder].filter(Boolean).join(' · ');cover.style.backgroundImage='';cover.textContent='♪';fetch('/api/track/'+encodeURIComponent(t.id)+'/cover').then(r=>{if(!r.ok)throw 0;return r.blob()}).then(b=>{if(index!==i)return;const u=URL.createObjectURL(b);cover.textContent='';cover.style.backgroundImage='url("'+u+'")'}).catch(()=>{});renderList();try{const m=await fetch('/api/track/'+encodeURIComponent(t.id)+'/metadata').then(r=>r.json());if(index!==i)return;lyrics=m.lyrics||[];titleEl.textContent=m.title||t.title||'Unknown';subEl.textContent=[m.artist||t.artist,m.album||t.album||t.folder].filter(Boolean).join(' · ');renderLyrics();updateMediaSession()}catch(e){renderLyrics();updateMediaSession()}if(auto)audio.play().catch(()=>{});updateMediaSession()}audio.onplay=()=>{setPlay();updateMediaSession();startSpectrum()};audio.onpause=()=>{setPlay();updateMediaSession()};audio.onended=()=>{if(index<tracks.length-1)loadTrack(index+1,true);else setPlay()};audio.ontimeupdate=()=>{const d=audio.duration||0,p=d?audio.currentTime/d*100:0;cur.textContent=fmt(audio.currentTime);dur.textContent=fmt(d);seek.value=d?Math.round(p*10):0;range(p);syncLyrics(audio.currentTime)};let lyricFrame=0;function startLyricSync(){if(lyricFrame)return;const tick=()=>{lyricFrame=requestAnimationFrame(tick);if(!audio.paused&&lyrics.length)syncLyrics(audio.currentTime)};lyricFrame=requestAnimationFrame(tick)}startLyricSync();audio.onloadedmetadata=()=>{dur.textContent=fmt(audio.duration);range(0)};seek.oninput=()=>{if(audio.duration){audio.currentTime=audio.duration*(Number(seek.value)/1000);range(Number(seek.value)/10);syncLyrics(audio.currentTime)}};playBtn.onclick=()=>audio.paused?audio.play():audio.pause();function startSpectrum(){if(audioCtx)return;try{audioCtx=new(window.AudioContext||window.webkitAudioContext)();analyser=audioCtx.createAnalyser();analyser.fftSize=128;analyser.smoothingTimeConstant=.82;sourceNode=audioCtx.createMediaElementSource(audio);sourceNode.connect(analyser);analyser.connect(audioCtx.destination);drawSpectrum()}catch(e){}}function drawSpectrum(){if(!analyser)return;const c=canvas.getContext('2d'),dpr=Math.min(devicePixelRatio||1,2),w=canvas.clientWidth,h=canvas.clientHeight;canvas.width=Math.max(1,w*dpr);canvas.height=Math.max(1,h*dpr);c.setTransform(dpr,0,0,dpr,0,0);const data=new Uint8Array(analyser.frequencyBinCount),bars=48,gap=2;function frame(){raf=requestAnimationFrame(frame);analyser.getByteFrequencyData(data);c.clearRect(0,0,w,h);const bw=Math.max(1,(w-(bars-1)*gap)/bars);for(let i=0;i<bars;i++){const v=data[Math.floor(i/bars*data.length)]/255,bh=Math.max(2,v*(h-4));c.fillStyle='rgba(228,230,232,'+(0.22+v*.68)+')';c.fillRect(i*(bw+gap),h-bh,bw,bh)}}frame()}window.addEventListener('resize',()=>{if(analyser)drawSpectrum()});renderList();loadTrack(0,false);</script></body></html>`;
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(body);
  }
  const share=p.match(/^\/(?:s|share|play)\/([^/]+)$/);
  if(share&&req.method==='GET'){
    scanLibrary();
    const id=decodeURIComponent(share[1]);
    const t=cachedTracks.find(x=>x.id===id);
    if(!t)return res.writeHead(404,{'Content-Type':'text/html; charset=utf-8'}).end('<h1>404</h1><p>Track not found</p>');
    const meta=await readMetadata(t);
    const escHtml=v=>String(v??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));
    const base=requestOrigin(req);
    const streamUrl=`/stream/${encodeURIComponent(id)}`;
    const directUrl=`/d/${encodeURIComponent(id)}`;
    const coverUrl=`/api/track/${encodeURIComponent(id)}/cover`;
    const pageUrl=`${base}/s/${encodeURIComponent(id)}`;
    const title=meta.title||t.name, artist=meta.artist||'', album=meta.album||'';
    const description=[artist,album].filter(Boolean).join(' · ')||'Simple Player';
    const cover=meta.hasCover?`<meta property="og:image" content="${escHtml(base+coverUrl)}"><meta name="twitter:image" content="${escHtml(base+coverUrl)}">`:'';
    const lyrics=Array.isArray(meta.lyrics)?meta.lyrics:[];
    const syncedLyrics=lyrics.some(x=>Number.isFinite(x.time));
    const lyricData=lyrics.map(x=>({time:Number.isFinite(x.time)?x.time:null,text:String(x.text??'')})).filter(x=>Number.isFinite(x.time)||x.text.trim());
    const lyricJson=JSON.stringify(lyricData).replace(/</g,'\\u003c');
    let firstTimedText=-1;for(let i=0;i<lyricData.length;i++){if(lyricData[i].time!==null&&lyricData[i].text.trim()){firstTimedText=i;break}}const lyricHtml=lyricData.map((x,i)=>{const isGap=x.time!==null&&!x.text.trim();const marker=isGap?(i<firstTimedText?'...':'♪'):x.text;return `<div class="lyric-line${isGap?' lyric-gap':''}" data-i="${i}">${escHtml(marker)}</div>`}).join('');
    const body=`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><link rel="icon" href="/web.ico"><title>${escHtml(title)} · Simple Player</title><meta property="og:type" content="music.song"><meta property="og:title" content="${escHtml(title)}"><meta property="og:description" content="${escHtml(description)}"><meta property="og:url" content="${escHtml(pageUrl)}">${cover}<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escHtml(title)}"><meta name="twitter:description" content="${escHtml(description)}"><style>:root{color-scheme:dark}*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}body{background:#141617;color:#e4e6e8;font:14px system-ui,-apple-system,Segoe UI,sans-serif;display:flex;justify-content:center;align-items:center;padding:10px}.card{width:min(760px,100%);height:min(96vh,760px);background:#181a1c;border:1px solid #2b3034;border-radius:12px;overflow:hidden;box-shadow:0 12px 40px #0006;display:flex;flex-direction:column}.top{flex:0 0 auto;display:grid;grid-template-columns:150px 1fr;gap:18px;align-items:center;padding:18px 20px 10px}.cover{width:150px;height:150px;border-radius:7px;background:#25292c center/cover no-repeat;display:grid;place-items:center;font-size:42px;color:#62686e}.info{text-align:left;min-width:0}.title{font-size:21px;font-weight:700;overflow-wrap:anywhere}.sub{margin-top:6px;color:#858b91;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.player{display:grid;grid-template-columns:42px minmax(0,1fr);grid-template-rows:34px;gap:10px;align-items:center;padding:7px 20px 8px;background:#151719;border-top:1px solid #252a2e;border-bottom:1px solid #252a2e}.player audio{display:none}.controls{display:flex;justify-content:center;align-items:center}.play-btn{width:31px;height:31px;border:0;border-radius:50%;background:#e4e6e8;color:#181a1c;cursor:pointer;display:grid;place-items:center;padding:0}.play-btn::before{content:'';display:block;width:0;height:0;border-top:5px solid transparent;border-bottom:5px solid transparent;border-left:7px solid currentColor;margin-left:2px}.play-btn.is-playing::before{width:9px;height:11px;border:0;background:linear-gradient(to right,currentColor 0 3px,transparent 3px 6px,currentColor 6px 9px);box-shadow:none;margin-left:0}.progress{min-width:0;display:grid;grid-template-columns:34px 1fr 34px;align-items:center;gap:7px;color:#858b91;font:9px/1 monospace}.progress input{width:100%;margin:0;accent-color:#e4e6e8}.progress input{appearance:none;-webkit-appearance:none;background:transparent;cursor:pointer}.progress input::-webkit-slider-runnable-track{height:3px;border-radius:3px;background:linear-gradient(to right,#e4e6e8 0%,#e4e6e8 var(--range-progress,0%),#383d41 var(--range-progress,0%),#383d41 100%)}.progress input::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;width:9px;height:9px;margin-top:-3px;border-radius:50%;border:0;background:#e4e6e8}.progress input::-moz-range-track{height:3px;border-radius:3px;background:#383d41}.progress input::-moz-range-progress{height:3px;border-radius:3px;background:#e4e6e8}.progress input::-moz-range-thumb{width:9px;height:9px;border:0;border-radius:50%;background:#e4e6e8}.spectrum{height:58px;flex:0 0 58px;padding:5px 20px 4px;background:#151719;border-bottom:1px solid #252a2e}.spectrum canvas{display:block;width:100%;height:100%}.links{text-align:center;padding:0 20px 8px}.links a{color:#bfc3c6;text-decoration:none}.download-link{display:inline-flex;align-items:center;justify-content:center;min-height:32px;padding:0 14px;border:1px solid #363b3f;border-radius:6px;background:#23272a;color:#e4e6e8!important;font-size:12px}.download-link:hover{background:#2b3034}.lyrics{min-height:0;flex:1;border-top:1px solid #2b3034;padding:10px 20px 14px;display:flex;flex-direction:column}.lyrics h2{flex:0 0 auto;margin:0 0 5px;font-size:11px;color:#858b91;letter-spacing:.08em;text-align:center}.lyrics-box{min-height:0;flex:1;overflow-y:auto;scrollbar-width:thin;padding:4px 8px}.lyric-line{text-align:center;line-height:1.45;padding:3px 8px;color:#73797e;transition:color .12s,transform .12s,font-size .12s}.lyric-line.active{color:#fff;font-weight:700;font-size:1.08em}.empty{color:#62686e;text-align:center;padding-top:10px}.unsynced .lyric-line{color:#aeb3b7}@media(max-width:520px){body{padding:0}.card{width:100%;height:100%;border:0;border-radius:0}.top{grid-template-columns:96px 1fr;gap:12px;padding:12px 14px 6px}.cover{width:96px;height:96px;border-radius:6px}.title{font-size:17px}.sub{font-size:12px}.player{grid-template-columns:38px minmax(0,1fr);grid-template-rows:30px;padding:5px 14px 6px;gap:2px 8px}.controls{grid-column:1;grid-row:1}.play-btn{width:30px;height:30px}.progress{grid-column:2;grid-row:1;grid-template-columns:34px 1fr 34px;height:22px}.spectrum{height:48px;flex-basis:48px;padding:4px 10px 3px}.links{padding:0 14px 6px;font-size:12px}.lyrics{padding:8px 10px 10px}.lyrics-box{padding:2px 4px}.lyric-line{padding:2px 5px;line-height:1.35}.lyric-line.active{font-size:1.04em}}@media(max-height:520px){.top{grid-template-columns:72px 1fr;padding:6px 12px 3px}.cover{width:72px;height:72px}.title{font-size:15px}.player{padding:2px 12px}.lyrics{padding-top:4px}}</style></head><body><main class="card"><div class="top"><div class="cover"${meta.hasCover?` style="background-image:url('${escHtml(coverUrl)}')"`:''}>${meta.hasCover?'':'♪'}</div><div class="info"><div class="title">${escHtml(title)}</div><div class="sub">${escHtml([artist,album].filter(Boolean).join(' · '))}</div></div></div><div class="player"><audio id="audio" crossorigin="anonymous" preload="metadata" src="${escHtml(streamUrl)}"></audio><div class="controls"><button id="play" class="play-btn" type="button" aria-label="播放/暫停"></button></div><div class="progress"><span id="cur">0:00</span><input id="seek" type="range" min="0" max="1000" value="0" aria-label="播放進度"><span id="dur">0:00</span></div></div><div class="spectrum"><canvas id="spectrum" aria-label="音頻頻譜可視化"></canvas></div><div class="links"><a class="download-link" href="${escHtml(directUrl)}" download>↓ 下載歌曲</a></div><section class="lyrics ${syncedLyrics?'synced':'unsynced'}"><h2>${syncedLyrics?'SYNCED LYRICS':'LYRICS'}</h2><div id="lyricsBox" class="lyrics-box">${lyricHtml||'<div class="empty">沒有內嵌歌詞</div>'}</div></section></main><script>const audio=document.getElementById('audio'),box=document.getElementById('lyricsBox'),playBtn=document.getElementById('play'),seek=document.getElementById('seek'),cur=document.getElementById('cur'),dur=document.getElementById('dur'),canvas=document.getElementById('spectrum'),lyrics=${lyricJson};const mediaTitle=${JSON.stringify(title)},mediaArtist=${JSON.stringify(artist)},mediaAlbum=${JSON.stringify(album)},mediaCover=${meta.hasCover?JSON.stringify(coverUrl):'null'};function setupMediaSession(){if(!('mediaSession' in navigator))return;try{navigator.mediaSession.metadata=new MediaMetadata({title:mediaTitle,artist:mediaArtist,album:mediaAlbum,artwork:mediaCover?[{src:mediaCover,type:'image/jpeg',sizes:'512x512'}]:[]})}catch(e){console.warn('Media Session metadata failed:',e)}const actions={play:()=>audio.play(),pause:()=>audio.pause(),seekbackward:()=>{audio.currentTime=Math.max(0,audio.currentTime-10)},seekforward:()=>{audio.currentTime=Math.min(audio.duration||Infinity,audio.currentTime+10)}};for(const [action,handler] of Object.entries(actions)){try{navigator.mediaSession.setActionHandler(action,handler)}catch(e){}}}function syncMediaSession(){if(!('mediaSession' in navigator))return;navigator.mediaSession.playbackState=audio.paused?'paused':'playing';if(Number.isFinite(audio.duration)&&audio.duration>0&&'setPositionState' in navigator.mediaSession){try{navigator.mediaSession.setPositionState({duration:audio.duration,playbackRate:audio.playbackRate||1,position:Math.min(audio.currentTime,audio.duration)})}catch(e){}}}setupMediaSession();const lines=[...document.querySelectorAll('.lyric-line')];let active=-1;function fmt(s){s=Number(s)||0;const m=Math.floor(s/60),sec=Math.floor(s%60);return m+':'+String(sec).padStart(2,'0')}function range(el,p){el.style.setProperty('--range-progress',Math.max(0,Math.min(100,p))+'%')}function setPlay(){playBtn.classList.toggle('is-playing',!audio.paused);playBtn.setAttribute('aria-label',audio.paused?'播放':'暫停')}playBtn.onclick=()=>audio.paused?audio.play():audio.pause();audio.onplay=()=>{setPlay();syncMediaSession()};audio.onpause=()=>{setPlay();syncMediaSession()};audio.onended=()=>{setPlay();syncMediaSession()};audio.volume=.9;seek.oninput=()=>{if(audio.duration){audio.currentTime=audio.duration*(Number(seek.value)/1000);range(seek,Number(seek.value)/10)}};audio.ontimeupdate=()=>{const d=audio.duration||0,p=d?audio.currentTime/d*100:0;cur.textContent=fmt(audio.currentTime);dur.textContent=fmt(d);seek.value=d?Math.round(p*10):0;range(seek,p);sync(audio.currentTime);syncMediaSession()};audio.onloadedmetadata=()=>{dur.textContent=fmt(audio.duration);range(seek,0);syncMediaSession()};audio.onratechange=syncMediaSession;range(seek,0);let audioCtx=null,analyser=null,sourceNode=null,raf=0;function startSpectrum(){if(audioCtx)return;try{audioCtx=new (window.AudioContext||window.webkitAudioContext)();analyser=audioCtx.createAnalyser();analyser.fftSize=128;analyser.smoothingTimeConstant=.82;sourceNode=audioCtx.createMediaElementSource(audio);sourceNode.connect(analyser);analyser.connect(audioCtx.destination);drawSpectrum();}catch(e){console.warn('Spectrum unavailable',e)}}function drawSpectrum(){if(!analyser||!canvas)return;const c=canvas.getContext('2d'),dpr=Math.min(window.devicePixelRatio||1,2),w=canvas.clientWidth,h=canvas.clientHeight;canvas.width=Math.max(1,Math.floor(w*dpr));canvas.height=Math.max(1,Math.floor(h*dpr));c.setTransform(dpr,0,0,dpr,0,0);const data=new Uint8Array(analyser.frequencyBinCount);const bars=48;const gap=2;function frame(){raf=requestAnimationFrame(frame);analyser.getByteFrequencyData(data);c.clearRect(0,0,w,h);const bw=Math.max(1,(w-(bars-1)*gap)/bars);for(let i=0;i<bars;i++){const idx=Math.floor(i/bars*data.length);const v=data[idx]/255;const bh=Math.max(2,v*(h-4));const x=i*(bw+gap);const y=h-bh;c.fillStyle='rgba(228,230,232,'+(0.22+v*.68)+')';c.fillRect(x,y,bw,bh)}}frame()}playBtn.addEventListener('click',()=>{if(!audio.paused){return}startSpectrum();if(audioCtx?.state==='suspended')audioCtx.resume();});audio.addEventListener('play',()=>{startSpectrum();if(audioCtx?.state==='suspended')audioCtx.resume()});window.addEventListener('resize',()=>{if(analyser)drawSpectrum()});function sync(t){if(!lines.length||!lyrics.some(x=>Number.isFinite(x.time)))return;let i=-1;for(let n=0;n<lyrics.length;n++){if(Number.isFinite(lyrics[n].time)&&lyrics[n].time<=t)i=n;else if(Number.isFinite(lyrics[n].time)&&lyrics[n].time>t)break}if(i===active)return;active=i;lines.forEach((el,n)=>el.classList.toggle('active',n===i));if(i>=0&&lyrics[i]?.text.trim()&&lines[i])lines[i].scrollIntoView({behavior:'auto',block:'center'});}audio.addEventListener('seeked',()=>sync(audio.currentTime));let lyricFrame=0;function startLyricSync(){if(lyricFrame)return;const tick=()=>{lyricFrame=requestAnimationFrame(tick);if(!audio.paused&&lyrics.length)sync(audio.currentTime)};lyricFrame=requestAnimationFrame(tick)}startLyricSync();</script></body></html>`;
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(body);
  }
  const direct=p.match(/^\/d\/([^/]+)$/);if(direct&&['GET','HEAD'].includes(req.method)){scanLibrary();const id=decodeURIComponent(direct[1]);const t=cachedTracks.find(x=>x.id===id);if(!t)return res.writeHead(404).end();const meta=readMetadataCache(t)||await readMetadata(t)||{};const title=String(meta.title||t.name||'download').replace(/[\\/:*?"<>|]/g,'_').trim()||'download';if(t.ext==='.m4a')return streamM4aAsFlac(req,res,t,'attachment',title+'.flac');return streamFile(req,res,safePath(t.path),null,'attachment',title+(t.ext||''));}
  const sp=p.match(/^\/stream\/([^/]+)$/);if(sp&&['GET','HEAD'].includes(req.method)){scanLibrary();const id=decodeURIComponent(sp[1]);const t=cachedTracks.find(x=>x.id===id);if(!t)return res.writeHead(404).end();const file=safePath(t.path);if(t.ext==='.m4a'){return streamM4aAsFlac(req,res,t);}return streamFile(req,res,file);}
  const ap=p.match(/^\/audio\/(.+)$/);if(ap&&['GET','HEAD'].includes(req.method)){const rel=decodeURIComponent(ap[1]),file=safePath(rel);if(!file)return res.writeHead(403).end();return streamFile(req,res,file);}
  if(req.socket.localPort===MOBILE_PORT)return json(res,404,{error:'Not found'});
  let rel=p==='/'?'index.html':p.slice(1);rel=decodeURIComponent(rel);const file=path.resolve(PUBLIC_DIR,rel);if(file!==PUBLIC_DIR&&!file.startsWith(PUBLIC_DIR+path.sep))return res.writeHead(403).end();let st;try{st=fs.statSync(file)}catch{return res.writeHead(404).end();}const ext=path.extname(file).toLowerCase();const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.svg':'image/svg+xml','.ico':'image/x-icon','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json'}[ext]||'application/octet-stream';res.writeHead(200,{'Content-Type':mime,'Cache-Control':ext==='.html'||ext==='.js'||ext==='.css'?'no-cache':'public,max-age=86400'});if(req.method==='HEAD')return res.end();fs.createReadStream(file).pipe(res);
}catch(e){console.error(e);json(res,500,{error:'Server error'});}};
function printStatus(){const nets=os.networkInterfaces(),ips=[];for(const xs of Object.values(nets))for(const x of(xs||[]))if(x.family==='IPv4'&&!x.internal)ips.push(x.address);console.log('Simple Player');console.log(`Music dir: ${MUSIC_DIR}`);console.log(`Cache dir: ${CACHE_DIR}`);console.log(`Local: http://localhost:${PORT}`);console.log(`Public origin: ${PUBLIC_ORIGIN || '(not set — share pages use the request host)'}`);console.log(`Tracks: ${cachedTracks.length}`);if(!fs.existsSync(MUSIC_DIR))console.warn('Music files does not exist.');for(const ip of ips)console.log(`LAN: http://${ip}:${PORT}`);}
const server=http.createServer(handleRequest);
setInterval(()=>{if(customLists)pruneCustomLists();},60*60*1000).unref();
const mobileServer=http.createServer(handleRequest);
(async()=>{
  try{
    const result=await scanLibraryChanges();
    console.log(`Initial scan: ${result.tracks.length} tracks (${result.added} added, ${result.changed} changed, ${result.removed} removed)`);
  }catch(e){console.error('Initial scan failed:',e.message)}
  server.listen(PORT,'0.0.0.0',()=>{printStatus();console.log(`Mobile API: http://localhost:${MOBILE_PORT}`);});
  mobileServer.listen(MOBILE_PORT,'0.0.0.0',()=>console.log(`Mobile API listening on 0.0.0.0:${MOBILE_PORT}`));
})();