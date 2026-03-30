import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.22.1/firebase-app.js';
import { getDatabase, ref, onChildRemoved, onValue, get } from 'https://www.gstatic.com/firebasejs/9.22.1/firebase-database.js';

const firebaseConfig = {
  apiKey: "AIzaSyDOK9DF3u9JXzfi7PYExrCDQX09vNN_c3k",
  authDomain: "uber-system-e73d6.firebaseapp.com",
  projectId: "uber-system-e73d6",
  storageBucket: "uber-system-e73d6.firebasestorage.app",
  messagingSenderId: "482805503804",
  appId: "1:482805503804:web:fa126da66cf3efcf45b039",
  measurementId: "G-CC559WX63X",
  databaseURL: "https://uber-system-e73d6-default-rtdb.firebaseio.com/"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

const statusEl = document.getElementById('status');
const listEl = document.getElementById('requests');
const locateBtn = document.getElementById('locateBtn');
const mapEl = document.getElementById('map');

let map = null;
let driverLatLng = null;
let driverMarker = null;
let routeLayer = null;
let destMarker = null;
let popupMap = null;
let popupDriverMarker = null;
let popupDestMarker = null;
let popupRouteLayer = null;
let popupOriginMarker = null;
let popupUserRouteLayer = null;
let showDriverRoute = true;
let showPassengerRoute = true;

function setStatus(msg){ if(statusEl) statusEl.textContent = msg; }

function haversine(a, b){
  // a and b are {lat,lng}
  const toRad = d => d * Math.PI / 180;
  const R = 6371e3; // meters
  const phi1 = toRad(a.lat), phi2 = toRad(b.lat);
  const dphi = toRad(b.lat - a.lat), dlambda = toRad(b.lng - a.lng);
  const x = Math.sin(dphi/2) * Math.sin(dphi/2) + Math.cos(phi1)*Math.cos(phi2)*Math.sin(dlambda/2)*Math.sin(dlambda/2);
  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
  return R * c;
}

function renderItem(key, data, distanceMeters){
  const el = document.createElement('div');
  el.className = 'req';
  el.id = `req-${key}`;
  const whenTs = data.timestamp || Date.now();
  const when = timeAgo(whenTs);
  const distText = (typeof distanceMeters === 'number') ? `<span class="distance">${(distanceMeters/1000).toFixed(2)} km</span>` : `<span class="distance">unknown</span>`;
  el.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center"><strong>Request</strong><button class="go">Open</button></div>
    <div class="meta"><span class="when">Lift requested ${when}</span> · ${distText}</div>`;
  const btn = el.querySelector('.go');
  btn.onclick = () => {
    showRequestOnMap(data, key);
  };
  return el;
}

function timeAgo(ts){
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff} seconds ago`;
  const mins = Math.floor(diff/60);
  if (mins < 60) return mins === 1 ? '1 minute ago' : `${mins} minutes ago`;
  const hrs = Math.floor(mins/60);
  if (hrs < 24) return hrs === 1 ? '1 hour ago' : `${hrs} hours ago`;
  const days = Math.floor(hrs/24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

async function ensureMap(){
  if (map) return;
  map = L.map(mapEl, {zoomControl:true}).setView([0,0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'&copy; OpenStreetMap contributors'}).addTo(map);
  // Leaflet needs to invalidate size when container may have changed
  setTimeout(()=>{ try { map.invalidateSize(); } catch(e){} }, 200);
}

async function showRequestOnMap(reqData, key){
  // open popup modal and use the popup map so driver sees a larger map
  openMapModal();
  await ensurePopupMap();
  if (!driverLatLng) {
    setStatus('Driver location unknown — click "Use my location"');
    return;
  }
  // clear previous on popup map
  if (popupDestMarker) { try{ popupMap.removeLayer(popupDestMarker); }catch(e){} popupDestMarker = null; }
  if (popupOriginMarker) { try{ popupMap.removeLayer(popupOriginMarker); }catch(e){} popupOriginMarker = null; }
  if (popupRouteLayer) { try{ popupMap.removeLayer(popupRouteLayer); }catch(e){} popupRouteLayer = null; }
  if (popupUserRouteLayer) { try{ popupMap.removeLayer(popupUserRouteLayer); }catch(e){} popupUserRouteLayer = null; }
    // Determine origin (where passenger was when requesting) and dest (where passenger wants to go)
    let origin = null;
    let dest = null;
    if (reqData.origin && typeof reqData.origin.lat === 'number') {
      origin = { lat: reqData.origin.lat, lng: reqData.origin.lng };
    } else if (reqData.geometry && Array.isArray(reqData.geometry) && reqData.geometry.length) {
      // geometry is an array of [lat,lng] pairs
      origin = { lat: reqData.geometry[0][0], lng: reqData.geometry[0][1] };
    } else if (typeof reqData.lat === 'number') {
      origin = { lat: reqData.lat, lng: reqData.lng };
    }

    if (reqData.destination && typeof reqData.destination.lat === 'number') {
      dest = { lat: reqData.destination.lat, lng: reqData.destination.lng };
    } else if (reqData.geometry && Array.isArray(reqData.geometry) && reqData.geometry.length) {
      const last = reqData.geometry[reqData.geometry.length - 1];
      dest = { lat: last[0], lng: last[1] };
    } else {
      dest = null;
    }
    if (origin) {
      popupOriginMarker = L.marker([origin.lat, origin.lng]).addTo(popupMap).bindPopup('Passenger origin');
    }
    if (dest) {
      popupDestMarker = L.marker([dest.lat, dest.lng]).addTo(popupMap).bindPopup('Passenger destination').openPopup();
    }
  if (!popupDriverMarker) popupDriverMarker = L.marker([driverLatLng.lat, driverLatLng.lng], {icon: L.icon({iconUrl:'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png', iconAnchor:[12,41]})}).addTo(popupMap).bindPopup('You');
  else popupDriverMarker.setLatLng([driverLatLng.lat, driverLatLng.lng]);

  // request route from OSRM (driver -> passenger pickup), prefer origin; fallback to destination
  const routeTarget = origin || dest;
  if (routeTarget) {
    try{
      const fromLonLat = `${driverLatLng.lng},${driverLatLng.lat}`;
      const toLonLat = `${routeTarget.lng},${routeTarget.lat}`;
      const url = `https://router.project-osrm.org/route/v1/driving/${fromLonLat};${toLonLat}?overview=full&geometries=geojson&alternatives=false&steps=false`;
      const resp = await fetch(url);
      if (resp.ok){
        const data = await resp.json();
        if (data && data.routes && data.routes.length){
          const coords = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
          popupRouteLayer = L.polyline(coords, {color:'#1978c8', weight:4});
          if (showDriverRoute) popupRouteLayer.addTo(popupMap);
          const bounds = popupRouteLayer.getBounds();
          popupMap.fitBounds(bounds, {padding:[40,40]});
        }
      }
    } catch(e){ console.error('Route error', e); }
  }
    // draw passenger origin->destination as a yellow line (use provided geometry if available)
    try{
      if (reqData.geometry && Array.isArray(reqData.geometry) && reqData.geometry.length) {
        popupUserRouteLayer = L.polyline(reqData.geometry, {color:'yellow', weight:4});
        if (showPassengerRoute) popupUserRouteLayer.addTo(popupMap);
        popupMap.fitBounds(popupUserRouteLayer.getBounds(), {padding:[40,40]});
      } else if (origin && dest) {
        popupUserRouteLayer = L.polyline([[origin.lat, origin.lng],[dest.lat, dest.lng]], {color:'yellow', weight:4});
        if (showPassengerRoute) popupUserRouteLayer.addTo(popupMap);
        const bounds = popupUserRouteLayer.getBounds();
        popupMap.fitBounds(bounds, {padding:[40,40]});
      } else {
        // fallback: show both markers
        const group = [];
        if (origin) group.push([origin.lat, origin.lng]);
        if (dest) group.push([dest.lat, dest.lng]);
        if (group.length) popupMap.fitBounds(group, {padding:[40,40]});
      }
    } catch(e){ console.error('Route draw error', e); }
}

function updateDriverRouteVisibility(){
  if (!popupMap) return;
  if (popupRouteLayer) {
    if (showDriverRoute && !popupMap.hasLayer(popupRouteLayer)) popupRouteLayer.addTo(popupMap);
    if (!showDriverRoute && popupMap.hasLayer(popupRouteLayer)) popupMap.removeLayer(popupRouteLayer);
  }
}

function updatePassengerRouteVisibility(){
  if (!popupMap) return;
  if (popupUserRouteLayer) {
    if (showPassengerRoute && !popupMap.hasLayer(popupUserRouteLayer)) popupUserRouteLayer.addTo(popupMap);
    if (!showPassengerRoute && popupMap.hasLayer(popupUserRouteLayer)) popupMap.removeLayer(popupUserRouteLayer);
  }
}

// Popup map support

function openMapModal(){
  const modal = document.getElementById('mapModal');
  if (!modal) return;
  modal.style.display = 'flex';
  // ensure popup map container visible
  setTimeout(()=>{ try{ const btn = document.getElementById('mapModalClose'); if(btn) btn.focus(); }catch(e){} },200);
}

function closeMapModal(){
  const modal = document.getElementById('mapModal');
  if (!modal) return;
  modal.style.display = 'none';
}

async function ensurePopupMap(){
  if (popupMap) { try{ popupMap.invalidateSize(); }catch(e){} return; }
  const popupEl = document.getElementById('mapPopup');
  if (!popupEl) return;
  popupMap = L.map(popupEl, {zoomControl:true}).setView([0,0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'&copy; OpenStreetMap contributors'}).addTo(popupMap);
  setTimeout(()=>{ try{ popupMap.invalidateSize(); }catch(e){} }, 200);
}

// wire close button
const modalCloseBtn = document.getElementById('mapModalClose');
if (modalCloseBtn) modalCloseBtn.addEventListener('click', () => { closeMapModal(); });

// Toggle controls in modal (buttons exist in DOM)
const toggleDriverPathBtn = document.getElementById('toggleDriverPathBtn');
const togglePassengerRouteBtn = document.getElementById('togglePassengerRouteBtn');
if (toggleDriverPathBtn) {
  toggleDriverPathBtn.addEventListener('click', () => {
    showDriverRoute = !showDriverRoute;
    toggleDriverPathBtn.textContent = showDriverRoute ? 'Hide driver→dest' : 'Show driver→dest';
    updateDriverRouteVisibility();
  });
  // initial label
  toggleDriverPathBtn.textContent = showDriverRoute ? 'Hide driver→dest' : 'Show driver→dest';
}
if (togglePassengerRouteBtn) {
  togglePassengerRouteBtn.addEventListener('click', () => {
    showPassengerRoute = !showPassengerRoute;
    togglePassengerRouteBtn.textContent = showPassengerRoute ? 'Hide passenger route' : 'Show passenger route';
    updatePassengerRouteVisibility();
  });
  togglePassengerRouteBtn.textContent = showPassengerRoute ? 'Hide passenger route' : 'Show passenger route';
}

const reqRef = ref(db, 'ride_requests');

function renderSnapshot(snapshot){
  listEl.innerHTML = '';
  if (!snapshot.exists()) { setStatus('No active requests'); return; }
  const items = [];
  snapshot.forEach(child => { items.push({key: child.key, val: child.val()}); });
  // compute distances if driver known
  if (driverLatLng) {
    items.forEach(i => {
      const origin = i.val && i.val.origin ? { lat: i.val.origin.lat, lng: i.val.origin.lng } : (i.val.lat ? { lat: i.val.lat, lng: i.val.lng } : null);
      if (origin) i.dist = haversine(driverLatLng, origin);
      else i.dist = Infinity;
    });
    items.sort((a,b) => (a.dist||0) - (b.dist||0));
  }
  items.forEach(i => {
    const el = renderItem(i.key, i.val, i.dist);
    listEl.appendChild(el);
  });
  setStatus('Loaded requests (' + items.length + ')');
}

onValue(reqRef, snapshot => { renderSnapshot(snapshot); });

onChildRemoved(reqRef, (snap) => {
  const el = document.getElementById(`req-${snap.key}`);
  if (el) el.remove();
});

setStatus('Connected — listening for ride_requests');

// location handling
async function updateDriverLocation(pos){
  driverLatLng = {lat: pos.coords.latitude, lng: pos.coords.longitude};
  // Do not create or show the main map automatically; only update marker if main map exists
  if (map) {
    if (!driverMarker) driverMarker = L.marker([driverLatLng.lat, driverLatLng.lng]).addTo(map).bindPopup('You');
    else driverMarker.setLatLng([driverLatLng.lat, driverLatLng.lng]);
    try{ map.setView([driverLatLng.lat, driverLatLng.lng], 13); }catch(e){}
  }
  // trigger a reload of list ordering
  const ev = new Event('reorderRequests');
  listEl.dispatchEvent(ev);
}

if (locateBtn) locateBtn.addEventListener('click', () => {
  if (!navigator.geolocation) { setStatus('Geolocation not supported'); return; }
  setStatus('Locating…');
  navigator.geolocation.getCurrentPosition(pos => { updateDriverLocation(pos); setStatus('Located'); }, err => { setStatus('Location error'); console.error(err); }, {enableHighAccuracy:true, timeout:10000});
});

// --- Driver identity + presence broadcasting ---
// Attempt to obtain drivers list from admin via BroadcastChannel or by fetching drivers.json
const CHANNEL = 'uber-drivers';
const bc = new BroadcastChannel(CHANNEL);
let driversList = [];
let currentDriver = null;
const selectEl = document.getElementById('driverSelect');
const manualInput = document.getElementById('driverManual');
const setDriverBtn = document.getElementById('setDriver');
const goOnlineBtn = document.getElementById('goOnline');
const goOfflineBtn = document.getElementById('goOffline');

function populateDrivers(select, list){
  // clear but keep first placeholder
  while (select.options.length > 1) select.remove(1);
  list.forEach(d => { const o = document.createElement('option'); o.value = d.id; o.textContent = d.name; select.appendChild(o); });
}

async function tryFetchDriversJson(){
  const candidates = ['./drivers.json','../ADMIN/drivers.json','/drivers.json','/ADMIN/drivers.json'];
  for (const p of candidates){
    try{
      const resp = await fetch(p, {cache:'no-store'});
      if (!resp.ok) continue;
      const js = await resp.json();
      if (Array.isArray(js)) { driversList = js; populateDrivers(selectEl, driversList); return; }
    }catch(e){}
  }
}

bc.addEventListener('message', (ev)=>{
  const m = ev.data;
  if (!m || !m.type) return;
  if (m.type === 'drivers-list' || m.type === 'drivers-updated'){
    driversList = m.drivers || [];
    populateDrivers(selectEl, driversList);
  }
  if (m.type === 'admin-present'){
    // ask for list
    bc.postMessage({type:'get-drivers'});
  }
});

// request list on load
bc.postMessage({type:'get-drivers'});
tryFetchDriversJson();

function setCurrentDriverById(id){
  const d = driversList.find(x=>x.id===id);
  if (d){ currentDriver = d; localStorage.setItem('uber_selected_driver', JSON.stringify(d)); setStatus('Driver: '+d.name); }
  else setStatus('Driver selected');
}

function setCurrentDriverByName(name){
  const d = driversList.find(x=>x.name===name);
  if (d){ setCurrentDriverById(d.id); }
  else { // create ephemeral driver object
    currentDriver = { id: 'manual-'+Math.random().toString(36).slice(2,8), name: name };
    localStorage.setItem('uber_selected_driver', JSON.stringify(currentDriver));
    setStatus('Driver: '+name+' (manual)');
  }
}

setDriverBtn?.addEventListener('click', ()=>{
  const selected = selectEl.value;
  const manual = manualInput.value.trim();
  if (manual) setCurrentDriverByName(manual);
  else if (selected) setCurrentDriverById(selected);
  else alert('Pick a driver or type a name');
});

goOnlineBtn?.addEventListener('click', ()=>{ setPresence(true); goOnlineBtn.style.display='none'; goOfflineBtn.style.display='inline-block'; });
goOfflineBtn?.addEventListener('click', ()=>{ setPresence(false); goOfflineBtn.style.display='none'; goOnlineBtn.style.display='inline-block'; });

function setPresence(online){
  if (!currentDriver){ alert('Set driver identity first'); return; }
  // send one immediate status, then continue to send location when available
  const msg = { type:'status', id: currentDriver.id, name: currentDriver.name, online: !!online, ts: Date.now() };
  if (driverLatLng) { msg.lat = driverLatLng.lat; msg.lng = driverLatLng.lng; }
  bc.postMessage(msg);
  // also save last known presence locally
  localStorage.setItem('uber_last_presence', JSON.stringify(msg));
}

// restore selected driver if saved
try{ const saved = JSON.parse(localStorage.getItem('uber_selected_driver')||'null'); if (saved){ currentDriver = saved; setStatus('Driver: '+(saved.name||saved.id)); } }catch(e){}

// whenever location updates, if we're online send an updated presence
const lastPresence = JSON.parse(localStorage.getItem('uber_last_presence')||'null');
let lastOnline = lastPresence && lastPresence.online;
// override setPresence to mark online/offline correctly when location updates
const original_updateDriverLocation = updateDriverLocation;
updateDriverLocation = async function(pos){
  await original_updateDriverLocation(pos);
  // send presence update if online
  const pres = JSON.parse(localStorage.getItem('uber_last_presence')||'null');
  if (pres && pres.online && currentDriver){
    const m = { type:'status', id: currentDriver.id, name: currentDriver.name, online:true, ts: Date.now(), lat: driverLatLng.lat, lng: driverLatLng.lng };
    bc.postMessage(m);
    localStorage.setItem('uber_last_presence', JSON.stringify(m));
  }
};


// allow external reorder trigger to re-render (simple: re-read db snapshot)
listEl.addEventListener('reorderRequests', async () => {
  try{
    const snap = await get(reqRef);
    renderSnapshot(snap);
  }catch(e){ console.error('Failed to refresh requests', e); }
});
