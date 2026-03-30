import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.22.1/firebase-app.js';
import { getDatabase, ref, onChildAdded, onChildRemoved, onValue } from 'https://www.gstatic.com/firebasejs/9.22.1/firebase-database.js';

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
    showRequestOnMap({lat: data.lat, lng: data.lng}, key);
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
}

async function showRequestOnMap(dest, key){
  await ensureMap();
  if (!driverLatLng) {
    setStatus('Driver location unknown — click "Use my location"');
    return;
  }
  if (destMarker) { try{ map.removeLayer(destMarker); }catch(e){} destMarker = null; }
  if (routeLayer) { try{ map.removeLayer(routeLayer); }catch(e){} routeLayer = null; }
  destMarker = L.marker([dest.lat, dest.lng]).addTo(map).bindPopup('Passenger').openPopup();
  if (!driverMarker) driverMarker = L.marker([driverLatLng.lat, driverLatLng.lng], {icon: L.icon({iconUrl:'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png', iconAnchor:[12,41]})}).addTo(map).bindPopup('You');
  else driverMarker.setLatLng([driverLatLng.lat, driverLatLng.lng]);

  // request route from OSRM
  try{
    const fromLonLat = `${driverLatLng.lng},${driverLatLng.lat}`;
    const toLonLat = `${dest.lng},${dest.lat}`;
    const url = `https://router.project-osrm.org/route/v1/driving/${fromLonLat};${toLonLat}?overview=full&geometries=geojson&alternatives=false&steps=false`;
    const resp = await fetch(url);
    if (resp.ok){
      const data = await resp.json();
      if (data && data.routes && data.routes.length){
        const coords = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
        routeLayer = L.polyline(coords, {color:'#1978c8', weight:4}).addTo(map);
        const bounds = routeLayer.getBounds();
        map.fitBounds(bounds, {padding:[40,40]});
      }
    }
  } catch(e){ console.error('Route error', e); }
}

const reqRef = ref(db, 'ride_requests');

onValue(reqRef, snapshot => {
  listEl.innerHTML = '';
  if (!snapshot.exists()) { setStatus('No active requests'); return; }
  const items = [];
  snapshot.forEach(child => { items.push({key: child.key, val: child.val()}); });
  // compute distances if driver known
  if (driverLatLng) {
    items.forEach(i => { i.dist = haversine(driverLatLng, {lat: i.val.lat, lng: i.val.lng}); });
    items.sort((a,b) => (a.dist||0) - (b.dist||0));
  }
  items.forEach(i => {
    const el = renderItem(i.key, i.val, i.dist);
    listEl.appendChild(el);
  });
  setStatus('Loaded requests (' + items.length + ')');
});

onChildRemoved(reqRef, (snap) => {
  const el = document.getElementById(`req-${snap.key}`);
  if (el) el.remove();
});

setStatus('Connected — listening for ride_requests');

// location handling
async function updateDriverLocation(pos){
  driverLatLng = {lat: pos.coords.latitude, lng: pos.coords.longitude};
  await ensureMap();
  if (!driverMarker) driverMarker = L.marker([driverLatLng.lat, driverLatLng.lng]).addTo(map).bindPopup('You');
  else driverMarker.setLatLng([driverLatLng.lat, driverLatLng.lng]);
  map.setView([driverLatLng.lat, driverLatLng.lng], 13);
  // trigger a reload of list ordering
  const ev = new Event('reorderRequests');
  listEl.dispatchEvent(ev);
}

if (locateBtn) locateBtn.addEventListener('click', () => {
  if (!navigator.geolocation) { setStatus('Geolocation not supported'); return; }
  setStatus('Locating…');
  navigator.geolocation.getCurrentPosition(pos => { updateDriverLocation(pos); setStatus('Located'); }, err => { setStatus('Location error'); console.error(err); }, {enableHighAccuracy:true, timeout:10000});
});

// allow external reorder trigger to re-render (simple: re-read db snapshot)
listEl.addEventListener('reorderRequests', () => { onValue(reqRef, () => {}); });
