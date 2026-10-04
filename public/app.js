const $=s=>document.querySelector(s);
const audio=$('#audio');
let spectrumCtx=null,spectrumAnalyser=null,spectrumSource=null,spectrumFrame=0;
let library=[],playlists={},view='Library',filtered=[],currentId=null,currentLyrics=[],activeLyric=-1;
const STORAGE_KEY='simplePlayer.settings.v1';
let savedSettings={};
try{savedSettings=JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}')||{}}catch(e){savedSettings={}}
const saveSettings=()=>{try{localStorage.setItem(STORAGE_KEY,JSON.stringify(savedSettings))}catch(e){}};
const savePosition=()=>{if(!currentId||!Number.isFinite(audio.currentTime))return;savedSettings.positionTrackId=currentId;savedSettings.position=audio.currentTime;saveSettings()};

/* Discord OAuth2 / local session */
const DISCORD_CLIENT_ID='1552923544420225046';
const DISCORD_REDIRECT_URI=window.location.origin+'/';
const DISCORD_SCOPE='identify';
const DISCORD_OAUTH_STORAGE='simplePlayer.discord.oauth.v1';
const DISCORD_PKCE_KEY='simplePlayer.discord.pkce.v1';
function b64url(bytes){let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
function randomBytes(n=32){const b=new Uint8Array(n);crypto.getRandomValues(b);return b}
async function sha256Base64Url(text){const data=new TextEncoder().encode(text);return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256',data)))}
let discordOAuth=null;
const discordDbPromise=new Promise((resolve,reject)=>{const req=indexedDB.open('simple-player-discord',1);req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains('oauth'))req.result.createObjectStore('oauth');};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
async function discordStoreGet(){const db=await discordDbPromise;return await new Promise((resolve,reject)=>{const tx=db.transaction('oauth','readonly');const r=tx.objectStore('oauth').get('session');r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>reject(r.error);});}
async function discordStoreSet(v){const db=await discordDbPromise;return await new Promise((resolve,reject)=>{const tx=db.transaction('oauth','readwrite');tx.objectStore('oauth').put(v,'session');tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}
async function discordStoreClear(){const db=await discordDbPromise;return await new Promise((resolve,reject)=>{const tx=db.transaction('oauth','readwrite');tx.objectStore('oauth').delete('session');tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}
async function loadDiscordOAuth(){try{discordOAuth=await discordStoreGet()}catch{discordOAuth=null}return discordOAuth}
async function saveDiscordOAuth(){if(discordOAuth)await discordStoreSet(discordOAuth);else await discordStoreClear()}
async function updateDiscordUI(){const btn=$('#discordBtn'),status=$('#discordStatus'),account=$('#discordAccount'),login=$('#discordLogin'),logout=$('#discordLogout');if(!btn||!status)return;const d=await loadDiscordOAuth();const connected=!!d?.accessToken;btn.querySelector('.discord-check')?.toggleAttribute('hidden',!connected);btn.title=connected?'Discord 已連結':'連結 Discord';btn.setAttribute('aria-label',btn.title);status.textContent=connected?'已連結 Discord':'尚未連結 Discord';if(account){account.hidden=!connected;account.textContent=connected&&d.user?`${d.user.global_name||d.user.username||'Discord 使用者'}${d.user.username&&d.user.global_name?` · @${d.user.username}`:''}`:''}if(login)login.hidden=connected;if(logout)logout.hidden=!connected}
async function discordFetchUser(accessToken){const r=await fetch('https://discord.com/api/v10/users/@me',{headers:{Authorization:'Bearer '+accessToken}});if(!r.ok){let detail='';try{detail=await r.text()}catch{}throw new Error('Discord 使用者資料取得失敗'+(detail?'：'+detail:''));}return r.json()}
async function discordRefresh(){const d=await loadDiscordOAuth();if(!d?.refreshToken)throw new Error('沒有 Discord refresh token');const r=await fetch('/api/discord/refresh',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({refresh_token:d.refreshToken})});if(!r.ok){let detail='';try{detail=await r.text()}catch{}throw new Error('Discord token refresh 失敗'+(detail?'：'+detail:''));}const t=await r.json();discordOAuth={...d,accessToken:t.access_token,refreshToken:t.refresh_token||d.refreshToken,expiresAt:Date.now()+Number(t.expires_in||604800)*1000,scope:t.scope||d.scope};await saveDiscordOAuth();return discordOAuth}
async function discordGetAccessToken(){const d=await loadDiscordOAuth();if(!d?.accessToken)return null;if(Number(d.expiresAt||0)-Date.now()<86400000){try{return(await discordRefresh()).accessToken}catch{discordOAuth=null;await saveDiscordOAuth();return null}}return d.accessToken}
async function discordLogin(){const state=b64url(randomBytes(24));const verifier=b64url(randomBytes(64));const challenge=await sha256Base64Url(verifier);await discordStoreSet({pending:{state,verifier,createdAt:Date.now()}});const q=new URLSearchParams({client_id:DISCORD_CLIENT_ID,response_type:'code',redirect_uri:DISCORD_REDIRECT_URI,scope:DISCORD_SCOPE,state,code_challenge:challenge,code_challenge_method:'S256'});window.location.href='https://discord.com/oauth2/authorize?'+q.toString()}
async function discordHandleCallback(){const u=new URL(location.href),code=u.searchParams.get('code'),state=u.searchParams.get('state'),error=u.searchParams.get('error');if(!code&&!error)return;if(error){history.replaceState({},'',u.pathname);throw new Error('Discord 授權取消：'+error)}const stored=await discordStoreGet(),pk=stored?.pending;if(!pk||pk.state!==state||!pk.verifier)throw new Error('Discord OAuth state 驗證失敗');const r=await fetch('/api/discord/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,code_verifier:pk.verifier})});await discordStoreSet({pending:null});history.replaceState({},'',u.pathname);if(!r.ok){let detail='';try{detail=await r.text()}catch{}throw new Error('Discord token exchange 失敗'+(detail?'：'+detail:''));}const t=await r.json(),user=await discordFetchUser(t.access_token);discordOAuth={accessToken:t.access_token,refreshToken:t.refresh_token||null,expiresAt:Date.now()+Number(t.expires_in||604800)*1000,scope:t.scope||DISCORD_SCOPE,user:{id:user.id,username:user.username,global_name:user.global_name,avatar:user.avatar}};await saveDiscordOAuth();await updateDiscordUI();openDiscordPicker()}
function openDiscordPicker(){const o=$('#discordOverlay');if(!o)return;o.hidden=false;requestAnimationFrame(()=>o.classList.add('is-open'));document.body.classList.add('sheet-open');updateDiscordUI()}
function closeDiscordPicker(){const o=$('#discordOverlay');if(!o)return;o.classList.remove('is-open');document.body.classList.remove('sheet-open');setTimeout(()=>{if(!o.classList.contains('is-open'))o.hidden=true},280)}
async function discordLogout(){const d=await loadDiscordOAuth();try{if(d?.accessToken)await fetch('/api/discord/revoke',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:d.accessToken,token_type_hint:'access_token'})})}finally{discordOAuth=null;await discordStoreClear();await updateDiscordUI()}}
let presenceSessionId='';
try{presenceSessionId=sessionStorage.getItem('simplePlayer.discord.presenceSession')||'';if(!presenceSessionId){presenceSessionId=crypto.randomUUID();sessionStorage.setItem('simplePlayer.discord.presenceSession',presenceSessionId)}}catch{presenceSessionId=crypto.randomUUID()}
let presenceHeartbeat=null,presenceLastSentAt=0,presenceLastKey='';
function buildPresenceState(){const t=library.find(x=>x.id===currentId)||null;const coverUrl=t?.id&&t?.hasCover?new URL('/api/track/'+encodeURIComponent(t.id)+'/cover',window.location.origin).href:'';return{version:3,sessionId:presenceSessionId,state:!t||!audio.src?'STOPPED':audio.ended?'STOPPED':audio.paused?'PAUSED':'PLAYING',trackId:t?.id||null,title:t?.title||t?.name||'',artist:t?.artist||'',album:t?.album||'',position:Number.isFinite(audio.currentTime)?audio.currentTime:0,duration:Number.isFinite(audio.duration)?audio.duration:0,coverUrl,updatedAt:Date.now()}}
async function postPresence(state,keepalive=false){try{const body=new URLSearchParams({state:JSON.stringify(state)});const r=await fetch('/api/discord/presence',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body,keepalive});if(!r.ok&&r.status!==409){let d='';try{d=await r.text()}catch{}console.warn('Discord Presence 更新失敗:',r.status,d)}}catch(e){if(!keepalive)console.warn('Discord Presence 連線失敗:',e)}}
function emitPresenceState(reason='heartbeat',force=false){const state=buildPresenceState();state.reason=reason;const key=`${state.state}|${state.trackId||''}|${Math.floor(state.position)}|${Math.floor(state.duration)}`;if(reason==='heartbeat'){window.dispatchEvent(new CustomEvent('simpleplayer:presence',{detail:state}));postPresence(state,false);return state;}if(!force&&key===presenceLastKey&&Date.now()-presenceLastSentAt<1200)return state;presenceLastKey=key;presenceLastSentAt=Date.now();window.dispatchEvent(new CustomEvent('simpleplayer:presence',{detail:state}));postPresence(state,reason==='closed');return state}
function startPresenceSync(){if(presenceHeartbeat)return;const immediate=()=>emitPresenceState('event',true);['play','playing','pause','seeked','loadedmetadata','durationchange','ended','emptied','error'].forEach(ev=>audio.addEventListener(ev,immediate));audio.addEventListener('timeupdate',()=>{syncProgressUI();if(!audio.paused&&currentLyrics.length)updateLyric();});window.addEventListener('pagehide',()=>emitPresenceState('closed',true));window.addEventListener('beforeunload',()=>emitPresenceState('closed',true));presenceHeartbeat=setInterval(()=>emitPresenceState('heartbeat'),5000);setTimeout(()=>emitPresenceState('initial',true),300);}

const fmt=s=>{if(!Number.isFinite(s))return '0:00';s=Math.max(0,Math.floor(s));return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`};
const size=n=>n<1048576?(n/1024).toFixed(0)+' KB':(n/1048576).toFixed(1)+' MB';
async function api(url,opt){const r=await fetch(url,opt);if(!r.ok)throw Error(await r.text());return r.json()}
async function load(){const[l,p]=await Promise.all([api('/api/library'),api('/api/playlists')]);library=l.tracks;playlists=p;$('#libraryCount').textContent=library.length;renderFolders();selectView(savedSettings.view||view);restoreLastTrack()}
async function refreshLibrary(){
  const btn=$('#refreshBtn');
  if(btn){btn.disabled=true;btn.textContent='⟳';btn.title='重新掃描中…'}
  try{
    const result=await api('/api/scan',{method:'POST'});
    await load();
    $('#countLine').textContent=`${library.length} tracks · +${result.added||0} / ~${result.changed||0} / -${result.removed||0}`;
  }finally{
    if(btn){btn.disabled=false;btn.textContent='↻';btn.title='重新掃描'}
  }
}
function renderFolders(){const items=[['Library','全部歌曲',library.length],...Object.entries(playlists).map(([name,tracks])=>[name,name,tracks.length])];const box=$('#playlistList');box.innerHTML='';for(const[name,label,count] of items.slice(1)){const b=document.createElement('div');b.className='playlist-item'+(view===name?' active':'');b.innerHTML=`<button class="playlist-label" type="button"> <span>${esc(label)}</span><span class="pl-count">${count}</span></button><button class="playlist-share-inline" type="button" title="分享歌單「${esc(label)}」" aria-label="分享歌單「${esc(label)}」">↗</button>`;b.querySelector('.playlist-label').onclick=()=>selectView(name);b.querySelector('.playlist-share-inline').onclick=e=>{e.stopPropagation();copyPlaylistShareLink(name,e.currentTarget)};box.appendChild(b)}document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===view));renderMobilePlaylists(items)}
function renderMobilePlaylists(items){const box=$('#mobilePlaylistList');if(!box)return;box.innerHTML='';for(const[name,label,count] of items){if(name==='Library'){const b=document.createElement('button');b.className='playlist-item'+(view===name?' active':'');b.innerHTML=`<span>${esc(label)}</span><span class="pl-count">${count}</span>`;b.onclick=()=>{selectView(name);closePlaylistPicker()};box.appendChild(b);continue}const b=document.createElement('div');b.className='playlist-item'+(view===name?' active':'');b.innerHTML=`<button class="playlist-label" type="button"><span>${esc(label)}</span><span class="pl-count">${count}</span></button><button class="playlist-share-inline" type="button" title="分享歌單「${esc(label)}」" aria-label="分享歌單「${esc(label)}」">↗</button>`;b.querySelector('.playlist-label').onclick=()=>{selectView(name);closePlaylistPicker()};b.querySelector('.playlist-share-inline').onclick=e=>{e.stopPropagation();copyPlaylistShareLink(name,e.currentTarget)};box.appendChild(b)}}
function openPlaylistPicker(){const o=$('#playlistOverlay');if(!o)return;o.hidden=false;$('#mobilePlaylistBtn').setAttribute('aria-expanded','true');document.body.classList.add('sheet-open');requestAnimationFrame(()=>o.classList.add('is-open'))}
function closePlaylistPicker(){const o=$('#playlistOverlay');if(!o)return;o.classList.remove('is-open');$('#mobilePlaylistBtn').setAttribute('aria-expanded','false');document.body.classList.remove('sheet-open');setTimeout(()=>{if(!o.classList.contains('is-open'))o.hidden=true},280)}
function selectView(name){view=name;savedSettings.view=name;saveSettings();const label=name==='Library'?'全部歌曲':name;$('#currentName').textContent=label;const shareBtn=$('#sharePlaylistBtn');if(shareBtn){shareBtn.hidden=name==='Library';shareBtn.title=name==='Library'?'分享這個歌單':`分享歌單「${name}」`;shareBtn.setAttribute('aria-label',shareBtn.title)}const mobileLabel=$('#mobilePlaylistBtn .mobile-playlist-label');if(mobileLabel)mobileLabel.textContent=label;let ids;if(name==='Library')ids=null;else ids=new Set(playlists[name]||[]);filtered=library.filter(t=>!ids||ids.has(t.id));renderRows($('#search').value);renderFolders()}
function renderRows(q=''){q=q.trim().toLowerCase();const rows=filtered.filter(t=>!q||`${t.title||''} ${t.artist||''} ${t.album||''} ${t.name} ${t.path}`.toLowerCase().includes(q));$('#countLine').textContent=`${rows.length} ${rows.length===1?'track':'tracks'}`;const body=$('#trackBody');body.innerHTML='';$('#empty').hidden=rows.length>0;rows.forEach((t,i)=>{const tr=document.createElement('tr');tr.dataset.id=t.id;tr.innerHTML=`<td class="num"></td><td><div class="songcell"><span class="song-name">${esc(t.title||t.name)}</span><small>${esc(t.artist||t.album||t.folder||'')}</small></div></td><td class="typecol">${esc(t.ext.slice(1).toUpperCase())}</td><td class="sizecol">${size(t.size)}</td><td class="sharecol"><div class="share-actions"><button class="share-btn share-page-btn" type="button" title="複製分享頁面連結" aria-label="複製分享頁面連結">↗</button></div></td>`;
      tr.querySelector('.num').textContent=i+1;
      tr.onclick=()=>playId(t.id,true,true);
      tr.querySelector('.share-page-btn').onclick=e=>{e.stopPropagation();copyShareLink(t.id,e.currentTarget)};
      body.appendChild(tr)});highlightPlaying()}
async function copyPlaylistShareLink(name,button){
  if(!name||name==='Library')return;
  const url=new URL('/p/'+encodeURIComponent(name),window.location.origin).href;
  try{await navigator.clipboard.writeText(url)}catch{const ta=document.createElement('textarea');ta.value=url;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove()}
  if(button){const old=button.textContent;button.textContent='✓';button.classList.add('copied');setTimeout(()=>{button.textContent=old;button.classList.remove('copied')},1200)}
}
async function copyShareLink(id,button){
  const url=new URL('/s/'+encodeURIComponent(id),window.location.origin).href;
  try{
    await navigator.clipboard.writeText(url);
  }catch{
    const ta=document.createElement('textarea');ta.value=url;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();
  }
  const old=button.textContent;button.textContent='✓';button.classList.add('copied');
  setTimeout(()=>{button.textContent=old;button.classList.remove('copied')},1200);
}
function highlightPlaying(){document.querySelectorAll('.tracks tr.playing').forEach(x=>x.classList.remove('playing'));if(currentId){const tr=document.querySelector(`tr[data-id="${CSS.escape(currentId)}"]`);if(tr)tr.classList.add('playing')}}
const DEFAULT_COVER_URL=new URL('/default-cover.png',window.location.origin).href;
function releaseCover(el){
  if(!el)return;
  const old=el.querySelector('img.cover-art');
  if(old)old.remove();
}
function setCoverFallback(el){
  if(!el)return;
  releaseCover(el);
  el.classList.add('has-image');
  el.style.backgroundImage=`url("${DEFAULT_COVER_URL}")`;
  el.dataset.fallback='1';
  if(!el.querySelector('span'))el.innerHTML='<span>♪</span>';
}
function applyMetadataCover(el,t){
  if(!el)return;
  setCoverFallback(el);
  if(!t?.id||t.hasCover===false)return;
  const url=t.coverUrl||('/api/track/'+encodeURIComponent(t.id)+'/cover?v='+encodeURIComponent(t.mtime||Date.now()));
  const img=document.createElement('img');
  img.className='cover-art';
  img.alt='';
  img.decoding='async';
  img.loading='eager';
  img.onload=()=>{
    const old=el.querySelector('img.cover-art');
    if(old&&old!==img)old.remove();
    el.innerHTML='';
    el.appendChild(img);
    el.style.backgroundImage='none';
    delete el.dataset.fallback;
  };
  img.onerror=()=>{img.remove();setCoverFallback(el)};
  img.src=url;
}

function updateMediaSession(t,meta=null){
  if(!('mediaSession' in navigator))return;
  const title=meta?.title||t.title||t.name||'Unknown',artist=meta?.artist||t.artist||'',album=meta?.album||t.album||t.folder||'';
  const coverSrc=(meta?.hasCover??t.hasCover)?new URL('/api/track/'+encodeURIComponent(t.id)+'/cover',window.location.origin).href:DEFAULT_COVER_URL;
  const artwork=[256,512].map(size=>({src:coverSrc,sizes:`${size}x${size}`,type:(meta?.coverFormat||'image/jpeg')}));
  try{navigator.mediaSession.metadata=new MediaMetadata({title,artist,album,artwork})}catch(e){console.warn('Media Session metadata failed:',e)}
}
function setupMediaSession(){
  if(!('mediaSession' in navigator))return;
  const actions={
    play:()=>audio.play(),pause:()=>audio.pause(),
    previoustrack:()=>playRelative(-1),nexttrack:()=>playRelative(1),
    seekbackward:()=>{audio.currentTime=Math.max(0,audio.currentTime-10)},
    seekforward:()=>{audio.currentTime=Math.min(audio.duration||Infinity,audio.currentTime+10)},
    seekto:details=>{if(details.fastSeek&&'fastSeek' in audio)audio.fastSeek(details.seekTime);else audio.currentTime=details.seekTime}
  };
  for(const [action,handler] of Object.entries(actions)){try{navigator.mediaSession.setActionHandler(action,handler)}catch(e){}}
}
function syncMediaSession(){
  if(!('mediaSession' in navigator))return;
  navigator.mediaSession.playbackState=audio.paused?'paused':'playing';
  if(Number.isFinite(audio.duration)&&audio.duration>0&&'setPositionState' in navigator.mediaSession){
    try{navigator.mediaSession.setPositionState({duration:audio.duration,playbackRate:audio.playbackRate||1,position:Math.min(audio.currentTime,audio.duration)})}catch(e){}
  }
}
function playId(id,autoPlay=true,autoExpand=false){const t=library.find(x=>x.id===id);if(!t)return;if(currentId&&currentId!==id)savePosition();currentId=id;lastSavedPosition=0;savedSettings.currentId=id;saveSettings();currentLyrics=[];activeLyric=-1;$('#lyrics').innerHTML='<div class="lyrics-loading">讀取內嵌歌詞…</div>';audio.src='/stream/'+encodeURIComponent(t.id);syncProgressUI();if(autoPlay)audio.play().catch(err=>{console.warn('Audio play failed:',err);$('#nowArtist').textContent='無法播放此音訊格式或串流';});setNow(t);if(autoExpand&&window.matchMedia('(max-width:900px)').matches)requestAnimationFrame(()=>openNowPlaying());updateMediaSession(t);api('/api/track/'+encodeURIComponent(t.id)+'/metadata').then(meta=>{if(currentId===t.id){const merged={...t,...meta};applyMetadataCover($('#cover'),merged);setExpandedNow(merged);updateMediaSession(merged,meta)}}).catch(()=>{});loadLyrics(t.id)}
function restoreLastTrack(){const id=savedSettings.currentId;if(!id||!library.some(t=>t.id===id))return;playId(id,false)}
function setNow(t){$('#nowTitle').textContent=t.title||t.name||'';$('#nowArtist').textContent=t.artist||t.album||t.folder||'';applyMetadataCover($('#cover'),t);setExpandedNow(t);highlightPlaying();syncProgressUI()}
async function loadLyrics(id){try{const data=await api('/api/track/'+encodeURIComponent(id)+'/metadata');if(currentId!==id)return;currentLyrics=data.lyrics||[];renderLyrics();}catch(e){console.error(e);$('#lyrics').innerHTML='<div class="lyrics-empty">無法讀取歌詞</div>';$('#lyricsState').textContent='ERROR'}}
function renderLyrics(){
  const targets=[$('#lyrics'),$('#expandedLyrics')].filter(Boolean);
  if(!currentLyrics.length){
    targets.forEach(box=>box.innerHTML='<div class="lyrics-empty">這首歌沒有可用的內嵌歌詞</div>');
    $('#lyricsState').textContent='NO LYRICS'; return;
  }
  let firstTimedText=-1;
  for(let i=0;i<currentLyrics.length;i++) if(Number.isFinite(currentLyrics[i]?.time)&&String(currentLyrics[i]?.text??'').trim()){firstTimedText=i;break}
  targets.forEach(box=>{
    box.innerHTML='';
    currentLyrics.forEach((line,i)=>{
      const el=document.createElement('div');
      const isGap=Number.isFinite(line.time)&&!String(line.text||'').trim();
      el.className='lyric-line'+(isGap?' lyric-gap':''); el.dataset.i=i;
      if(isGap)el.textContent=i<firstTimedText?'...':'♪'; else el.textContent=line.text||'';
      el.onclick=()=>{if(Number.isFinite(line.time)){audio.currentTime=line.time;updateLyric()}};
      box.appendChild(el);
    });
  });
  $('#lyricsState').textContent=currentLyrics.some(x=>Number.isFinite(x.time))?'SYNCED':'TEXT';
}
function setExpandedNow(t){const title=$('#expandedTitle'),artist=$('#expandedArtist'),cover=$('#expandedCover');if(title)title.textContent=t?.title||t?.name||'尚未播放';if(artist)artist.textContent=t?.artist||t?.album||'';if(cover)setCoverFallback(cover);if(t?.id&&cover)applyMetadataCover(cover,t)}
function syncProgressUI(){const duration=Number.isFinite(audio.duration)&&audio.duration>0?audio.duration:0;const current=Math.max(0,Math.min(duration||Infinity,Number(audio.currentTime)||0));const pct=duration?current/duration*100:0;const seek=$('#seek');if(seek){seek.max=1000;seek.value=Math.round(pct*10);updateRange(seek,pct);seek.setAttribute('aria-valuetext',`${fmt(current)} / ${fmt(duration)}`)}if($('#cur'))$('#cur').textContent=fmt(current);if($('#dur'))$('#dur').textContent=fmt(duration);const eSeek=$('#expandedSeek');if(eSeek){eSeek.max=1000;eSeek.value=Math.round(pct*10);updateRange(eSeek,pct);eSeek.setAttribute('aria-valuetext',`${fmt(current)} / ${fmt(duration)}`)}if($('#expandedCur'))$('#expandedCur').textContent=fmt(current);if($('#expandedDur'))$('#expandedDur').textContent=fmt(duration);const p=$('#expandedPlay');if(p){p.classList.toggle('is-playing',!audio.paused);p.setAttribute('aria-label',audio.paused?'播放':'暫停')}}
function syncExpandedPlayer(){syncProgressUI();const lines=document.querySelectorAll('#expandedLyrics .lyric-line');lines.forEach((el,i)=>el.classList.toggle('active',i===activeLyric))}
function centerExpandedLyric(el,behavior='smooth'){const box=$('#expandedLyrics');if(!box||!el)return;const br=box.getBoundingClientRect(),er=el.getBoundingClientRect();const delta=er.top+er.height/2-(br.top+br.height/2);const maxTop=Math.max(0,box.scrollHeight-box.clientHeight);const target=Math.max(0,Math.min(maxTop,box.scrollTop+delta));box.scrollTo({top:target,behavior})}
function centerActiveExpandedLyric(behavior='auto'){if(activeLyric<0)return;const box=$('#expandedLyrics'),el=box?.querySelector(`.lyric-line[data-i="${activeLyric}"]`);if(el)requestAnimationFrame(()=>centerExpandedLyric(el,behavior))}
function openNowPlaying(){const o=$('#nowPlayingOverlay');if(!o)return;o.hidden=false;o.style.opacity='';const sheet=o.querySelector('.now-sheet');if(sheet)sheet.style.transform='';syncExpandedPlayer();const t=library.find(x=>x.id===currentId);if(t)setExpandedNow(t);requestAnimationFrame(()=>{o.classList.add('is-open');centerActiveExpandedLyric('auto')});startSpectrum()}
function closeNowPlaying(){const o=$('#nowPlayingOverlay');if(!o)return;o.classList.remove('is-open');o.style.opacity='';setTimeout(()=>{if(!o.classList.contains('is-open'))o.hidden=true},320)}
function ensureSpectrum(){
  if(spectrumAnalyser)return true;
  try{
    spectrumCtx=new (window.AudioContext||window.webkitAudioContext)();
    spectrumAnalyser=spectrumCtx.createAnalyser(); spectrumAnalyser.fftSize=128; spectrumAnalyser.smoothingTimeConstant=.82;
    spectrumSource=spectrumCtx.createMediaElementSource(audio); spectrumSource.connect(spectrumAnalyser); spectrumAnalyser.connect(spectrumCtx.destination); return true;
  }catch(e){console.warn('Spectrum unavailable:',e);return false}
}
function startSpectrum(){if(!ensureSpectrum())return;if(spectrumCtx.state==='suspended')spectrumCtx.resume();if(spectrumFrame)return;const canvases=[$('#spectrum'),$('#desktopSpectrum')].filter(Boolean);if(!canvases.length)return;const drawCanvas=(canvas,data)=>{const w=canvas.clientWidth,h=canvas.clientHeight,dpr=window.devicePixelRatio||1;if(!w||!h)return;if(canvas.width!==Math.floor(w*dpr)||canvas.height!==Math.floor(h*dpr)){canvas.width=Math.floor(w*dpr);canvas.height=Math.floor(h*dpr)}const c=canvas.getContext('2d');c.setTransform(dpr,0,0,dpr,0,0);c.clearRect(0,0,w,h);const bars=Math.max(20,Math.min(48,Math.floor(w/9))),gap=2,bw=Math.max(2,(w-gap*(bars-1))/bars),fill=getComputedStyle(document.body).getPropertyValue('--range-fill').trim()||'#aaa';for(let i=0;i<bars;i++){const idx=Math.floor(i*data.length/bars);const v=data[idx]/255;const bh=Math.max(1.5,v*h*.92);c.fillStyle=fill;c.fillRect(i*(bw+gap),h-bh,bw,bh)}};const draw=()=>{spectrumFrame=requestAnimationFrame(draw);const data=new Uint8Array(spectrumAnalyser.frequencyBinCount);spectrumAnalyser.getByteFrequencyData(data);canvases.forEach(canvas=>drawCanvas(canvas,data))};draw()}

function updateLyric(){
  if(!currentLyrics.length)return;
  const t=Number(audio.currentTime);
  if(!Number.isFinite(t))return;
  let i=-1;
  // Only a timed line whose timestamp has actually been reached may become active.
  // Use the timestamp immediately before the current playback position; never
  // carry an active line forward across a future timestamp.
  for(let n=0;n<currentLyrics.length;n++){
    const lt=Number(currentLyrics[n]?.time);
    if(!Number.isFinite(lt))continue;
    if(lt<=t)i=n;
    else break;
  }
  const line=i>=0?currentLyrics[i]:null;
  const shouldActivate=!!line&&Number.isFinite(Number(line.time))&&Number(line.time)<=t&&String(line.text??'').trim().length>0;
  const nextActive=shouldActivate?i:-1;
  if(nextActive===activeLyric)return;
  activeLyric=nextActive;
  document.querySelectorAll('.lyric-line.active').forEach(x=>x.classList.remove('active'));
  if(nextActive>=0){
    const els=document.querySelectorAll(`.lyric-line[data-i="${nextActive}"]`);
    els.forEach(el=>el.classList.add('active'));
    const box=$('#expandedLyrics');
    const el=box?.querySelector(`.lyric-line[data-i="${nextActive}"]`);
    if(el&&box)centerExpandedLyric(el,'smooth');
    const desktopBox=$('#lyrics');
    const desktopEl=desktopBox?.querySelector(`.lyric-line[data-i="${nextActive}"]`);
    if(desktopEl)desktopEl.scrollIntoView({block:'center',behavior:'smooth'});
  }
}
function playRelative(dir){const list=filtered.length?filtered:library;if(!list.length)return;let i=list.findIndex(x=>x.id===currentId);if(i<0)i=dir>0?0:list.length-1;else{i+=dir;if(i<0)i=list.length-1;if(i>=list.length)i=0}playId(list[i].id)}
function esc(s=''){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
$('#search').oninput=e=>renderRows(e.target.value);

$('#refreshBtn').onclick=()=>refreshLibrary().catch(e=>{console.error(e);$('#countLine').textContent='重新掃描失敗'});
document.querySelectorAll('.nav-item').forEach(b=>b.onclick=()=>selectView(b.dataset.view));
$('#play').onclick=()=>audio.paused?audio.play():audio.pause();$('#prev').onclick=()=>playRelative(-1);$('#next').onclick=()=>playRelative(1);
audio.volume=Number.isFinite(savedSettings.volume)?Math.max(0,Math.min(1,savedSettings.volume)):.9;$('#volume').value=String(audio.volume);
audio.muted=!!savedSettings.muted;
function updateMuteButton(){const b=$('#mute');if(!b)return;b.classList.toggle('muted',audio.muted);b.setAttribute('aria-label',audio.muted?'取消靜音':'靜音');b.setAttribute('title',audio.muted?'取消靜音':'靜音')}
$('#mute').onclick=()=>{audio.muted=!audio.muted;savedSettings.muted=audio.muted;saveSettings();updateMuteButton()};
function updateRange(el,pct){el.style.setProperty('--range-progress',`${Math.max(0,Math.min(100,pct))}%`)}
let lastSavedPosition=0;
audio.ontimeupdate=()=>{const d=audio.duration||0;const pct=d?audio.currentTime/d*100:0;$('#cur').textContent=fmt(audio.currentTime);$('#dur').textContent=fmt(d);$('#seek').value=d?Math.round(pct*10):0;updateRange($('#seek'),pct);updateLyric();syncExpandedPlayer();syncMediaSession();if(audio.currentTime-lastSavedPosition>=2){lastSavedPosition=audio.currentTime;savePosition()}};
$('#seek').oninput=e=>{const pct=Number(e.target.value)/1000;updateRange(e.target,pct*100);if(audio.duration){audio.currentTime=audio.duration*pct;savePosition()}};
$('#volume').oninput=e=>{audio.volume=Number(e.target.value);audio.muted=false;savedSettings.volume=audio.volume;savedSettings.muted=false;saveSettings();updateMuteButton();updateRange(e.target,audio.volume*100)};
updateRange($('#seek'),0);updateRange($('#volume'),audio.volume*100);updateMuteButton();
audio.onplay=()=>{const b=$('#play');b.classList.add('is-playing');b.setAttribute('aria-label','暫停');syncExpandedPlayer();startSpectrum();syncMediaSession()};audio.onpause=()=>{const b=$('#play');b.classList.remove('is-playing');b.setAttribute('aria-label','播放');syncExpandedPlayer();syncMediaSession()};audio.onloadedmetadata=()=>{syncMediaSession();const pos=savedSettings.positionTrackId===currentId?savedSettings.position:0;if(Number.isFinite(pos)&&pos>0&&pos<audio.duration){audio.currentTime=pos;lastSavedPosition=pos;updateLyric();syncExpandedPlayer()}};audio.onratechange=syncMediaSession;audio.onended=()=>{savePosition();playRelative(1)};
window.addEventListener('beforeunload',savePosition);
document.addEventListener('visibilitychange',()=>{if(document.hidden)savePosition()});
let suppressMiniClick=false;
$('#nowPlaying').onclick=()=>{if(suppressMiniClick){suppressMiniClick=false;return}openNowPlaying()};
$('#nowPlaying').onkeydown=e=>{if(e.key==='Enter'||e.key===' ') {e.preventDefault();openNowPlaying()}};
$('#nowClose').onclick=closeNowPlaying;
// Mini Player swipe up: progressively reveal the full player. No gesture is attached to the playlist sheet.
(function setupMiniSwipe(){
  const mini=$('#nowPlaying'),overlay=$('#nowPlayingOverlay'),sheet=overlay?.querySelector('.now-sheet');
  if(!mini||!overlay||!sheet)return;
  let tracking=false,startY=0,lastY=0,startTime=0,lastTime=0,moved=false;
  mini.addEventListener('pointerdown',e=>{
    if(e.pointerType==='mouse')return;
    tracking=true;moved=false;startY=lastY=e.clientY;startTime=lastTime=performance.now();
    try{mini.setPointerCapture(e.pointerId)}catch{}
  });
  mini.addEventListener('pointermove',e=>{
    if(!tracking)return;
    const dy=e.clientY-startY;
    if(dy>=0){return}
    moved=Math.abs(dy)>4;lastY=e.clientY;lastTime=performance.now();
    const travel=Math.max(110,window.innerHeight*.22);
    const progress=Math.max(0,Math.min(1,-dy/travel));
    overlay.hidden=false;
    overlay.classList.remove('is-open');
    overlay.style.visibility='visible';
    overlay.style.opacity=String(progress);
    sheet.classList.add('is-dragging');
    sheet.style.transform=`translateY(${(1-progress)*100}%)`;
    e.preventDefault();
  });
  const finish=e=>{
    if(!tracking)return;tracking=false;
    const dy=lastY-startY,dt=Math.max(1,lastTime-startTime),velocity=(-dy)/dt;
    const travel=Math.max(110,window.innerHeight*.22),progress=Math.max(0,Math.min(1,-dy/travel));
    sheet.classList.remove('is-dragging');
    if(moved&&(progress>=.68||velocity>=.75)){
      suppressMiniClick=true;
      sheet.style.transform='';overlay.style.opacity='';overlay.style.visibility='';
      syncExpandedPlayer();overlay.classList.add('is-open');
      centerActiveExpandedLyric('auto');startSpectrum();
    }else if(moved){
      suppressMiniClick=true;
      sheet.style.transform='';overlay.style.opacity='';overlay.style.visibility='';
      setTimeout(()=>{if(!overlay.classList.contains('is-open'))overlay.hidden=true},340);
    }
    try{mini.releasePointerCapture(e.pointerId)}catch{}
  };
  mini.addEventListener('pointerup',finish);
  mini.addEventListener('pointercancel',finish);
})();
// Swipe down to shrink the full-screen player. Keep the lyric area free for normal vertical scrolling.
(function setupNowSwipe(){
  const sheet=$('#nowPlayingOverlay .now-sheet');
  if(!sheet)return;
  let tracking=false,startY=0,lastY=0,startTime=0,lastTime=0,moved=false;
  const blocked=el=>el?.closest('#expandedLyrics,button,input,textarea,select,a');
  sheet.addEventListener('pointerdown',e=>{
    if(e.pointerType==='mouse' || blocked(e.target))return;
    tracking=true;moved=false;startY=lastY=e.clientY;startTime=lastTime=performance.now();
    sheet.classList.add('is-dragging');
    try{sheet.setPointerCapture(e.pointerId)}catch{}
  });
  sheet.addEventListener('pointermove',e=>{
    if(!tracking)return;
    const dy=e.clientY-startY;
    if(dy<0){sheet.style.transform='translateY(0)';return;}
    moved=dy>4;lastY=e.clientY;lastTime=performance.now();
    sheet.style.transform=`translateY(${dy}px)`;
  });
  const finish=(e)=>{
    if(!tracking)return; tracking=false;
    const dy=Math.max(0,lastY-startY), dt=Math.max(1,lastTime-startTime), velocity=dy/dt;
    sheet.classList.remove('is-dragging');
    const threshold=Math.max(110,sheet.clientHeight*.22);
    if(moved && (dy>=threshold || velocity>=.75)){
      sheet.style.transform='';
      closeNowPlaying();
    }else{
      sheet.style.transform='';
    }
    try{sheet.releasePointerCapture(e.pointerId)}catch{}
  };
  sheet.addEventListener('pointerup',finish);
  sheet.addEventListener('pointercancel',finish);
})();
$('#expandedPlay').onclick=()=>audio.paused?audio.play():audio.pause();
$('#expandedPrev').onclick=()=>playRelative(-1);$('#expandedNext').onclick=()=>playRelative(1);
$('#expandedSeek').oninput=e=>{if(audio.duration){audio.currentTime=audio.duration*(Number(e.target.value)/1000);savePosition();updateLyric();syncExpandedPlayer()}};
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('#nowPlayingOverlay').hidden)closeNowPlaying()});
let lyricFrame=0;
function startLyricSync(){
  if(lyricFrame)return;
  const tick=()=>{
    lyricFrame=requestAnimationFrame(tick);
    if(!audio.paused && currentLyrics.length) updateLyric();
  };
  lyricFrame=requestAnimationFrame(tick);
}
startLyricSync();
setupMediaSession();
function applyTheme(){const light=!!savedSettings.lightTheme;document.body.classList.toggle('light',light);document.querySelector('meta[name=theme-color]')?.setAttribute('content',light?'#f3f4f6':'#16181a')}
applyTheme();
$('#themeBtn').onclick=()=>{savedSettings.lightTheme=!document.body.classList.contains('light');saveSettings();applyTheme()};
document.addEventListener('keydown',e=>{if(e.key==='/'&&document.activeElement!==$('#search')){e.preventDefault();$('#search').focus()}if(e.code==='Space'&&document.activeElement.tagName!=='INPUT'){e.preventDefault();$('#play').click()}if(e.key==='Escape')closePlaylistPicker()});
$('#mobilePlaylistBtn').onclick=openPlaylistPicker;$('#playlistClose').onclick=closePlaylistPicker;$('#sharePlaylistBtn').onclick=()=>copyPlaylistShareLink(view,$('#sharePlaylistBtn'));$('#playlistOverlay').addEventListener('click',e=>{if(e.target.id==='playlistOverlay')closePlaylistPicker()});
$('#discordBtn').onclick=async()=>{const d=await loadDiscordOAuth();if(d?.accessToken)openDiscordPicker();else discordLogin().catch(e=>{console.error(e);openDiscordPicker();const s=$('#discordStatus');if(s)s.textContent=e.message||'Discord 登入失敗';});};$('#discordClose').onclick=closeDiscordPicker;$('#discordOverlay').addEventListener('click',e=>{if(e.target.id==='discordOverlay')closeDiscordPicker()});$('#discordLogin').onclick=()=>{discordLogin().catch(e=>{console.error(e);alert(e.message||'Discord 登入失敗')})};$('#discordLogout').onclick=()=>discordLogout().catch(e=>alert(e.message||'解除 Discord 失敗'));window.addEventListener('keydown',e=>{if(e.key==='Escape')closeDiscordPicker()});
Promise.resolve().then(()=>discordHandleCallback()).catch(e=>{console.error(e);alert(e.message||'Discord 登入失敗')}).finally(()=>updateDiscordUI());
startPresenceSync();
load().catch(e=>{console.error(e);$('#countLine').textContent='無法載入音樂庫'});