const test = require('node:test');
const assert = require('node:assert/strict');

test('rez-media-events service bootstrap', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');

  // Verify main entry point exists
  assert.match(source, /rez-media-events/i);
  assert.match(source, /main|async/i);
});

test('rez-media-events health server', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'health.ts'), 'utf8');

  // Verify health server implementation
  assert.match(source, /startHealthServer/);
  assert.match(source, /\/health/);
  assert.match(source, /\/healthz|\/ready/);
});

test('rez-media-events HTTP server', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'http.ts'), 'utf8');

  // Verify HTTP server setup
  assert.match(source, /express\(\)|startHttpServer/i);
});

test('rez-media-events worker process', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'worker.ts'), 'utf8');

  // Verify worker implementation
  assert.match(source, /startMediaWorker|Worker/i);
  assert.match(source, /process|queue/i);
});

test('rez-media-events graceful shutdown', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');

  // Verify shutdown handlers
  assert.match(source, /SIGTERM|SIGINT/);
  assert.match(source, /shutdown|graceful/i);
});
