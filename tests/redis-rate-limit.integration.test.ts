import assert from 'node:assert/strict';
import test from 'node:test';

const apiUrl = process.env.API_TEST_URL;
const secondaryApiUrl = process.env.API_TEST_SECONDARY_URL;

test('API instances share the Redis rate-limit window', { skip: !apiUrl || !secondaryApiUrl }, async () => {
  const urls = [apiUrl!, secondaryApiUrl!];
  const statuses: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    const response = await fetch(`${urls[index % urls.length]}/api/v1/rate-limit-test`);
    statuses.push(response.status);
    if (index < 3) assert.equal(response.status, 404, `request ${index + 1} should stay under the shared limit`);
    else {
      assert.equal(response.status, 429, `request ${index + 1} should be blocked across API instances`);
      assert.equal((await response.json() as { error?: { code?: string } }).error?.code, 'rate_limit_exceeded');
    }
  }
  assert.deepEqual(statuses, [404, 404, 404, 429, 429]);
});

test('trusted forwarded client IPs receive separate Redis rate-limit windows', { skip: !apiUrl || !secondaryApiUrl }, async () => {
  const request = (url: string, clientIp: string) => fetch(`${url}/api/v1/rate-limit-test`, {
    headers: { 'x-forwarded-for': clientIp },
  });
  const statuses = [
    (await request(apiUrl!, '198.51.100.10')).status,
    (await request(secondaryApiUrl!, '198.51.100.11')).status,
    (await request(apiUrl!, '198.51.100.10')).status,
    (await request(secondaryApiUrl!, '198.51.100.11')).status,
    (await request(apiUrl!, '198.51.100.10')).status,
    (await request(secondaryApiUrl!, '198.51.100.11')).status,
    (await request(apiUrl!, '198.51.100.10')).status,
  ];
  assert.deepEqual(statuses, [404, 404, 404, 404, 404, 404, 429]);
});
