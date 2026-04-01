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

// DOM refs
const statusEl = document.getElementById('status');
const listEl = document.getElementById('requests');
const driverSelect = document.getElementById('driverSelect');
const selectDriverBtn = document.getElementById('selectDriverBtn');
const selectedDriverSpan = document.getElementById('selectedDriver');
const identityModal = document.getElementById('identityModal');
const changeIdentityBtn = document.getElementById('changeIdentityBtn');
const startShiftBtn = document.getElementById('startShiftBtn');
const stopShiftBtn = document.getElementById('stopShiftBtn');
const emptyState = document.getElementById('emptyState');

let selectedDriverId = null;
let selectedDriverName = null;
let shiftActive = false;
let watchId = null;
let onDisconnectHandler = null;

// Map-related state
let popupMap = null;
let popupDriverMarker = null;
let popupDestMarker = null;
let popupRouteLayer = null;
let popupOriginMarker = null;
let popupUserRouteLayer = null;
let showDriverRoute = true;
let showPassengerRoute = true;

let driverLatLng = null;

// ===== NAVIGATION MODE STATE =====
let navMap = null;
let navDriverMarker = null;
let navRouteLayer = null;
let navDestMarker = null;
let navOriginMarker = null;
let navPassengerRouteLayer = null;
let navWatchId = null;
let navLocked = true; // auto-follow driver
let navSteps = [];
let navCurrentStepIdx = 0;
let navActiveRequestKey = null;
let navActiveRequestData = null;

function setStatus(msg){ if(statusEl) statusEl.textContent = msg; }

function haversine(a, b){
  const toRad = d => d * Math.PI / 180;
  const R = 6371e3;
  const phi1 = toRad(a.lat), phi2 = toRad(b.lat);
  const dphi = toRad(b.lat - a.lat), dlambda = toRad(b.lng - a.lng);
  const x = Math.sin(dphi/2) * Math.sin(dphi/2) + Math.cos(phi1)*Math.cos(phi2)*Math.sin(dlambda/2)*Math.sin(dlambda/2);
  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
  return R * c;
}

function timeAgo(ts){
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  const mins = Math.floor(diff/60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins/60);
  return `${hrs}h ago`;
}

// ===== REQUEST CARDS =====
function renderItem(key, data, distanceMeters){
  const el = document.createElement('div');
  el.className = 'req';
  el.id = `req-${key}`;
  const when = timeAgo(data.timestamp || Date.now());
  const distText = (typeof distanceMeters === 'number' && isFinite(distanceMeters)) ? `${(distanceMeters/1000).toFixed(1)} km` : '? km';
  let pickup = 'Location pending';
  if (data.origin && typeof data.origin.lat === 'number') pickup = `${data.origin.lat.toFixed(4)}, ${data.origin.lng.toFixed(4)}`;
  else if (data.lat && data.lng) pickup = `${data.lat.toFixed(4)}, ${data.lng.toFixed(4)}`;

  const leftHtml = `<div class="left"><div class="title">Ride Request</div><div class="meta">${pickup} · ${distText} · ${when}</div></div>`;
  const actions = document.createElement('div');
  actions.className = 'actions';

  const openBtn = document.createElement('button');
  openBtn.className = 'go';
  openBtn.textContent = 'Preview';
  openBtn.onclick = () => showRequestOnMap(data, key);
  actions.appendChild(openBtn);

  if (data && data.acceptedBy) {
    if (data.acceptedBy === selectedDriverId) {
      // Navigate button
      const navBtn = document.createElement('button');
      navBtn.className = 'navigate';
      navBtn.textContent = 'Navigate';
      navBtn.onclick = () => enterNavMode(key, data);
      actions.appendChild(navBtn);
      // Complete button
      const comp = document.createElement('button');
      comp.className = 'complete';
      comp.textContent = (data.status === 'completed') ? 'Done' : 'Complete';
      comp.disabled = (data.status === 'completed');
      comp.onclick = () => completeRequest(key);
      actions.appendChild(comp);
    } else {
      const taken = document.createElement('div');
      taken.className = 'meta';
      taken.style.color = '#ef4444';
      taken.textContent = 'Taken';
      actions.appendChild(taken);
    }
  } else {
    const acc = document.createElement('button');
    acc.className = 'accept';
    acc.textContent = 'Accept';
    acc.onclick = () => acceptRequest(key);
    actions.appendChild(acc);
  }

  el.appendChild(document.createRange().createContextualFragment(leftHtml));
  el.appendChild(actions);
  return el;
}

async function acceptRequest(key){
  if (!selectedDriverId) return alert('Sign in first');
  if (!shiftActive) return alert('Start your shift first');
  const r = ref(db, 'ride_requests/' + key);
  try{
    const result = await runTransaction(r, (cur) => {
      if (!cur) return cur;
      if (cur.acceptedBy) return;
      cur.acceptedBy = selectedDriverId;
      cur.acceptedAt = Date.now();
      cur.status = 'accepted';
      return cur;
    });
    if (!result.committed) return alert('Already taken by another driver');
    setStatus('Ride accepted');
  }catch(e){ console.error('Accept failed', e); alert('Failed to accept'); }
}

async function completeRequest(key){
  if (!selectedDriverId) return alert('Sign in first');
  try{
    await remove(ref(db, 'ride_requests/' + key));
    setStatus('Ride completed');
    // If in nav mode for this request, exit
    if (navActiveRequestKey === key) exitNavMode();
  }catch(e){ console.error('Complete failed', e); alert('Failed to complete'); }
}

// ===== DRIVER IDENTITY =====
function populateDrivers(snapshot){
  const list = snapshot.val() || {};
  if (!driverSelect) return;
  const cur = driverSelect.value;
  driverSelect.innerHTML = '<option value="">Choose driver…</option>';
  Object.keys(list).forEach(k => {
    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = list[k].name || ('Driver ' + k.slice(0,6));
    driverSelect.appendChild(opt);
  });
  if (cur) driverSelect.value = cur;
  const saved = localStorage.getItem('driverId');
  if (saved && !selectedDriverId) {
    const opt = Array.from(driverSelect.options).find(o => o.value === saved);
    if (opt) setIdentityFromId(saved).catch(e=>console.error(e));
  }
}

if (driverSelect) onValue(ref(db, 'drivers'), snapshot => populateDrivers(snapshot));

if (selectDriverBtn) selectDriverBtn.addEventListener('click', async ()=>{
  const id = driverSelect.value;
  if (!id) return alert('Choose a driver first');
  try{
    await setIdentityFromId(id);
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
  setStatus('Offline');
  if (identityModal) identityModal.style.display = 'none';
  if (changeIdentityBtn) changeIdentityBtn.style.display = 'inline-flex';
}

if (changeIdentityBtn) changeIdentityBtn.addEventListener('click', ()=>{
  if (identityModal) identityModal.style.display = 'flex';
});

window.addEventListener('beforeunload', ()=>{
  if (selectedDriverId && shiftActive) {
    try{ update(ref(db, 'drivers/'+selectedDriverId), { online: false, lastSeen: Date.now() }); }catch(e){}
    try{ if (onDisconnectHandler) onDisconnectHandler.cancel(); }catch(e){}
  }
});

// ===== MAP PREVIEW MODAL (for Open/Preview button) =====
function openMapModal(){
  const modal = document.getElementById('mapModal');
  if (!modal) return;
  modal.style.display = 'flex';
  setTimeout(()=>{ try{ popupMap && popupMap.invalidateSize(); }catch(e){} },200);
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
  if (popupMap.attributionControl) popupMap.attributionControl.setPrefix('');
  setTimeout(()=>{ try{ popupMap.invalidateSize(); }catch(e){} }, 200);
}

async function showRequestOnMap(reqData, key){
  openMapModal();
  await ensurePopupMap();
  if (!driverLatLng) { setStatus('Location unknown'); return; }

  // Clear previous layers
  [popupDestMarker, popupOriginMarker, popupRouteLayer, popupUserRouteLayer].forEach(l => {
    if (l) try{ popupMap.removeLayer(l); }catch(e){}
  });
  popupDestMarker = popupOriginMarker = popupRouteLayer = popupUserRouteLayer = null;

  let origin = null, dest = null;
  if (reqData.origin && typeof reqData.origin.lat === 'number') origin = reqData.origin;
  else if (reqData.geometry && reqData.geometry.length) origin = { lat: reqData.geometry[0][0], lng: reqData.geometry[0][1] };
  else if (typeof reqData.lat === 'number') origin = { lat: reqData.lat, lng: reqData.lng };

  if (reqData.destination && typeof reqData.destination.lat === 'number') dest = reqData.destination;
  else if (reqData.geometry && reqData.geometry.length) { const last = reqData.geometry[reqData.geometry.length-1]; dest = { lat: last[0], lng: last[1] }; }

  if (origin) popupOriginMarker = L.marker([origin.lat, origin.lng]).addTo(popupMap).bindPopup('Pickup');
  if (dest) popupDestMarker = L.marker([dest.lat, dest.lng]).addTo(popupMap).bindPopup('Dropoff').openPopup();
  if (!popupDriverMarker) popupDriverMarker = L.marker([driverLatLng.lat, driverLatLng.lng]).addTo(popupMap).bindPopup('You');
  else popupDriverMarker.setLatLng([driverLatLng.lat, driverLatLng.lng]);

  const routeTarget = origin || dest;
  if (routeTarget) {
    try{
      const url = `https://router.project-osrm.org/route/v1/driving/${driverLatLng.lng},${driverLatLng.lat};${routeTarget.lng},${routeTarget.lat}?overview=full&geometries=geojson&alternatives=false&steps=false`;
      const resp = await fetch(url);
      if (resp.ok){
        const data = await resp.json();
        if (data && data.routes && data.routes.length){
          const coords = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
          popupRouteLayer = L.polyline(coords, {color:'#3b82f6', weight:5, opacity:0.9});
          if (showDriverRoute) popupRouteLayer.addTo(popupMap);
          popupMap.fitBounds(popupRouteLayer.getBounds(), {padding:[50,50]});
        }
      }
    } catch(e){ console.error('Route error', e); }
  }

  // Passenger route
  try{
    if (reqData.geometry && reqData.geometry.length) {
      popupUserRouteLayer = L.polyline(reqData.geometry, {color:'#facc15', weight:4, dashArray:'8,6'});
      if (showPassengerRoute) popupUserRouteLayer.addTo(popupMap);
      popupMap.fitBounds(popupUserRouteLayer.getBounds(), {padding:[50,50]});
    } else if (origin && dest) {
      popupUserRouteLayer = L.polyline([[origin.lat,origin.lng],[dest.lat,dest.lng]], {color:'#facc15', weight:4, dashArray:'8,6'});
      if (showPassengerRoute) popupUserRouteLayer.addTo(popupMap);
      popupMap.fitBounds(popupUserRouteLayer.getBounds(), {padding:[50,50]});
    }
  }catch(e){}
}

// Modal toggle wiring
const modalCloseBtn = document.getElementById('mapModalClose');
if (modalCloseBtn) modalCloseBtn.addEventListener('click', closeMapModal);

const toggleDriverPathBtn = document.getElementById('toggleDriverPathBtn');
const togglePassengerRouteBtn = document.getElementById('togglePassengerRouteBtn');
if (toggleDriverPathBtn) {
  toggleDriverPathBtn.addEventListener('click', () => {
    showDriverRoute = !showDriverRoute;
    toggleDriverPathBtn.textContent = showDriverRoute ? 'Hide driver route' : 'Show driver route';
    if (popupRouteLayer && popupMap) {
      if (showDriverRoute && !popupMap.hasLayer(popupRouteLayer)) popupRouteLayer.addTo(popupMap);
      if (!showDriverRoute && popupMap.hasLayer(popupRouteLayer)) popupMap.removeLayer(popupRouteLayer);
    }
  });
}
if (togglePassengerRouteBtn) {
  togglePassengerRouteBtn.addEventListener('click', () => {
    showPassengerRoute = !showPassengerRoute;
    togglePassengerRouteBtn.textContent = showPassengerRoute ? 'Hide passenger route' : 'Show passenger route';
    if (popupUserRouteLayer && popupMap) {
      if (showPassengerRoute && !popupMap.hasLayer(popupUserRouteLayer)) popupUserRouteLayer.addTo(popupMap);
      if (!showPassengerRoute && popupMap.hasLayer(popupUserRouteLayer)) popupMap.removeLayer(popupUserRouteLayer);
    }
  });
}

// ===== REALTIME REQUEST LIST =====
const reqRef = ref(db, 'ride_requests');

function renderSnapshot(snapshot){
  listEl.innerHTML = '';
  if (!snapshot.exists()) {
    setStatus(shiftActive ? 'Waiting for requests…' : 'Offline');
    if (emptyState && shiftActive) emptyState.style.display = 'flex';
    return;
  }
  if (emptyState) emptyState.style.display = 'none';
  const items = [];
  snapshot.forEach(child => items.push({key: child.key, val: child.val()}));
  const filtered = items.filter(i => !(i.val && i.val.acceptedBy && i.val.acceptedBy !== selectedDriverId));
  if (driverLatLng) {
    filtered.forEach(i => {
      const origin = i.val.origin || (i.val.lat ? {lat:i.val.lat, lng:i.val.lng} : null);
      i.dist = origin ? haversine(driverLatLng, origin) : Infinity;
    });
    filtered.sort((a,b) => (a.dist||0) - (b.dist||0));
  }
  filtered.forEach(i => listEl.appendChild(renderItem(i.key, i.val, i.dist)));
  if (shiftActive) setStatus(`${filtered.length} request${filtered.length===1?'':'s'}`);
}

onValue(reqRef, snapshot => renderSnapshot(snapshot));
onChildRemoved(reqRef, snap => { const el = document.getElementById(`req-${snap.key}`); if (el) el.remove(); });

// ===== DRIVER LOCATION =====
async function updateDriverLocation(pos){
  driverLatLng = {lat: pos.coords.latitude, lng: pos.coords.longitude};
  if (selectedDriverId && shiftActive) {
    try{ await update(ref(db, 'drivers/'+selectedDriverId), { lat: driverLatLng.lat, lng: driverLatLng.lng, lastSeen: Date.now(), online: true }); }catch(e){}
  }
}

// ===== SHIFT MANAGEMENT =====
async function startShift(){
  if (!selectedDriverId) {
    if (identityModal) identityModal.style.display = 'flex';
    return;
  }
  if (!navigator.geolocation) { setStatus('No geolocation'); return; }
  setStatus('Getting location…');
  try{
    const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, {enableHighAccuracy:true, timeout:10000}));
    await updateDriverLocation(pos);
    await update(ref(db, 'drivers/'+selectedDriverId), { online: true, lastSeen: Date.now() });
    onDisconnectHandler = onDisconnect(ref(db, 'drivers/'+selectedDriverId));
    await onDisconnectHandler.update({ online: false, lastSeen: Date.now() });

    const req = document.getElementById('requests');
    if (req) req.style.display = '';
    watchId = navigator.geolocation.watchPosition(async p => await updateDriverLocation(p), err => console.error('watch err', err), {enableHighAccuracy:true, maximumAge:2000, timeout:10000});
    shiftActive = true;
    if (statusEl) { statusEl.textContent = 'Online'; statusEl.classList.add('online'); }
    if (startShiftBtn) startShiftBtn.style.display = 'none';
    if (stopShiftBtn) stopShiftBtn.style.display = '';
  }catch(e){ console.error('Start shift failed', e); setStatus('Start failed'); }
}

async function stopShift(){
  if (!shiftActive) return;
  try{ if (watchId && navigator.geolocation) navigator.geolocation.clearWatch(watchId); }catch(e){}
  watchId = null;
  shiftActive = false;
  if (onDisconnectHandler) { try{ await onDisconnectHandler.cancel(); }catch(e){} onDisconnectHandler = null; }
  if (selectedDriverId) {
    try{ await update(ref(db, 'drivers/'+selectedDriverId), { online: false, lastSeen: Date.now() }); }catch(e){}
  }
  const req = document.getElementById('requests'); if (req) req.style.display = 'none';
  if (emptyState) emptyState.style.display = 'none';
  if (startShiftBtn) startShiftBtn.style.display = '';
  if (stopShiftBtn) stopShiftBtn.style.display = 'none';
  setStatus('Offline');
  if (statusEl) statusEl.classList.remove('online');
  exitNavMode();
}

if (startShiftBtn) startShiftBtn.addEventListener('click', startShift);
if (stopShiftBtn) stopShiftBtn.addEventListener('click', stopShift);

// ===== NAVIGATION MODE (Google Maps-style) =====

// Turn instruction icons (SVG strings for maneuver types)
const MANEUVER_ICONS = {
  'turn-left': '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="14 15 9 20 4 15"/><path d="M20 4h-7a4 4 0 00-4 4v12"/></svg>',
  'turn-right': '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="10 15 15 20 20 15"/><path d="M4 4h7a4 4 0 014 4v12"/></svg>',
  'straight': '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>',
  'arrive': '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>',
  'default': '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg>'
};

function getManeuverIcon(modifier){
  if (!modifier) return MANEUVER_ICONS['default'];
  if (modifier.includes('left')) return MANEUVER_ICONS['turn-left'];
  if (modifier.includes('right')) return MANEUVER_ICONS['turn-right'];
  if (modifier.includes('straight')) return MANEUVER_ICONS['straight'];
  return MANEUVER_ICONS['default'];
}

function formatStepDistance(meters){
  if (meters < 100) return `${Math.round(meters)} m`;
  if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
  return `${(meters/1000).toFixed(1)} km`;
}

async function enterNavMode(key, reqData){
  navActiveRequestKey = key;
  navActiveRequestData = reqData;
  navLocked = true;

  const navModeEl = document.getElementById('navMode');
  if (navModeEl) navModeEl.style.display = 'flex';

  // Create nav map if needed
  if (!navMap) {
    navMap = L.map('navMap', {zoomControl: false, attributionControl: false}).setView([0,0], 16);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19}).addTo(navMap);
    // When user drags, disable lock; re-center button re-enables it
    navMap.on('dragstart', () => { navLocked = false; });
  }
  setTimeout(() => { try{ navMap.invalidateSize(); }catch(e){} }, 200);

  // Determine pickup and destination
  let origin = null, dest = null;
  if (reqData.origin && typeof reqData.origin.lat === 'number') origin = reqData.origin;
  else if (typeof reqData.lat === 'number') origin = { lat: reqData.lat, lng: reqData.lng };
  if (reqData.destination && typeof reqData.destination.lat === 'number') dest = reqData.destination;

  // Clear previous nav layers
  [navRouteLayer, navDestMarker, navOriginMarker, navPassengerRouteLayer].forEach(l => {
    if (l && navMap) try{ navMap.removeLayer(l); }catch(e){}
  });
  navRouteLayer = navDestMarker = navOriginMarker = navPassengerRouteLayer = null;

  // Put driver marker
  if (!driverLatLng) { setStatus('Location unknown'); return; }
  if (!navDriverMarker) {
    const driverIcon = L.divIcon({
      className: '',
      html: '<div style="width:20px;height:20px;background:#3b82f6;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,0.3);"></div>',
      iconSize: [20,20],
      iconAnchor: [10,10]
    });
    navDriverMarker = L.marker([driverLatLng.lat, driverLatLng.lng], {icon: driverIcon, zIndexOffset: 1000}).addTo(navMap);
  } else {
    navDriverMarker.setLatLng([driverLatLng.lat, driverLatLng.lng]);
    if (!navMap.hasLayer(navDriverMarker)) navDriverMarker.addTo(navMap);
  }

  // Route target: go to pickup first (unless already at pickup)
  const routeTarget = origin || dest;
  if (!routeTarget) { updateNavUI('No destination info', '', 0, 0); return; }

  // Place markers
  if (origin) navOriginMarker = L.marker([origin.lat, origin.lng]).addTo(navMap).bindPopup('Pickup');
  if (dest) navDestMarker = L.marker([dest.lat, dest.lng]).addTo(navMap).bindPopup('Dropoff');

  // Draw passenger route in yellow
  if (reqData.geometry && reqData.geometry.length) {
    navPassengerRouteLayer = L.polyline(reqData.geometry, {color:'#facc15', weight:4, dashArray:'6,6', opacity:0.7}).addTo(navMap);
  } else if (origin && dest) {
    navPassengerRouteLayer = L.polyline([[origin.lat,origin.lng],[dest.lat,dest.lng]], {color:'#facc15', weight:4, dashArray:'6,6', opacity:0.7}).addTo(navMap);
  }

  // Fetch route with steps for turn-by-turn
  await fetchNavRoute(driverLatLng, routeTarget);

  // Center on driver
  navMap.setView([driverLatLng.lat, driverLatLng.lng], 17);

  // Start watching position for navigation
  if (navWatchId) try{ navigator.geolocation.clearWatch(navWatchId); }catch(e){}
  navWatchId = navigator.geolocation.watchPosition(
    pos => onNavPositionUpdate(pos),
    err => console.error('Nav watch error', err),
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
  );
}

async function fetchNavRoute(from, to){
  try{
    const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson&alternatives=false&steps=true`;
    const resp = await fetch(url);
    if (!resp.ok) return;
    const data = await resp.json();
    if (!data || data.code !== 'Ok' || !data.routes || !data.routes.length) return;
    const route = data.routes[0];
    const coords = route.geometry.coordinates.map(c => [c[1], c[0]]);

    // Draw route
    if (navRouteLayer && navMap) try{ navMap.removeLayer(navRouteLayer); }catch(e){}
    navRouteLayer = L.polyline(coords, {color:'#3b82f6', weight:6, opacity:0.9}).addTo(navMap);

    // Parse steps
    navSteps = [];
    if (route.legs && route.legs.length) {
      route.legs.forEach(leg => {
        if (leg.steps) {
          leg.steps.forEach(step => {
            navSteps.push({
              instruction: step.name ? `${step.maneuver.type === 'arrive' ? 'Arrive at' : (step.maneuver.modifier || 'Continue on')} ${step.name}` : (step.maneuver.type === 'arrive' ? 'You have arrived' : 'Continue'),
              modifier: step.maneuver.modifier || step.maneuver.type || '',
              distance: step.distance,
              duration: step.duration,
              location: { lat: step.maneuver.location[1], lng: step.maneuver.location[0] }
            });
          });
        }
      });
    }
    navCurrentStepIdx = 0;

    // Update UI
    const totalKm = (route.distance / 1000).toFixed(1);
    const totalMin = Math.round(route.duration / 60);
    const stepText = navSteps.length > 0 ? navSteps[0].instruction : 'Head to destination';
    const stepDist = navSteps.length > 0 ? formatStepDistance(navSteps[0].distance) : '';
    updateNavUI(stepText, stepDist, totalMin, totalKm, navSteps.length > 0 ? navSteps[0].modifier : '');

  }catch(e){ console.error('Nav route error', e); }
}

function onNavPositionUpdate(pos){
  const lat = pos.coords.latitude, lng = pos.coords.longitude;
  driverLatLng = { lat, lng };

  // Update driver marker
  if (navDriverMarker) navDriverMarker.setLatLng([lat, lng]);

  // Auto-follow (lock mode)
  if (navLocked && navMap) {
    navMap.setView([lat, lng], navMap.getZoom(), { animate: true, duration: 0.5 });
  }

  // Advance step if close enough to next maneuver
  if (navSteps.length > 0 && navCurrentStepIdx < navSteps.length) {
    const step = navSteps[navCurrentStepIdx];
    const dist = haversine({lat, lng}, step.location);
    if (dist < 30 && navCurrentStepIdx < navSteps.length - 1) {
      navCurrentStepIdx++;
      const next = navSteps[navCurrentStepIdx];
      updateNavUI(next.instruction, formatStepDistance(next.distance), null, null, next.modifier);
    }
    // Update distance to next step
    if (navCurrentStepIdx < navSteps.length) {
      const cur = navSteps[navCurrentStepIdx];
      const distToStep = haversine({lat, lng}, cur.location);
      const stepDistEl = document.getElementById('navStepDist');
      if (stepDistEl) stepDistEl.textContent = formatStepDistance(distToStep);
    }
  }

  // Update overall ETA/distance to route target
  if (navActiveRequestData) {
    const origin = navActiveRequestData.origin || (navActiveRequestData.lat ? {lat:navActiveRequestData.lat,lng:navActiveRequestData.lng} : null);
    const target = origin || navActiveRequestData.destination;
    if (target) {
      const totalDist = haversine({lat, lng}, target);
      const etaMin = Math.max(1, Math.round(totalDist / 700));
      const etaEl = document.getElementById('navETA');
      const distEl = document.getElementById('navDist');
      if (etaEl) etaEl.textContent = etaMin;
      if (distEl) distEl.textContent = (totalDist/1000).toFixed(1);
    }
  }

  // Also update Firebase
  if (selectedDriverId && shiftActive) {
    update(ref(db, 'drivers/'+selectedDriverId), { lat, lng, lastSeen: Date.now(), online: true }).catch(()=>{});
  }
}

function updateNavUI(stepText, stepDist, etaMin, distKm, modifier){
  const stepTextEl = document.getElementById('navStepText');
  const stepDistEl = document.getElementById('navStepDist');
  const etaEl = document.getElementById('navETA');
  const distEl = document.getElementById('navDist');
  const iconEl = document.getElementById('navInstructionIcon');
  if (stepTextEl && stepText !== null) stepTextEl.textContent = stepText;
  if (stepDistEl && stepDist !== null) stepDistEl.textContent = stepDist;
  if (etaEl && etaMin !== null) etaEl.textContent = etaMin;
  if (distEl && distKm !== null) distEl.textContent = distKm;
  if (iconEl && modifier !== undefined) iconEl.innerHTML = getManeuverIcon(modifier);
}

function exitNavMode(){
  const navModeEl = document.getElementById('navMode');
  if (navModeEl) navModeEl.style.display = 'none';
  if (navWatchId) try{ navigator.geolocation.clearWatch(navWatchId); }catch(e){}
  navWatchId = null;
  navActiveRequestKey = null;
  navActiveRequestData = null;
  navSteps = [];
  navCurrentStepIdx = 0;
}

// Wire nav mode buttons
const navRecenterBtn = document.getElementById('navRecenterBtn');
const navCompleteBtn = document.getElementById('navCompleteBtn');
const navExitBtn = document.getElementById('navExitBtn');

if (navRecenterBtn) navRecenterBtn.addEventListener('click', () => {
  navLocked = true;
  if (driverLatLng && navMap) navMap.setView([driverLatLng.lat, driverLatLng.lng], 17, {animate:true});
});

if (navCompleteBtn) navCompleteBtn.addEventListener('click', () => {
  if (navActiveRequestKey) completeRequest(navActiveRequestKey);
});

if (navExitBtn) navExitBtn.addEventListener('click', exitNavMode);

// ===== INIT =====
setStatus('Offline');
// Auto-show identity modal on first load if not signed in
setTimeout(() => {
  if (!selectedDriverId && identityModal) identityModal.style.display = 'flex';
}, 500);

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
