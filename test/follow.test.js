import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atBottom, follower } from '../public/js/follow.js';

test('follow: stays at the bottom, counts what arrives while scrolled up, follows again at the bottom', () => {
  const f = follower(3);
  assert.deepEqual(f.update(4), { scroll: true, unseen: 0 });
  f.scrolled(false);
  assert.deepEqual(f.update(5), { scroll: false, unseen: 1 });
  assert.deepEqual(f.update(7), { scroll: false, unseen: 3 });
  assert.deepEqual(f.update(7), { scroll: false, unseen: 3 }); // a reaction redraw adds nothing
  f.scrolled(true);
  assert.deepEqual(f.update(8), { scroll: true, unseen: 0 });
});

test('follow: jump (the chip, or your own post) follows again; a removed comment never counts negative', () => {
  const f = follower(5);
  f.scrolled(false);
  assert.equal(f.update(4).unseen, 0);
  f.update(6);
  f.jump();
  assert.deepEqual(f.update(7), { scroll: true, unseen: 0 });
});

test('atBottom allows a few pixels of slack', () => {
  assert.equal(atBottom({ scrollHeight: 1000, scrollTop: 590, clientHeight: 400 }), true);
  assert.equal(atBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 400 }), false);
});
