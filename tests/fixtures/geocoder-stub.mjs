import http from 'node:http';
import process from 'node:process';
import { URL } from 'node:url';

const places = [
  { place_id: 101, display_name: 'Стрий, Львівська область, Україна', lat: '49.2567', lon: '23.8561' },
  { place_id: 102, display_name: 'Львів, Львівська область, Україна', lat: '49.8397', lon: '24.0297' },
];

const server = http.createServer((request, response) => {
  const query = new URL(request.url ?? '/', 'http://localhost').searchParams.get('q')?.toLocaleLowerCase('uk') ?? '';
  const results = places.filter((place) => place.display_name.toLocaleLowerCase('uk').includes(query));
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(results));
});

server.on('connection', (socket) => socket.on('error', () => {}));

server.listen(Number(process.env.GEOCODER_STUB_PORT ?? 3004), '127.0.0.1');
