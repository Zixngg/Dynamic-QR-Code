"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
require("dotenv/config");
const zod_1 = require("zod");
const Env = zod_1.z.object({
    DB_HOST: zod_1.z.string(),
    DB_PORT: zod_1.z.coerce.number().default(1433),
    DB_USER: zod_1.z.string(),
    DB_PASS: zod_1.z.string(),
    DB_NAME: zod_1.z.string(),
});
exports.env = Env.parse(process.env);
