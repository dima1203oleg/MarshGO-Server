// Test-only OSRM-compatible foot router. It deliberately snaps the origin away from the
// requested point to exercise the API's geometry coverage guard; never configure outside tests.
import http from 'node:http';
import process from 'node:process';

const snappedGeometry = [[24.032136, 49.842068], [24.03222, 49.8419]];
const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', fixture: true }));
    return;
  }
  if (!request.url?.startsWith('/route/v1/foot/')) {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: 'NotFound' }));
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    code: 'Ok',
    routes: [{ distance: 19.6, duration: 14.2, geometry: { coordinates: snappedGeometry } }],
  }));
});
server.on('connection', (socket) => socket.on('error', () => {}));
server.listen(Number(process.env.WALKING_OSRM_STUB_PORT ?? 3305), '127.0.0.1');
