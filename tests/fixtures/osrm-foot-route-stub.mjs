// Deterministic OSRM-compatible foot graph for isolated route-search integration tests only.
// It follows requested endpoints exactly and reports distance-based walking time.
import http from 'node:http';
import process from 'node:process';

const routeRequests = [];
const radians = (degrees) => degrees * Math.PI / 180;
const distanceMeters = (a, b) => {
  const lat1 = radians(a[1]);
  const lat2 = radians(b[1]);
  const dLat = lat2 - lat1;
  const dLon = radians(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
};

const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', fixture: true }));
    return;
  }
  if (request.url === '/_stats') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ requests: routeRequests }));
    return;
  }
  const rawPath = request.url?.split('?')[0] ?? '';
  const path = rawPath.replace(/^\/route\/v1\/foot\//, '');
  const points = path.split(';').map((point) => point.split(',').map(Number));
  if (!rawPath.startsWith('/route/v1/foot/') || points.length !== 2
    || points.some((point) => point.length !== 2 || point.some((value) => !Number.isFinite(value)))) {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: 'NotFound' }));
    return;
  }
  const [from, to] = points;
  routeRequests.push({ from, to });
  const distance = Math.max(1, Math.ceil(distanceMeters(from, to)));
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ code: 'Ok', routes: [{ distance, duration: Math.max(1, Math.ceil(distance / 1.3)),
    geometry: { coordinates: [from, to] } }] }));
});
server.on('connection', (socket) => socket.on('error', () => {}));
server.listen(Number(process.env.WALKING_ROUTE_STUB_PORT ?? 3306), '127.0.0.1');
