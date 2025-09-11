"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SQL = void 0;
exports.getPool = getPool;
const mssql_1 = __importDefault(require("mssql"));
const config_1 = require("./config");
let pool = null;
async function getPool() {
    if (pool && pool.connected)
        return pool;
    pool = await new mssql_1.default.ConnectionPool({
        server: config_1.env.DB_HOST,
        port: config_1.env.DB_PORT,
        user: config_1.env.DB_USER,
        password: config_1.env.DB_PASS,
        database: config_1.env.DB_NAME,
        options: {
            encrypt: true, // keep true; good default
            trustServerCertificate: true // allow self-signed for local
        },
        pool: { min: 0, max: 10, idleTimeoutMillis: 30000 }
    }).connect();
    return pool;
}
exports.SQL = mssql_1.default;
