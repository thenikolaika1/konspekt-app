// Запуск (нужен пакет playwright): BASE=http://localhost:8080/ W=390 H=844 node tools/ui-audit.js
// Технический аудит UI: все экраны, DOM + computed styles + консоль + сеть.
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8080/';
const OUT = process.env.OUT || 'ui-audit-screens';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const IMG = ['03-camera.png', '13-note.png', '01-home.png'].map((f) => path.join(ROOT, f));

function inPageAudit(){
  const vw=innerWidth, vh=innerHeight, issues=[];
  const rgb=s=>{const m=s&&s.match(/rgba?\(([^)]+)\)/);if(!m)return null;const p=m[1].split(/[ ,\/]+/).filter(Boolean).map(Number);return {r:p[0],g:p[1],b:p[2],a:p.length>3?p[3]:1}};
  const L=c=>{const f=v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)};return .2126*f(c.r)+.7152*f(c.g)+.0722*f(c.b)};
  const CR=(a,b)=>{const x=L(a),y=L(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
  const bgOf=el=>{for(let e=el;e;e=e.parentElement){const s=getComputedStyle(e);if(s.backgroundImage&&s.backgroundImage!=='none'){const m=s.backgroundImage.match(/rgba?\([^)]+\)/);const c=m&&rgb(m[0]);if(c&&c.a>.5)return c}const c=rgb(s.backgroundColor);if(c&&c.a>.5)return c;if(e.tagName==='IMG')return null}return {r:255,g:255,b:255,a:1}};
  const hidden=el=>{if(el.closest('[inert]'))return 'inert (закрывающийся слой)';for(let e=el;e&&e!==document.documentElement;e=e.parentElement){const s=getComputedStyle(e);if(s.display==='none'||s.visibility==='hidden'||parseFloat(s.opacity)<.1)return (e===el?'':'ancestor ')+(s.display==='none'?'display:none':s.visibility==='hidden'?'visibility:hidden':'opacity:'+s.opacity)}return ''};
  const inHScroll=el=>{for(let e=el.parentElement;e;e=e.parentElement){const o=getComputedStyle(e).overflowX;if(o==='auto'||o==='scroll')return true}return false};
  const name=el=>{let n=el.tagName.toLowerCase();if(el.id)n+='#'+el.id;const cls=(el.getAttribute('class')||'').trim().split(/\s+/).slice(0,2).join('.');if(cls)n+='.'+cls;const d=[...el.attributes].find(a=>a.name.startsWith('data-'));if(d)n+='['+d.name+(d.value?'='+d.value.slice(0,20):'')+']';const t=(el.innerText||el.getAttribute('aria-label')||'').trim().replace(/\s+/g,' ').slice(0,24);return n+(t?' "'+t+'"':'')};
  const INTER='button,input,[data-go],[data-back],[data-note],[data-bookmark],[data-note-menu],[data-bookmark-menu],[data-sheet],[data-camera],[data-gallery],[data-process],[data-retry],[data-start],[data-close],[data-confirm-delete],[data-save-rename],[data-toggle-bm],[data-new-bm-for-note],[data-rename],[data-delete],[data-edit-bm],[data-open-note],[data-icon],[data-color],[data-create-bm],[data-select-page],[data-remove-page],[data-retake],[data-clear-field]';
  const stats={interactive:0,icons:0,texts:0,images:0};
  if(document.querySelectorAll('use').length) issues.push({kind:'svg-use',el:document.querySelectorAll('use').length+' <use> elements'});
  const layer=document.querySelector('#app .overlay');
  document.querySelectorAll('#app '+INTER.split(',').join(',#app ')).forEach(el=>{
    if(el.type==='file')return; if(layer&&!layer.contains(el))return; stats.interactive++;
    const h=hidden(el); const r=el.getBoundingClientRect();
    if(el.closest('[inert]'))return; // закрывающийся лист: не интерактивен по определению
    if(h){ if(el.matches('[data-clear-field]'))return; issues.push({kind:'hidden-control',el:name(el),why:h});return }
    if(r.width<1||r.height<1){issues.push({kind:'zero-size',el:name(el)});return}
    const af=getComputedStyle(el,'::after');let ex=0;if(af.content!=='none'&&af.position==='absolute')ex=Math.max(0,-parseFloat(af.top)||0);
    if(!el.matches('input')&&(r.width+2*ex<24||r.height+2*ex<24))issues.push({kind:'small-target',el:name(el),size:Math.round(r.width)+'x'+Math.round(r.height)});
    if((r.left<-1||r.right>vw+1)&&!inHScroll(el))issues.push({kind:'outside-viewport',el:name(el),x:Math.round(r.left),right:Math.round(r.right)});
    const cx=Math.min(Math.max(r.left+r.width/2,1),vw-1), cy=r.top+r.height/2;
    if(cy>0&&cy<vh&&r.left>=0&&r.right<=vw){const hit=document.elementFromPoint(cx,cy);if(hit&&hit!==el&&!el.contains(hit)&&!hit.contains(el))issues.push({kind:'covered',el:name(el),by:name(hit)})}
  });
  document.querySelectorAll('#app svg').forEach(svg=>{
    stats.icons++; if(hidden(svg))return;
    const r=svg.getBoundingClientRect(); if(r.width<1||r.height<1){issues.push({kind:'icon-zero-size',el:name(svg.parentElement)});return}
    let bb={width:0,height:0};try{bb=svg.getBBox()}catch(e){}
    if(!(bb.width>0||bb.height>0))issues.push({kind:'icon-empty',el:name(svg.parentElement)});
    if(svg.classList.contains('ui-icon')){const c=rgb(getComputedStyle(svg).color),b=bgOf(svg);if(c&&b&&c.a>.1){const cr=CR(c,b);if(cr<1.6)issues.push({kind:'icon-low-contrast',el:name(svg.parentElement),ratio:+cr.toFixed(2),fg:getComputedStyle(svg).color})}else if(c&&c.a<=.1)issues.push({kind:'icon-transparent',el:name(svg.parentElement)})}
  });
  const walker=document.createTreeWalker(document.getElementById('app'),NodeFilter.SHOW_TEXT);let n;
  const seen=new Set();
  while((n=walker.nextNode())){const t=n.textContent.trim();if(!t)continue;const el=n.parentElement;if(seen.has(el))continue;seen.add(el);stats.texts++;
    if(hidden(el))continue; const r=el.getBoundingClientRect();if(r.width<1||r.height<1){issues.push({kind:'text-zero-size',el:name(el)});continue}
    const s=getComputedStyle(el);const c=rgb(s.color),b=bgOf(el);
    if(c&&c.a<.15&&!/text/.test(s.webkitBackgroundClip||s.backgroundClip))issues.push({kind:'text-transparent',el:name(el)});
    else if(c&&b&&!/text/.test(s.webkitBackgroundClip||s.backgroundClip)){const cr=CR(c,b);if(cr<2)issues.push({kind:'text-low-contrast',el:name(el),ratio:+cr.toFixed(2),fg:s.color,bg:`rgb(${b.r},${b.g},${b.b})`})}
    if((r.left<-1||r.right>vw+1)&&!inHScroll(el))issues.push({kind:'text-outside',el:name(el),right:Math.round(r.right)});
    if(el.scrollWidth>el.clientWidth+2&&s.overflow==='hidden'&&s.textOverflow!=='ellipsis'&&s.webkitLineClamp==='none')issues.push({kind:'text-clipped',el:name(el)});
  }
  // контролы, которые должны лежать внутри своего контейнера
  [['.page-remove','.page-thumb'],['.field-clear','.field-wrap']].forEach(([c,box])=>document.querySelectorAll(c).forEach(el=>{if(hidden(el))return;const r=el.getBoundingClientRect(),q=el.closest(box).getBoundingClientRect();const cx=r.left+r.width/2,cy=r.top+r.height/2;if(cx<q.left||cx>q.right||cy<q.top-8||cy>q.bottom)issues.push({kind:'misplaced',el:name(el)})}));
  document.querySelectorAll('img').forEach(img=>{stats.images++;if(!img.complete||!img.naturalWidth)issues.push({kind:'image-broken',el:img.getAttribute('src').slice(0,60)})});
  if(document.documentElement.scrollWidth>vw+1)issues.push({kind:'horizontal-overflow',px:document.documentElement.scrollWidth-vw});
  return {stats,issues};
}

(async()=>{
  const b=await chromium.launch({executablePath:process.env.CHROMIUM||undefined});
  const W=+(process.env.W||390),H=+(process.env.H||844);
  const ctx=await b.newContext({viewport:{width:W,height:H},deviceScaleFactor:2,isMobile:true,hasTouch:true});
  const p=await ctx.newPage(); const cons=[], net=[];
  p.on('console',m=>{const t=m.text();if(m.type()==='error'&&!(t.startsWith('[generation] failed Error: x')))cons.push(t);if(m.type()==='warning'&&t.includes('[icon]'))cons.push(t)}); p.on('pageerror',e=>cons.push('pageerror: '+e.message));
  p.on('requestfailed',r=>{const f=(r.failure()||{}).errorText||'';if(!f.includes('ERR_ABORTED'))net.push('FAILED '+r.url()+' '+f)});
  p.on('response',r=>{if(r.status()>=400)net.push(r.status()+' '+r.url())});
  const fresh=async(first)=>{await p.goto(BASE);await p.evaluate(f=>{localStorage.clear();if(!f)localStorage.setItem('k-first','1')},first);await p.goto(BASE);await p.waitForTimeout(150)};
  const toCamera=async n=>{await fresh();await p.click('.hero [data-go=camera]');if(n){await p.setInputFiles('#cameraInput',IMG.slice(0,n));await p.waitForFunction(k=>document.querySelectorAll('.page-thumb').length===k&&!document.querySelector('.page-shot.loading'),n)}};
  const screens={
    welcome:async()=>fresh(true),
    home:async()=>fresh(),
    'home-empty':async()=>{await fresh();await p.evaluate(()=>{localStorage.setItem('konspekt.store.v1',JSON.stringify({version:1,notes:[],bookmarks:[]}))});await p.goto(BASE)},
    'camera-0':async()=>toCamera(0),
    'camera-1':async()=>toCamera(1),
    'camera-3':async()=>toCamera(3),
    processing:async()=>{await toCamera(1);await p.click('[data-process]');await p.waitForTimeout(1300)},
    note:async()=>{await p.waitForSelector('.note-title',{timeout:8000})},
    'note-bottom':async()=>{await p.evaluate(()=>scrollTo(0,document.body.scrollHeight));await p.waitForTimeout(100)},
    error:async()=>{await toCamera(1);await p.evaluate(()=>{window.K.generator.analyzePages=async()=>{throw new Error('x')}});await p.click('[data-process]');await p.waitForSelector('.error-icon')},
    'all-notes':async()=>{await fresh();await p.click('.section-row [data-go=all-notes]')},
    'all-notes-search-empty':async()=>{await p.fill('#noteSearch','zzzz')},
    bookmarks:async()=>{await fresh();await p.click('.section-row [data-go=bookmarks]')},
    bookmark:async()=>{await p.click('[data-bookmark="bm-history"]')},
    'sheet-bookmark':async()=>{await p.click('.screen-head .more')},
    'rename-bookmark':async()=>{await p.click('[data-rename=bookmark]')},
    'delete-bookmark':async()=>{await p.click('.modal [data-close]');await p.click('.screen-head .more');await p.click('[data-delete=bookmark]')},
    'new-bookmark':async()=>{await fresh();await p.click('.bookmarks [data-go=new-bookmark]')},
    'new-bookmark-filled':async()=>{await p.fill('#bmName','Контрольная')},
    'edit-bookmark':async()=>{await fresh();await p.click('.section-row [data-go=bookmarks]');await p.click('[data-bookmark="bm-history"]');await p.click('.screen-head .more');await p.click('[data-edit-bm]')},
    'sheet-note':async()=>{await fresh();await p.locator('.note-card [data-note-menu]').first().click()},
    'sheet-add':async()=>{await p.click('.sheet [data-sheet=add]')},
    'rename-note':async()=>{await fresh();await p.locator('.note-card [data-note-menu]').first().click();await p.click('[data-rename=note]')},
    'delete-note':async()=>{await p.click('.modal [data-close]');await p.locator('.note-card [data-note-menu]').first().click();await p.click('[data-delete=note]')},
    'note-from-card':async()=>{await fresh();await p.locator('.note-card').first().click();await p.waitForSelector('.note-title')},
    'sheet-add-from-note':async()=>{await p.click('.note-bookmark')},
  };
  const only=process.env.ONLY?process.env.ONLY.split(','):null;
  const summary={};
  for(const [k,fn] of Object.entries(screens)){
    if(only&&!only.includes(k))continue;
    cons.length=0;net.length=0;
    try{await fn()}catch(e){summary[k]={error:e.message.split('\n')[0]};continue}
    await p.waitForTimeout(150);
    const a=await p.evaluate(inPageAudit);
    a.console=[...cons];a.network=[...net];
    summary[k]=a;
    await p.screenshot({path:`${OUT}/${k}.png`});
  }
  // все ассеты приложения должны отдавать 200
  const assets=await p.evaluate(async()=>{const urls=['./','./index.html','./manifest.json','./service-worker.js','./assets/logo-mark.png','./icons/icon-192.png','./icons/icon-512.png','./icons/apple-touch-icon.png','./icons/favicon-32.png',...[...document.querySelectorAll('script[src],link[href]')].map(e=>e.getAttribute('src')||e.getAttribute('href'))];const out=[];for(const u of [...new Set(urls)]){const r=await fetch(u,{cache:'no-store'});out.push([r.status,u])}return out});
  const badAssets=assets.filter(a=>a[0]!==200);
  console.log('ASSETS checked:',assets.length,'non-200:',JSON.stringify(badAssets));
  await b.close();
  let total=badAssets.length;
  for(const [k,v] of Object.entries(summary)){
    if(v.error){console.log(`✗ ${k}: SETUP ERROR ${v.error}`);total++;continue}
    const n=v.issues.length+v.console.length+v.network.length; total+=n;
    console.log(`${n?'✗':'✓'} ${k}  [controls ${v.stats.interactive}, icons ${v.stats.icons}, texts ${v.stats.texts}, img ${v.stats.images}]`);
    v.issues.forEach(i=>console.log('    - '+JSON.stringify(i)));
    v.console.forEach(c=>console.log('    - console: '+c)); v.network.forEach(c=>console.log('    - network: '+c));
  }
  console.log('TOTAL PROBLEMS:',total);
})();
