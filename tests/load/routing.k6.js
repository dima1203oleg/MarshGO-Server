/* global __ENV, __VU, __ITER */
import http from 'k6/http';
import { check } from 'k6';

const baseUrl = (__ENV.API_BASE_URL || 'http://127.0.0.1:3002').replace(/\/$/, '');
const token = __ENV.API_BEARER_TOKEN || '';
const mode = __ENV.LOAD_SCENARIO || 'rate';
const rate = Number(__ENV.TARGET_RPS || 5);
const host = baseUrl.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
if (!['localhost', '127.0.0.1', '::1'].includes(host) && __ENV.LOAD_TEST_ALLOW_REMOTE !== '1') {
  throw new Error('Load test is local-only; set LOAD_TEST_ALLOW_REMOTE=1 only for an approved isolated staging target.');
}
if (!token) throw new Error('Set API_BEARER_TOKEN to a dedicated test account token.');

export const options = mode === 'same-100' ? {
  scenarios: { identical_route_burst: { executor: 'shared-iterations', vus: 100, iterations: 100, maxDuration: '60s' } },
  thresholds: { http_req_failed: ['rate<0.01'], http_req_duration: ['p(95)<3000'] },
} : {
  scenarios: { route_search: { executor: 'constant-arrival-rate', rate, timeUnit: '1s', duration: __ENV.DURATION || '60s',
    preAllocatedVUs: Math.max(10, rate * 2), maxVUs: Math.max(50, rate * 8) } },
  thresholds: { http_req_failed: ['rate<0.01'], http_req_duration: ['p(95)<3000', 'p(99)<5000'] },
};

export default function () {
  const requestId = `load-${__VU}-${__ITER}-${Date.now()}`;
  const body = JSON.stringify({ origin: [30.5234, 50.4501], destination: [30.6139, 50.4547],
    profile: { mode: 'CAR' }, requestId });
  const response = http.post(`${baseUrl}/api/v1/routing/calculate`, body, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, tags: { endpoint: 'routing.calculate' },
  });
  check(response, { 'route responds successfully': (res) => res.status === 200 });
}
