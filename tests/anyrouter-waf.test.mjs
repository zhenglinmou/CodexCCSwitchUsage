import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractAnyRouterAcwChallenge,
  isAnyRouterAcwUrl,
  solveAnyRouterAcwChallenge,
  withAnyRouterAcwRetry,
} from '../browser-companion/anyrouter-waf.js';

const KNOWN_ARG1 = 'A3F7266552617B54B8BE3AF29C125E502FABE903';
const KNOWN_COOKIE = '6a5233c9253051a9917309b6830f57679572fd6e';

test('AnyRouter ACW handling is restricted to the exact HTTPS origin', () => {
  assert.equal(isAnyRouterAcwUrl('https://anyrouter.top/api/user/self'), true);
  assert.equal(isAnyRouterAcwUrl('http://anyrouter.top/api/user/self'), false);
  assert.equal(isAnyRouterAcwUrl('https://anyrouter.top.example/api/user/self'), false);
  assert.equal(isAnyRouterAcwUrl('not-a-url'), false);
});

test('AnyRouter ACW solver matches the legacy bridge known vector', () => {
  assert.equal(solveAnyRouterAcwChallenge(KNOWN_ARG1), KNOWN_COOKIE);
  assert.throws(() => solveAnyRouterAcwChallenge('not-a-challenge'), /40 hexadecimal/i);
});

test('AnyRouter ACW challenge extraction accepts the WAF script and rejects unrelated HTML', () => {
  assert.equal(extractAnyRouterAcwChallenge(`<script>var arg1='${KNOWN_ARG1}'</script>`), KNOWN_ARG1);
  assert.equal(extractAnyRouterAcwChallenge(`<script>var arg1 = "${KNOWN_ARG1.toLowerCase()}";</script>`), KNOWN_ARG1.toLowerCase());
  assert.equal(extractAnyRouterAcwChallenge('<html>ordinary error page</html>'), '');
});

test('AnyRouter ACW retry writes the solved browser cookie before retrying the request', async () => {
  const responses = [
    { status: 200, text: `<script>var arg1='${KNOWN_ARG1}'</script>` },
    { status: 200, text: '{"success":true,"data":{"quota":1}}' },
  ];
  const cookies = [];
  let calls = 0;

  const result = await withAnyRouterAcwRetry(
    async () => responses[calls++],
    async value => cookies.push(value),
  );

  assert.equal(calls, 2);
  assert.deepEqual(cookies, [KNOWN_COOKIE]);
  assert.equal(result.text, responses[1].text);
});

test('AnyRouter ACW retry is bounded and ignores non-challenge responses', async () => {
  let challengeCalls = 0;
  const cookies = [];
  const challengeResult = await withAnyRouterAcwRetry(
    async () => {
      challengeCalls += 1;
      return { status: 200, text: `<script>var arg1='${KNOWN_ARG1}'</script>` };
    },
    async value => cookies.push(value),
  );

  assert.equal(challengeCalls, 3);
  assert.equal(cookies.length, 2);
  assert.match(challengeResult.text, /arg1/);

  let ordinaryCalls = 0;
  const ordinaryResult = await withAnyRouterAcwRetry(
    async () => {
      ordinaryCalls += 1;
      return { status: 403, text: '<html>captcha required</html>' };
    },
    async () => assert.fail('unrelated HTML must not update a browser cookie'),
  );

  assert.equal(ordinaryCalls, 1);
  assert.equal(ordinaryResult.status, 403);
});
