import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig(process.env);
const app = await buildApp({ db: null, config });
await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`Hornhoof is running at ${config.publicUrl}`);
