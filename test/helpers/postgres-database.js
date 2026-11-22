const { PGlite } = require('@electric-sql/pglite');
const { createDatabaseAdapter, initializeDatabase } = require('../../database');

async function createTestDatabase() {
  const engine = new PGlite();
  const db = createDatabaseAdapter({
    query: (sql, params) => engine.query(sql, params),
    withTransaction: work => engine.transaction(work),
    close: () => engine.close()
  });
  await initializeDatabase(db);
  return db;
}

module.exports = { createTestDatabase };
