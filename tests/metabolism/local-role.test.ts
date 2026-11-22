import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../src/db/connection.js';
import { readLocalOrganizerRole, readLocalRoleRecord, writeLocalRole } from '../../src/metabolism/local-role.js';

describe('local organizer role', () => {
  it('falls back to the legacy switch only while the key was never written', () => {
    const db = createTestDb();
    try {
      expect(readLocalOrganizerRole(db)).toBe(true);
      expect(readLocalOrganizerRole(db, false)).toBe(false);
      expect(writeLocalRole(db, { organizer: true, revision: null, source: 'local' })).toBe(true);
      expect(readLocalOrganizerRole(db, false)).toBe(true);
      expect(writeLocalRole(db, { organizer: false, revision: 3, source: 'server' })).toBe(true);
      expect(readLocalOrganizerRole(db, true)).toBe(false);
    } finally { db.close(); }
  });

  it('never lets an older server revision overwrite a newer one; reports only real changes', () => {
    const db = createTestDb();
    try {
      writeLocalRole(db, { organizer: true, revision: 5, source: 'server' });
      expect(writeLocalRole(db, { organizer: false, revision: 4, source: 'server' })).toBe(false);
      expect(readLocalRoleRecord(db)).toEqual({ organizer: true, revision: 5, source: 'server' });
      expect(writeLocalRole(db, { organizer: true, revision: 6, source: 'server' })).toBe(false);
      expect(writeLocalRole(db, { organizer: false, revision: 7, source: 'server' })).toBe(true);
      // local evaluation (logout / sync off) always applies and drops the revision
      expect(writeLocalRole(db, { organizer: true, revision: null, source: 'local' })).toBe(true);
      expect(writeLocalRole(db, { organizer: false, revision: 1, source: 'server' })).toBe(true);
    } finally { db.close(); }
  });

  it('treats a corrupt value as never written', () => {
    const db = createTestDb();
    try {
      db.prepare("INSERT INTO metadata (key, value) VALUES ('metabolism.local_role', 'garbage')").run();
      expect(readLocalRoleRecord(db)).toBeNull();
      expect(readLocalOrganizerRole(db, false)).toBe(false);
    } finally { db.close(); }
  });
});
