import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAcl } from '../src/acl.js';

const id = 'd0123456789abcdef';
const other = 'dfedcba9876543210';
const can = (action, topic, username = id) => checkAcl({ username, topic, action });

test('device publishes own values, state and meta', () => {
  assert.equal(can('publish', `dev/${id}/temperature`), true);
  assert.equal(can('publish', `dev/${id}/$state`), true);
  assert.equal(can('publish', `dev/${id}/$meta`), true);
  assert.equal(can('publish', `dev/${id}/relay_1`), true);
});

test('device cannot publish commands, foreign or odd topics', () => {
  assert.equal(can('publish', `dev/${id}/relay/set`), false);
  assert.equal(can('publish', `dev/${other}/temperature`), false);
  assert.equal(can('publish', `dev/${id}/$other`), false);
  assert.equal(can('publish', `dev/${id}/Temp`), false);
  assert.equal(can('publish', `dev/${id}/`), false);
  assert.equal(can('publish', `dev/${id}/#`), false);
  assert.equal(can('publish', '$SYS/brokers'), false);
});

test('device subscribes only to own set topics', () => {
  assert.equal(can('subscribe', `dev/${id}/+/set`), true);
  assert.equal(can('subscribe', `dev/${id}/relay/set`), true);
  assert.equal(can('subscribe', `dev/${id}/#`), false);
  assert.equal(can('subscribe', `dev/+/+/set`), false);
  assert.equal(can('subscribe', `dev/${other}/+/set`), false);
  assert.equal(can('subscribe', `$share/g/dev/${id}/+/set`), false);
  assert.equal(can('subscribe', `dev/${id}/temperature`), false);
});

test('non-device usernames and bad input are denied', () => {
  assert.equal(can('publish', 'dev/backend/x', 'backend'), false);
  assert.equal(can('publish', 'dev/+/x', '+'), false);
  assert.equal(checkAcl({}), false);
  assert.equal(can('retain', `dev/${id}/temperature`), false);
});
