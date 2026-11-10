import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpRoot = mkdtempSync(join(tmpdir(), 'companion-card-test-'));
const dbPath = join(tmpRoot, 'test.db');
process.env.RESONANT_HOME = tmpRoot;
writeFileSync(join(tmpRoot, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');

const { initDb, getDb } = await import('../db.js');
const { listCompanions, updateCompanionCard, deleteCompanion, ProtectedCompanionError } = await import('./rooms.js');

before(() => initDb(dbPath));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

describe('companion card', () => {
  it('a fresh house has the card columns (migration 026)', () => {
    const compA = listCompanions().find((c) => c.id === 'companion-a');
    assert.ok(compA);
    assert.equal(compA.bio, null);
    assert.equal(compA.status, null);
    assert.equal(compA.phone, null);
  });

  it('re-running init on the same DB is harmless (duplicate columns are fine)', () => {
    assert.doesNotThrow(() => initDb(dbPath));
  });

  it('writes only the fields sent and reads them back', () => {
    const updated = updateCompanionCard('companion-a', { bio: 'Plainspoken, modern, heartfelt.' });
    assert.equal(updated?.bio, 'Plainspoken, modern, heartfelt.');
    assert.equal(updated?.display_name, 'Companion A');
    assert.equal(listCompanions().find((c) => c.id === 'companion-a')?.bio, 'Plainspoken, modern, heartfelt.');
    // Companion B untouched.
    assert.equal(listCompanions().find((c) => c.id === 'companion-b')?.bio, null);
  });

  it('null clears a field', () => {
    updateCompanionCard('companion-a', { status: 'Online' });
    assert.equal(updateCompanionCard('companion-a', { status: null })?.status, null);
  });

  it('the card look saves too: photo, emoji, color (migration 048)', () => {
    const updated = updateCompanionCard('companion-b', { avatar: 'data:image/webp;base64,AAAA', emoji: '🔶', color: '#334455' });
    assert.equal(updated?.avatar, 'data:image/webp;base64,AAAA');
    assert.equal(updated?.emoji, '🔶');
    assert.equal(updated?.color, '#334455');
    const listed = listCompanions().find((c) => c.id === 'companion-b');
    assert.equal(listed?.emoji, '🔶');
    assert.equal(listed?.color, '#334455');
    assert.equal(updateCompanionCard('companion-b', { color: null })?.color, null);
  });

  it('an unknown companion is null, not a crash', () => {
    assert.equal(updateCompanionCard('nobody', { bio: 'x' }), null);
  });
});

describe('companion deletion', () => {
  it('does not seed companion-c in a fresh registry', () => {
    assert.equal(listCompanions().some(c => c.id === 'companion-c'), false);
  });

  it('removes cards, rosters and defaults without disturbing unrelated records', () => {
    const db = getDb();
    db.prepare("INSERT INTO companions (id, display_name, brain) VALUES ('companion-c', 'Companion C', 'companion-c')").run();
    db.prepare("INSERT INTO threads (id, name, type, created_at, default_companion_id) VALUES ('delete-test', 'Deletion test', 'named', datetime('now'), 'companion-c')").run();
    db.prepare("INSERT INTO thread_companions (thread_id, companion_id) VALUES ('delete-test', 'companion-c')").run();
    const residents = listCompanions().filter(c => c.id !== 'companion-c');
    assert.equal(deleteCompanion('companion-c'), true);
    assert.deepEqual(listCompanions(), residents);
    assert.equal((db.prepare("SELECT default_companion_id FROM threads WHERE id = 'delete-test'").get() as { default_companion_id: string | null }).default_companion_id, null);
    assert.equal(deleteCompanion('companion-c'), false);
    assert.equal(db.prepare("SELECT 1 FROM thread_companions WHERE companion_id = 'companion-c'").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM threads WHERE default_companion_id = 'companion-c'").get(), undefined);
  });

  it('protects both core residents without changing their cards or rosters', () => {
    const before = listCompanions();
    const rosters = getDb().prepare('SELECT * FROM thread_companions').all();
    for (const id of ['companion-a', 'companion-b']) {
      assert.throws(() => deleteCompanion(id), ProtectedCompanionError);
    }
    assert.deepEqual(listCompanions(), before);
    assert.deepEqual(getDb().prepare('SELECT * FROM thread_companions').all(), rosters);
  });

  it('restores absent core residents at startup without resurrecting companion-c', () => {
    const db = getDb();
    db.prepare("DELETE FROM thread_companions WHERE companion_id IN ('companion-a', 'companion-b')").run();
    db.prepare("DELETE FROM companions WHERE id IN ('companion-a', 'companion-b')").run();
    initDb(dbPath);
    assert.deepEqual(listCompanions().map(c => c.id), ['companion-a', 'companion-b']);
    updateCompanionCard('companion-a', { bio: 'Keep my card' });
    initDb(dbPath);
    assert.equal(listCompanions().find(c => c.id === 'companion-a')?.bio, 'Keep my card');
    assert.equal(listCompanions().some(c => c.id === 'companion-c'), false);
  });
});
