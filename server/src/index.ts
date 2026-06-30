import { config } from './config.js';
import { startServer } from './server.js';
import { SimDataSource } from './datasource/sim.js';
import { LiveDataSource } from './datasource/live.js';
import type { DataSource } from './datasource/index.js';

async function main(): Promise<void> {
  // Live (real chain + Bybit) by default; the simulator is an explicit opt-in.
  // A live boot failure is fatal — we never silently serve simulated data in
  // production. A process supervisor should restart the service.
  const source: DataSource = config.source === 'sim' ? new SimDataSource() : new LiveDataSource();
  console.log(`[mpamm] starting ${source.mode} source`);
  await source.start();

  // History persistence is owned by the live source (DB = source of truth,
  // spec §6.2); the simulator regenerates its history each boot.
  const server = startServer(source);

  const shutdown = () => {
    console.log('\n[mpamm] shutting down');
    source.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[mpamm] fatal:', e);
  process.exit(1);
});
