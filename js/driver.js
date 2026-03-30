import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.22.1/firebase-app.js';
import { getDatabase, ref, onChildRemoved, onValue, get, update, onDisconnect, runTransaction, remove } from 'https://www.gstatic.com/firebasejs/9.22.1/firebase-database.js';

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
const refreshBtn = document.getElementById('refreshBtn');
const mapEl = document.getElementById('map');
const driverSelect = document.getElementById('driverSelect');
const selectDriverBtn = document.getElementById('selectDriverBtn');
const selectedDriverSpan = document.getElementById('selectedDriver');
const identityModal = document.getElementById('identityModal');
const changeIdentityBtn = document.getElementById('changeIdentityBtn');
const startShiftBtn = document.getElementById('startShiftBtn');
const stopShiftBtn = document.getElementById('stopShiftBtn');

let selectedDriverId = null;
let selectedDriverName = null;
let shiftActive = false;
let watchId = null;
let onDisconnectHandler = null;

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
  const distText = (typeof distanceMeters === 'number') ? `${(distanceMeters/1000).toFixed(2)} km` : `unknown`;
  // pickup summary
  let pickup = 'Pickup unknown';
  if (data.origin && typeof data.origin.lat === 'number') pickup = `Pickup: ${data.origin.lat.toFixed(4)}, ${data.origin.lng.toFixed(4)}`;
  else if (data.lat && data.lng) pickup = `Pickup: ${data.lat.toFixed(4)}, ${data.lng.toFixed(4)}`;
  const leftHtml = `<div class="left"><div class="title">Request</div><div class="meta">${pickup} · ${when}</div></div>`;
  // actions: Open, Accept/Complete depending on state
  const actions = document.createElement('div');
  actions.className = 'actions';
  const meta = document.createElement('div'); meta.className = 'meta'; meta.style.marginRight = '8px'; meta.textContent = distText;
  actions.appendChild(meta);
  const openBtn = document.createElement('button'); openBtn.className = 'go'; openBtn.textContent = 'Open';
  openBtn.onclick = () => { showRequestOnMap(data, key); };
  actions.appendChild(openBtn);

  // Accept button (only shown when not accepted) or Complete (when accepted by this driver)
  if (data && data.acceptedBy) {
    if (data.acceptedBy === selectedDriverId) {
      const comp = document.createElement('button'); comp.className = 'complete'; comp.textContent = (data.status === 'completed') ? 'Completed' : 'Lift complete';
      comp.disabled = (data.status === 'completed');
      comp.onclick = () => { completeRequest(key); };
      actions.appendChild(comp);
    } else {
      // accepted by someone else — mark as taken
      const taken = document.createElement('div'); taken.className = 'meta'; taken.style.color = '#c33'; taken.textContent = 'Taken'; actions.appendChild(taken);
    }
  } else {
    const acc = document.createElement('button'); acc.className = 'accept'; acc.textContent = 'Accept';
    acc.onclick = () => { acceptRequest(key); };
    actions.appendChild(acc);
  }
  el.appendChild(document.createRange().createContextualFragment(leftHtml));
  el.appendChild(actions);
  return el;
}

async function acceptRequest(key){
  if (!selectedDriverId) return alert('Sign in as a driver first');
  if (!shiftActive) return alert('Start your shift before accepting rides');
  const r = ref(db, 'ride_requests/' + key);
  try{
    const result = await runTransaction(r, (current) => {
      if (!current) return current; // disappeared
      if (current.acceptedBy) return; // already taken
      current.acceptedBy = selectedDriverId;
      current.acceptedAt = Date.now();
      current.status = 'accepted';
      return current;
    });
    if (!result.committed) {
      alert('Request already accepted by another driver');
      return;
    }
    setStatus('Accepted request');
  }catch(e){ console.error('Accept failed', e); alert('Failed to accept request'); }
}

async function completeRequest(key){
  if (!selectedDriverId) return alert('Sign in as a driver first');
  const r = ref(db, 'ride_requests/' + key);
  try{
    // remove the request entirely from the database
    await remove(r);
    setStatus('Ride completed — request cleared');
  }catch(e){ console.error('Complete failed', e); alert('Failed to complete request'); }
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

// --- Driver identity management ---
function populateDrivers(snapshot){
  const list = snapshot.val() || {};
  if (!driverSelect) return;
  // clear, keep default
  const cur = driverSelect.value;
  driverSelect.innerHTML = '<option value="">-- Select driver identity --</option>';
  Object.keys(list).forEach(k => {
    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = list[k].name || ('Driver ' + k.slice(0,6));
    driverSelect.appendChild(opt);
  });
  // restore if possible
  if (cur) driverSelect.value = cur;
  // if driver previously signed in on this device, auto-select
  const saved = localStorage.getItem('driverId');
  if (saved && !selectedDriverId) {
    // if the saved id exists in the list, set it
    const opt = Array.from(driverSelect.options).find(o => o.value === saved);
    if (opt) {
      setIdentityFromId(saved).catch(e=>console.error(e));
    }
  }
}

if (driverSelect) {
  // listen for drivers list
  onValue(ref(db, 'drivers'), snapshot => populateDrivers(snapshot));
}

if (selectDriverBtn) selectDriverBtn.addEventListener('click', async ()=>{
  const id = driverSelect.value;
  if (!id) return alert('Choose a driver identity first');
  try{
    await setIdentityFromId(id);
    // persist
    localStorage.setItem('driverId', id);
  }catch(e){ console.error(e); }
});

async function setIdentityFromId(id){
  if (!id) return;
  selectedDriverId = id;
  const snap = await get(ref(db, 'drivers/'+id));
  const val = snap.val() || {};
  selectedDriverName = val.name || '';
  if (selectedDriverSpan) selectedDriverSpan.textContent = selectedDriverName || id;
  // DO NOT mark online yet — driver must press Start Shift to begin
  setStatus('Signed in (press Start Shift): ' + (selectedDriverName||id));
  // hide modal if visible
  if (identityModal) identityModal.style.display = 'none';
  if (changeIdentityBtn) changeIdentityBtn.style.display = 'inline-block';
}

if (changeIdentityBtn) changeIdentityBtn.addEventListener('click', ()=>{
  if (identityModal) identityModal.style.display = 'flex';
});

// mark offline on unload
window.addEventListener('beforeunload', ()=>{
  if (selectedDriverId && shiftActive) {
    try{ update(ref(db, 'drivers/'+selectedDriverId), { online: false, lastSeen: Date.now() }); }catch(e){}
    // onDisconnect will also handle abrupt disconnects; ensure onDisconnect is cancelled when closing gracefully
    try{ if (onDisconnectHandler) onDisconnectHandler.cancel(); }catch(e){}
  }
});

async function ensureMap(){
  if (map) return;
  map = L.map(mapEl, {zoomControl:true}).setView([0,0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'networKING Technology'}).addTo(map);
  if (map && map.attributionControl && typeof map.attributionControl.setPrefix === 'function') {
    map.attributionControl.setPrefix('');
  }
  // Leaflet needs to invalidate size when container may have changed
  setTimeout(()=>{ try { map.invalidateSize(); } catch(e){} }, 200);
}

async function showRequestOnMap(reqData, key){
  // open popup modal and use the popup map so driver sees a larger map
  openMapModal();
  await ensurePopupMap();
  if (!driverLatLng) {
    setStatus('Driver location unknown — start your shift or refresh location');
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
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'networKING Technology'}).addTo(popupMap);
  if (popupMap && popupMap.attributionControl && typeof popupMap.attributionControl.setPrefix === 'function') {
    popupMap.attributionControl.setPrefix('');
  }
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
  // filter out requests accepted by other drivers
  const filtered = items.filter(i => { return !(i.val && i.val.acceptedBy && i.val.acceptedBy !== selectedDriverId); });
  // compute distances if driver known
  if (driverLatLng) {
    items.forEach(i => {
      const origin = i.val && i.val.origin ? { lat: i.val.origin.lat, lng: i.val.origin.lng } : (i.val.lat ? { lat: i.val.lat, lng: i.val.lng } : null);
      if (origin) i.dist = haversine(driverLatLng, origin);
      else i.dist = Infinity;
    });
    items.sort((a,b) => (a.dist||0) - (b.dist||0));
  }
  filtered.forEach(i => {
    const el = renderItem(i.key, i.val, i.dist);
    listEl.appendChild(el);
  });
  setStatus('Loaded requests (' + filtered.length + ')');
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
  // update driver record in database if identity selected AND shift active
  if (selectedDriverId && shiftActive) {
    try{
      await update(ref(db, 'drivers/'+selectedDriverId), { lat: driverLatLng.lat, lng: driverLatLng.lng, lastSeen: Date.now(), online: true });
    }catch(e){ console.error('Failed to update driver location', e); }
  }
}

if (refreshBtn) refreshBtn.addEventListener('click', () => {
  if (!navigator.geolocation) { setStatus('Geolocation not supported'); return; }
  if (!shiftActive) { setStatus('Not on shift — press Start Shift'); return; }
  setStatus('Refreshing location…');
  navigator.geolocation.getCurrentPosition(pos => { updateDriverLocation(pos); setStatus('Location refreshed'); }, err => { setStatus('Location error'); console.error(err); }, {enableHighAccuracy:true, timeout:10000});
});

// Start shift flow — requests and map are hidden until shift begins
async function startShift(){
  if (!selectedDriverId) {
    // show identity modal so driver can sign in
    if (identityModal) identityModal.style.display = 'flex';
    return;
  }
  if (!navigator.geolocation) { setStatus('Geolocation not supported'); return; }
  setStatus('Starting shift — obtaining location…');
  try{
    // initial position
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {enableHighAccuracy:true, timeout:10000});
    });
    await updateDriverLocation(pos);
    // mark driver online
    try{ await update(ref(db, 'drivers/'+selectedDriverId), { online: true, lastSeen: Date.now() }); }catch(e){ console.error('Failed to set online', e); }
    // register onDisconnect fallback so if the driver loses connection or closes the browser
    // the DB will mark them offline automatically
    try{
      onDisconnectHandler = onDisconnect(ref(db, 'drivers/'+selectedDriverId));
      await onDisconnectHandler.update({ online: false, lastSeen: Date.now() });
    }catch(e){ console.error('Failed to set onDisconnect', e); }
    // show UI (requests only). main map remains hidden until the driver opens a request
    const req = document.getElementById('requests'); if (req) req.style.display = '';
    if (refreshBtn) refreshBtn.style.display = 'inline-flex';
    // start continuous updates
    watchId = navigator.geolocation.watchPosition(async p => { await updateDriverLocation(p); }, err => { console.error('watch error', err); }, {enableHighAccuracy:true, maximumAge:2000, timeout:10000});
    shiftActive = true;
    setStatus('Shift started');
    // toggle buttons
    if (startShiftBtn) startShiftBtn.style.display = 'none';
    if (stopShiftBtn) stopShiftBtn.style.display = '';
    // hide main map by default
    const mapc = document.getElementById('map'); if (mapc) mapc.style.display = 'none';
  }catch(e){ console.error('Start shift failed', e); setStatus('Start shift failed'); }
}

if (startShiftBtn) startShiftBtn.addEventListener('click', startShift);

// Stop shift (clean shutdown)
async function stopShift(){
  if (!shiftActive) return;
  // stop geo watch
  try{ if (watchId && navigator.geolocation) navigator.geolocation.clearWatch(watchId); }catch(e){}
  watchId = null;
  shiftActive = false;
  // cancel onDisconnect and mark offline
  if (onDisconnectHandler) {
    try{ await onDisconnectHandler.cancel(); }catch(e){}
    onDisconnectHandler = null;
  }
  if (selectedDriverId) {
    try{ await update(ref(db, 'drivers/'+selectedDriverId), { online: false, lastSeen: Date.now() }); }catch(e){ console.error('Failed to set offline', e); }
  }
  // hide UI
  const req = document.getElementById('requests'); if (req) req.style.display = 'none';
  const mapc = document.getElementById('map'); if (mapc) mapc.style.display = 'none';
  if (refreshBtn) refreshBtn.style.display = 'none';
  if (startShiftBtn) startShiftBtn.style.display = '';
  if (stopShiftBtn) stopShiftBtn.style.display = 'none';
  setStatus('Shift stopped');
}

if (stopShiftBtn) stopShiftBtn.addEventListener('click', stopShift);

// show identity modal on first load if not signed in
window.addEventListener('load', ()=>{
  const saved = localStorage.getItem('driverId');
  if (!saved) {
    if (identityModal) identityModal.style.display = 'flex';
  } else {
    // saved identity will be restored when drivers list loads
  }
});

// allow external reorder trigger to re-render (simple: re-read db snapshot)
listEl.addEventListener('reorderRequests', async () => {
  try{
    const snap = await get(reqRef);
    renderSnapshot(snap);
  }catch(e){ console.error('Failed to refresh requests', e); }
});
