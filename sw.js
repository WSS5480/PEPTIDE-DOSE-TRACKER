const CACHE='pdg-v49';
const FILES=['./','./index.html','./manifest.webmanifest','./updates.json','./icon-192.png','./icon-512.png','./apple-touch-icon.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const sameOrigin=new URL(e.request.url).origin===self.location.origin;
  e.respondWith(
    fetch(e.request).then(res=>{
      if(sameOrigin&&res.ok){const copy=res.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));}
      return res;
    }).catch(()=>caches.match(e.request,{ignoreSearch:true}).then(r=>r||(e.request.mode==='navigate'?caches.match('./index.html'):Response.error())))
  );
});
/* renewal reminders sent by the owner's console */
self.addEventListener('push',e=>{let d={};try{d=e.data?e.data.json():{};}catch(x){}
  e.waitUntil(self.registration.showNotification(d.title||'Peptide Dose Guide',{body:d.body||'',tag:d.tag||'dose-guide',icon:'icon-192.png',badge:'icon-192.png',vibrate:[300,150,300,150,300],requireInteraction:!!d.urgent}));});
self.addEventListener('notificationclick',e=>{e.notification.close();
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(l=>{for(const c of l){if('focus' in c)return c.focus();}return self.clients.openWindow('./');}));});
