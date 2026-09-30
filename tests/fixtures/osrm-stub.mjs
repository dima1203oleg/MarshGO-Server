// Test-only OSRM contract fixture. Never configure this endpoint outside isolated tests.
import http from 'node:http';
import process from 'node:process';
import { URL } from 'node:url';

const server = http.createServer((request, response) => {
  const parsed = new URL(request.url ?? '/', 'http://localhost');
  if (parsed.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', fixture: true }));
    return;
  }
  const routePath = parsed.pathname.split('/').at(-1) ?? '';
  const waypointTexts = routePath.split(';');
  const parsePoint = (value) => value?.split(',').map(Number);
  const waypoints = waypointTexts.map(parsePoint);
  if (waypoints.length < 2 || waypoints.some((point) => !point || point.some((value) => !Number.isFinite(value)))) {
    response.writeHead(400).end(JSON.stringify({ code: 'InvalidQuery' }));
    return;
  }
  const legs = waypoints.slice(1).map((point, index) => {
    const from = waypoints[index];
    const lat1 = from[1] * Math.PI / 180;
    const lat2 = point[1] * Math.PI / 180;
    const dLat = lat2 - lat1;
    const dLon = (point[0] - from[0]) * Math.PI / 180;
    const haversine = 2 * 6_371_000 * Math.asin(Math.sqrt(
      Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2,
    ));
    const distance = haversine * 1.1;
    return { distance, duration: distance / 12 };
  });
  const distance = legs.reduce((total, leg) => total + leg.distance, 0);
  const duration = legs.reduce((total, leg) => total + leg.duration, 0);
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    code: 'Ok',
    routes: [{ distance, duration, legs, geometry: { coordinates: waypoints } }],
  }));
});
server.on('connection', (socket) => socket.on('error', () => {}));
server.listen(Number(process.env.OSRM_STUB_PORT ?? 3004), '127.0.0.1');
