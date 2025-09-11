"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const db_1 = require("./db");
async function main() {
    const pool = await (0, db_1.getPool)();
    const r = await pool.request().query(`
    SELECT DB_NAME() AS dbname, SUSER_SNAME() AS login_name, SYSUTCDATETIME() AS utc_now;
  `);
    console.log(r.recordset[0]);
}
main().catch(err => {
    console.error('DB test failed:', err);
    process.exit(1);
});
