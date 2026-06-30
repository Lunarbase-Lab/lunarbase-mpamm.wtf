import { config } from './config.js';
import { startServer } from './server.js';
import { SimDataSource } from './datasource/sim.js';
import { LiveDataSource } from './datasource/live.js';
import { probeChain } from './chain/rpc.js';
import type { DataSource } from './datasource/index.js';

async function pickSource(): Promise<DataSource> {
  if (config.source === 'sim') return new SimDataSource();
  if (config.source === 'live') return new LiveDataSource();

  // auto — probe the chain; fall back to sim if unreachable
  const probe = await probeChain();
  if (probe.ok) {
    console.log(`[mpamm] auto: chain reachable at block ${probe.block} → live`);
    return new LiveDataSource();
  }
  console.warn(`[mpamm] auto: chain unreachable (${probe.reason}) → sim`);
  return new SimDataSource();
}

async function main(): Promise<void> {
  let source = await pickSource();
  try {
    await source.start();
  } catch (e) {
    if (source.mode === 'live') {
      console.error('[mpamm] live source failed to start → falling back to sim:', (e as Error).message);
      source = new SimDataSource();
      await source.start();
    } else {
      throw e;
    }
  }

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
